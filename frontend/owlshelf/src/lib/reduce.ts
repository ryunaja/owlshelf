/**
 * reduce.ts — the ONE reducer, for local and remote ops (plan §6.4).
 * WORKER ONLY.
 *
 * Everything here is a pure function of op content plus the persisted room
 * record, so every device holding the same op set computes the same winner:
 * convergence by construction. Three rules carry most of the weight:
 *
 *  - The total order is `(hlcTs, hlcCounter, typeRank, deviceId, opId)` —
 *    never arrival order, never a wall-clock window. typeRank is put 0,
 *    delete 1, resolve 2, so a delete still wins its equal-clock tie and a
 *    user's race decision always terminates the race at equal clock.
 *  - A rejected op still occupies its sequence slot. The cursor advances over
 *    ADOPTED and QUARANTINED slots alike; a cursor that advanced only over
 *    adopted ops let one buggy mint silence a device for its whole room
 *    (audit-4 D1/R4-P0-1, executed).
 *  - Dedup runs BEFORE the clock check. Dedup needs no clock, and a
 *    re-delivered duplicate whose stamp has drifted beyond skew must still
 *    reach the cursor — "dup delivery is the repair path" dies if the clock
 *    check runs first (audit-4 R4-P2-2).
 */

import type { OwlshelfDB } from "./db";
import { receiveHlc, type Hlc } from "./hlc";
import { normalizePayload } from "./payload";
import { readRoom, writeRoom } from "./roomMeta";
import {
  ROW_TABLES,
  type OpType,
  type QuarantineEntry,
  type Room,
  type RowOp,
  type RowTable,
} from "./stores";

// ─── Total order ───────────────────────────────────────────────────────────

export const TYPE_RANK: Record<OpType, number> = { put: 0, delete: 1, resolve: 2 };

export interface OrderKey {
  ts: number;
  counter: number;
  rank: number;
  deviceId: string;
  opId: string;
}

export function orderKey(op: RowOp): OrderKey {
  return {
    ts: op.hlcTs,
    counter: op.hlcCounter,
    rank: TYPE_RANK[op.type],
    deviceId: op.deviceId,
    opId: op.opId,
  };
}

/** The `winner` column's format (stores.ts `SyncColumns`). */
export function winnerKey(op: RowOp): string {
  return `${op.hlcTs}:${op.hlcCounter}:${TYPE_RANK[op.type]}:${op.deviceId}:${op.opId}`;
}

export function parseWinnerKey(key: string | null | undefined): OrderKey | null {
  if (!key) return null;
  const parts = key.split(":");
  if (parts.length < 5) return null;
  const [ts, counter, rank, deviceId, ...rest] = parts;
  const opId = rest.join(":");
  const numeric = (value: string): number => (/^\d+$/.test(value) ? Number(value) : Number.NaN);
  const parsedTs = numeric(ts);
  const parsedCounter = numeric(counter);
  const parsedRank = numeric(rank);
  if (!Number.isFinite(parsedTs) || !Number.isFinite(parsedCounter) || !Number.isFinite(parsedRank)) {
    return null;
  }
  return { ts: parsedTs, counter: parsedCounter, rank: parsedRank, deviceId, opId };
}

export function compareOrder(a: OrderKey, b: OrderKey): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.opId !== b.opId) return a.opId < b.opId ? -1 : 1;
  return 0;
}

export function compareOps(a: RowOp, b: RowOp): number {
  return compareOrder(orderKey(a), orderKey(b));
}

// ─── Errors ────────────────────────────────────────────────────────────────

/** An op may only ever touch a row of its OWN room. A cross-room rowId is a
 *  probe, not an edit (review-2 P0-7). */
export class CrossRoomError extends Error {
  op: RowOp;

  constructor(op: RowOp) {
    super(`reduce: op ${op.opId} targets a row outside room ${op.roomId}`);
    this.name = "CrossRoomError";
    this.op = op;
  }
}

/** A payload that fails §15.3 validation. Rejected before any write. */
export class MalformedPayloadError extends Error {
  op: RowOp;

  constructor(op: RowOp) {
    super(`reduce: op ${op.opId} carries a malformed ${op.table}/${op.type} payload`);
    this.name = "MalformedPayloadError";
    this.op = op;
  }
}

