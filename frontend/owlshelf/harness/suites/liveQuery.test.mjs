/**
 * liveQuery.test.mjs — the invariant that broke the profile page.
 *
 * `useLive` used to call `ensureOpen()` INSIDE the liveQuery querier.
 * `ensureOpen` runs the migration, which opens read-write transactions, and
 * Dexie rejects those inside a liveQuery context:
 *
 *   "Readwrite transaction in liveQuery context."
 *
 * The query then fails permanently, `value` stays null, the page renders its
 * loading skeleton forever, and — because the add-profile button is gated on
 * `!error` — there is no way to create a profile at all. The device looks
 * broken on first use.
 *
 * These tests pin both halves: the broken shape throws, the fixed shape emits.
 */

import { liveQuery } from "dexie";
import { assert, assertDeepEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";

/** Subscribe once and settle with the first emission or the first error. */
function firstEmission(querier) {
  return new Promise((resolve) => {
    let subscription = null;
    subscription = liveQuery(querier).subscribe({
      next: (rows) => {
        subscription?.unsubscribe();
        resolve({ rows, error: null });
      },
      error: (error) => {
        subscription?.unsubscribe();
        resolve({ rows: null, error });
      },
    });
  });
}

export default {
  name: "liveQuery — read-write transactions are rejected inside a querier (§6.5)",
  tests: [
    {
      name: "a querier that opens a read-write transaction is rejected",
      async run() {
        await withDb(async (db) => {
          const { error } = await firstEmission(async () => {
            await db.transaction("rw", db.profiles, async () => {
              await db.profiles.toArray();
            });
            return [];
          });
          assert(error !== null, "Dexie rejects it");
          assert(
            /readwrite transaction in livequery/i.test(String(error.message)),
            `Dexie's message, got: ${error?.message}`,
          );
        });
      },
    },
    {
      name: "a pure-read querier emits",
      async run() {
        await withDb(async (db) => {
          await db.profiles.put({ id: "p1", name: "Shelf", type: "personal" });
          const { rows, error } = await firstEmission(() => db.profiles.toArray());
          assert(error === null, "no error");
          assertDeepEqual(
            rows.map((r) => r.id),
            ["p1"],
            "the row is emitted",
          );
        });
      },
    },
    {
      name: "opening the database BEFORE subscribing keeps the querier pure",
      async run() {
        await withDb(async (db) => {
          // The fixed shape: open first, outside the querier, then read.
          await db.open();
          await db.profiles.put({ id: "p1", name: "Shelf", type: "personal" });
          const { rows, error } = await firstEmission(() => db.profiles.toArray());
          assert(error === null, "no error");
          assertDeepEqual(
            rows.map((r) => r.id),
            ["p1"],
            "emitted",
          );
        });
      },
    },
  ],
};
