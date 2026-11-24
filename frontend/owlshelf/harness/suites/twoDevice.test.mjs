/**
 * twoDevice.test.mjs — do two engines actually converge?
 *
 * Every other sync suite drives ONE engine against a scripted socket. That
 * proves the engine's behaviour; it does not prove that two devices sharing a
 * room key end up with the same rows. This suite runs two real `SyncEngine`s
 * over an in-memory relay and asserts convergence — the thing the user
 * actually cares about.
 *
 * The specific question it answers: **does a fresh device converge without
 * anyone clicking catch-up?** Presence is supposed to trigger it (§6.6), and
 * if that path is broken the symptom is exactly "you have to hit catch-up".
 */

import { SyncEngine } from "../../src/lib/sync.ts";
import { executeCommand } from "../../src/lib/cmd.ts";
import { readRoom } from "../../src/lib/roomMeta.ts";
import { assert, assertEqual } from "../lib/assert.mjs";
import { disposeDb, freshDb } from "../lib/db.mjs";
import { DEVICE_A, DEVICE_B, ROOM_A, ROOM_KEY, seedRoom } from "../lib/fixtures.mjs";
import { makeRelay } from "../lib/relay.mjs";

const RELAY = "ws://relay.test/ws";

/** Let queued frames, timers, and Dexie transactions settle. */
const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Both devices carry the SAME roster, because that is what `importRoom` writes
 * when a second device joins. A roster of one device per side would make every
 * outbox entry ack immediately (`decideAck` skips the author and finds no other
 * member), which is a different scenario entirely.
 */