// ─── Room identity ─────────────────────────────────────────────────────────

/** Profiles are keyed by roomId; every other row carries `profileId`. */
export function belongsToRoom(table: RowTable, row: Record<string, unknown>, roomId: string): boolean {
  if (table === "profiles") return row.id === roomId;
  return row.profileId === roomId;
}

// ─── Materialization ───────────────────────────────────────────────────────

function tombstoneOf(op: RowOp, row: Record<string, unknown> | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = row ? { ...row } : { id: op.rowId };
  // A tombstone for a row this device never saw still belongs to the room, or
  // the room-scoped identity check would reject the row's next put.
  if (op.table !== "profiles") next.profileId = op.roomId;
  next.winner = winnerKey(op);
  next.deletedAt = op.hlcTs;
  return next;
}

function liveRowOf(op: RowOp, content: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...content, id: op.rowId };
  if (op.table !== "profiles") next.profileId = op.roomId;
  next.winner = winnerKey(op);
  // ALWAYS written: `visible()` is a strict null check, and a live row with
  // the field absent rendered INVISIBLE (audit-4 R4-P2-1, executed).
  next.deletedAt = null;
  return next;
}

/**
 * Apply one op to its row. Assumes it is already inside a transaction.
 *
 * History append is the LAST write with no catch: the unique index is the
 * final dedup authority, so a colliding append aborts the whole transaction
 * and the caller treats it as dedup/retry. Catching it here would commit the
 * row write on a duplicate.
 */
export async function reduceOp(db: OwlshelfDB, op: RowOp): Promise<"won" | "lost"> {
  if (op.table === "profiles" && op.rowId !== op.roomId) throw new CrossRoomError(op);

  // Validate before ANY write, win or lose: a malformed payload must never
  // reach history either, because conflict restore reads it back.
  const payload = normalizePayload(op.table, op.type, op.payload, { side: "receive" });
  if (!payload.ok) throw new MalformedPayloadError(op);

  const table = db.table(op.table);
  const row = (await table.get(op.rowId)) as Record<string, unknown> | undefined;
  if (row && !belongsToRoom(op.table, row, op.roomId)) throw new CrossRoomError(op);

  const current = parseWinnerKey(row?.winner as string | undefined);
  if (current && compareOrder(orderKey(op), current) <= 0) {
    await db.ops.put(op);
    return "lost";
  }

  let next: Record<string, unknown>;
  if (payload.type === "delete") {
    next = tombstoneOf(op, row);
  } else if (payload.type === "resolve") {
    next = payload.keep === "tombstone" ? tombstoneOf(op, row) : liveRowOf(op, payload.content);
  } else {
    next = liveRowOf(op, payload.value);
  }

  await table.put(next);
  await db.ops.put(op);
  return "won";
}

// ─── Cursors ───────────────────────────────────────────────────────────────

/**
 * Advance the highest CONTIGUOUS `authorSeq` prefix for one author, draining
 * `pending` and stepping over quarantined slots.
 *
 * A slot is FILLED iff its op is adopted OR quarantined. Out-of-order ops are
 * already adopted (the reducer is order-independent, so early materialization
 * is safe); `pending` only indexes the beyond-prefix ops so the drain is an
 * index lookup, not a scan. The prefix never moves backward.
 */
export async function advanceCursor(
  db: OwlshelfDB,
  room: Room,
  deviceId: string,
  seq: number,
): Promise<number> {
  const current = room.cursorIn[deviceId] ?? 0;
  if (!Number.isInteger(seq) || seq <= current) return current;

  if (seq > current + 1) {
    await db.pending.put({ roomId: room.roomId, deviceId, authorSeq: seq });
    return current;
  }

  // Re-delivery of an op that was already indexed as pending: the marker is
  // spent, not left behind.
  await db.pending.delete([room.roomId, deviceId, seq]);

  let cursor = seq;
  for (;;) {
    const next = cursor + 1;
    const buffered = await db.pending.get([room.roomId, deviceId, next]);
    if (buffered) {
      await db.pending.delete([room.roomId, deviceId, next]);
      cursor = next;
      continue;
    }
    const quarantined = await db.quarantine.get([room.roomId, deviceId, next]);
    if (quarantined) {
      cursor = next;
      continue;
    }
    break;
  }

  room.cursorIn[deviceId] = cursor;
  return cursor;
}

