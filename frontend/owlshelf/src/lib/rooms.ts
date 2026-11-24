/**
 * rooms.ts — pairing, joining, leaving, revoking (plan §6.7). WORKER ONLY.
 *
 * `createRoom` and `joinRoom` are the two call sites that BUILD the trust
 * anchor, which is why the QR minter takes a stored `Room` rather than loose
 * arguments: the pass-4 regression was a create path that referenced an unbound
 * room and an undefined anchor, so pairing could not run at all. Here the
 * anchor is signed and persisted BEFORE anything is returned, in the same
 * transaction as the room record.
 *
 * ── The dev stopgap this replaces ────────────────────────────────────────
 *
 * `roomShare.ts`'s export/import copied a room's key and roster between
 * origins with no signature and no anchor. It still exists for the offline
 * two-device test, but it is no longer the pairing story: `joinRoom` verifies a
 * signed anchor, and `outbox.ts`'s `admitPeerToRoster` — which let any device
 * write itself into its local roster, and therefore defeat revocation — is
 * gone. A device joins a roster only when the OWNER signs an epoch naming it.
 *
 * ── Rotation keeps the roomId ────────────────────────────────────────────
 *
 * §6.7 calls rotation "effectively a new room" because a new key is a new relay
 * hash. The LOCAL identity does not change: `roomId` stays, `profileId` stays
 * equal to it (§6.1's rule that a remap would orphan the profile from its room),
 * and the op log stays — it is keyed by roomId, not by generation. So a
 * rotation changes the key, bumps `keyGen`, and snapshots the OLD generation
 * into `meta["notice:<roomId>:<gen>"]` so the owner can serve the notice from
 * the old hash for `ROTATE_NOTICE_WINDOW`.
 */

import type { OwlshelfDB } from "./db";
import { bytesToB64url, getDeviceKeys, sign, type DeviceKeys } from "./keys";
import { parseJoinFragment, type JoinFragment, type JoinReject } from "./pairing";
import { mintEpoch, sortMembers, verifyEpoch } from "./roster";
import { listRooms, readRoom, roomMetaKey, writeRoom } from "./roomMeta";
import { CommandError } from "./cmd";
import { mintRotateKey, type ControlOp } from "./control";
import type { Profile } from "../types/item";
import type { RoomReject } from "./pairingErrors";
import type { Room, RosterMember } from "./stores";

/** §6.7 step 3: how long the owner serves the rotation notice from the old
 *  hash. 30 days, per the plan. */
export const ROTATE_NOTICE_WINDOW = 30 * 24 * 60 * 60 * 1000;

export interface RoomDeps {
  db: OwlshelfDB;
  getDeviceId: () => Promise<string>;
  keys?: DeviceKeys;
  now?: () => number;
  uuid?: () => string;
  random?: (bytes: number) => Uint8Array;
}

async function resolve(deps: RoomDeps): Promise<{
  db: OwlshelfDB;
  deviceId: string;
  keys: DeviceKeys;
  now: number;
  uuid: () => string;
  random: (bytes: number) => Uint8Array;
}> {
  return {
    db: deps.db,
    deviceId: await deps.getDeviceId(),
    keys: deps.keys ?? (await getDeviceKeys(deps.db)),
    now: (deps.now ?? Date.now)(),
    uuid: deps.uuid ?? (() => crypto.randomUUID()),
    random: deps.random ?? ((bytes: number) => crypto.getRandomValues(new Uint8Array(bytes))),
  };
}

