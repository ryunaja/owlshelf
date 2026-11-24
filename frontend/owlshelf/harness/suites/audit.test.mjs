/**
 * audit.test.mjs — the consistency audit's local half (§6.6).
 *
 * The audit is the production twin of Gate B's property tests: the tests prove
 * the reducer before shipping, the audit catches whatever the tests missed.
 * What is under test here is the DIGEST's inputs (does it see tombstones? does
 * it see the log's shape?) and the repair ladder's decision table.
 */

import {
  auditMismatchAction,
  collectAuditRows,
  countOpsByAuthor,
  localAuditDigest,
} from "../../src/lib/audit.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, DEVICE_B, ROOM_A, makeOp, seedRoom } from "../lib/fixtures.mjs";

function row(id, overrides = {}) {
  return {
    id,
    name: "Book",
    locationId: "loc-1",
    profileId: ROOM_A,
    winner: "1000:0:0:dev-a:op-1",
    deletedAt: null,
    ...overrides,
  };
}

export default {
  name: "audit — digest inputs and the repair ladder (§6.6)",
  tests: [
    {
      name: "collectAuditRows sees every row table, tombstoned or not",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await db.profiles.put({ id: ROOM_A, name: "Shelf", type: "personal" });
          await db.locations.put(row("loc-1", { name: "Shelf A" }));
          await db.items.put(row("item-1"));
          await db.items.put(row("item-2", { deletedAt: 1234 }));

          const rows = await collectAuditRows(db, ROOM_A);
          assertEqual(rows.length, 4, "profile + location + two items");
          assertDeepEqual(
            rows.map((r) => `${r.table}/${r.rowId}`).sort(),
            ["items/item-1", "items/item-2", "locations/loc-1", "profiles/room-a"],
            "every table",
          );
        });
      },
    },
    {
      name: "a tombstone is in the digest, not filtered out",
      async run() {
        // A device that dropped a tombstone and one that kept it have different
        // state; a visible-rows-only digest would call them converged.
        await withDb(async (db) => {
          await seedRoom(db);
          await db.items.put(row("item-1"));
          const live = await localAuditDigest(db, ROOM_A);

          await db.items.put(row("item-1", { deletedAt: 1234 }));
          const dead = await localAuditDigest(db, ROOM_A);

          assert(live !== dead, "the tombstone must change the digest");
        });
      },
    },
    {
      name: "a row in another room is not in this room's digest",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await db.items.put(row("item-1"));
          const before = await localAuditDigest(db, ROOM_A);

          await db.items.put(row("item-other", { profileId: "room-b" }));
          const after = await localAuditDigest(db, ROOM_A);

          assertEqual(before, after, "another room's row is invisible here");
        });
      },
    },
    {
      name: "countOpsByAuthor counts the log, not the rows",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await db.ops.put(makeOp({ opId: "op-a1", deviceId: DEVICE_A, authorSeq: 1 }));
          await db.ops.put(makeOp({ opId: "op-a2", deviceId: DEVICE_A, authorSeq: 2 }));
          await db.ops.put(makeOp({ opId: "op-b1", deviceId: DEVICE_B, authorSeq: 1 }));

          assertDeepEqual(
            await countOpsByAuthor(db, ROOM_A),
            { [DEVICE_A]: 2, [DEVICE_B]: 1 },
            "per author",
          );
        });
      },
    },
    {
      name: "the digest sees the log's shape, not just its rows",
      async run() {
        // audit-4 R4-P2-5: two devices with different `pending` depths produced
        // identical rows-only digests while their conflict lists differed.
        await withDb(async (db) => {
          await seedRoom(db);
          await db.items.put(row("item-1"));
          const shallow = await localAuditDigest(db, ROOM_A);

          await db.ops.put(makeOp({ opId: "op-extra", deviceId: DEVICE_B, authorSeq: 1 }));
          const deep = await localAuditDigest(db, ROOM_A);

          assert(shallow !== deep, "an extra op must change the digest");
        });
      },
    },
    {
      name: "two devices with the same rows and log agree",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await db.items.put(row("item-1"));
          await db.ops.put(makeOp({ opId: "op-1", authorSeq: 1 }));

          const first = await localAuditDigest(db, ROOM_A);
          const second = await localAuditDigest(db, ROOM_A);
          assertEqual(first, second, "deterministic");
        });
      },
    },
    {
      name: "a matching digest is agreement",
      async run() {
        const view = { digest: "abc", highWater: { "dev-a": 3 } };
        assertEqual(auditMismatchAction(view, view), "agree", "same digest");
      },
    },
    {
      name: "a digest mismatch with different high-water is rung 1: catch up",
      async run() {
        // The common case by a wide margin: a device is BEHIND, not divergent.
        assertEqual(
          auditMismatchAction(
            { digest: "abc", highWater: { "dev-a": 3 } },
            { digest: "def", highWater: { "dev-a": 5 } },
          ),
          "catchup",
          "behind",
        );
        assertEqual(
          auditMismatchAction(
            { digest: "abc", highWater: { "dev-a": 3 } },
            { digest: "def", highWater: { "dev-a": 3, "dev-b": 1 } },
          ),
          "catchup",
          "an author we have never seen",
        );
      },
    },
    {
      name: "a digest mismatch with the SAME high-water is rung 2: rebuild",
      async run() {
        // Same log, different rows — reducer non-determinism, a bug, not a
        // sync problem. Blind overwrite would hide it.
        assertEqual(
          auditMismatchAction(
            { digest: "abc", highWater: { "dev-a": 3, "dev-b": 1 } },
            { digest: "def", highWater: { "dev-b": 1, "dev-a": 3 } },
          ),
          "rebuild",
          "key order must not matter",
        );
      },
    },
    {
      name: "the ladder never votes and never overwrites",
      async run() {
        // Every outcome is one of three, and none of them is "take the peer's
        // rows": the repair is always a local re-derivation.
        const outcomes = new Set();
        for (const [mine, theirs] of [
          [{ digest: "a", highWater: {} }, { digest: "a", highWater: {} }],
          [{ digest: "a", highWater: {} }, { digest: "b", highWater: { x: 1 } }],
          [{ digest: "a", highWater: { x: 1 } }, { digest: "b", highWater: { x: 1 } }],
        ]) {
          outcomes.add(auditMismatchAction(mine, theirs));
        }
        assertDeepEqual([...outcomes].sort(), ["agree", "catchup", "rebuild"], "three outcomes");
      },
    },
  ],
};
