/**
 * gc.test.mjs — the cheap half of storage GC (§15.5, §6.6, §8.2).
 *
 * Two deletes, and the tests that matter are the ones about what must NOT be
 * deleted: a `cmd:` receipt inside its TTL (deleting it re-opens the
 * idempotency window), a pending outbox entry (that is the backlog), and any
 * meta row that is not a `cmd:` record.
 *
 * The floor is tested by counting, not by timing: a second prune inside the
 * floor must leave a newly-expired record alone, which is only observable if
 * the scan really did not run.
 */

import { executeCommand } from "../../src/lib/cmd.ts";
import {
  CMD_PRUNE_FLOOR,
  CMD_PRUNE_KEY,
  CMD_TTL,
  OUTBOX_TTL,
  pruneAckedOutbox,
  pruneCommandRecords,
  pruneRoom,
} from "../../src/lib/gc.ts";
import { SyncEngine } from "../../src/lib/sync.ts";
import { assert, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, ROOM_A, ROOM_B, fixedClock, fixedUuid, seedRoom } from "../lib/fixtures.mjs";

const WALL = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const RELAY = "ws://relay.test/room-a";

function options(overrides = {}) {
  // A constant clock: `createdAt` is read after the HLC mint, so a stepping
  // clock would make the assertion about the tick count, not the record.
  return { deviceId: DEVICE_A, now: fixedClock(WALL, 0), uuid: fixedUuid("u"), ...overrides };
}

function outboxEntry(opId, overrides = {}) {
  return {
    opId,
    roomId: ROOM_A,
    deviceId: DEVICE_A,
    authorSeq: 1,
    state: "acked",
    attempts: 0,
    createdAt: WALL,
    ...overrides,
  };
}

/** A `cmd:` receipt as an older build wrote it — no `createdAt`. */
function legacyCmdRecord(cmdId) {
  return { key: `cmd:${cmdId}`, opId: `op-${cmdId}`, rowId: "row-1" };
}

function fakeSocket() {
  return {
    sent: [],
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    close() {},
  };
}

function makeEngine(db, overrides = {}) {
  const sockets = [];
  const statuses = [];
  const engine = new SyncEngine({
    db,
    roomId: ROOM_A,
    deviceId: DEVICE_A,
    socketFactory: () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => WALL,
    randomUUID: (() => {
      let n = 0;
      return () => `conn-${++n}`;
    })(),
    random: () => 0,
    onStatus: (status) => statuses.push(status),
    ...overrides,
  });
  return { engine, sockets, statuses };
}

