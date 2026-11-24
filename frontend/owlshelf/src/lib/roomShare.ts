/**
 * roomShare.ts — the dev-only room hand-off (plan §13, Gate G).
 *
 * NOT §6.7's pairing. This carries no roster anchor, no owner signature, and no
 * revocation story — it is exactly what two devices need to decrypt each
 * other's envelopes, so op convergence can be tested before step 6 exists.
 * Treat the payload as a secret: it contains the room key in the clear, which
 * is equally true of the real QR fragment.
 *
 * ── Why this is a lib module and not a dev one ────────────────────────────
 *
 * `importRoom` WRITES: a `room:` meta row and a `profiles` row, in one
 * transaction. §5 says the worker is the single writer, so this cannot live in
 * the tab any more — it moved here when the engine did, and the dev panel now
 * reaches it through `dev-import-room`. `exportRoom` is a pure read but travels
 * with it, because splitting the pair across the thread boundary would be
 * worse than moving both.
 *
 * Refusals throw `CommandError("validation", …)` so the message survives the
 * port unchanged: `toWorkerError` keeps the code, and the panel shows the text.
 */

import { CommandError } from "./cmd";
import { roomKeyBytes } from "./envelope";
import { readRoom, writeRoom } from "./roomMeta";
import type { OwlshelfDB } from "./db";
import type { Room, RosterMember } from "./stores";

/**
 * The dev-only room-sharing payload.
 *
 * NOT §6.7's QR: no roster anchor, no owner signature, no revocation. It is
 * exactly what two devices need to decrypt each other's envelopes, so op
 * convergence can be tested before step 6 exists. It contains the room key in
 * the clear — as the real QR fragment does — so treat it as a secret.
 */
export interface RoomExport {
  v: 1;
  roomId: string;
  relayUrl: string | null;
  keyGen: number;
  roomKey: string;
  roster: RosterMember[];
  profile: { name: string; type: string; avatarEmoji: string };
}

/** Serialise one room for pasting into another origin. */
export async function exportRoom(db: OwlshelfDB, roomId: string): Promise<string | null> {
  const room = await readRoom(db, roomId);
  if (!room) return null;
  const profileRow = (await db.profiles.get(roomId)) as
    | { name?: string; type?: string; avatarEmoji?: string }
    | undefined;
  const payload: RoomExport = {
    v: 1,
    roomId: room.roomId,
    relayUrl: room.relayUrl,
    keyGen: room.keyGen,
    roomKey: room.roomKey,
    roster: room.roster,
    profile: {
      name: profileRow?.name ?? "Shared shelf",
      type: profileRow?.type ?? "personal",
      avatarEmoji: profileRow?.avatarEmoji ?? "👤",
    },
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Adopt an exported room on this device.
 *
 * Refuses when the room already exists locally WITH data (§6.7 join step 1): a
 * device legitimately holds several rooms, so an unrelated room is not a merge
 * hazard, but re-importing over a populated one would remap nothing and
 * silently fork the authorSeq space.
 */
export async function importRoom(
  db: OwlshelfDB,
  getDeviceId: () => Promise<string>,
  text: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CommandError("validation", "Import failed: not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CommandError("validation", "Import failed: expected an object.");
  }
  const raw = parsed as Record<string, unknown>;

  if (raw.v !== 1) {
    throw new CommandError("validation", "Import failed: unsupported version.");
  }
  const roomId = raw.roomId;
  if (typeof roomId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) {
    throw new CommandError("validation", "Import failed: bad roomId.");
  }
  const roomKey = raw.roomKey;
  if (typeof roomKey !== "string") {
    throw new CommandError("validation", "Import failed: missing roomKey.");
  }
  try {
    // Throws unless it decodes to exactly 32 bytes — the same check the
    // sealing path applies, so a truncated key fails here, not at first send.
    roomKeyBytes(roomKey);
  } catch {
    throw new CommandError("validation", "Import failed: roomKey is not 32 bytes.");
  }
  const keyGen = raw.keyGen;
  if (typeof keyGen !== "number" || !Number.isInteger(keyGen) || keyGen < 1) {
    throw new CommandError("validation", "Import failed: bad keyGen.");
  }
  const relayUrl = typeof raw.relayUrl === "string" ? raw.relayUrl : null;

  const existing = await readRoom(db, roomId);
  if (existing) {
    const [ops, items] = await Promise.all([
      db.ops.where("roomId").equals(roomId).count(),
      db.items.where("profileId").equals(roomId).count(),
    ]);
    if (ops > 0 || items > 0) {
      throw new CommandError(
        "validation",
        `Import refused: room ${roomId} already exists here with data.`,
      );
    }
  }

  const deviceId = await getDeviceId();
  const now = Date.now();
  const exportedRoster = Array.isArray(raw.roster) ? (raw.roster as RosterMember[]) : [];
  const roster = exportedRoster.filter((m) => m.deviceId !== deviceId);
  roster.push({ deviceId, role: "member", addedAt: now });

  const profileRaw = (raw.profile ?? {}) as Record<string, unknown>;
  const room: Room = {
    roomId,
    profileId: roomId,
    relayUrl,
    keyGen,
    roomKey,
    roster,
    // Empty cursors: the join's whole point is a full catch-up.
    cursorIn: {},
    // A fresh authorSeq space — this device's own, never the exporter's.
    nextAuthorSeq: 1,
    clock: { ts: 0, counter: 0 },
    migration: "promoted",
    createdAt: now,
  };

  await db.transaction("rw", db.meta, db.profiles, async () => {
    await writeRoom(db, room);
    // `db.table(...)` rather than `db.profiles`: the typed table declares only
    // `{ id }`, and `createProfile` writes through the same untyped handle for
    // the same reason.
    await db.table("profiles").put({
      id: roomId,
      name: typeof profileRaw.name === "string" ? profileRaw.name : "Shared shelf",
      type: profileRaw.type === "business" ? "business" : "personal",
      avatarEmoji: typeof profileRaw.avatarEmoji === "string" ? profileRaw.avatarEmoji : "👤",
      deletedAt: null,
    });
  });
}

/** Persist a relay URL onto a room. `connect()` gates on this field. */
export async function setRoomRelayUrl(
  db: OwlshelfDB,
  roomId: string,
  url: string,
): Promise<void> {
  const room = await readRoom(db, roomId);
  if (!room) return;
  await writeRoom(db, { ...room, relayUrl: url.trim() === "" ? null : url.trim() });
}
