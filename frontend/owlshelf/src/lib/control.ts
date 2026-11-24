/**
 * control.ts — signed room-control ops (plan §6.4, §6.7). WORKER ONLY.
 *
 * The closed union is THREE kinds. Nothing else may change a room's trust
 * state, which is what makes the shape check a real gate rather than a
 * formality: `applyControlOp` accepts only these, verifies the signature
 * against the room's PINNED owner key, and applies exactly one transition.
 * A `put` cannot roster a device; a control op cannot write a row.
 *
 * ── Why a separate path from the row reducer ─────────────────────────────
 *
 * §6.4: control ops "have no `table`, so admission step 1 would reject them
 * all". The row path's first check is the table allowlist; a control op must be
 * admitted by its closed kind union and its signature instead. Neither handler
 * accepts the other's shape, so there is no shape through which a row op can
 * acquire control authority.
 *
 * ── What is NOT here yet ─────────────────────────────────────────────────
 *
 * Control ops are minted, verified, and applied, and the caller broadcasts them
 * over the `control` envelope — but they are not yet entries in the `ops` log,
 * so a peer that is OFFLINE at rotation time does not receive the notice from
 * catch-up on its next connect. That is the remaining half of audit-4
 * D4/R4-P1-5 and it needs the log to carry a second op shape; see
 * `owlshelf-code-vs-plan.md` §5.6 before changing it.
 */

import type { OwlshelfDB } from "./db";
import { controlSignatureInput } from "./canonical";
import { sign, verify, type DeviceKeys } from "./keys";
import { adoptEpoch, sortMembers } from "./roster";
import { readRoom, writeRoom } from "./roomMeta";
import type { Room, RosterMember } from "./stores";

export type ControlOp =
  | {
      kind: "roster-epoch";
      roomId: string;
      signer: string;
      epoch: number;
      members: RosterMember[];
      sig: string;
    }
  | { kind: "rotate-key"; roomId: string; signer: string; keyGen: number; sig: string }
  | { kind: "rehome"; roomId: string; signer: string; relayUrl: string; sig: string };

export type ControlReject =
  | "bad-shape"        // not an object, wrong kind, missing/extra fields
  | "wrong-room"       // the op names a different room — a relay cannot make this happen, a bug or an attack can
  | "not-the-owner"    // signature does not verify against the pinned owner key
  | "stale"            // epoch or keyGen does not move forward
  | "unknown-anchor";  // the room has no pinned owner key

export type ControlResult =
  | { ok: true; applied: ControlOp["kind"] }
  | { ok: false; reason: ControlReject };

// ─── Shape validation ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/**
 * Read a control op from an untrusted body.
 *
 * Every field is checked, and unknown fields are DROPPED rather than copied
 * through: an op object is what gets re-broadcast, and passing an unvetted
 * field along is how a "verified" relay becomes an injection point.
 */
export function readControlOp(value: unknown): ControlOp | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (kind !== "roster-epoch" && kind !== "rotate-key" && kind !== "rehome") return null;
  if (!isDeviceId(value.roomId) || !isDeviceId(value.signer)) return null;
  if (typeof value.sig !== "string" || value.sig === "") return null;

  if (kind === "rotate-key") {
    if (!Number.isInteger(value.keyGen) || (value.keyGen as number) < 1) return null;
    return {
      kind,
      roomId: value.roomId,
      signer: value.signer,
      keyGen: value.keyGen as number,
      sig: value.sig,
    };
  }

  if (kind === "rehome") {
    if (typeof value.relayUrl !== "string" || !/^wss?:\/\/\S+$/.test(value.relayUrl)) return null;
    return {
      kind,
      roomId: value.roomId,
      signer: value.signer,
      relayUrl: value.relayUrl,
      sig: value.sig,
    };
  }

  if (!Number.isInteger(value.epoch) || (value.epoch as number) < 1) return null;
  if (!Array.isArray(value.members) || value.members.length === 0) return null;
  const members: RosterMember[] = [];
  for (const item of value.members) {
    if (!isRecord(item)) return null;
    if (!isDeviceId(item.deviceId)) return null;
    if (item.role !== "owner" && item.role !== "member") return null;
    if (!Number.isInteger(item.addedAt) || (item.addedAt as number) < 0) return null;
    members.push({
      deviceId: item.deviceId,
      role: item.role,
      addedAt: item.addedAt as number,
    });
  }
  if (members.filter((member) => member.role === "owner").length !== 1) return null;
  if (new Set(members.map((member) => member.deviceId)).size !== members.length) return null;

  return {
    kind,
    roomId: value.roomId,
    signer: value.signer,
    epoch: value.epoch as number,
    members: sortMembers(members),
    sig: value.sig,
  };
}