export default {
  name: "gc — cmd: and acked-outbox retention (§15.5, §6.6)",
  tests: [
    {
      name: "a command records its createdAt, so the receipt can be aged",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await executeCommand(
            db,
            { cmdId: "c1", roomId: ROOM_A, kind: "putItem", locationId: "loc-1", item: { name: "Dune" } },
            options(),
          );
          const record = await db.meta.get("cmd:c1");
          assert(record !== undefined, "the receipt exists");
          assertEqual(record.createdAt, WALL, "createdAt is the command's clock");
        });
      },
    },
    {
      name: "a fresh cmd record survives the prune",
      async run() {
        await withDb(async (db) => {
          await db.meta.put({ key: "cmd:c1", opId: "op-1", rowId: "row-1", createdAt: WALL });
          const deleted = await pruneCommandRecords(db, WALL + HOUR);
          assertEqual(deleted, 0, "nothing deleted");
          assert((await db.meta.get("cmd:c1")) !== undefined, "the receipt is still there");
        });
      },
    },
    {
      name: "an expired cmd record is deleted",
      async run() {
        await withDb(async (db) => {
          await db.meta.put({ key: "cmd:c1", opId: "op-1", rowId: "row-1", createdAt: WALL });
          const deleted = await pruneCommandRecords(db, WALL + CMD_TTL + 1);
          assertEqual(deleted, 1, "one deleted");
          assertEqual(await db.meta.get("cmd:c1"), undefined, "the receipt is gone");
        });
      },
    },
    {
      name: "a cmd record with no createdAt is deleted, not kept forever",
      async run() {
        await withDb(async (db) => {
          await db.meta.put(legacyCmdRecord("old"));
          const deleted = await pruneCommandRecords(db, WALL);
          assertEqual(deleted, 1, "the pre-TTL receipt is collected");
          assertEqual(await db.meta.get("cmd:old"), undefined, "gone");
        });
      },
    },
    {
      name: "the prune never touches a non-cmd meta row",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await db.meta.put({ key: "deviceId", value: DEVICE_A });
          await db.meta.put({ key: CMD_PRUNE_KEY, at: 0 });
          await db.meta.put(legacyCmdRecord("old"));

          await pruneCommandRecords(db, WALL);

          assert((await db.meta.get("deviceId")) !== undefined, "deviceId survives");
          assert((await db.meta.get(`room:${ROOM_A}`)) !== undefined, "the room record survives");
          assert((await db.meta.get(CMD_PRUNE_KEY)) !== undefined, "the floor row survives");
        });
      },
    },
    {
      name: "a retry inside the TTL still returns the original ack",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const command = {
            cmdId: "c1",
            roomId: ROOM_A,
            kind: "putItem",
            locationId: "loc-1",
            item: { name: "Dune" },
          };
          const first = await executeCommand(db, command, options());

          // A prune that runs between the commit and the retry must not
          // re-open the window: this is the whole reason the TTL is 24 h.
          await pruneCommandRecords(db, WALL + HOUR);

          const retry = await executeCommand(db, command, options());
          assertEqual(retry.opIds[0], first.opIds[0], "the same opId comes back");
          assertEqual(retry.rowId, first.rowId, "the same rowId comes back");
          assertEqual(await db.ops.count(), 1, "exactly one op was ever minted");
        });
      },
    },
    {
      name: "an acked entry past the grace is deleted",
      async run() {
        await withDb(async (db) => {
          await db.outbox.put(outboxEntry("op-1"));
          const deleted = await pruneAckedOutbox(db, ROOM_A, WALL + OUTBOX_TTL + 1);
          assertEqual(deleted, 1, "one deleted");
          assertEqual(await db.outbox.get("op-1"), undefined, "gone");
        });
      },
    },
    {
      name: "an acked entry inside the grace survives",
      async run() {
        await withDb(async (db) => {
          await db.outbox.put(outboxEntry("op-1"));
          const deleted = await pruneAckedOutbox(db, ROOM_A, WALL + HOUR);
          assertEqual(deleted, 0, "nothing deleted");
          assert((await db.outbox.get("op-1")) !== undefined, "still there");
        });
      },
    },
    {
      name: "pending and dead entries are never deleted",
      async run() {
        await withDb(async (db) => {
          await db.outbox.put(outboxEntry("op-pending", { state: "pending" }));
          await db.outbox.put(outboxEntry("op-dead", { state: "dead" }));
          await db.outbox.put(outboxEntry("op-acked"));

          const deleted = await pruneAckedOutbox(db, ROOM_A, WALL + OUTBOX_TTL + 1);

          assertEqual(deleted, 1, "only the acked one");
          assert((await db.outbox.get("op-pending")) !== undefined, "pending is the backlog");
          assert((await db.outbox.get("op-dead")) !== undefined, "dead is a diagnostic");
          assertEqual(await db.outbox.get("op-acked"), undefined, "acked is gone");
        });
      },
    },
    {
      name: "another room's acked entries are untouched",
      async run() {
        await withDb(async (db) => {
          await db.outbox.put(outboxEntry("op-a"));
          await db.outbox.put(outboxEntry("op-b", { roomId: ROOM_B }));

          await pruneAckedOutbox(db, ROOM_A, WALL + OUTBOX_TTL + 1);

          assertEqual(await db.outbox.get("op-a"), undefined, "room A collected");
          assert((await db.outbox.get("op-b")) !== undefined, "room B untouched");
        });
      },
    },
    {
      name: "the cmd scan is floored, so a second prune inside the floor does nothing",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await db.meta.put({ key: "cmd:first", opId: "op-1", rowId: "r", createdAt: WALL });

          const first = await pruneRoom(db, ROOM_A, WALL + CMD_TTL + 1);
          assertEqual(first.commands, 1, "the first scan collected it");

          // Expired, but the floor has not elapsed — the scan must not run.
          // Strictly inside the floor: `HOUR` alone IS the floor, so the
          // boundary would pass for the wrong reason.
          await db.meta.put({ key: "cmd:second", opId: "op-2", rowId: "r", createdAt: WALL });
          const second = await pruneRoom(db, ROOM_A, WALL + CMD_TTL + 1 + HOUR / 2);
          assertEqual(second.commands, 0, "floored");
          assert((await db.meta.get("cmd:second")) !== undefined, "the record survives the floor");

          const third = await pruneRoom(db, ROOM_A, WALL + CMD_TTL + 1 + CMD_PRUNE_FLOOR + 1);
          assertEqual(third.commands, 1, "the floor elapsed and the scan ran");
          assertEqual(await db.meta.get("cmd:second"), undefined, "now collected");
        });
      },
    },
    {
      name: "the floor row is written only after a successful scan",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const realWhere = db.meta.where.bind(db.meta);
          db.meta.where = () => {
            throw new Error("boom");
          };

          let threw = false;
          try {
            await pruneRoom(db, WALL);
          } catch {
            threw = true;
          }
          assert(threw, "the scan threw");
          assertEqual(await db.meta.get(CMD_PRUNE_KEY), undefined, "no floor row was written");

          db.meta.where = realWhere;
          await pruneRoom(db, WALL);
          assert((await db.meta.get(CMD_PRUNE_KEY)) !== undefined, "the retry wrote the floor");
        });
      },
    },
    {
      name: "pruneRoom reports both counts",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await db.meta.put(legacyCmdRecord("old"));
          await db.outbox.put(outboxEntry("op-1"));

          const result = await pruneRoom(db, ROOM_A, WALL + OUTBOX_TTL + 1);

          assertEqual(result.commands, 1, "one receipt");
          assertEqual(result.outbox, 1, "one outbox entry");
        });
      },
    },
    {
      name: "SyncEngine.start() prunes, and the dial is not delayed by it",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          await db.meta.put(legacyCmdRecord("old"));
          await db.outbox.put(outboxEntry("op-1"));

          // The ordering is the assertion: at the moment the socket is
          // created, the receipt must still be there. Pruning first would
          // put a `cmd:` scan between the user and their socket.
          let atDial = null;
          const { engine, sockets } = makeEngine(db, {
            now: () => WALL + OUTBOX_TTL + 1,
            socketFactory: () => {
              const socket = fakeSocket();
              sockets.push(socket);
              atDial = db.meta.get("cmd:old");
              return socket;
            },
          });
          await engine.start();
          engine.stop();

          assert(atDial !== null, "the socket factory ran");
          assert((await atDial) !== undefined, "the receipt was still there at dial time");
          assertEqual(await db.meta.get("cmd:old"), undefined, "and collected afterwards");
          assertEqual(await db.outbox.get("op-1"), undefined, "the acked entry was collected");
          assertEqual(sockets.length, 1, "one socket");
        });
      },
    },
    {
      name: "a failing prune does not stop the engine from connecting",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          db.meta.where = () => {
            throw new Error("boom");
          };

          const { engine, sockets, statuses } = makeEngine(db);
          await engine.start();
          engine.stop();

          assertEqual(sockets.length, 1, "the socket was opened anyway");
          assert(statuses.includes("connecting"), "the engine reached connecting");
        });
      },
    },
  ],
};
