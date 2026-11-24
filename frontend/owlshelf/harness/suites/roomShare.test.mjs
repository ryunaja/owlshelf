/**
 * roomShare.test.mjs — the dev-only room hand-off (§13, Gate G).
 *
 * NOT §6.7's pairing: no roster anchor, no owner signature, no revocation. It
 * is exactly what two devices need to decrypt each other's envelopes, so op
 * convergence can be tested before step 6 exists.
 *
 * ── Why this suite exists separately ──────────────────────────────────────
 *
 * `importRoom` WRITES — a `room:` meta row and a `profiles` row in one
 * transaction — so when the engine moved into the worker (§5.5) it moved out of
 * the dev panel and into `lib/roomShare.ts`. These tests follow it: they call
 * the module directly rather than going through the panel, because the panel is
 * now only a caller.
 *
 * The refusal cases matter more than the happy path. A re-import over a
 * populated room would remap nothing and silently fork the authorSeq space, so
 * every guard below is load-bearing.
 */

import { exportRoom, importRoom, setRoomRelayUrl } from "../../src/lib/roomShare.ts";
import { readRoom } from "../../src/lib/roomMeta.ts";
import { CommandError } from "../../src/lib/cmd.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, DEVICE_B, ROOM_A, ROOM_B, ROOM_KEY, seedRoom } from "../lib/fixtures.mjs";

const RELAY = "ws://relay.test/ws";

/** A valid export payload, as `exportRoom` would produce it. */
function payload(overrides = {}) {
  return {
    v: 1,
    roomId: ROOM_A,
    relayUrl: RELAY,
    keyGen: 1,
    roomKey: ROOM_KEY,
    roster: [{ deviceId: DEVICE_B, role: "owner", addedAt: 0 }],
    profile: { name: "Shared", type: "personal", avatarEmoji: "👤" },
    ...overrides,
  };
}

/** Assert that `fn` rejects with a `CommandError` whose message contains `text`. */
async function assertRefused(fn, text, label) {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof CommandError, `${label}: a CommandError`);
    assertEqual(error.code, "validation", `${label}: validation code`);
    assert(error.message.includes(text), `${label}: message mentions "${text}"`);
    return;
  }
  throw new Error(`${label}: expected a refusal, got success`);
}