// ─── Mint (owner only) ─────────────────────────────────────────────────────

/** The owner's deviceId, from the pinned anchor — never from `room.roster`,
 *  which is derived and therefore not an authority. */
function anchorOwner(room: Room): RosterMember | null {
  const anchor = room.rosterAnchor;
  if (!anchor) return null;
  const owners = anchor.members.filter((member) => member.role === "owner");
  return owners.length === 1 ? owners[0] : null;
}

/**
 * True when this device may sign control ops for the room.
 *
 * Both halves are required: the anchor names this device as owner AND the pinned
 * key is this device's key. Checking only the first would let a device that
 * copied an anchor claim ownership with a key it does not hold.
 */
export function canMintControl(room: Room, keys: DeviceKeys, deviceId: string): boolean {
  const owner = anchorOwner(room);
  if (owner === null) return false;
  return owner.deviceId === deviceId && room.ownerPub === keys.pub;
}

/** Build and sign one `roster-epoch` op. Throws when the caller is not the
 *  owner: an unsigned epoch is a bug, not a refusal. */
export async function mintRosterEpoch(
  room: Room,
  keys: DeviceKeys,
  deviceId: string,
  members: readonly RosterMember[],
): Promise<ControlOp> {
  if (!canMintControl(room, keys, deviceId)) {
    throw new Error("mintRosterEpoch: this device is not the room's owner");
  }
  const sorted = sortMembers(members);
  const epoch = (room.rosterEpoch ?? 1) + 1;
  const input = controlSignatureInput("roster-epoch", room.roomId, deviceId, { epoch, members: sorted });
  return {
    kind: "roster-epoch",
    roomId: room.roomId,
    signer: deviceId,
    epoch,
    members: sorted,
    sig: await sign(keys.priv, input),
  };
}

/** Build and sign one `rotate-key` op. Carries the generation ONLY. */
export async function mintRotateKey(
  room: Room,
  keys: DeviceKeys,
  deviceId: string,
  keyGen: number,
): Promise<ControlOp> {
  if (!canMintControl(room, keys, deviceId)) {
    throw new Error("mintRotateKey: this device is not the room's owner");
  }
  if (!Number.isInteger(keyGen) || keyGen <= room.keyGen) {
    throw new Error("mintRotateKey: the generation must move forward");
  }
  const input = controlSignatureInput("rotate-key", room.roomId, deviceId, { keyGen });
  return { kind: "rotate-key", roomId: room.roomId, signer: deviceId, keyGen, sig: await sign(keys.priv, input) };
}

/** Build and sign one `rehome` op. */
export async function mintRehome(
  room: Room,
  keys: DeviceKeys,
  deviceId: string,
  relayUrl: string,
): Promise<ControlOp> {
  if (!canMintControl(room, keys, deviceId)) {
    throw new Error("mintRehome: this device is not the room's owner");
  }
  if (!/^wss?:\/\/\S+$/.test(relayUrl)) {
    throw new Error("mintRehome: that is not a relay URL");
  }
  const input = controlSignatureInput("rehome", room.roomId, deviceId, { relayUrl });
  return { kind: "rehome", roomId: room.roomId, signer: deviceId, relayUrl, sig: await sign(keys.priv, input) };
}

// ─── Apply ─────────────────────────────────────────────────────────────────

async function verifyOp(room: Room, op: ControlOp): Promise<ControlReject | null> {
  if (!room.ownerPub) return "unknown-anchor";
  const owner = anchorOwner(room);
  if (owner === null) return "unknown-anchor";
  // Only the pinned owner may hold control authority. Checking the signer
  // before the signature keeps the reason honest and skips a needless verify.
  if (op.signer !== owner.deviceId) return "not-the-owner";
  // The body is derived from the op, never passed alongside it: a caller that
  // could hand over the op and its body separately could verify one shape and
  // apply another.
  let input: Uint8Array<ArrayBuffer>;
  try {
    input =
      op.kind === "roster-epoch"
        ? controlSignatureInput("roster-epoch", room.roomId, op.signer, {
            epoch: op.epoch,
            members: op.members,
          })
        : op.kind === "rotate-key"
          ? controlSignatureInput("rotate-key", room.roomId, op.signer, { keyGen: op.keyGen })
          : controlSignatureInput("rehome", room.roomId, op.signer, { relayUrl: op.relayUrl });
  } catch {
    return "bad-shape";
  }
  return (await verify(room.ownerPub, input, op.sig)) ? null : "not-the-owner";
}

