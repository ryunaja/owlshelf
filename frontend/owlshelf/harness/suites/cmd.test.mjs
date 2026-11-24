/**
 * cmd.test.mjs — plan §6.3, executed.
 *
 * The command path is where durability is promised, so the tests that matter
 * most are the ones about what happens when the transaction does NOT commit:
 * the ack must reject, and nothing may survive.
 */

import { CommandError, executeCommand, executeMoveMany } from "../../src/lib/cmd.ts";
import { sha256Hex } from "../../src/lib/hash.ts";
import { assert, assertDeepEqual, assertEqual, assertRejectsWith } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import {
  DEVICE_A,
  ROOM_A,
  ROOM_B,
  fixedClock,
  fixedUuid,
  putPayload,
  seedRoom,
} from "../lib/fixtures.mjs";

const WALL = 1_700_000_000_000;

function options(overrides = {}) {
  return { deviceId: DEVICE_A, now: fixedClock(WALL), uuid: fixedUuid("u"), ...overrides };
}

export default {
  name: "cmd — one writer, one transaction (§6.3)",
  tests: [
    {
      name: "putItem mints one op, writes the row, the outbox entry, and the counter",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const ack = await executeCommand(
            db,
            { cmdId: "c1", roomId: ROOM_A, kind: "putItem", locationId: "loc-1", item: { name: "Dune" } },
            options(),
          );
          assertEqual(ack.opIds.length, 1, "one op");

          const op = await db.ops.get(ack.opIds[0]);
          assertEqual(op.authorSeq, 1, "authorSeq");
          assertEqual(op.roomId, ROOM_A, "roomId");
          assertEqual(op.deviceId, DEVICE_A, "deviceId");
          assertEqual(op.type, "put", "type");

          const row = await db.items.get(ack.rowId);
          assertEqual(row.name, "Dune", "row name");
          assertEqual(row.profileId, ROOM_A, "profileId filled from the room");
          assertEqual(row.deletedAt, null, "live row says so explicitly");
          assertEqual(typeof row.winner, "string", "winner metadata");

          const outbox = await db.outbox.toArray();
          assertEqual(outbox.length, 1, "one outbox entry");
          assertEqual(outbox[0].state, "pending", "state");
          assertEqual(outbox[0].authorSeq, 1, "the entry carries its own seq");

          const room = await db.meta.get(`room:${ROOM_A}`);
          assertEqual(room.nextAuthorSeq, 2, "counter advanced");
        });
      },
    },
    {
      name: "a retried cmdId returns the ORIGINAL ack and mints nothing",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const command = {
            cmdId: "same",
            roomId: ROOM_A,
            kind: "putItem",
            locationId: "loc-1",
            item: { name: "Dune" },
          };
          const first = await executeCommand(db, command, options());
          const second = await executeCommand(db, command, options());
          assertDeepEqual(second, first, "same ack");
          assertEqual(await db.ops.count(), 1, "one op");
          assertEqual(await db.outbox.count(), 1, "one outbox entry");
          const room = await db.meta.get(`room:${ROOM_A}`);
          assertEqual(room.nextAuthorSeq, 2, "the counter moved once");
        });
      },
    },
    {
      name: "the ack is gated on COMMIT: an aborted transaction rejects and leaves nothing (R4-P1-6)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });

          // One seam across both commands. Calls 1–2 are the seed's rowId and
          // opId; calls 3–4 are the move's destination rowId and opId; call 5
          // throws, so the transaction aborts AFTER the destination put was
          // written — exactly the case the old `onsuccess` idiom reported as
          // success.
          let calls = 0;
          const uuid = () => {
            calls += 1;
            if (calls === 5) throw new Error("harness: injected failure");
            return `u-${calls}`;
          };
          const opts = { deviceId: DEVICE_A, now: fixedClock(WALL), uuid };

          await executeCommand(
            db,
            { cmdId: "seed", roomId: ROOM_A, kind: "putItem", locationId: "loc-1", item: { name: "Dune" } },
            opts,
          );
          const itemId = (await db.items.toArray()).find((row) => row.profileId === ROOM_A).id;

          await assertRejectsWith(
            () =>
              executeCommand(
                db,
                {
                  cmdId: "abort",
                  roomId: ROOM_A,
                  kind: "moveItem",
                  itemId,
                  destination: { roomId: ROOM_B, locationId: "loc-b" },
                },
                opts,
              ),
            (error) => error instanceof CommandError,
            "the command rejects",
          );

          const rows = await db.items.toArray();
          assertEqual(rows.length, 1, "the destination row did not survive the abort");
          assertEqual(rows[0].deletedAt, null, "the source row is still live");
          assertEqual(await db.ops.count(), 1, "no op survived");
          assertEqual(await db.outbox.count(), 1, "no outbox entry survived");
        });
      },
    },
    {
      name: "deleteItem writes a tombstone, not a hard delete",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const created = await executeCommand(
            db,
            { cmdId: "c1", roomId: ROOM_A, kind: "putItem", locationId: "loc-1", item: { name: "Dune" } },
            options(),
          );
          await executeCommand(
            db,
            { cmdId: "c2", roomId: ROOM_A, kind: "deleteItem", itemId: created.rowId },
            options(),
          );
          const row = await db.items.get(created.rowId);
          assertEqual(typeof row.deletedAt, "number", "tombstoned");
          assertEqual(row.name, "Dune", "content survives for restore");
        });
      },
    },
    {
      name: "putLocation fills profileId from the room and drops itemCount",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const ack = await executeCommand(
            db,
            {
              cmdId: "c1",
              roomId: ROOM_A,
              kind: "putLocation",
              location: { name: "Shelf", icon: "📦", description: "", itemCount: 9 },
            },
            options(),
          );
          const row = await db.locations.get(ack.rowId);
          assertEqual(row.profileId, ROOM_A, "profileId");
          assertEqual("itemCount" in row, false, "itemCount dropped");
        });
      },
    },
    {
      name: "deleteLocation tombstones the location",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const ack = await executeCommand(
            db,
            { cmdId: "c1", roomId: ROOM_A, kind: "putLocation", location: { name: "Shelf" } },
            options(),
          );
          await executeCommand(
            db,
            { cmdId: "c2", roomId: ROOM_A, kind: "deleteLocation", locationId: ack.rowId },
            options(),
          );
          const row = await db.locations.get(ack.rowId);
          assertEqual(typeof row.deletedAt, "number", "tombstoned");
        });
      },
    },
    {
      name: "resolveConflict keep:row restores the row from the supplied content",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const created = await executeCommand(
            db,
            { cmdId: "c1", roomId: ROOM_A, kind: "putItem", locationId: "loc-1", item: { name: "Dune" } },
            options(),
          );
          await executeCommand(
            db,
            { cmdId: "c2", roomId: ROOM_A, kind: "deleteItem", itemId: created.rowId },
            options(),
          );
          await executeCommand(
            db,
            {
              cmdId: "c3",
              roomId: ROOM_A,
              kind: "resolveConflict",
              table: "items",
              rowId: created.rowId,
              keep: "row",
              content: putPayload("items", { name: "Restored" }),
            },
            options(),
          );
          const row = await db.items.get(created.rowId);
          assertEqual(row.name, "Restored", "restored");
          assertEqual(row.deletedAt, null, "live again");
        });
      },
    },
    {
      name: "moveItem within one room is ONE put with the new locationId",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const created = await executeCommand(
            db,
            { cmdId: "c1", roomId: ROOM_A, kind: "putItem", locationId: "loc-1", item: { name: "Dune" } },
            options(),
          );
          const ack = await executeCommand(
            db,
            {
              cmdId: "c2",
              roomId: ROOM_A,
              kind: "moveItem",
              itemId: created.rowId,
              destination: { roomId: ROOM_A, locationId: "loc-2" },
            },
            options(),
          );
          assertEqual(ack.opIds.length, 1, "one op");
          assertEqual(ack.rowId, created.rowId, "same row");
          const row = await db.items.get(created.rowId);
          assertEqual(row.locationId, "loc-2", "moved");
          assertEqual(row.deletedAt, null, "no tombstone");
        });
      },
    },
    {
      name: "moveItem across rooms is TWO ops: destination put, then source tombstone",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          // One uuid seam across both commands: a fresh seam per command would
          // hand the destination the source's rowId, which is the collision the
          // new-rowId rule exists to avoid.
          const opts = options();
          const created = await executeCommand(
            db,
            { cmdId: "c1", roomId: ROOM_A, kind: "putItem", locationId: "loc-a", item: { name: "Dune" } },
            opts,
          );
          const ack = await executeCommand(
            db,
            {
              cmdId: "c2",
              roomId: ROOM_A,
              kind: "moveItem",
              itemId: created.rowId,
              destination: { roomId: ROOM_B, locationId: "loc-b" },
            },
            opts,
          );

          assertEqual(ack.opIds.length, 2, "two ops");
          const [destinationOp, sourceOp] = await Promise.all(ack.opIds.map((id) => db.ops.get(id)));
          assertEqual(destinationOp.type, "put", "destination put first");
          assertEqual(destinationOp.roomId, ROOM_B, "destination op belongs to room B");
          assertEqual(sourceOp.type, "delete", "source delete second");
          assertEqual(sourceOp.roomId, ROOM_A, "source op belongs to room A");

          const destination = await db.items.get(ack.rowId);
          assertEqual(destination.profileId, ROOM_B, "destination row in room B");
          assertEqual(destination.locationId, "loc-b", "destination location");
          assertEqual(destination.name, "Dune", "content copied");

          const source = await db.items.get(created.rowId);
          assertEqual(typeof source.deletedAt, "number", "source tombstoned");

          const roomA = await db.meta.get(`room:${ROOM_A}`);
          const roomB = await db.meta.get(`room:${ROOM_B}`);
          assertEqual(roomA.nextAuthorSeq, 3, "room A minted the delete");
          assertEqual(roomB.nextAuthorSeq, 2, "room B minted the put");
        });
      },
    },
    {
      // §8.1: "Cross-room moves copy the blob to the destination room's
      // `files` row (same hash, new roomId) in the same transaction as the
      // destination put." Without it the destination row references a hash
      // that room cannot resolve, and the source tombstone is the only thing
      // keeping the bytes alive.
      name: "a cross-room move copies the blob into the destination room",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          const opts = options();

          const bytes = new Uint8Array([9, 8, 7]);
          const hash = await sha256Hex(bytes);
          await db.files.put({
            roomId: ROOM_A,
            hash,
            bytes,
            size: bytes.byteLength,
            contentType: "image/webp",
            createdAt: 1,
          });

          const created = await executeCommand(
            db,
            {
              cmdId: "c1",
              roomId: ROOM_A,
              kind: "putItem",
              locationId: "loc-a",
              item: { name: "Dune", imageUrl: `idb://${hash}` },
            },
            opts,
          );

          await executeCommand(
            db,
            {
              cmdId: "move",
              roomId: ROOM_A,
              kind: "moveItem",
              itemId: created.rowId,
              destination: { roomId: ROOM_B, locationId: "loc-b" },
            },
            opts,
          );

          const source = await db.files.get([ROOM_A, hash]);
          const destination = await db.files.get([ROOM_B, hash]);
          assert(source, "the source copy survives the move");
          assert(destination, "the destination room has its own row");
          assertEqual(destination.size, bytes.byteLength, "same bytes");
          assertEqual(destination.contentType, "image/webp", "same content type");
        });
      },
    },
    {
      name: "a cross-room move of an item with no blob writes no file row",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          const opts = options();
          const created = await executeCommand(
            db,
            { cmdId: "c1", roomId: ROOM_A, kind: "putItem", locationId: "loc-a", item: { name: "Dune" } },
            opts,
          );
          await executeCommand(
            db,
            {
              cmdId: "move",
              roomId: ROOM_A,
              kind: "moveItem",
              itemId: created.rowId,
              destination: { roomId: ROOM_B, locationId: "loc-b" },
            },
            opts,
          );
          assertEqual(await db.files.count(), 0, "no phantom file row");
        });
      },
    },
    {
      // The plan never specifies partial moves; `stock` is a per-row count and
      // every move in the plan is row-level. Moving fewer copies than the row
      // holds therefore SPLITS the row rather than incrementing a destination
      // row: the reducer is last-writer-wins per row, so two concurrent
      // "move 2 to B" would both read the old count and both write the same
      // new one, losing copies. A new row per move is the only convergent
      // representation.
      name: "a partial same-room move splits the row into a new row plus a remainder",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          // One options object: `fixedUuid` restarts its sequence per call, so
          // a second `options()` would mint the split row with the source id.
          const opts = options();
          const created = await executeCommand(
            db,
            {
              cmdId: "c1",
              roomId: ROOM_A,
              kind: "putItem",
              locationId: "loc-1",
              item: { name: "Dune", stock: 5 },
            },
            opts,
          );
          const ack = await executeCommand(
            db,
            {
              cmdId: "c2",
              roomId: ROOM_A,
              kind: "moveItem",
              itemId: created.rowId,
              destination: { roomId: ROOM_A, locationId: "loc-2" },
              amount: 2,
            },
            opts,
          );

          assertEqual(ack.opIds.length, 2, "two puts: the split row and the remainder");
          assert(ack.rowId !== created.rowId, "the moved copies get a NEW row");

          const moved = await db.items.get(ack.rowId);
          assertEqual(moved.locationId, "loc-2", "moved copies are on the destination shelf");
          assertEqual(moved.stock, 2, "moved copies");
          assertEqual(moved.deletedAt, null, "live");

          const remainder = await db.items.get(created.rowId);
          assertEqual(remainder.locationId, "loc-1", "the remainder stays put");
          assertEqual(remainder.stock, 3, "remainder copies");
          assertEqual(remainder.deletedAt, null, "the source row is NOT tombstoned");
        });
      },
    },
    {
      name: "a partial cross-room move copies the blob and leaves the remainder behind",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          const opts = options();

          const bytes = new Uint8Array([4, 5, 6]);
          const hash = await sha256Hex(bytes);
          await db.files.put({
            roomId: ROOM_A,
            hash,
            bytes,
            size: bytes.byteLength,
            contentType: "image/webp",
            createdAt: 1,
          });

          const created = await executeCommand(
            db,
            {
              cmdId: "c1",
              roomId: ROOM_A,
              kind: "putItem",
              locationId: "loc-a",
              item: { name: "Dune", stock: 4, imageUrl: `idb://${hash}` },
            },
            opts,
          );

          const ack = await executeCommand(
            db,
            {
              cmdId: "move",
              roomId: ROOM_A,
              kind: "moveItem",
              itemId: created.rowId,
              destination: { roomId: ROOM_B, locationId: "loc-b" },
              amount: 1,
            },
            opts,
          );

          const moved = await db.items.get(ack.rowId);
          assertEqual(moved.profileId, ROOM_B, "moved copies live in the destination room");
          assertEqual(moved.stock, 1, "moved copies");
          assertEqual(moved.imageUrl, `idb://${hash}`, "the photo came along");

          const remainder = await db.items.get(created.rowId);
          assertEqual(remainder.profileId, ROOM_A, "the remainder stays in the source room");
          assertEqual(remainder.stock, 3, "remainder copies");
          assertEqual(remainder.deletedAt, null, "no tombstone on a partial move");

          assert(await db.files.get([ROOM_A, hash]), "the source room keeps its bytes");
          assert(await db.files.get([ROOM_B, hash]), "the destination room has its own row");
        });
      },
    },
    {
      name: "moving every copy is a full move, not a split",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          const opts = options();
          const created = await executeCommand(
            db,
            {
              cmdId: "c1",
              roomId: ROOM_A,
              kind: "putItem",
              locationId: "loc-a",
              item: { name: "Dune", stock: 3 },
            },
            opts,
          );
          const ack = await executeCommand(
            db,
            {
              cmdId: "move",
              roomId: ROOM_A,
              kind: "moveItem",
              itemId: created.rowId,
              destination: { roomId: ROOM_B, locationId: "loc-b" },
              amount: 3,
            },
            opts,
          );

          assertEqual(ack.opIds.length, 2, "destination put + source tombstone");
          const moved = await db.items.get(ack.rowId);
          assertEqual(moved.stock, 3, "all copies moved");
          const source = await db.items.get(created.rowId);
          assert(source.deletedAt !== null, "the source row is tombstoned");
        });
      },
    },
    {
      name: "an amount outside 1..stock is a validation error and writes nothing",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const created = await executeCommand(
            db,
            {
              cmdId: "c1",
              roomId: ROOM_A,
              kind: "putItem",
              locationId: "loc-1",
              item: { name: "Dune", stock: 2 },
            },
            options(),
          );
          const before = await db.ops.count();

          for (const amount of [0, -1, 3, 1.5]) {
            await assertRejectsWith(
              () =>
                executeCommand(
                  db,
                  {
                    cmdId: `bad-${amount}`,
                    roomId: ROOM_A,
                    kind: "moveItem",
                    itemId: created.rowId,
                    destination: { roomId: ROOM_A, locationId: "loc-2" },
                    amount,
                  },
                  options(),
                ),
              (error) => error instanceof CommandError && error.code === "validation",
              `amount ${amount} rejected`,
            );
          }

          assertEqual(await db.ops.count(), before, "no op was minted");
          const row = await db.items.get(created.rowId);
          assertEqual(row.stock, 2, "the row is untouched");
          assertEqual(row.locationId, "loc-1", "still on its shelf");
        });
      },
    },
    {
      // Gate E: "a bulk move reports per item". One bad item must not roll
      // back the others, and the caller must be able to tell which failed.
      name: "a bulk move reports per item and keeps the successes",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          const opts = options();

          const first = await executeCommand(
            db,
            { cmdId: "c1", roomId: ROOM_A, kind: "putItem", locationId: "loc-a", item: { name: "Dune" } },
            opts,
          );
          const second = await executeCommand(
            db,
            { cmdId: "c2", roomId: ROOM_A, kind: "putItem", locationId: "loc-a", item: { name: "Emma" } },
            opts,
          );

          const results = await executeMoveMany(
            db,
            {
              cmdId: "bulk",
              roomId: ROOM_A,
              itemIds: [first.rowId, "does-not-exist", second.rowId],
              destination: { roomId: ROOM_B, locationId: "loc-b" },
            },
            opts,
          );

          assertEqual(results.length, 3, "one result per input item");
          assertEqual(results[0].ok, true, "first moved");
          assertEqual(results[1].ok, false, "the missing item failed");
          assert(results[1].error.length > 0, "and says why");
          assertEqual(results[2].ok, true, "third moved despite the failure");

          const moved = await db.items.where("profileId").equals(ROOM_B).toArray();
          assertEqual(moved.length, 2, "both good items reached the destination");
        });
      },
    },
    {
      name: "a bulk move is idempotent per item",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          const opts = options();
          const created = await executeCommand(
            db,
            { cmdId: "c1", roomId: ROOM_A, kind: "putItem", locationId: "loc-a", item: { name: "Dune" } },
            opts,
          );
          const request = {
            cmdId: "bulk",
            roomId: ROOM_A,
            itemIds: [created.rowId],
            destination: { roomId: ROOM_B, locationId: "loc-b" },
          };
          const first = await executeMoveMany(db, request, opts);
          const second = await executeMoveMany(db, request, opts);
          assertDeepEqual(second, first, "same results");
          assertEqual(await db.ops.count(), 3, "no extra ops");
        });
      },
    },
    {
      name: "a retried cross-room move returns both opIds and the same destination row",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          const opts = options();
          const created = await executeCommand(
            db,
            { cmdId: "c1", roomId: ROOM_A, kind: "putItem", locationId: "loc-a", item: { name: "Dune" } },
            opts,
          );
          const command = {
            cmdId: "move",
            roomId: ROOM_A,
            kind: "moveItem",
            itemId: created.rowId,
            destination: { roomId: ROOM_B, locationId: "loc-b" },
          };
          const first = await executeCommand(db, command, opts);
          const second = await executeCommand(db, command, opts);
          assertDeepEqual(second, first, "same ack");
          assertEqual(await db.ops.count(), 3, "no extra ops");
          const record = await db.meta.get("cmd:move");
          assertDeepEqual(record.opIds, first.opIds, "the record holds both opIds");
          assertEqual(record.rowId, first.rowId, "and the destination row");
        });
      },
    },
    {
      name: "an unknown room is a validation error, not a silent write",
      async run() {
        await withDb(async (db) => {
          await assertRejectsWith(
            () =>
              executeCommand(
                db,
                { cmdId: "c1", roomId: "nope", kind: "putItem", locationId: "l", item: { name: "x" } },
                options(),
              ),
            (error) => error instanceof CommandError && error.code === "validation",
            "validation error",
          );
          assertEqual(await db.ops.count(), 0, "nothing minted");
        });
      },
    },
    {
      name: "a malformed payload is rejected before anything is minted",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          // `stock: -1` fails §15.3 on the MINT side too — the mint-side
          // defaults only fill ABSENT fields, they never repair bad values.
          await assertRejectsWith(
            () =>
              executeCommand(
                db,
                {
                  cmdId: "c1",
                  roomId: ROOM_A,
                  kind: "putItem",
                  locationId: "loc-1",
                  item: { name: "Dune", stock: -1 },
                },
                options(),
              ),
            (error) => error instanceof CommandError && error.code === "validation",
            "validation error",
          );
          assertEqual(await db.ops.count(), 0, "nothing minted");
          assertEqual(await db.outbox.count(), 0, "no outbox entry");
          assertEqual(await db.items.count(), 0, "no row");
          const room = await db.meta.get(`room:${ROOM_A}`);
          assertEqual(room.nextAuthorSeq, 1, "the counter did not move");
        });
      },
    },
    {
      name: "a location with an empty name is rejected on mint (no 'Untitled' fallback)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await assertRejectsWith(
            () =>
              executeCommand(
                db,
                { cmdId: "c1", roomId: ROOM_A, kind: "putLocation", location: { name: "" } },
                options(),
              ),
            (error) => error instanceof CommandError && error.code === "validation",
            "validation error",
          );
          assertEqual(await db.locations.count(), 0, "no row");
        });
      },
    },
    {
      name: "a colliding mint aborts loudly and never double-appends",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          // Another engine already spent seq 1 but the room record still says
          // 1: every attempt collides on the unique index.
          await db.ops.put({
            opId: "squatter",
            roomId: ROOM_A,
            deviceId: DEVICE_A,
            authorSeq: 1,
            hlcTs: WALL,
            hlcCounter: 0,
            type: "put",
            table: "items",
            rowId: "squatter-row",
            payload: putPayload("items"),
          });
          await assertRejectsWith(
            () =>
              executeCommand(
                db,
                { cmdId: "c1", roomId: ROOM_A, kind: "putItem", locationId: "loc-1", item: { name: "Dune" } },
                options(),
              ),
            (error) => error instanceof CommandError && error.code === "constraint",
            "constraint error",
          );
          assertEqual(await db.ops.count(), 1, "only the squatter's op exists");
          assertEqual(await db.outbox.count(), 0, "no outbox entry");
        });
      },
    },
  ],
};
