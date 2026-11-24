/**
 * syncStore.test.mjs — the dev panel's store (§13, Gate G).
 *
 * ── What changed when the engine moved into the worker (§5.5) ─────────────
 *
 * The store used to OWN a `SyncEngine`. It does not any more: the engine lives
 * in the worker, so this is a view. That is the fix, not a demotion — the panel
 * used to open its own socket for the selected room while `syncRuntime` opened
 * one per room for the app, so opening the panel doubled the connections for
 * that room, and the relay's `conns_per_ip = 3` counts across all rooms.
 *
 * So these tests drive a REAL `createWorkerHost` through `localTransport`, and
 * the assertions split along §5's line:
 *
 *  - durable state (rooms, relay URL, op counts, outbox buckets, cursors) is a
 *    tab-side READ and is asserted against the database;
 *  - the engine's live state (status, connId, members, log) and its operations
 *    cross the port as `dev-*` and are asserted against the host.
 *
 * The protocol itself is `sync.test.mjs`; the boot path is
 * `syncRuntime.test.mjs`.
 */

import { SyncStore, DEFAULT_RELAY_URL, closeHint } from "../../src/dev/syncStore.ts";
import { createWorkerHost } from "../../src/lib/worker/host.ts";
import { createWorkerClient, localTransport } from "../../src/lib/worker/client.ts";
import { readRoom } from "../../src/lib/roomMeta.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, ROOM_A, ROOM_B, seedRoom } from "../lib/fixtures.mjs";

const RELAY = "ws://relay.test/ws";

/** Let liveQuery emissions and queued microtasks settle. */
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** A `SocketLike` that records frames and lets the test fire the events. */
function fakeSocket(url) {
  return {
    url,
    sent: [],
    closed: null,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
    open() {
      this.onopen?.({});
    },
  };
}