/**
 * Verify and apply one control op.
 *
 * ── Why verification is OUTSIDE the transaction ──────────────────────────
 *
 * `verify` calls `crypto.subtle.verify`, whose promise is not backed by an
 * IndexedDB request. Awaiting one of those inside a Dexie transaction lets the
 * transaction auto-commit — Dexie's "Transaction committed too early" — because
 * IndexedDB commits when the microtask queue drains without a new request on
 * the transaction. Execution found this: three refusal tests and both rotation
 * paths failed with exactly that error before the split.
 *
 * Splitting is also the more honest shape. Every input to verification is
 * immutable for the life of a room: the roomId, the pinned `ownerPub`, the
 * anchor's owner deviceId, and the op's own bytes. Nothing that could make a
 * passed check wrong can change afterwards. What CAN move is staleness, and
 * that is re-read inside the transaction below, so two epochs arriving at once
 * cannot both win.
 */
export async function applyControlOp(
  db: OwlshelfDB,
  roomId: string,
  op: ControlOp,
): Promise<ControlResult> {
  if (op.roomId !== roomId) return { ok: false, reason: "wrong-room" };

  const pinned = await readRoom(db, roomId);
  if (!pinned) return { ok: false, reason: "wrong-room" };
  const rejection = await verifyOp(pinned, op);
  if (rejection !== null) return { ok: false, reason: rejection };

  return db.transaction("rw", db.meta, async (): Promise<ControlResult> => {
    const room = await readRoom(db, roomId);
    if (!room) return { ok: false, reason: "wrong-room" };

    if (op.kind === "roster-epoch") {
      // `adoptEpoch`, not `applyEpoch`: the signature is already checked, and
      // this half is synchronous by contract so it cannot commit the tx early.
      const result = adoptEpoch(room, { epoch: op.epoch, members: op.members, sig: op.sig });
      if (!result.ok) {
        return { ok: false, reason: result.reason === "stale-epoch" ? "stale" : "not-the-owner" };
      }
      await writeRoom(db, room);
      return { ok: true, applied: "roster-epoch" };
    }

    if (op.kind === "rotate-key") {
      // `keyGen` on the room is the generation it is CURRENTLY writing under,
      // and this op does not move it — only the owner's `revokeDevice` mints the
      // new key. So staleness is judged against `rotationPending` too: a notice
      // re-delivered by a reconnect must be a no-op, not a second "pending".
      if (op.keyGen <= room.keyGen) return { ok: false, reason: "stale" };
      if (room.rotationPending !== undefined && op.keyGen <= room.rotationPending) {
        return { ok: false, reason: "stale" };
      }
      // The generation is recorded; the KEY is not, and must never be — the new
      // key arrives out of band (§6.7 step 4). Minting stops immediately, which
      // is the whole point of the notice: continuing to write into a room no
      // one will read strands the edits with no diagnostic.
      room.rotationPending = op.keyGen;
      await writeRoom(db, room);
      return { ok: true, applied: "rotate-key" };
    }

    if (op.relayUrl === room.relayUrl) return { ok: false, reason: "stale" };
    // Staged, not applied: §6.7 makes repointing a room's relay a TRUST PROMPT,
    // because the owner can point every member at a host it controls. The UI
    // confirms; `confirmRehome` commits.
    room.pendingRelayUrl = op.relayUrl;
    await writeRoom(db, room);
    return { ok: true, applied: "rehome" };
  });
}

/** Accept a staged rehome. The only path that moves a room's relay URL. */
export async function confirmRehome(db: OwlshelfDB, roomId: string): Promise<boolean> {
  return db.transaction("rw", db.meta, async () => {
    const room = await readRoom(db, roomId);
    if (!room || !room.pendingRelayUrl) return false;
    room.relayUrl = room.pendingRelayUrl;
    delete room.pendingRelayUrl;
    await writeRoom(db, room);
    return true;
  });
}

/**
 * Refuse a staged rehome: clear the prompt without moving the URL.
 *
 * This is a write and it has to exist. A prompt with only "accept" is not a
 * choice — the flag would sit there forever, and a room that keeps asking a
 * question the user already answered is the UI equivalent of a stuck lock.
 */
export async function dismissRehome(db: OwlshelfDB, roomId: string): Promise<boolean> {
  return db.transaction("rw", db.meta, async () => {
    const room = await readRoom(db, roomId);
    if (!room || !room.pendingRelayUrl) return false;
    delete room.pendingRelayUrl;
    await writeRoom(db, room);
    return true;
  });
}