// ─── Admission ─────────────────────────────────────────────────────────────

export type QuarantineReason = QuarantineEntry["reason"];

export type AdmitOutcome =
  | { status: "adopted"; opId: string; cursor: number; won: boolean }
  | { status: "duplicate"; opId: string; cursor: number }
  | { status: "quarantined"; reason: QuarantineReason; cursor: number }
  | { status: "fork"; cursor: number }
  | { status: "dropped"; reason: "unknown-room" | "invalid" };

export interface AdmitOptions {
  now?: () => number;
}

function isRowOpShape(op: unknown): op is RowOp {
  if (op === null || typeof op !== "object") return false;
  const candidate = op as Partial<RowOp>;
  if (typeof candidate.opId !== "string" || candidate.opId.length === 0) return false;
  if (typeof candidate.roomId !== "string" || candidate.roomId.length === 0) return false;
  if (typeof candidate.deviceId !== "string" || candidate.deviceId.length === 0) return false;
  if (typeof candidate.rowId !== "string" || candidate.rowId.length === 0) return false;
  return true;
}

async function quarantineSlot(
  db: OwlshelfDB,
  op: RowOp,
  reason: QuarantineReason,
  opIds?: string[],
): Promise<void> {
  const entry: QuarantineEntry = {
    roomId: op.roomId,
    deviceId: op.deviceId,
    authorSeq: op.authorSeq,
    opId: op.opId,
    reason,
    receivedAt: Date.now(),
  };
  if (opIds) entry.opIds = opIds;
  await db.quarantine.put(entry);
}

/**
 * Admit one remote op: the whole pipeline in ONE transaction.
 *
 * Order is normative (plan §6.4): table allowlist → type/sequence → dedup
 * precheck → receive clock → reduce → advance cursor → save clock.
 */
