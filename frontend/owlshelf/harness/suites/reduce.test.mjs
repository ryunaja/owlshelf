/**
 * reduce.test.mjs — plan §6.4, executed against real Dexie.
 *
 * The reducer is the one place where convergence is decided, so most of these
 * are permutation tests: the same op set delivered in every order must produce
 * the same row. A test that only checks one order proves nothing about a
 * reducer whose whole job is order independence.
 */

import { admitRemoteOp, deriveConflicts } from "../../src/lib/reduce.ts";
import { isVisible } from "../../src/lib/visible.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, DEVICE_B, ROOM_A, ROOM_B, makeOp, putPayload, seedRoom } from "../lib/fixtures.mjs";

const WALL = 1_700_000_000_000;

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let index = 0; index < items.length; index++) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) out.push([items[index], ...tail]);
  }
  return out;
}

/** Deliver `ops` in the given order against a fresh db, return the row. */
async function deliver(ops, rowId = "item-1") {
  return withDb(async (db) => {
    await seedRoom(db);
    for (const op of ops) await admitRemoteOp(db, op, { now: () => WALL });
    return db.items.get(rowId);
  });
}

export default {
  name: "reduce — total order, tombstones, cursors (§6.4)",
  tests: [
    {
      name: "put/put: the higher HLC wins, in either delivery order",
      async run() {
        const low = makeOp({ opId: "low", authorSeq: 1, hlcTs: 1000, payload: putPayload("items", { name: "Low" }) });
        const high = makeOp({ opId: "high", authorSeq: 2, hlcTs: 2000, payload: putPayload("items", { name: "High" }) });
        assertEqual((await deliver([low, high])).name, "High", "forward");
        assertEqual((await deliver([high, low])).name, "High", "reverse");
      },
    },
    {
      name: "put/delete at equal clock: the delete wins on typeRank",
      async run() {
        const put = makeOp({ opId: "p", authorSeq: 1, hlcTs: 1000, hlcCounter: 5, payload: putPayload("items") });
        const del = makeOp({ opId: "d", authorSeq: 2, hlcTs: 1000, hlcCounter: 5, type: "delete", payload: undefined });
        const forward = await deliver([put, del]);
        const reverse = await deliver([del, put]);
        assertEqual(forward.deletedAt, 1000, "forward tombstoned");
        assertEqual(reverse.deletedAt, 1000, "reverse tombstoned");
        assertEqual(isVisible(forward), false, "invisible");
      },
    },
    {
      name: "equal HLCs: deviceId then opId break the tie, order-independently",
      async run() {
        const a = makeOp({ opId: "a", deviceId: DEVICE_A, authorSeq: 1, hlcTs: 1000, payload: putPayload("items", { name: "A" }) });
        const b = makeOp({ opId: "b", deviceId: DEVICE_B, authorSeq: 1, hlcTs: 1000, payload: putPayload("items", { name: "B" }) });
        assertEqual((await deliver([a, b])).name, "B", "forward");
        assertEqual((await deliver([b, a])).name, "B", "reverse");
      },
    },
    {
      name: "property: every permutation of three ops converges on the same row",
      async run() {
        const ops = [
          makeOp({ opId: "x1", authorSeq: 1, hlcTs: 1000, payload: putPayload("items", { name: "one" }) }),
          makeOp({ opId: "x2", authorSeq: 2, hlcTs: 3000, payload: putPayload("items", { name: "three" }) }),
          makeOp({ opId: "x3", authorSeq: 3, hlcTs: 2000, payload: putPayload("items", { name: "two" }) }),
        ];
        const rows = [];
        for (const order of permutations(ops)) rows.push(await deliver(order));
        const first = JSON.stringify(rows[0]);
        for (const row of rows) assertEqual(JSON.stringify(row), first, "every permutation agrees");
        assertEqual(rows[0].name, "three", "the highest HLC wins");
      },
    },
    {
      name: "duplicate delivery is a clean no-op that still advances the cursor",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const op = makeOp({ opId: "dup", authorSeq: 1, hlcTs: 1000 });
          const first = await admitRemoteOp(db, op, { now: () => WALL });
          const second = await admitRemoteOp(db, op, { now: () => WALL });
          assertEqual(first.status, "adopted", "first adopted");
          assertEqual(second.status, "duplicate", "second is a duplicate");
          assertEqual(second.cursor, 1, "cursor");
          assertEqual(await db.ops.count(), 1, "one op in history");
          assertEqual((await db.items.get("item-1")).name, "Book", "row unchanged");
        });
      },
    },
    {
      name: "a losing op is kept in history, not discarded",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const winner = makeOp({ opId: "w", authorSeq: 1, hlcTs: 2000, payload: putPayload("items", { name: "Winner" }) });
          const loser = makeOp({ opId: "l", authorSeq: 2, hlcTs: 1000, payload: putPayload("items", { name: "Loser" }) });
          await admitRemoteOp(db, winner, { now: () => WALL });
          const outcome = await admitRemoteOp(db, loser, { now: () => WALL });
          assertEqual(outcome.won, false, "loser lost");
          assertEqual(await db.ops.count(), 2, "both ops in history");
          assertEqual((await db.items.get("item-1")).name, "Winner", "row keeps the winner");
        });
      },
    },
    {
      name: "the reducer ALWAYS writes deletedAt (R4-P2-1)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await admitRemoteOp(db, makeOp({ opId: "p", authorSeq: 1, hlcTs: 1000 }), { now: () => WALL });
          const row = await db.items.get("item-1");
          assertEqual("deletedAt" in row, true, "the field is present");
          assertEqual(row.deletedAt, null, "and null for a live row");
          assertEqual(isVisible(row), true, "visible");
        });
      },
    },
    {
      name: "visible() is a strict null check: deletedAt 0 is a tombstone",
      async run() {
        assertEqual(isVisible({ deletedAt: 0 }), false, "0 is a tombstone");
        assertEqual(isVisible({ deletedAt: null }), true, "null is live");
        assertEqual(isVisible({}), false, "absent is invisible");
      },
    },
    {
      name: "resolve keep:row materializes payload.content FLAT, not nested (P0-6)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await admitRemoteOp(db, makeOp({ opId: "p", authorSeq: 1, hlcTs: 1000 }), { now: () => WALL });
          await admitRemoteOp(
            db,
            makeOp({
              opId: "r",
              authorSeq: 2,
              hlcTs: 2000,
              type: "resolve",
              payload: { keep: "row", content: putPayload("items", { name: "Restored" }) },
            }),
            { now: () => WALL },
          );
          const row = await db.items.get("item-1");
          assertEqual(row.name, "Restored", "content applied");
          assertEqual("content" in row, false, "no nested content field");
          assertEqual("keep" in row, false, "no nested keep field");
          assertEqual(row.deletedAt, null, "live");
        });
      },
    },
    {
      name: "resolve without content is rejected with zero row change (N11)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await admitRemoteOp(db, makeOp({ opId: "p", authorSeq: 1, hlcTs: 1000 }), { now: () => WALL });
          const before = await db.items.get("item-1");
          const outcome = await admitRemoteOp(
            db,
            makeOp({ opId: "r", authorSeq: 2, hlcTs: 2000, type: "resolve", payload: { keep: "row" } }),
            { now: () => WALL },
          );
          assertEqual(outcome.status, "quarantined", "quarantined");
          assertEqual(outcome.reason, "bad-type", "reason");
          assertDeepEqual(await db.items.get("item-1"), before, "row untouched");
        });
      },
    },
    {
      name: "a malformed PUT payload is quarantined: no row, no history, no clock advance",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const before = await db.meta.get(`room:${ROOM_A}`);
          const outcome = await admitRemoteOp(
            db,
            // An empty name is malformed on RECEIVE (only a local mint
            // normalizes it to "Untitled").
            makeOp({ opId: "bad", authorSeq: 1, hlcTs: 5000, payload: { name: "", locationId: "loc-1" } }),
            { now: () => WALL },
          );
          assertEqual(outcome.status, "quarantined", "quarantined");
          assertEqual(outcome.reason, "bad-type", "reason");
          assertEqual(await db.items.count(), 0, "nothing materialized");
          assertEqual(await db.ops.count(), 0, "not in history either");
          const after = await db.meta.get(`room:${ROOM_A}`);
          assertDeepEqual(after.clock, before.clock, "the clock did not advance");
          assertEqual(outcome.cursor, 1, "the slot is still filled");
          const record = await db.quarantine.get([ROOM_A, DEVICE_A, 1]);
          assertEqual(record.reason, "bad-type", "the diagnostic is durable");
        });
      },
    },
    {
      name: "a malformed payload is rejected even when the op would LOSE",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await admitRemoteOp(
            db,
            makeOp({ opId: "winner", authorSeq: 1, hlcTs: 9000, payload: putPayload("items", { name: "Winner" }) }),
            { now: () => WALL },
          );
          // Lower HLC, so it would be adopted into history only — but a
          // malformed payload must never reach history, because conflict
          // restore reads it back.
          const outcome = await admitRemoteOp(
            db,
            makeOp({ opId: "loser", authorSeq: 2, hlcTs: 1000, payload: { name: "x", locationId: "l", stock: -1 } }),
            { now: () => WALL },
          );
          assertEqual(outcome.status, "quarantined", "quarantined");
          assertEqual(await db.ops.count(), 1, "only the winner is in history");
          assertEqual((await db.items.get("item-1")).name, "Winner", "row untouched");
        });
      },
    },
    {
      name: "an unknown op type is quarantined, never materialized (N14)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const outcome = await admitRemoteOp(db, makeOp({ opId: "u", authorSeq: 1, type: "upsert" }), { now: () => WALL });
          assertEqual(outcome.status, "quarantined", "quarantined");
          assertEqual(outcome.reason, "bad-type", "reason");
          assertEqual(await db.items.count(), 0, "nothing materialized");
        });
      },
    },
    {
      name: "a fractional authorSeq is quarantined and never buffered in pending (N14)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const outcome = await admitRemoteOp(db, makeOp({ opId: "f", authorSeq: 1.5 }), { now: () => WALL });
          assertEqual(outcome.status, "quarantined", "quarantined");
          assertEqual(outcome.reason, "bad-seq", "reason");
          assertEqual(await db.pending.count(), 0, "not buffered");
          assertEqual(await db.items.count(), 0, "nothing materialized");
        });
      },
    },
    {
      name: "a cross-room rowId is a probe, not an edit (P0-7)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          await admitRemoteOp(db, makeOp({ opId: "p", authorSeq: 1, hlcTs: 1000 }), { now: () => WALL });
          const before = await db.items.get("item-1");
          const outcome = await admitRemoteOp(
            db,
            makeOp({ opId: "x", roomId: ROOM_B, authorSeq: 1, hlcTs: 2000, payload: putPayload("items", { name: "Hijack" }) }),
            { now: () => WALL },
          );
          assertEqual(outcome.status, "quarantined", "quarantined");
          assertEqual(outcome.reason, "cross-room", "reason");
          assertDeepEqual(await db.items.get("item-1"), before, "row untouched");
        });
      },
    },
    {
      name: "the table allowlist rejects a non-row store before any store access (P0-7)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const outcome = await admitRemoteOp(db, makeOp({ opId: "m", table: "meta" }), { now: () => WALL });
          assertEqual(outcome.status, "dropped", "dropped");
          assertEqual(await db.ops.count(), 0, "nothing written");
          assertEqual(await db.items.count(), 0, "nothing materialized");
        });
      },
    },
    {
      name: "dedup runs BEFORE the clock check (R4-P2-2)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const op = makeOp({ opId: "d", authorSeq: 1, hlcTs: 1000 });
          await admitRemoteOp(db, op, { now: () => WALL });
          // Re-deliver the same op with a clock far past the skew horizon: a
          // clock-first pipeline would quarantine it and freeze the cursor.
          const outcome = await admitRemoteOp(db, op, { now: () => WALL - 10 * 86_400_000 });
          assertEqual(outcome.status, "duplicate", "still a duplicate");
          assertEqual(outcome.cursor, 1, "cursor advanced");
        });
      },
    },
    {
      name: "a hostile far-future MAX_COUNTER op is rejected and the room stays joinable (N5/R4-P0-2)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const hostile = makeOp({
            opId: "hostile",
            authorSeq: 1,
            hlcTs: WALL + 23 * 3_600_000,
            hlcCounter: 2 ** 31,
          });
          const outcome = await admitRemoteOp(db, hostile, { now: () => WALL });
          assertEqual(outcome.status, "quarantined", "quarantined");
          assertEqual(outcome.reason, "bad-stamp", "reason");

          const room = await db.meta.get(`room:${ROOM_A}`);
          assertEqual(room.clock.ts, 0, "the clock did not absorb the hostile stamp");

          const fresh = makeOp({ opId: "fresh", deviceId: DEVICE_B, authorSeq: 1, hlcTs: WALL });
          const adopted = await admitRemoteOp(db, fresh, { now: () => WALL });
          assertEqual(adopted.status, "adopted", "a new device can still join");
        });
      },
    },
    {
      name: "a quarantined slot never freezes its author's successors (R4-P0-1)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await admitRemoteOp(db, makeOp({ opId: "s1", authorSeq: 1, hlcTs: 1000 }), { now: () => WALL });
          const bad = await admitRemoteOp(db, makeOp({ opId: "s2", authorSeq: 2, type: "nope" }), { now: () => WALL });
          assertEqual(bad.status, "quarantined", "seq 2 quarantined");
          const after = await admitRemoteOp(
            db,
            makeOp({ opId: "s3", authorSeq: 3, hlcTs: 3000, payload: putPayload("items", { name: "After" }) }),
            { now: () => WALL },
          );
          assertEqual(after.status, "adopted", "seq 3 adopted");
          assertEqual(after.cursor, 3, "the cursor stepped over the quarantined slot");
          assertEqual((await db.items.get("item-1")).name, "After", "the successor materialized");
        });
      },
    },
    {
      name: "same seq, different opId is a FORK, not a duplicate (R4-P0-3)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await admitRemoteOp(db, makeOp({ opId: "a", authorSeq: 1, hlcTs: 1000 }), { now: () => WALL });
          const outcome = await admitRemoteOp(
            db,
            makeOp({ opId: "b", authorSeq: 1, hlcTs: 2000, payload: putPayload("items", { name: "Forked" }) }),
            { now: () => WALL },
          );
          assertEqual(outcome.status, "fork", "fork detected");
          const room = await db.meta.get(`room:${ROOM_A}`);
          assertEqual(room.forked, true, "the room is flagged");
          const record = await db.quarantine.get([ROOM_A, DEVICE_A, 1]);
          assertEqual(record.reason, "fork", "reason");
          assertDeepEqual(record.opIds, ["a", "b"], "both opIds are named");
          assertEqual((await db.items.get("item-1")).name, "Book", "the fork did not materialize");
        });
      },
    },
    {
      name: "cursor: a gap freezes the prefix, and filling it drains the run (P0-5)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const three = await admitRemoteOp(db, makeOp({ opId: "s3", authorSeq: 3, hlcTs: 3000 }), { now: () => WALL });
          assertEqual(three.cursor, 0, "prefix frozen at 0");
          assertEqual(await db.pending.count(), 1, "seq 3 buffered");
          const one = await admitRemoteOp(db, makeOp({ opId: "s1", authorSeq: 1, hlcTs: 1000 }), { now: () => WALL });
          assertEqual(one.cursor, 1, "prefix at 1");
          const two = await admitRemoteOp(db, makeOp({ opId: "s2", authorSeq: 2, hlcTs: 2000 }), { now: () => WALL });
          assertEqual(two.cursor, 3, "the whole run drained");
          assertEqual(await db.pending.count(), 0, "pending emptied");
        });
      },
    },
    {
      name: "cursor: an op at or below the prefix never moves it backward",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await admitRemoteOp(db, makeOp({ opId: "s1", authorSeq: 1, hlcTs: 1000 }), { now: () => WALL });
          await admitRemoteOp(db, makeOp({ opId: "s2", authorSeq: 2, hlcTs: 2000 }), { now: () => WALL });
          const stale = await admitRemoteOp(db, makeOp({ opId: "s1b", authorSeq: 1, hlcTs: 500 }), { now: () => WALL });
          assertEqual(stale.cursor, 2, "no regress");
        });
      },
    },
    {
      name: "conflicts are derived: a cross-device put/delete race, cleared by a resolve",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await admitRemoteOp(db, makeOp({ opId: "p", authorSeq: 1, hlcTs: 1000 }), { now: () => WALL });
          await admitRemoteOp(
            db,
            makeOp({ opId: "d", deviceId: DEVICE_B, authorSeq: 1, hlcTs: 2000, type: "delete", payload: undefined }),
            { now: () => WALL },
          );
          const conflicts = await deriveConflicts(db, ROOM_A);
          assertEqual(conflicts.length, 1, "one conflict");
          assertEqual(conflicts[0].put.opId, "p", "the put");
          assertEqual(conflicts[0].delete.opId, "d", "the delete");

          await admitRemoteOp(
            db,
            makeOp({
              opId: "r",
              authorSeq: 2,
              hlcTs: 3000,
              type: "resolve",
              payload: { keep: "row", content: putPayload("items", { name: "Kept" }) },
            }),
            { now: () => WALL },
          );
          assertEqual((await deriveConflicts(db, ROOM_A)).length, 0, "the resolve cleared it");
        });
      },
    },
    {
      name: "the plain roomId index exists, so a full-log walk does not throw (N9)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await admitRemoteOp(db, makeOp({ opId: "p", authorSeq: 1, hlcTs: 1000 }), { now: () => WALL });
          const ops = await db.ops.where("roomId").equals(ROOM_A).toArray();
          assertEqual(ops.length, 1, "enumerated by roomId");
        });
      },
    },
    {
      name: "the outbox state index exists, so the resume query does not throw (review-2 P0-4)",
      async run() {
        await withDb(async (db) => {
          const pending = await db.outbox.where("state").equals("pending").toArray();
          assertEqual(pending.length, 0, "enumerated by state");
        });
      },
    },
  ],
};