/** A store wired to an isolated DB, a real host, and fake sockets. */
function makeStore(db, options = {}) {
  const sockets = [];
  const host = createWorkerHost({
    db,
    getDeviceId: async () => DEVICE_A,
    // The harness database is already open; the app singleton is not this one.
    ensureOpen: async () => {},
    socketFactory: (url) => {
      const socket = fakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    defaultRelayUrl: options.defaultRelayUrl,
    hiddenDisconnect: options.hiddenDisconnect,
  });
  const client = createWorkerClient(localTransport(host));
  const store = new SyncStore({ db, getClient: async () => client });
  return { store, sockets, host, client };
}

export default {
  name: "syncStore — the dev panel's view over the worker (§13)",
  tests: [
    {
      name: "loadRooms with no room reports an error and stays unselected",
      async run() {
        await withDb(async (db) => {
          const { store } = makeStore(db);
          await store.loadRooms();
          const snap = store.getSnapshot();
          assertEqual(snap.roomId, null, "no room selected");
          assert(snap.error !== null, "an error is surfaced");
          assertDeepEqual(snap.rooms, [], "no rooms listed");
        });
      },
    },
    {
      name: "loadRooms selects the first room and defaults the relay URL",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const { store } = makeStore(db);
          await store.loadRooms();
          const snap = store.getSnapshot();
          assertEqual(snap.roomId, ROOM_A, "room selected");
          assertEqual(snap.deviceId, DEVICE_A, "deviceId came back over the port");
          assertEqual(snap.relayUrl, DEFAULT_RELAY_URL, "default relay URL");
          assertDeepEqual(snap.rooms, [ROOM_A], "room listed");
          assertEqual(snap.error, null, "no error");
        });
      },
    },
    {
      name: "setRelayUrl persists to the room, not just the snapshot",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const { store } = makeStore(db);
          await store.loadRooms();
          await store.setRelayUrl(RELAY);
          assertEqual(store.getSnapshot().relayUrl, RELAY, "snapshot updated");
          const room = await readRoom(db, ROOM_A);
          assertEqual(room.relayUrl, RELAY, "durable — connect() reads this");
        });
      },
    },
    {
      name: "an empty relay URL is persisted as null, not the empty string",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const { store } = makeStore(db);
          await store.loadRooms();
          await store.setRelayUrl("   ");
          const room = await readRoom(db, ROOM_A);
          assertEqual(room.relayUrl, null, "null, so connect() stays offline");
        });
      },
    },
    {
      name: "connect without a room refuses instead of throwing",
      async run() {
        await withDb(async (db) => {
          const { store, sockets } = makeStore(db);
          await store.connect();
          assertEqual(store.getSnapshot().running, false, "not running");
          assert(store.getSnapshot().error !== null, "error surfaced");
          assertEqual(sockets.length, 0, "no socket opened");
        });
      },
    },
    {
      name: "connect persists the URL then asks the worker for the room",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const { store, sockets, host } = makeStore(db);
          await store.loadRooms();
          await store.setRelayUrl(RELAY);
          await store.connect();
          try {
            await tick();
            const snap = store.getSnapshot();
            assertEqual(snap.running, true, "the worker holds an engine");
            assertEqual(snap.status, "connecting", "connecting");
            assertEqual(sockets.length, 1, "one socket");
            assertEqual(sockets[0].url, RELAY, "dialled the persisted URL");
            assertEqual(host.rooms.length, 1, "one engine in the worker");
            assert(
              snap.log.some((e) => e.kind === "resume"),
              "the worker logged the resume",
            );
          } finally {
            await store.disconnect();
          }
        });
      },
    },
    {
      name: "connect twice does not open a second socket",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const { store, sockets } = makeStore(db);
          await store.loadRooms();
          await store.setRelayUrl(RELAY);
          await store.connect();
          try {
            await store.connect();
            await tick();
            assertEqual(sockets.length, 1, "still one socket");
          } finally {
            await store.disconnect();
          }
        });
      },
    },
    {
      // The bug this replaces: the panel used to rebind its own engine when the
      // selection changed, which meant a second socket for the second room. The
      // engine set belongs to the worker now, so selecting another room must
      // not open anything — it only changes what the panel DISPLAYS.
      name: "selecting another room does not open a second socket",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          const { store, sockets } = makeStore(db);
          await store.loadRooms();
          await store.selectRoom(ROOM_A);
          await store.setRelayUrl(RELAY);
          await store.connect();
          try {
            await tick();
            assertEqual(sockets.length, 1, "one socket for room A");

            await store.selectRoom(ROOM_B);
            await tick();

            assertEqual(sockets.length, 1, "no new socket for room B");
            assertEqual(sockets[0].closed, null, "the room-A socket stayed open");
            assertEqual(store.getSnapshot().roomId, ROOM_B, "the panel shows B");
          } finally {
            await store.disconnect();
          }
        });
      },
    },
    {
      // `disconnect` suspends rather than tearing down, because the engine is
      // shared with every other tab and `syncRuntime` still holds a reference.
      name: "disconnect suspends the engine and resets the live fields",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const { store, sockets, host } = makeStore(db, { hiddenDisconnect: 0 });
          await store.loadRooms();
          await store.setRelayUrl(RELAY);
          await store.connect();
          await tick();
          sockets[0].open();
          await tick();

          await store.disconnect();
          // `suspend()` schedules the teardown on §6.6's window, so the close
          // lands one turn after the request.
          await tick();
          await store.refresh();

          const snap = store.getSnapshot();
          assertEqual(snap.running, true, "the engine still exists — it is shared");
          assertEqual(snap.status, "offline", "but it is offline");
          assertEqual(snap.connId, null, "connId cleared");
          assert(sockets[0].closed !== null, "the socket was closed");
          assertEqual(host.rooms.length, 1, "the room was not released");
        });
      },
    },
    {
      name: "operations on a room with no engine surface an error, not a throw",
      async run() {
        await withDb(async (db) => {
          // A room exists, so the panel has a selection — but nothing has
          // handed it to the worker, so there is no engine to operate on.
          await seedRoom(db);
          const { store } = makeStore(db);
          await store.loadRooms();
          await store.catchup();
          assertEqual(store.getSnapshot().running, false, "still idle");
          assert(store.getSnapshot().error !== null, "the failure is visible");
          assert(
            store.getSnapshot().error.includes("no engine"),
            "and it names the reason",
          );
        });
      },
    },
    {
      name: "refresh counts ops and buckets the outbox by state",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await db.ops.bulkPut([
            { opId: "o1", roomId: ROOM_A, deviceId: DEVICE_A, authorSeq: 1 },
            { opId: "o2", roomId: ROOM_A, deviceId: DEVICE_A, authorSeq: 2 },
            { opId: "o3", roomId: "other-room", deviceId: DEVICE_A, authorSeq: 1 },
          ]);
          await db.outbox.bulkPut([
            { opId: "o1", roomId: ROOM_A, deviceId: DEVICE_A, authorSeq: 1, state: "pending", attempts: 0, createdAt: 0 },
            { opId: "o2", roomId: ROOM_A, deviceId: DEVICE_A, authorSeq: 2, state: "acked", attempts: 1, createdAt: 0 },
            { opId: "o3", roomId: "other-room", deviceId: DEVICE_A, authorSeq: 1, state: "dead", attempts: 3, createdAt: 0 },
          ]);
          const { store } = makeStore(db);
          await store.loadRooms();
          const snap = store.getSnapshot();
          assertEqual(snap.ops, 2, "only this room's ops");
          assertDeepEqual(snap.outbox, { pending: 1, acked: 1, dead: 0 }, "this room only");
        });
      },
    },
    {
      name: "refresh mirrors the worker's engine state",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const { store } = makeStore(db);
          await store.loadRooms();
          await store.setRelayUrl(RELAY);
          await store.connect();
          try {
            await tick();
            const snap = store.getSnapshot();
            assert(snap.connId !== null, "connId mirrored");
            assertEqual(snap.status, "connecting", "status mirrored");
            assertEqual(snap.deviceId, DEVICE_A, "deviceId mirrored");
          } finally {
            await store.disconnect();
          }
        });
      },
    },
    {
      name: "getSnapshot is referentially stable when nothing changed",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const { store } = makeStore(db);
          await store.loadRooms();
          await store.setRelayUrl(RELAY);
          await store.connect();
          try {
            // Settle first: the first refresh legitimately changes the
            // snapshot (connId goes from null to the engine's value). The
            // property under test is that IDLE calls allocate nothing.
            await store.refresh();
            const first = store.getSnapshot();
            const second = store.getSnapshot();
            // useSyncExternalStore re-renders forever if getSnapshot returns a
            // fresh object on every call with no change behind it.
            assert(first === second, "same object across idle getSnapshot calls");
          } finally {
            await store.disconnect();
          }
        });
      },
    },
    {
      name: "watchRooms picks up a room created after the panel mounted",
      async run() {
        await withDb(async (db) => {
          const { store } = makeStore(db);
          const stop = store.watchRooms();
          try {
            // The panel mounts on a fresh device: no profile, no room.
            await tick();
            assertEqual(store.getSnapshot().roomId, null, "no room yet");
            assert(store.getSnapshot().error !== null, "error surfaced");

            await seedRoom(db, { roomId: ROOM_A });
            await tick();

            assertEqual(store.getSnapshot().roomId, ROOM_A, "the new room appeared");
            assertEqual(store.getSnapshot().error, null, "the error cleared");
          } finally {
            stop();
          }
        });
      },
    },
    {
      name: "a live emission does not overwrite the relay URL being typed",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          const { store } = makeStore(db);
          const stop = store.watchRooms();
          try {
            await tick();
            assertEqual(store.getSnapshot().roomId, ROOM_A, "selected");

            // The user is mid-edit; nothing has been persisted yet.
            store.setRelayUrl("ws://typing.test/ws");
            await tick();

            // Any write to `meta` re-emits the room list. Resetting the field
            // on every emission would erase what is being typed.
            await seedRoom(db, { roomId: ROOM_B });
            await tick();

            assertEqual(
              store.getSnapshot().relayUrl,
              "ws://typing.test/ws",
              "the typed URL survived the emission",
            );
          } finally {
            stop();
          }
        });
      },
    },
    {
      name: "closeHint names the fix, not just the code",
      async run() {
        // `offline` alone is useless: a refused origin, a relay that is not
        // running, and a full room all look identical.
        assert((closeHint(1006) ?? "").includes("unreachable"), "1006 → relay down");
        assert((closeHint(4401) ?? "").includes("ALLOWED_ORIGINS"), "4401 → allowlist");
        assert((closeHint(4403) ?? "").includes("full"), "4403 → room full");
        assert((closeHint(4404) ?? "").includes("re-pair"), "4404 → re-pair");
        assert((closeHint(1013) ?? "").includes("capacity"), "1013 → capacity");
        assertEqual(closeHint(1000), null, "a normal close needs no hint");
      },
    },
    {
      name: "subscribers are notified on change and released on unsubscribe",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const { store } = makeStore(db);
          let calls = 0;
          const unsubscribe = store.subscribe(() => {
            calls += 1;
          });
          await store.loadRooms();
          assert(calls > 0, "notified");
          const seen = calls;
          unsubscribe();
          await store.setRelayUrl(RELAY);
          assertEqual(calls, seen, "no notification after unsubscribe");
        });
      },
    },
  ],
};