function nanoid(random: (bytes: number) => Uint8Array, len = 10): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = random(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** `roomId` is the profile id is the room id (§6.1). 8-char device prefix +
 *  nanoid, so two devices minting at the same moment cannot collide and a human
 *  reading a log can tell which device made the room. */
export function mintRoomId(deviceId: string, random: (bytes: number) => Uint8Array): string {
  return `${deviceId.replace(/-/g, "").slice(0, 8)}-${nanoid(random)}`;
}

// ─── Create ────────────────────────────────────────────────────────────────

export interface CreateRoomInput {
  relayUrl: string | null;
  name: string;
  type: "personal" | "business";
  avatarEmoji: string;
}

/**
 * §6.7 create, in order: mint the id and key, sign epoch 1, persist COMPLETE
 * room metadata, then write the profile row — one transaction, so a crash never
 * leaves a profile without its room or a room that cannot be paired.
 */
export async function createRoom(
  input: CreateRoomInput,
  deps: RoomDeps,
): Promise<{ room: Room; profile: Profile }> {
  const { db, deviceId, keys, now, random } = await resolve(deps);

  const roomId = mintRoomId(deviceId, random);
  const roomKey = bytesToB64url(random(32));
  const members: RosterMember[] = [{ deviceId, role: "owner", addedAt: now }];
  const anchor = await mintEpoch(roomId, deviceId, keys.priv, 1, members);

  const room: Room = {
    roomId,
    profileId: roomId,
    relayUrl: input.relayUrl && input.relayUrl.trim() !== "" ? input.relayUrl.trim() : null,
    keyGen: 1,
    roomKey,
    roster: anchor.members,
    cursorIn: {},
    nextAuthorSeq: 1,
    clock: { ts: 0, counter: 0 },
    migration: "promoted",
    createdAt: now,
    ownerPub: keys.pub,
    rosterAnchor: anchor,
    rosterEpoch: 1,
    rosterChain: [anchor],
  };
  const profile: Profile = {
    id: roomId,
    name: input.name,
    type: input.type,
    avatarEmoji: input.avatarEmoji,
  };

  await db.transaction("rw", db.meta, db.profiles, async () => {
    await writeRoom(db, room);
    // Row tables carry the reducer-owned tombstone column; a live row says so
    // explicitly (audit R4-P2-1's absent-field trap).
    await db.table("profiles").put({ ...profile, deletedAt: null });
  });

  return { room, profile };
}

// ─── Repair: rooms that predate the roster anchor ──────────────────────────

export type RepairOutcome =
  | "repaired" // we signed epoch 1 and persisted it
  | "has-roster" // nothing to do — already anchored
  | "not-this-device"; // pinned to ANOTHER owner: signing would be a forgery

/**
 * Give a room that has no signed roster an epoch-1 anchor, or say why not.
 *
 * Rooms created before `createRoom` minted anchors — and every room written by
 * the deleted `newRoom`/`createProfile` paths — carry a key and an id but no
 * `ownerPub` and no anchor. `mintJoinFragment` must refuse those (an invite
 * with no pin lets any member claim ownership), so the owner saw "cannot share"
 * with no way out. This is the way out, and it is safe for one reason:
 *
 *   a room with no `ownerPub` was NEVER joinable — `joinRoom` requires the
 *   fragment's `o`, and no code path can produce `o` from an anchorless room —
 *   so the only device that can hold it is the one that made it.
 *
 * The one case this must NOT touch is a room pinned to a different owner with
 * its anchor missing: signing that roster would mint a forgery in the owner's
 * name. It reports `not-this-device` and the share dialog says so.
 *
 * The signature is minted BEFORE the transaction (WebCrypto cannot run inside
 * an IndexedDB request), and only the room record is written — `keyGen`, the
 * key, the cursors and the op log are untouched, so a repair cannot rotate a
 * room or lose history.
 */
async function repairOne(
  room: Room,
  ctx: { db: OwlshelfDB; deviceId: string; keys: DeviceKeys; now: number },
): Promise<RepairOutcome> {
  if (room.rosterAnchor) return "has-roster";
  if (typeof room.ownerPub === "string" && room.ownerPub !== ctx.keys.pub) return "not-this-device";

  // Keep the members the room already knows about: a room that had admitted a
  // peer before losing its anchor must not silently drop that peer. A stale
  // owner row is replaced by THIS device, because that is who is signing.
  const kept: RosterMember[] =
    Array.isArray(room.roster) && room.roster.length > 0
      ? room.roster.map((member) =>
          member.role === "owner" ? { ...member, deviceId: ctx.deviceId } : member,
        )
      : [];
  // An anchor with no owner is unverifiable (`ownerOf` returns null and every
  // joiner refuses it), so a roster that somehow lost its owner row gets this
  // device as owner rather than being signed into an invalid epoch.
  const members: RosterMember[] = kept.some((member) => member.role === "owner")
    ? kept
    : [{ deviceId: ctx.deviceId, role: "owner", addedAt: ctx.now }, ...kept];

  const anchor = await mintEpoch(room.roomId, ctx.deviceId, ctx.keys.priv, 1, members);

  await writeRoom(ctx.db, {
    ...room,
    keyGen: Number.isInteger(room.keyGen) && room.keyGen >= 1 ? room.keyGen : 1,
    ownerPub: room.ownerPub ?? ctx.keys.pub,
    roster: anchor.members,
    rosterAnchor: anchor,
    rosterEpoch: 1,
    rosterChain: [anchor],
  });
  return "repaired";
}

export async function repairRoom(room: Room, deps: RoomDeps): Promise<RepairOutcome> {
  return repairOne(room, await resolve(deps));
}

/** Repair every anchorless room on this device. Returns the ids it fixed. */
export async function repairRosters(deps: RoomDeps): Promise<string[]> {
  const rooms = await listRooms(deps.db);
  if (!rooms.some((room) => !room.rosterAnchor)) return [];
  // One key read and one deviceId read for the whole pass: the anchor is signed
  // per room, but nothing about the signing identity changes between rooms.
  const ctx = await resolve(deps);
  const fixed: string[] = [];
  for (const room of rooms) {
    if ((await repairOne(room, ctx)) === "repaired") fixed.push(room.roomId);
  }
  return fixed;
}

// ─── Join ──────────────────────────────────────────────────────────────────

export type JoinRoomResult =
  | { ok: true; room: Room }
  | { ok: false; reason: JoinReject | RoomReject };

/**
 * §6.7 join, in order: refuse if THIS room already exists with data, adopt the
 * QR's key and generation (never hardcoded), pin its anchor, and write the
 * profile row.
 *
 * The joiner is NOT added to its own roster. That is not an oversight: the
 * roster's only authority is the owner's signature, and a device that could
 * write itself in could also write itself back after a revocation. Until the
 * owner's signed epoch arrives, this device's roster is the anchor's members —
 * which is enough for the ack rule to work in the right direction.
 */
export async function joinRoom(
  text: string,
  deps: RoomDeps & { profileName?: string },
): Promise<JoinRoomResult> {
  const parsed = parseJoinFragment(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const fragment: JoinFragment = parsed.fragment;

  // The anchor must be self-consistent before anything is persisted: epoch 1,
  // exactly one owner, a signature field. Cryptographic verification against
  // the pinned key happens on the first epoch that arrives, and on every one
  // after — a joiner cannot verify epoch 1 against itself without already
  // trusting it, which is the point of a pin.
  const { db, deviceId, now } = await resolve(deps);

  const existing = await readRoom(db, fragment.roomId);
  if (existing) {
    const [ops, items, locations] = await Promise.all([
      db.ops.where("roomId").equals(fragment.roomId).count(),
      db.items.where("profileId").equals(fragment.roomId).count(),
      db.locations.where("profileId").equals(fragment.roomId).count(),
    ]);
    if (ops > 0 || items > 0 || locations > 0) return { ok: false, reason: "room-exists" };
  }

  const room: Room = {
    roomId: fragment.roomId,
    profileId: fragment.roomId,
    relayUrl: fragment.relayUrl,
    // FROM THE QR, never hardcoded (review-2 P0-1).
    keyGen: fragment.keyGen,
    roomKey: fragment.roomKey,
    roster: sortMembers(fragment.anchor.members),
    // Empty cursors: the join's whole point is a full catch-up.
    cursorIn: {},
    // A fresh authorSeq space — this device's own, never the owner's.
    nextAuthorSeq: 1,
    clock: { ts: 0, counter: 0 },
    migration: "promoted",
    createdAt: now,
    ownerPub: fragment.ownerPub,
    rosterAnchor: fragment.anchor,
    rosterEpoch: 1,
    rosterChain: [fragment.anchor],
  };

  await db.transaction("rw", db.meta, db.profiles, async () => {
    await writeRoom(db, room);
    await db.table("profiles").put({
      id: fragment.roomId,
      name: deps.profileName ?? "Shared shelf",
      type: "personal",
      avatarEmoji: "👤",
      deletedAt: null,
    });
  });

  // `deviceId` is read for its side effect: it mints the local identity on
  // first join, so the first minted op has a device to attribute it to even if
  // the user never creates a room of their own.
  void deviceId;
  return { ok: true, room };
}

// ─── Re-pair: the same room at a NEW generation (§6.7 step 4) ──────────────

export type RejoinResult =
  | { ok: true; room: Room }
  | { ok: false; reason: JoinReject | RoomReject };

/**
 * Adopt a rotation code for a room this device ALREADY holds.
 *
 * `joinRoom` refuses a room that has data (§6.7 join step 1, N10) — and after a
 * rotation every surviving member has data, so re-pairing cannot be a join. It
 * is the same operation with three differences, and each is a rule, not a
 * convenience:
 *
 *  - **A newer generation is required.** A stale QR must not downgrade a device
 *    to a generation the room has left; `same-generation` is the refusal.
 *  - **The owner is PINNED, not re-read.** The fragment's `ownerPub` must equal
 *    the one this device already trusts, and the anchor must verify against it.
 *    A member who holds the room key can mint a fragment, but not this one.
 *  - **The epoch-1 anchor must be unchanged.** §6.7 makes the anchor immutable:
 *    a different epoch-1 signature for the same roomId means a re-anchored
 *    history, which is the one thing a re-pair must never accept.
 *
 * Cursors and the author sequence are KEPT: the log is keyed by roomId and the
 * rotation does not renumber it, so a re-paired member resumes where it stopped
 * rather than re-downloading the history it already has (§8.4).
 */
export async function rejoinRoom(text: string, deps: RoomDeps): Promise<RejoinResult> {
  const parsed = parseJoinFragment(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const fragment: JoinFragment = parsed.fragment;

  const room = await readRoom(deps.db, fragment.roomId);
  if (!room) return { ok: false, reason: "no-room" };
  if (!room.ownerPub) return { ok: false, reason: "anchor-unverified" };
  if (fragment.ownerPub !== room.ownerPub) return { ok: false, reason: "owner-changed" };

  const pinnedOwner = room.rosterAnchor?.members.find((member) => member.role === "owner");
  const incomingOwner = fragment.anchor.members.find((member) => member.role === "owner");
  if (!pinnedOwner || !incomingOwner) return { ok: false, reason: "anchor-unverified" };
  if (incomingOwner.deviceId !== pinnedOwner.deviceId) {
    return { ok: false, reason: "owner-changed" };
  }
  if (room.rosterAnchor && room.rosterAnchor.sig !== fragment.anchor.sig) {
    return { ok: false, reason: "anchor-unverified" };
  }

  // `verifyEpoch` calls `crypto.subtle`, whose promise is not an IndexedDB
  // request: awaiting it inside a Dexie transaction commits the transaction
  // early and loses the write. Verify FIRST, then open one transaction.
  const rejection = await verifyEpoch(
    room.roomId,
    room.ownerPub,
    pinnedOwner.deviceId,
    fragment.anchor,
  );
  if (rejection !== null) return { ok: false, reason: "anchor-unverified" };

  if (fragment.keyGen <= room.keyGen) return { ok: false, reason: "same-generation" };

  const next: Room = {
    ...room,
    relayUrl: fragment.relayUrl,
    keyGen: fragment.keyGen,
    roomKey: fragment.roomKey,
    // The anchor's members, not the surviving set: epochs that arrived after
    // the rotation are the authority on membership, and they continue from the
    // same counter because the roomId never changed.
    roster: sortMembers(fragment.anchor.members),
    rosterAnchor: room.rosterAnchor ?? fragment.anchor,
    rosterChain: mergeChain(room.rosterChain, fragment.anchor),
  };
  // The room is usable again: the notice's whole effect was "stop minting until
  // you are re-paired", and this is the re-pair.
  delete next.rotationPending;

  await deps.db.transaction("rw", deps.db.meta, async () => {
    await writeRoom(deps.db, next);
  });

  return { ok: true, room: next };
}

/** Anchor + every epoch already seen, one per epoch, sorted. */
function mergeChain(
  chain: readonly { epoch: number; members: RosterMember[]; sig: string }[] | undefined,
  anchor: { epoch: number; members: RosterMember[]; sig: string },
): Array<{ epoch: number; members: RosterMember[]; sig: string }> {
  const byEpoch = new Map<number, { epoch: number; members: RosterMember[]; sig: string }>();
  for (const epoch of chain ?? []) byEpoch.set(epoch.epoch, epoch);
  byEpoch.set(anchor.epoch, anchor);
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

// ─── The roster grows by signature, not by contact ─────────────────────────

export type AdmitResult =
  | { ok: true; op: ControlOp; room: Room }
  | { ok: false; reason: "not-the-owner" | "already-a-member" | "unknown-room" };

/**
 * Add a device to the roster — OWNER ONLY, by minting epoch + 1.
 *
 * Called when this device authenticates contact from a peer it does not know.
 * The peer cannot do this for itself (that was the stopgap this replaces), so
 * the owner is the only path in. Being automatic on authenticated contact is
 * deliberate: possession of the room key is already the membership credential,
 * and revocation is key rotation (§6.7) — so adding a key-holder to the
 * bookkeeping changes no access, it only lets the ack rule wait for them.
 *
 * Returns the signed op so the caller can broadcast it; a peer that misses the
 * broadcast does not lose access, it just does not appear in anyone's roster
 * until the next epoch.
 */
export async function admitDevice(
  roomId: string,
  peerDeviceId: string,
  deps: RoomDeps,
): Promise<AdmitResult> {
  const { db, deviceId, keys, now } = await resolve(deps);
  const room = await readRoom(db, roomId);
  if (!room) return { ok: false, reason: "unknown-room" };
  if (room.ownerPub !== keys.pub) return { ok: false, reason: "not-the-owner" };
  if (room.roster.some((member) => member.deviceId === peerDeviceId)) {
    return { ok: false, reason: "already-a-member" };
  }
  if (peerDeviceId === deviceId) return { ok: false, reason: "already-a-member" };

  const members = [...room.roster, { deviceId: peerDeviceId, role: "member" as const, addedAt: now }];
  const epoch = await mintEpoch(room.roomId, deviceId, keys.priv, (room.rosterEpoch ?? 1) + 1, members);

  await db.transaction("rw", db.meta, async () => {
    const fresh = await readRoom(db, roomId);
    if (!fresh) return;
    if (fresh.roster.some((member) => member.deviceId === peerDeviceId)) return;
    fresh.roster = epoch.members;
    fresh.rosterEpoch = epoch.epoch;
    fresh.rosterChain = [...(fresh.rosterChain ?? []), epoch].sort((a, b) => a.epoch - b.epoch);
    await writeRoom(db, fresh);
  });

  const updated = (await readRoom(db, roomId)) ?? room;
  return {
    ok: true,
    room: updated,
    op: {
      kind: "roster-epoch",
      roomId: room.roomId,
      signer: deviceId,
      epoch: epoch.epoch,
      members: epoch.members,
      sig: epoch.sig,
    },
  };
}

// ─── Revoke → rotate → re-pair ─────────────────────────────────────────────

export interface RevokeResult {
  ok: true;
  /** The signed notice to post into the OLD room before leaving it. */
  notice: ControlOp;
  /** The room at its NEW generation. Its key is NOT in the notice. */
  room: Room;
  /** What to keep so the old hash can still serve the notice. */
  oldGeneration: { roomId: string; keyGen: number; roomKey: string; relayUrl: string | null; expiresAt: number };
}

/**
 * §6.7 revocation: roster-epoch + 1 with the target removed, then rotate the key.
 *
 * Owner only. The new key is generated HERE and never travels in the notice —
 * the notice carries the generation only, which is what lets it be served from
 * the old room for 30 days without a key grace window.
 */
export async function revokeDevice(
  roomId: string,
  targetDeviceId: string,
  deps: RoomDeps,
): Promise<RevokeResult | { ok: false; reason: RoomReject }> {
  const { db, deviceId, keys, now, random } = await resolve(deps);
  const room = await readRoom(db, roomId);
  if (!room) return { ok: false, reason: "unknown-room" };
  if (room.ownerPub !== keys.pub) return { ok: false, reason: "not-the-owner" };
  if (targetDeviceId === deviceId) return { ok: false, reason: "cannot-remove-the-owner" };
  const target = room.roster.find((member) => member.deviceId === targetDeviceId);
  if (!target) return { ok: false, reason: "not-a-member" };

  const survivors = room.roster.filter((member) => member.deviceId !== targetDeviceId);
  const epoch = await mintEpoch(room.roomId, deviceId, keys.priv, (room.rosterEpoch ?? 1) + 1, survivors);
  const notice = await mintRotateKey(room, keys, deviceId, room.keyGen + 1);

  // A rotation that mints the SAME key is not a rotation, and the revocation it
  // is supposed to enforce would silently not happen. A real CSPRNG never
  // repeats 32 bytes; a broken or stubbed one can, so this refuses instead of
  // shipping a revocation that leaves the old key live.
  const rotatedKey = bytesToB64url(random(32));
  if (rotatedKey === room.roomKey) {
    throw new CommandError("internal", "rotate-key produced the current key — refusing to revoke");
  }

  const next: Room = {
    ...room,
    keyGen: room.keyGen + 1,
    roomKey: rotatedKey,
    roster: epoch.members,
    rosterEpoch: epoch.epoch,
    rosterChain: [...(room.rosterChain ?? []), epoch].sort((a, b) => a.epoch - b.epoch),
  };
  delete next.rotationPending;
  delete next.pendingRelayUrl;

  const oldGeneration = {
    roomId: room.roomId,
    keyGen: room.keyGen,
    roomKey: room.roomKey,
    relayUrl: room.relayUrl,
    expiresAt: now + ROTATE_NOTICE_WINDOW,
  };

  await db.transaction("rw", db.meta, async () => {
    await writeRoom(db, next);
    // The old generation, kept ALIVE and separate: the old hash must keep
    // answering for ROTATE_NOTICE_WINDOW so a member offline at rotation time
    // learns it must re-pair instead of minting into a room nobody reads.
    await db.meta.put({
      key: `notice:${room.roomId}:${room.keyGen}`,
      ...oldGeneration,
    });
  });

  return { ok: true, notice, room: next, oldGeneration };
}

// ─── Leave (the exact purge set, §15.17) ──────────────────────────────────

/** Meta key holding a leaver's signed statement, which must survive the purge. */
export function leaveKey(roomId: string): string {
  return `leave:${roomId}`;
}

/**
 * §15.17's purge set, and the ONE ordering rule it exists to protect: the
 * statement that proves this device left is written FIRST and lives OUTSIDE the
 * purged log, so an offline leave can always complete. A purge that deleted its
 * own durability is the bug this ordering prevents.
 *
 * The statement is signed but carries no authority — a leave is not in §6.4's
 * closed control union, so it cannot be a control op. It is evidence, and it is
 * kept until an owner-signed epoch removes this device.
 */
export async function leaveRoom(roomId: string, deps: RoomDeps): Promise<void> {
  const { db, deviceId, keys, now } = await resolve(deps);
  const room = await readRoom(db, roomId);
  if (!room) throw new CommandError("validation", `Room ${roomId} is not on this device.`);
  if (room.roster.some((member) => member.role === "owner" && member.deviceId === deviceId)) {
    throw new CommandError(
      "validation",
      "You own this room. Removing your own device would leave it unmanageable.",
    );
  }

  // The statement is signed BEFORE the transaction opens: `sign` calls
  // `crypto.subtle`, whose promise is not an IndexedDB request, so awaiting it
  // inside the transaction lets the transaction auto-commit ("Transaction
  // committed too early"). Nothing about the statement depends on the purge, so
  // the reordering costs nothing and removes the hazard.
  const statement = {
    key: leaveKey(roomId),
    roomId,
    deviceId,
    at: now,
    sig: await sign(keys.priv, new TextEncoder().encode(`leave\n${roomId}\n${deviceId}\n${now}`)),
  };

  await db.transaction(
    "rw",
    [
      db.meta,
      db.profiles,
      db.locations,
      db.items,
      db.ops,
      db.outbox,
      db.pending,
      db.quarantine,
      db.files,
      db.snapshots,
    ],
    async () => {
      // 1. Durability of the leave, outside everything purged below. It is the
      //    FIRST write in the transaction so a crash mid-purge cannot take it
      //    with it — the ordering is the durability, not the statement.
      await db.meta.put(statement);

      // 2. The purge set: the profile row (it IS the room on this device), all
      //    three row tables, the log and its derived stores, media, snapshots,
      //    and the room meta record.
      await db.profiles.delete(roomId);
      await db.items.where("profileId").equals(roomId).delete();
      await db.locations.where("profileId").equals(roomId).delete();
      await db.ops.where("roomId").equals(roomId).delete();
      // `pending`/`quarantine`/`files` are keyed by a COMPOUND primary key whose
      // first component is the roomId, and Dexie cannot range-scan a compound
      // PK by prefix without a sentinel it does not export. `outbox` is keyed by
      // `opId` and indexed only by `[roomId+state]`, so it has no range to scan
      // either. `filter` is a full scan and that is fine: a leave is a
      // once-per-room user action, and an obviously-correct scan beats a
      // sentinel that silently deletes too much.
      await db.outbox.filter((row) => row.roomId === roomId).delete();
      await db.pending.filter((row) => row.roomId === roomId).delete();
      await db.quarantine.filter((row) => row.roomId === roomId).delete();
      await db.files.filter((row) => row.roomId === roomId).delete();
      await db.snapshots.delete(roomId);
      await db.meta.delete(roomMetaKey(roomId));
      // The old-generation notice records belong to the room being left.
      const noticeKeys = await db.meta.where("key").startsWith(`notice:${roomId}:`).primaryKeys();
      for (const key of noticeKeys) await db.meta.delete(key);
    },
  );
}
