/**
 * integration.test.mjs — the real client against the real relay (§5.3).
 *
 * Every other sync suite drives the engine against a fake socket, and
 * `backend/tests/` drives the relay against a fake client. **Nothing tested
 * them against each other**, so the wire was verified twice, independently,
 * against two readings of §15.4 — which is exactly how the divergences in
 * `owlshelf-code-vs-plan.md` §1 went unnoticed.
 *
 * This suite closes that: `backend/main.py` runs as a child process on a free
 * port, and the shipped `SyncEngine` dials it over `ws` with a real `Origin`
 * header. Nothing is faked except the database (fake-indexeddb) and the clock.
 *
 * The relay is expensive to start, so it is started once per suite via the
 * runner's `before`/`after` hooks rather than per test.
 */

import { WebSocket } from "ws";
import { SyncEngine } from "../../src/lib/sync.ts";
import { executeCommand } from "../../src/lib/cmd.ts";
import { readRoom } from "../../src/lib/roomMeta.ts";
import { createWorkerHost } from "../../src/lib/worker/host.ts";
import { assert, assertEqual } from "../lib/assert.mjs";
import { disposeDb, freshDb } from "../lib/db.mjs";
import {
  DEVICE_A,
  DEVICE_B,
  ROOM_A,
  ROOM_B,
  ROOM_KEY,
  ROOM_KEY_B,
  seedRoom,
} from "../lib/fixtures.mjs";
import { TEST_ORIGIN, startRelay } from "../integration/relay.mjs";
import { relaySocketFactory } from "../integration/socket.mjs";

/** Let queued frames, timers, and Dexie transactions settle. */
const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds, or fail with `message`. */
async function waitFor(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await settle(50);
  }
  throw new Error(`timed out after ${timeoutMs} ms: ${message}`);
}