export async function admitRemoteOp(
  db: OwlshelfDB,
  op: RowOp,
  options: AdmitOptions = {},
): Promise<AdmitOutcome> {
  const now = options.now ?? Date.now;

  return db.transaction(
    "rw",
    [db.ops, db.pending, db.quarantine, db.meta, db.profiles, db.locations, db.items],
    async (): Promise<AdmitOutcome> => {
      // 1. Table allowlist — checked BEFORE any store access, so inbound JSON
      //    naming `meta`, `outbox`, or any non-row store reaches NOTHING.
      if (!isRowOpShape(op) || !ROW_TABLES.includes(op.table)) {
        return { status: "dropped", reason: "invalid" };
      }
      if (!Number.isFinite(op.authorSeq)) return { status: "dropped", reason: "invalid" };

      const room = await readRoom(db, op.roomId);
      if (!room) return { status: "dropped", reason: "unknown-room" };

      // 2. Type + sequence validation. An unknown type once ranked as a put
      //    and materialized; a fractional seq once buffered in `pending`
      //    forever because the gap could never fill (audit-2 N14, executed).
      if (!(op.type in TYPE_RANK)) {
        // A rejected op still OCCUPIES its slot: the cursor must step over it
        // or every later op from this author is stranded in `pending` forever
        // (audit-4 D1/R4-P0-1, executed).
        await quarantineSlot(db, op, "bad-type");
        const cursor = await advanceCursor(db, room, op.deviceId, op.authorSeq);
        await writeRoom(db, room);
        return { status: "quarantined", reason: "bad-type", cursor };
      }
      if (!Number.isInteger(op.authorSeq) || op.authorSeq <= 0) {
        // A fractional seq is not a slot in the contiguous integer sequence,
        // so it is quarantined for the diagnostic and never moves the cursor.
        await quarantineSlot(db, op, "bad-seq");
        return { status: "quarantined", reason: "bad-seq", cursor: room.cursorIn[op.deviceId] ?? 0 };
      }

      // 3. Dedup precheck FIRST, clock second.
      const existing = await db.ops
        .where("[roomId+deviceId+authorSeq]")
        .equals([op.roomId, op.deviceId, op.authorSeq])
        .first();

      if (existing) {
        if (existing.opId === op.opId) {
          const cursor = await advanceCursor(db, room, op.deviceId, op.authorSeq);
          await writeRoom(db, room);
          return { status: "duplicate", opId: op.opId, cursor };
        }
        // Same seq, DIFFERENT opId: a fork. Dedup keyed on the seq number
        // alone once hid exactly this (audit-4 R4-P0-3, executed).
        await quarantineSlot(db, op, "fork", [existing.opId, op.opId]);
        room.forked = true;
        const cursor = await advanceCursor(db, room, op.deviceId, op.authorSeq);
        await writeRoom(db, room);
        return { status: "fork", cursor };
      }

      // 4. Receive clock, non-dups only. A far-ahead peer must advance the
      //    local clock before this device can mint a lower stamp.
      const clockBefore: Hlc = { ...room.clock };
      const received = receiveHlc(room.clock, { ts: op.hlcTs, counter: op.hlcCounter }, now());
      if (!received.ok) {
        await quarantineSlot(db, op, "bad-stamp");
        const cursor = await advanceCursor(db, room, op.deviceId, op.authorSeq);
        await writeRoom(db, room);
        return { status: "quarantined", reason: "bad-stamp", cursor };
      }
      room.clock = received.clock;

      // 5. Reduce. A rejected op writes ONE quarantine record and NOTHING
      //    else — including no clock advance, so the clock is restored.
      let won: boolean;
      try {
        won = (await reduceOp(db, op)) === "won";
      } catch (error) {
        if (error instanceof CrossRoomError) {
          room.clock = clockBefore;
          await quarantineSlot(db, op, "cross-room");
          const cursor = await advanceCursor(db, room, op.deviceId, op.authorSeq);
          await writeRoom(db, room);
          return { status: "quarantined", reason: "cross-room", cursor };
        }
        if (error instanceof MalformedPayloadError) {
          room.clock = clockBefore;
          await quarantineSlot(db, op, "bad-type");
          const cursor = await advanceCursor(db, room, op.deviceId, op.authorSeq);
          await writeRoom(db, room);
          return { status: "quarantined", reason: "bad-type", cursor };
        }
        throw error;
      }

      // 6. Advance the cursor (duplicates took this path above too).
      const cursor = await advanceCursor(db, room, op.deviceId, op.authorSeq);
      // 7. Save the clock for non-dups.
      await writeRoom(db, room);
      return { status: "adopted", opId: op.opId, cursor, won };
    },
  );
}

// ─── Derived conflicts ─────────────────────────────────────────────────────

export interface ConflictEntry {
  table: RowTable;
  rowId: string;
  put: RowOp;
  delete: RowOp;
}

/**
 * A row is in conflict iff, in the ops AFTER its last resolve (or all its ops
 * if none), the top put and the top delete are both present and from
 * different devices.
 *
 * Derived, never stored: a stored, event-written flag is arrival-order
 * dependent — whichever device applied the losing op second would be the only
 * one flagged — and diverges by construction.
 */
export async function deriveConflicts(db: OwlshelfDB, roomId: string): Promise<ConflictEntry[]> {
  const conflicts: ConflictEntry[] = [];

  for (const table of ROW_TABLES) {
    const rows =
      table === "profiles"
        ? await db.profiles.where("id").equals(roomId).toArray()
        : await db
            .table(table)
            .where("profileId")
            .equals(roomId)
            .toArray();

    for (const row of rows as Array<{ id: string }>) {
      const ops = (await db.ops
        .where("[roomId+table+rowId]")
        .equals([roomId, table, row.id])
        .toArray()) as RowOp[];
      if (ops.length === 0) continue;
      ops.sort(compareOps);

      let start = 0;
      for (let index = ops.length - 1; index >= 0; index--) {
        if (ops[index].type === "resolve") {
          start = index + 1;
          break;
        }
      }

      let topPut: RowOp | null = null;
      let topDelete: RowOp | null = null;
      for (let index = start; index < ops.length; index++) {
        const op = ops[index];
        if (op.type === "put") topPut = op;
        else if (op.type === "delete") topDelete = op;
      }

      if (topPut && topDelete && topPut.deviceId !== topDelete.deviceId) {
        conflicts.push({ table, rowId: row.id, put: topPut, delete: topDelete });
      }
    }
  }

  return conflicts;
}