const ROSTER = [
  { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
  { deviceId: DEVICE_B, role: "member", addedAt: 0 },
];

/** A device: its own database, its own engine, the shared relay. */
async function makeDevice(relay, deviceId, engineOptions = {}, roster = ROSTER) {
  const db = await freshDb();
  await seedRoom(db, {
    relayUrl: RELAY,
    roomKey: ROOM_KEY,
    roster,
  });
  const engine = new SyncEngine({
    db,
    roomId: ROOM_A,
    deviceId,
    socketFactory: relay.socketFactory,
    // The shipped default is 5 s. A test that waited it out would take
    // minutes across five cases, so the interval is injected — the timer is
    // the same code either way.
    drainInterval: 50,
    ...engineOptions,
  });
  return { db, engine, deviceId };
}

/** Open the socket the engine just dialled. */
function openSocket(relay, index) {
  relay.sockets[index]?.open();
}

async function withTwoDevices(fn, relayOptions = {}, rosters = {}) {
  const relay = makeRelay(relayOptions);
  const a = await makeDevice(relay, DEVICE_A, {}, rosters.a ?? ROSTER);
  const b = await makeDevice(relay, DEVICE_B, {}, rosters.b ?? ROSTER);
  try {
    return await fn({ relay, a, b });
  } finally {
    a.engine.stop();
    b.engine.stop();
    await disposeDb(a.db);
    await disposeDb(b.db);
  }
}

/** Create one item on a device through the real command path. */
async function addItem(device, name, cmdId) {
  return executeCommand(
    device.db,
    { cmdId, roomId: ROOM_A, kind: "putItem", locationId: "loc-1", item: { name } },
    { deviceId: device.deviceId, now: () => Date.now(), uuid: () => `${cmdId}-u` },
  );
}

export default {
  name: "twoDevice — two engines over one relay converge (§6.6, Gate C)",
  tests: [
    {
      name: "a fresh device pulls existing history with NO manual catch-up",
      async run() {
        await withTwoDevices(async ({ relay, a, b }) => {
          // A already has history before B ever connects.
          await addItem(a, "Dune", "c1");
          await addItem(a, "Emma", "c2");

          await a.engine.start();
          openSocket(relay, 0);
          await settle();

          // B joins. Presence must trigger its catch-up on its own.
          await b.engine.start();
          openSocket(relay, 1);
          await settle(400);

          const items = await b.db.items.toArray();
          assertEqual(items.length, 2, "B pulled both rows without a manual catch-up");

          // Completion waits SETTLE (2 s) after the end marker, so the badge
          // is the last thing to settle — not a sign that anything is stuck.
          await settle(2_200);
          assertEqual(b.engine.currentStatus, "synced", "B reports synced");
        });
      },
    },
    {
      name: "an op created while both are connected reaches the peer without catch-up",
      async run() {
        await withTwoDevices(async ({ relay, a, b }) => {
          await a.engine.start();
          openSocket(relay, 0);
          await settle();
          await b.engine.start();
          openSocket(relay, 1);
          await settle(200);

          await addItem(a, "Dune", "c1");
          // The drain timer is 5 s; presence already fired, so wait past one
          // tick rather than guessing.
          await settle(600);

          const items = await b.db.items.toArray();
          const sent = relay.sockets[0]?.sent ?? [];
          assertEqual(
            items.length,
            1,
            `the push path delivered the op — sent=${JSON.stringify(
              sent.map((f) => f.kind ?? f.type),
            )} relay=${JSON.stringify(relay.log)}`,
          );
        });
      },
    },
    {
      name: "with broadcast dropped, catch-up still repairs the gap",
      async run() {
        // The relay swallows untargeted envelopes, so the push path cannot
        // work. Catch-up is targeted, so it must still converge the room.
        await withTwoDevices(
          async ({ relay, a, b }) => {
            await a.engine.start();
            openSocket(relay, 0);
            await settle();
            await b.engine.start();
            openSocket(relay, 1);
            await settle(200);

            await addItem(a, "Dune", "c1");
            await settle(300);
            assertEqual((await b.db.items.toArray()).length, 0, "the push was dropped");

            await b.engine.requestCatchup();
            await settle(300);
            assertEqual(
              (await b.db.items.toArray()).length,
              1,
              `catch-up repaired it — relay=${JSON.stringify(relay.log)}`,
            );
          },
          { dropBroadcast: true },
        );
      },
    },
    {
      name: "both directions converge: each device keeps its own op",
      async run() {
        await withTwoDevices(async ({ relay, a, b }) => {
          await a.engine.start();
          openSocket(relay, 0);
          await settle();
          await b.engine.start();
          openSocket(relay, 1);
          await settle(200);

          await addItem(a, "Dune", "c1");
          await addItem(b, "Emma", "c2");
          await settle(700);

          const aItems = (await a.db.items.toArray()).map((row) => row.name).sort();
          const bItems = (await b.db.items.toArray()).map((row) => row.name).sort();
          assertEqual(aItems.length, 2, "A has both");
          assertEqual(bItems.length, 2, "B has both");
          assertEqual(aItems.join(","), bItems.join(","), "same rows on both sides");
        });
      },
    },
    {
      name: "the room's cursors advance on both sides after convergence",
      async run() {
        await withTwoDevices(async ({ relay, a, b }) => {
          await a.engine.start();
          openSocket(relay, 0);
          await settle();
          await b.engine.start();
          openSocket(relay, 1);
          await settle(200);

          await addItem(a, "Dune", "c1");
          await settle(700);

          const roomB = await readRoom(b.db, ROOM_A);
          assert(roomB, "B has the room");
          assertEqual(roomB.cursorIn[DEVICE_A], 1, "B adopted A's seq 1");
        });
      },
    },
    {
      // `this.room` is loaded once at connect and never refreshed, so every
      // path that ADVERTISES our position (catch-up replies, audits, catch-up
      // requests) reports the counter as it was at connect time. The visible
      // symptom is the peer's outbox never clearing: it is told we adopted
      // nothing, so it keeps the entry pending forever.
      name: "a device advertises its CURRENT cursors, not the ones it had at connect",
      async run() {
        await withTwoDevices(async ({ relay, a, b }) => {
          await a.engine.start();
          openSocket(relay, 0);
          await settle();
          await b.engine.start();
          openSocket(relay, 1);
          await settle(200);

          // B authors an op. It stays pending until A proves adoption.
          await addItem(b, "Emma", "c1");
          await settle(300);

          // A pulls it, so A's cursorIn[DEVICE_B] is now 1.
          await a.engine.requestCatchup();
          await settle(300);
          const roomA = await readRoom(a.db, ROOM_A);
          assertEqual(roomA.cursorIn[DEVICE_B], 1, "A adopted B's seq 1");

          // A now advertises that adoption. B must be able to ack.
          await a.engine.sendAudit();
          await settle(300);

          const entry = await b.db.outbox.toArray();
          assertEqual(entry.length, 1, "one outbox entry");
          assertEqual(
            entry[0].state,
            "acked",
            "B cleared the entry once A advertised the adoption",
          );
        });
      },
    },
    {
      // The dev export/import writes the joiner into ITS OWN roster and cannot
      // reach back to the owner's, so the owner's roster still lists only
      // itself. `decideAck` then finds nobody to wait for and acks every op on
      // creation — the owner never announces anything. This is the asymmetry
      // the user hit: the joiner pushes, the owner does not.
      name: "the OWNER announces new ops even when its roster never learned about the joiner",
      async run() {
        await withTwoDevices(
          async ({ relay, a, b }) => {
            await a.engine.start();
            openSocket(relay, 0);
            await settle();
            await b.engine.start();
            openSocket(relay, 1);
            await settle(300);

            // A's roster is [A] only — exactly what `importRoom` leaves behind.
            await addItem(a, "Dune", "c1");
            await settle(400);

            const sent = (relay.sockets[0]?.sent ?? []).map((f) => f.kind ?? f.type);
            assert(
              sent.includes("op"),
              `the owner sent its op — sent=${JSON.stringify(sent)}`,
            );
            assertEqual(
              (await b.db.items.toArray()).length,
              1,
              "the joiner received it",
            );
          },
          {},
          { a: [{ deviceId: DEVICE_A, role: "owner", addedAt: 0 }] },
        );
      },
    },
  ],
};