const ROSTER = [
  { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
  { deviceId: DEVICE_B, role: "member", addedAt: 0 },
];

/** A device: its own database, its own engine, the real relay. */
async function makeDevice(relayUrl, deviceId, options = {}) {
  const db = await freshDb();
  await seedRoom(db, { relayUrl, roomKey: ROOM_KEY, roster: ROSTER });
  const sockets = [];
  const factory = relaySocketFactory(TEST_ORIGIN);
  const engine = new SyncEngine({
    db,
    roomId: ROOM_A,
    deviceId,
    socketFactory: (url) => {
      const socket = factory(url);
      sockets.push(socket);
      return socket;
    },
    // The shipped default is 5 s; a test that waited it out would take
    // minutes. The timer is the same code either way.
    drainInterval: 50,
    ...options,
  });
  return { db, engine, deviceId, sockets };
}

async function dispose(device) {
  device.engine.stop();
  await disposeDb(device.db);
}

/** Create one item through the real command path. */
async function addItem(device, name, cmdId) {
  return executeCommand(
    device.db,
    { cmdId, roomId: ROOM_A, kind: "putItem", locationId: "loc-1", item: { name } },
    { deviceId: device.deviceId, now: () => Date.now(), uuid: () => `${cmdId}-u` },
  );
}

/** Every live item name in a device's database. */
async function itemNames(device) {
  const rows = await device.db.items.toArray();
  return rows.filter((row) => row.deletedAt === null).map((row) => row.name).sort();
}

let relay = null;

export default {
  name: "integration — the real client against the real relay (§5.3, Gate G)",

  async before() {
    relay = await startRelay();
  },

  async after() {
    await relay?.stop();
    relay = null;
  },

  tests: [
    {
      // The relay fails closed on a missing Origin, so this is also the check
      // that the harness's transport is honest: a client that cannot send one
      // never gets past admission.
      name: "the relay admits a client that sends an allowed Origin",
      async run() {
        const device = await makeDevice(relay.url, DEVICE_A);
        try {
          await device.engine.start();
          await waitFor(
            () => device.sockets.length === 1 && device.sockets[0].sent.length > 0,
            "the engine dialled and sent a hello",
          );
          const hello = device.sockets[0].sent.find((frame) => frame.type === "hello");
          assert(hello, "a hello was sent");
          assertEqual(hello.roomId, ROOM_A, "hello names the room");
          assertEqual(hello.keyGen, 1, "hello carries the key generation");
          assertEqual(typeof hello.hash, "string", "hello carries the room hash");
        } finally {
          await dispose(device);
        }
      },
    },
    {
      name: "a client with a disallowed Origin is refused with 4401",
      async run() {
        const socket = new WebSocket(relay.url, { origin: "http://evil.test" });
        const code = await new Promise((resolve, reject) => {
          socket.on("close", (closeCode) => resolve(closeCode));
          socket.on("error", () => {
            /* `ws` reports the refusal as an error too; the close code is the
               assertion, so the error is expected and ignored. */
          });
          setTimeout(() => reject(new Error("no close within 5 s")), 5_000);
        });
        assertEqual(code, 4401, "origin refused");
      },
    },
    {
      // The whole point of §5.3: two shipped engines, one shipped relay, and
      // the ops actually cross. A wire mismatch shows up here as a timeout.
      name: "two real engines converge through the real relay",
      async run() {
        const a = await makeDevice(relay.url, DEVICE_A);
        const b = await makeDevice(relay.url, DEVICE_B);
        try {
          await a.engine.start();
          await b.engine.start();
          await waitFor(
            () => a.sockets.length === 1 && b.sockets.length === 1,
            "both engines dialled",
          );

          await addItem(a, "From A", "a1");
          await waitFor(
            async () => (await itemNames(b)).includes("From A"),
            "A's op reached B",
          );

          await addItem(b, "From B", "b1");
          await waitFor(
            async () => (await itemNames(a)).includes("From B"),
            "B's op reached A",
          );

          assertEqual(
            JSON.stringify(await itemNames(a)),
            JSON.stringify(await itemNames(b)),
            "both devices hold the same rows",
          );
        } finally {
          await dispose(a);
          await dispose(b);
        }
      },
    },
    {
      // §9 multiplexing, end to end: the shipped worker host, the real relay,
      // two shelves on one device. The relay's per-IP cap counts sockets, so
      // this is the number that has to be "one per device" — a public IP is
      // shared by households under CGNAT, and "rooms installed" was never a
      // number the relay could reason about.
      name: "two shelves on one device share ONE socket, and both still sync",
      async run() {
        const hubDevice = async () => {
          const db = await freshDb();
          await seedRoom(db, { roomId: ROOM_A, relayUrl: relay.url, roomKey: ROOM_KEY, roster: ROSTER });
          await seedRoom(db, { roomId: ROOM_B, relayUrl: relay.url, roomKey: ROOM_KEY_B, roster: ROSTER });
          const sockets = [];
          const transport = relaySocketFactory(TEST_ORIGIN);
          const host = createWorkerHost({
            db,
            getDeviceId: async () => DEVICE_A,
            ensureOpen: async () => {},
            socketFactory: (url) => {
              const socket = transport(url);
              sockets.push(socket);
              return socket;
            },
            // The shipped default is 5 s; the timer is the same code either way.
            drainInterval: 50,
          });
          return { db, host, sockets };
        };

        const a = await hubDevice();
        const b = await hubDevice();
        try {
          for (const roomId of [ROOM_A, ROOM_B]) {
            await a.host.handle({ id: 1, kind: "room-add", roomId });
            await b.host.handle({ id: 1, kind: "room-add", roomId });
          }

          await waitFor(
            () => a.sockets.length === 1 && b.sockets.length === 1,
            "each device dialled exactly one socket for two shelves",
          );
          await waitFor(
            async () => a.host.rooms.length === 2 && b.host.rooms.length === 2,
            "both engines exist on both devices",
          );

          // Both rooms are joined on the ONE wire — the relay has no
          // per-room socket to fall back on.
          await waitFor(() => {
            const frames = a.sockets[0].sent;
            return (
              frames.some((frame) => frame.type === "hello") &&
              frames.filter((frame) => frame.type === "join").length >= 1
            );
          }, "the second room joined the open socket");

          await executeCommand(
            a.db,
            { cmdId: "a-b", roomId: ROOM_B, kind: "putItem", locationId: "loc-1", item: { name: "Shelf B book" } },
            { deviceId: DEVICE_A, now: () => Date.now(), uuid: () => "a-b-u" },
          );
          await waitFor(
            async () =>
              (await b.db.items.toArray())
                .filter((row) => row.deletedAt === null)
                .some((row) => row.name === "Shelf B book"),
            "an op minted in room B reached the peer",
          );

          await executeCommand(
            a.db,
            { cmdId: "a-a", roomId: ROOM_A, kind: "putItem", locationId: "loc-1", item: { name: "Shelf A book" } },
            { deviceId: DEVICE_A, now: () => Date.now(), uuid: () => "a-a-u" },
          );
          await waitFor(
            async () =>
              (await b.db.items.toArray())
                .filter((row) => row.deletedAt === null)
                .some((row) => row.name === "Shelf A book"),
            "and an op minted in room A reached the same peer on the same socket",
          );

          // Two devices, four room memberships, two sockets on the relay.
          assertEqual(a.sockets.length, 1, "A: one socket");
          assertEqual(b.sockets.length, 1, "B: one socket");
        } finally {
          a.host.stop();
          b.host.stop();
          await disposeDb(a.db);
          await disposeDb(b.db);
        }
      },
    },
    {
      // §6.6: presence triggers catch-up, so a device that was offline while
      // ops were created must converge on connect with nobody clicking
      // anything. This is the "you have to hit catch-up" symptom, against the
      // real relay.
      name: "a device that connects late pulls the history with no manual catch-up",
      async run() {
        const a = await makeDevice(relay.url, DEVICE_A);
        const b = await makeDevice(relay.url, DEVICE_B);
        try {
          await a.engine.start();
          await waitFor(() => a.sockets.length === 1, "A dialled");
          await addItem(a, "Written while B was away", "a1");

          // B was never connected, so it has no cursor and no presence.
          await b.engine.start();
          await waitFor(
            async () => (await itemNames(b)).includes("Written while B was away"),
            "B caught up on connect",
          );
        } finally {
          await dispose(a);
          await dispose(b);
        }
      },
    },
    {
      // The relay stamps `from` with the connection id (§9). The engine's
      // `onEnvelope` is the only place that surfaces it, and a wrong stamp
      // breaks the ack rule's attribution — so it is worth pinning against the
      // real relay rather than the fake.
      name: "the relay stamps `from` with the sender's connection id",
      async run() {
        const seen = [];
        const a = await makeDevice(relay.url, DEVICE_A);
        const b = await makeDevice(relay.url, DEVICE_B, {
          onEnvelope: (kind, _body, from) => seen.push({ kind, from }),
        });
        try {
          await a.engine.start();
          await b.engine.start();
          await waitFor(
            () => a.sockets.length === 1 && b.sockets.length === 1,
            "both engines dialled",
          );

          await addItem(a, "Stamped", "a1");
          await waitFor(
            async () => (await itemNames(b)).includes("Stamped"),
            "the op arrived",
          );

          // The kind is deliberately not asserted: whether B receives a live
          // `op` broadcast or a `catchup-reply` depends on whether A had seen
          // B's presence yet, and both are legitimate. What must hold is that
          // the relay stamped a connection id on whatever it forwarded.
          const stamped = seen.find((entry) => typeof entry.from === "string" && entry.from.length > 0);
          assert(stamped, "B saw an envelope carrying a relay-stamped `from`");
        } finally {
          await dispose(a);
          await dispose(b);
        }
      },
    },
    {
      // §6.6's ack rule is derived from peers' advertised cursors, over the
      // REACHABLE set. A peer nobody has heard from does not block, so a
      // single-op test would ack at creation and prove nothing — B has to be
      // heard from first. That is the real path: B's op reaches A, A records
      // B's cursor and `lastSeen`, and only then does A's own op wait for B.
      name: "the outbox waits for a reachable peer, then clears when it adopts",
      async run() {
        const a = await makeDevice(relay.url, DEVICE_A);
        // §6.6 has no "I adopted your op" message: adoption proof arrives in a
        // catch-up request, a catchup-reply end marker, or an audit high-water
        // mark. So the ack latency is bounded by the audit interval (5 min by
        // default), not by delivery — which is exactly what "OUTBOX pending 2,
        // acked 0" looks like in the panel. The interval is injected here; the
        // timer is the same code either way.
        const b = await makeDevice(relay.url, DEVICE_B, { auditInterval: 200 });
        try {
          await a.engine.start();
          await b.engine.start();
          await waitFor(
            () => a.sockets.length === 1 && b.sockets.length === 1,
            "both engines dialled",
          );

          // B speaks first, so A learns B exists and what it has adopted.
          await addItem(b, "From B", "b1");
          await waitFor(
            async () => (await itemNames(a)).includes("From B"),
            "B's op reached A",
          );
          await waitFor(async () => {
            const room = await readRoom(a.db, ROOM_A);
            return room.lastSeen?.[DEVICE_B] !== undefined;
          }, "A recorded B as reachable");

          // Now A's op must WAIT: B is reachable and has not adopted it yet.
          await addItem(a, "From A", "a1");
          const roomBefore = await readRoom(a.db, ROOM_A);
          assertEqual(
            roomBefore.peerCursors?.[DEVICE_B]?.[DEVICE_A] ?? 0,
            0,
            "B has not adopted A's op yet",
          );

          await waitFor(
            async () => (await itemNames(b)).includes("From A"),
            "B adopted A's op",
          );
          await waitFor(async () => {
            const pending = await a.db.outbox.where("state").equals("pending").count();
            return pending === 0;
          }, "A's outbox drained once B adopted");

          const room = await readRoom(a.db, ROOM_A);
          assertEqual(room.peerCursors?.[DEVICE_B]?.[DEVICE_A], 1, "A recorded B's cursor");
        } finally {
          await dispose(a);
          await dispose(b);
        }
      },
    },
  ],
};
