/**
 * outbox.ts — the durable outbox and the DERIVED ack rule (plan §6.6).
 *
 * "Acked" is derived from peers' advertised cursors, never a delivery receipt,
 * and it is computed over the REACHABLE set, not the roster. That distinction
 * is the whole point: audit-4 D2/R4-P1-1 executed the roster version and found
 * one member absent for a week left 12,000 of 12,000 entries unacked, so every
 * resume re-sent 7.2 MB and the backlog grew without bound.
 *
 * Three sources of adoption proof, all of them cursors:
 *   1. the cursors a peer advertises in its catch-up requests,
 *   2. the responder cursors inside every catchup-reply end marker (audit-2 N8),
 *   3. audit high-water marks.
 *
 * A missing socket means "pending", never "dropped". Durability lives here; the
 * socket queue is only a transport buffer.
 */

import type { OwlshelfDB } from "./db";
import { readRoom, writeRoom } from "./roomMeta";
import type { OutboxEntry, Room } from "./stores";

/** A member unreachable longer than this stops blocking acks (§6.6). */
export const ACK_GRACE = 7 * 24 * 60 * 60 * 1000;

/** Bounded send batches on resume (§6.6). */
export const DRAIN_BATCH = 500;

/**
 * Enumerate every entry whose `state` is not acked.
 *
 * Via the plain `state` index, which is load-bearing: without it this query
 * throws SchemaError and the outbox never even enumerates (review-2 P0-4,
 * executed). The `[roomId+state]` compound index is the room-scoped form.
 */
export async function pendingOutbox(
  db: OwlshelfDB,
  roomId: string,
  limit: number = DRAIN_BATCH,
): Promise<OutboxEntry[]> {
  return db.outbox
    .where("[roomId+state]")
    .equals([roomId, "pending"])
    .limit(limit)
    .toArray();
}

/** Every non-acked entry for a room, regardless of state. */
export async function unackedOutbox(
  db: OwlshelfDB,
  roomId: string,
): Promise<OutboxEntry[]> {
  const rows = await db.outbox.where("roomId").equals(roomId).toArray();
  return rows.filter((row) => row.state !== "acked");
}

// ─── Adoption evidence ─────────────────────────────────────────────────────

/**
 * Record what a peer has ADOPTED from us, and that we heard from it.
 *
 * `cursors` is the peer's `{authorDeviceId → seq}` map. Merging is monotonic:
 * a cursor never moves backward, because a stale re-delivery must not un-ack
 * an entry that a later message already proved adopted.
 *
 * Does NOT touch the roster. It used to, via a dev stopgap that added any
 * device named in a sealed body — and that stopgap had to die: a device that
 * can write itself into its local roster can also write itself BACK after a
 * revocation, which defeats revocation entirely. The roster now changes only
 * when the OWNER signs an epoch (`rooms.ts`'s `admitDevice`, `control.ts`'s
 * `applyControlOp`).
 */
export async function recordPeerCursors(
  db: OwlshelfDB,
  roomId: string,
  peerDeviceId: string,
  cursors: Readonly<Record<string, number>>,
  now: number,
): Promise<void> {
  const room = await readRoom(db, roomId);
  if (!room) return;

  const peerCursors = { ...(room.peerCursors ?? {}) };
  const existing = { ...(peerCursors[peerDeviceId] ?? {}) };
  for (const [author, seq] of Object.entries(cursors)) {
    if (!Number.isInteger(seq) || seq < 0) continue;
    const current = existing[author] ?? 0;
    if (seq > current) existing[author] = seq;
  }
  peerCursors[peerDeviceId] = existing;

  room.peerCursors = peerCursors;
  room.lastSeen = { ...(room.lastSeen ?? {}), [peerDeviceId]: now };
  await writeRoom(db, room);
}

/** Record authenticated contact without any cursor evidence. */
export async function touchPeer(
  db: OwlshelfDB,
  roomId: string,
  peerDeviceId: string,
  now: number,
): Promise<void> {
  const room = await readRoom(db, roomId);
  if (!room) return;
  room.lastSeen = { ...(room.lastSeen ?? {}), [peerDeviceId]: now };
  await writeRoom(db, room);
}

// ─── The ack rule ──────────────────────────────────────────────────────────

export interface AckDecision {
  acked: boolean;
  /** Peers still blocking this entry, for the sync-status badge. */
  blockedBy: string[];
}