export default {
  name: "roomShare — the dev-only room hand-off (§13)",
  tests: [
    {
      name: "exportRoom serialises the key, generation, relay and roster",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY, keyGen: 3 });
          await db.table("profiles").put({
            id: ROOM_A,
            name: "Shelf",
            type: "business",
            avatarEmoji: "📚",
            deletedAt: null,
          });

          const text = await exportRoom(db, ROOM_A);
          assert(text !== null, "an export was produced");
          const parsed = JSON.parse(text);

          assertEqual(parsed.v, 1, "versioned");
          assertEqual(parsed.roomId, ROOM_A, "roomId");
          assertEqual(parsed.relayUrl, RELAY, "relay URL");
          assertEqual(parsed.keyGen, 3, "the CURRENT generation travels with the key");
          assertEqual(parsed.roomKey, ROOM_KEY, "the key");
          assertDeepEqual(parsed.roster, [{ deviceId: DEVICE_A, role: "owner", addedAt: 0 }], "roster");
          assertDeepEqual(
            parsed.profile,
            { name: "Shelf", type: "business", avatarEmoji: "📚" },
            "profile",
          );
        });
      },
    },
    {
      name: "exportRoom for a room that does not exist returns null",
      async run() {
        await withDb(async (db) => {
          assertEqual(await exportRoom(db, "no-such-room"), null, "null, not a throw");
        });
      },
    },
    {
      name: "importRoom rejects malformed payloads without writing",
      async run() {
        await withDb(async (db) => {
          const cases = [
            ["not json", "not valid JSON"],
            ["null", "expected an object"],
            [JSON.stringify(payload({ v: 2 })), "unsupported version"],
            [JSON.stringify(payload({ roomId: "bad id!" })), "bad roomId"],
            [JSON.stringify(payload({ roomKey: undefined })), "missing roomKey"],
            [JSON.stringify(payload({ roomKey: "AAAA" })), "not 32 bytes"],
            [JSON.stringify(payload({ keyGen: 0 })), "bad keyGen"],
          ];
          for (const [text, expected] of cases) {
            await assertRefused(
              () => importRoom(db, async () => DEVICE_A, text),
              expected,
              expected,
            );
          }
          assertEqual(await readRoom(db, ROOM_A), undefined, "nothing was written");
        });
      },
    },
    {
      name: "importRoom writes the room with a fresh authorSeq and empty cursors",
      async run() {
        await withDb(async (db) => {
          await importRoom(db, async () => DEVICE_A, JSON.stringify(payload()));

          const room = await readRoom(db, ROOM_A);
          assert(room, "the room exists");
          assertEqual(room.nextAuthorSeq, 1, "a fresh authorSeq space, never the exporter's");
          assertDeepEqual(room.cursorIn, {}, "empty cursors — the join's whole point");
          assertEqual(room.keyGen, 1, "the generation came across");
          assertEqual(room.roomKey, ROOM_KEY, "the key came across");
          assertEqual(room.relayUrl, RELAY, "the relay came across");
          assertEqual(room.migration, "promoted", "already migrated");

          const profile = await db.table("profiles").get(ROOM_A);
          assert(profile, "the profile row exists");
          assertEqual(profile.name, "Shared", "the profile name came across");
        });
      },
    },
    {
      name: "importRoom adds this device to the roster as a member",
      async run() {
        await withDb(async (db) => {
          await importRoom(db, async () => DEVICE_A, JSON.stringify(payload()));

          const room = await readRoom(db, ROOM_A);
          const mine = room.roster.find((m) => m.deviceId === DEVICE_A);
          assert(mine, "this device is on the roster");
          assertEqual(mine.role, "member", "as a member, not the owner");
          assert(
            room.roster.some((m) => m.deviceId === DEVICE_B),
            "the exporter is still there",
          );
        });
      },
    },
    {
      name: "importRoom refuses a room that already exists here with data",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await db.ops.put({
            opId: "o1",
            roomId: ROOM_A,
            deviceId: DEVICE_A,
            authorSeq: 1,
            hlcTs: 1,
            hlcCounter: 0,
            type: "put",
            table: "items",
            rowId: "i1",
            payload: { name: "Book", locationId: "l1" },
          });

          await assertRefused(
            () => importRoom(db, async () => DEVICE_A, JSON.stringify(payload())),
            "already exists here with data",
            "populated room",
          );

          const room = await readRoom(db, ROOM_A);
          assertEqual(room.nextAuthorSeq, 1, "the existing room was not rewritten");
        });
      },
    },
    {
      // audit-2 N10: a device legitimately holds several rooms, so an unrelated
      // room is not a merge hazard. Refusing per DEVICE would make a second
      // profile impossible to join.
      name: "importRoom refuses per ROOM, not per device (audit-2 N10)",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_B });
          await db.ops.put({
            opId: "o1",
            roomId: ROOM_B,
            deviceId: DEVICE_A,
            authorSeq: 1,
            hlcTs: 1,
            hlcCounter: 0,
            type: "put",
            table: "items",
            rowId: "i1",
            payload: { name: "Book", locationId: "l1" },
          });

          // A DIFFERENT room, on a device that already holds one with data.
          await importRoom(db, async () => DEVICE_A, JSON.stringify(payload()));

          const room = await readRoom(db, ROOM_A);
          assert(room, "the second room was joined");
          assertEqual(room.roomId, ROOM_A, "and it is the right one");
        });
      },
    },
    {
      name: "a room exported from one device imports into another with the same key",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A, relayUrl: RELAY, keyGen: 2 });
          const text = await exportRoom(db, ROOM_A);
          assert(text !== null, "exported");

          // A second device, with its own database.
          await withDb(async (other) => {
            await importRoom(other, async () => DEVICE_B, text);
            const room = await readRoom(other, ROOM_A);
            assert(room, "joined");
            assertEqual(room.roomKey, ROOM_KEY, "same key, so envelopes decrypt");
            assertEqual(room.keyGen, 2, "same generation, so the relay accepts them");
            assertEqual(room.relayUrl, RELAY, "same relay");
            assert(
              room.roster.some((m) => m.deviceId === DEVICE_B && m.role === "member"),
              "the joiner is on the roster",
            );
          });
        });
      },
    },
    {
      name: "setRoomRelayUrl persists, and an empty string becomes null",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await setRoomRelayUrl(db, ROOM_A, RELAY);
          assertEqual((await readRoom(db, ROOM_A)).relayUrl, RELAY, "persisted");

          await setRoomRelayUrl(db, ROOM_A, "   ");
          assertEqual((await readRoom(db, ROOM_A)).relayUrl, null, "null, not empty string");
        });
      },
    },
    {
      name: "setRoomRelayUrl on a missing room is a no-op, not a throw",
      async run() {
        await withDb(async (db) => {
          await setRoomRelayUrl(db, "no-such-room", RELAY);
          assertEqual(await readRoom(db, "no-such-room"), undefined, "nothing created");
        });
      },
    },
  ],
};
