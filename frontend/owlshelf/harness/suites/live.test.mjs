/**
 * live.test.mjs — a REMOTE op repaints a live query (plan §6.5).
 *
 * This is the claim the whole tab-side facade rests on: "live queries repaint
 * automatically when remote ops land". A command repainting its own tab
 * proves nothing — that is the same call stack. A remote op arrives as an
 * `ops` row plus a `reduceOp`, with no command and no tab involved, so this
 * suite drives exactly that path and watches a `liveQuery` subscription.
 *
 * The relay does not exist yet (step 5), so this is the only place the remote
 * path can be executed today. It is also the regression that matters: if
 * someone replaces the live query with a one-shot read, these tests fail.
 */

import { liveQuery } from "dexie";
import { reduceOp } from "../../src/lib/reduce.ts";
import { isVisible } from "../../src/lib/visible.ts";
import { assert, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_B, ROOM_A, ROOM_B, makeOp, putPayload, seedRoom } from "../lib/fixtures.mjs";

const LOCATION = "loc-1";

/**
 * Subscribe and record every emission, with a bounded wait so a missing
 * repaint fails the test instead of hanging the harness.
 */
function watch(observable) {
  const emissions = [];
  const listeners = new Set();

  const subscription = observable.subscribe({
    next: (value) => {
      emissions.push(value);
      for (const listener of [...listeners]) listener();
    },
    error: () => {
      for (const listener of [...listeners]) listener();
    },
  });

  return {
    emissions,
    /** Resolve with the first emission matching `predicate`. */
    async until(predicate, label) {
      const deadline = Date.now() + 2000;
      for (;;) {
        const hit = emissions.find(predicate);
        if (hit !== undefined) return hit;
        if (Date.now() > deadline) {
          throw new Error(
            `${label} — no matching emission within 2s (saw ${emissions.length}: ${JSON.stringify(emissions)})`,
          );
        }
        await new Promise((resolve) => {
          const done = () => {
            listeners.delete(done);
            resolve();
          };
          listeners.add(done);
          setTimeout(done, 25);
        });
      }
    },
    stop: () => subscription.unsubscribe(),
  };
}

/** The same query `useItems` runs: visible rows for one location. */
function itemsQuery(db, locationId) {
  return liveQuery(async () => {
    const rows = await db.items.where("locationId").equals(locationId).toArray();
    return rows.filter(isVisible);
  });
}

export default {
  name: "live — a remote op repaints a live query (§6.5)",
  tests: [
    {
      name: "a remote put appears without any command or refetch",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const view = watch(itemsQuery(db, LOCATION));

          const first = await view.until((rows) => rows.length === 0, "initial empty emission");
          assertEqual(first.length, 0, "starts empty");

          // A remote op: no cmdId, no tab, another device's sequence.
          await reduceOp(
            db,
            makeOp({
              deviceId: DEVICE_B,
              authorSeq: 1,
              hlcTs: 2000,
              payload: putPayload("items", { name: "Remote Book", locationId: LOCATION }),
            }),
          );

          const after = await view.until((rows) => rows.length === 1, "repaint after the remote put");
          assertEqual(after.length, 1, "one row");
          assertEqual(after[0].name, "Remote Book", "the remote payload materialized");
          assertEqual(after[0].deletedAt, null, "a live row says so explicitly");

          view.stop();
        });
      },
    },
    {
      name: "a remote delete removes the row from the live query",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const view = watch(itemsQuery(db, LOCATION));

          await reduceOp(
            db,
            makeOp({
              deviceId: DEVICE_B,
              authorSeq: 1,
              hlcTs: 2000,
              payload: putPayload("items", { name: "Remote Book", locationId: LOCATION }),
            }),
          );
          await view.until((rows) => rows.length === 1, "the put landed");

          await reduceOp(
            db,
            makeOp({
              opId: "op-remote-delete",
              deviceId: DEVICE_B,
              authorSeq: 2,
              hlcTs: 3000,
              type: "delete",
              payload: undefined,
            }),
          );

          const after = await view.until((rows) => rows.length === 0, "repaint after the remote delete");
          assertEqual(after.length, 0, "the tombstone is filtered out, not rendered");

          view.stop();
        });
      },
    },
    {
      name: "a remote op in ANOTHER room does not add a row here",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await seedRoom(db, { roomId: ROOM_B });
          const view = watch(itemsQuery(db, LOCATION));

          await view.until((rows) => rows.length === 0, "initial empty emission");

          await reduceOp(
            db,
            makeOp({
              opId: "op-other-room",
              roomId: ROOM_B,
              deviceId: DEVICE_B,
              authorSeq: 1,
              hlcTs: 2000,
              payload: putPayload("items", { name: "Elsewhere", locationId: "loc-other" }),
            }),
          );

          // Give the subscription a chance to fire, then assert it did not
          // gain a row. Dexie may re-emit the same value; the assertion is
          // about the CONTENT, which is what the user sees.
          await new Promise((resolve) => setTimeout(resolve, 100));
          for (const rows of view.emissions) {
            assertEqual(rows.length, 0, "another room's op never appears in this room's view");
          }

          view.stop();
        });
      },
    },
    {
      name: "the room's own command repaints too — the same subscription",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const view = watch(itemsQuery(db, LOCATION));
          await view.until((rows) => rows.length === 0, "initial empty emission");

          // A LOCAL write through the same reducer the command path uses.
          await reduceOp(
            db,
            makeOp({
              deviceId: "dev-local",
              authorSeq: 1,
              hlcTs: 2000,
              payload: putPayload("items", { name: "Local Book", locationId: LOCATION }),
            }),
          );

          const after = await view.until((rows) => rows.length === 1, "repaint after the local put");
          assert(after[0].name === "Local Book", "the local row materialized");

          view.stop();
        });
      },
    },
  ],
};