/**
 * Decide one entry against the room's current evidence.
 *
 * An entry is acked when it has been SENT at least once AND every roster member
 * other than its author is either:
 *   - reachable, and its cursor for the entry's author covers `authorSeq`;
 *   - unreachable longer than ACK_GRACE;
 *   - gone from the roster (pruned on roster change).
 *
 * `acked` claims "every peer provably has this". Before the first transport
 * attempt the opposite is certain — no peer has been given the chance — so an
 * entry with `attempts === 0` is never acked, not even in a single-device room
 * where the set of peers to wait for is empty. Without this the FIRST drain
 * tick acks every freshly minted op, `pendingOutbox` (state === "pending")
 * stops returning it, and the owner never announces anything it minted before
 * a peer made contact: the rows only ever arrive by catch-up. That was a live
 * symptom ("the device never announces the new change").
 *
 * The roster is the authority for WHO to wait for, and only the owner can
 * extend it (`rooms.ts`'s `admitDevice`). Nothing in this module mutates it.
 */
export function decideAck(
  entry: OutboxEntry,
  room: Room,
  now: number,
): AckDecision {
  if (entry.attempts === 0) return { acked: false, blockedBy: [] };

  const blockedBy: string[] = [];
  const lastSeen = room.lastSeen ?? {};
  const peerCursors = room.peerCursors ?? {};

  for (const member of room.roster) {
    if (member.deviceId === entry.deviceId) continue;

    const seenAt = lastSeen[member.deviceId];
    const reachable = seenAt !== undefined && now - seenAt <= ACK_GRACE;
    if (!reachable) continue;

    const adopted = peerCursors[member.deviceId]?.[entry.deviceId] ?? 0;
    if (adopted < entry.authorSeq) blockedBy.push(member.deviceId);
  }

  return { acked: blockedBy.length === 0, blockedBy };
}

/**
 * Flip every now-acked entry for a room. Returns the opIds that changed.
 *
 * Idempotent: an already-acked entry is skipped, so a resume that re-runs this
 * after a crash changes nothing.
 */
export async function evaluateAcks(
  db: OwlshelfDB,
  roomId: string,
  now: number,
): Promise<string[]> {
  const room = await readRoom(db, roomId);
  if (!room) return [];

  const entries = await unackedOutbox(db, roomId);
  const flipped: string[] = [];

  await db.transaction("rw", db.outbox, db.meta, async () => {
    for (const entry of entries) {
      if (!decideAck(entry, room, now).acked) continue;
      await db.outbox.put({ ...entry, state: "acked" });
      flipped.push(entry.opId);
    }
  });

  return flipped;
}

// ─── Drain ─────────────────────────────────────────────────────────────────

export interface DrainPlan {
  /** Entries to send, in authorSeq order so a peer's cursor advances. */
  send: OutboxEntry[];
  /** Entries that flipped to acked during this evaluation. */
  acked: string[];
  /** Entries still blocked, with the peers blocking them. */
  blocked: Array<{ opId: string; blockedBy: string[] }>;
}

/**
 * What to send on resume: evaluate acks first, then take a bounded batch.
 *
 * Ordering by `authorSeq` matters. A peer's cursor is CONTIGUOUS, so sending
 * seq 5 before seq 4 leaves 5 buffered in `pending` until 4 arrives — correct,
 * but it costs a round trip and a `pending` row per out-of-order op.
 */
export async function drainPlan(
  db: OwlshelfDB,
  roomId: string,
  now: number,
  limit: number = DRAIN_BATCH,
): Promise<DrainPlan> {
  const acked = await evaluateAcks(db, roomId, now);
  const room = await readRoom(db, roomId);
  if (!room) return { send: [], acked, blocked: [] };

  const pending = await pendingOutbox(db, roomId, limit);
  pending.sort((a, b) => {
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    return a.authorSeq - b.authorSeq;
  });

  const blocked: Array<{ opId: string; blockedBy: string[] }> = [];
  for (const entry of pending) {
    const decision = decideAck(entry, room, now);
    if (!decision.acked) blocked.push({ opId: entry.opId, blockedBy: decision.blockedBy });
  }

  return { send: pending, acked, blocked };
}

/** Mark one entry as attempted. `attempts` is diagnostic everywhere EXCEPT in
 *  `decideAck`, where a zero count means "never sent, therefore never acked". */
export async function noteAttempt(db: OwlshelfDB, opId: string): Promise<void> {
  const entry = await db.outbox.get(opId);
  if (!entry) return;
  await db.outbox.put({ ...entry, attempts: entry.attempts + 1 });
}
