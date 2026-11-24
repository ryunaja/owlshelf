/**
 * syncRuntime.test.mjs — the app's sync host (§7.1's trigger map).
 *
 * The engine was fully implemented and fully tested, and had exactly one call
 * site: the dev panel behind `?sync=1`. A normal page load never opened a
 * socket, so "sync" only existed for whoever knew the query parameter. This
 * suite is about the boot path, not the protocol — the protocol is
 * `sync.test.mjs` and `twoDevice.test.mjs`.
 *
 * ── What changed when the engine moved into the worker (§5.5) ─────────────
 *
 * `SyncRuntime` no longer constructs engines; it is a client of the plan's own
 * port protocol. So these tests drive a REAL `createWorkerHost` through
 * `localTransport` — the same host the worker runs, with a fake socket. That
 * means every assertion below now covers the port as well as the runtime, and
 * the headline test is the one the move existed for: two tabs asking for the
 * same room get ONE socket, not two.
 *
 * What matters here:
 *
 *  1. Every room gets an engine, because §7.1 says "catch up ALL rooms" and a
 *     socket is room-bound.
 *  2. A room with no `relayUrl` still reaches the relay, because pairing
 *     (§6.7) does not exist yet and every room ships `null`. Without the
 *     default, auto-connect would be a no-op on every real device.
 *  3. A profile created after boot is picked up without a reload.
 *  4. `stop()` really stops: sockets closed, listeners removed, no engine
 *     left behind. React StrictMode runs start → stop → start on every mount.
 *  5. N tabs do not mean N sockets. `room-add` is reference-counted per port.
 */

import { SyncRuntime } from "../../src/lib/syncRuntime.ts";
import { createWorkerHost } from "../../src/lib/worker/host.ts";
import { createWorkerClient, localTransport } from "../../src/lib/worker/client.ts";
import { bytesToB64, open, roomHash, seal } from "../../src/lib/envelope.ts";
import { sha256Hex } from "../../src/lib/hash.ts";
import { subscribeMedia } from "../../src/lib/mediaUrl.ts";
import { demandBlob, resetBlobDemand } from "../../src/lib/blobDemand.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, DEVICE_B, ROOM_A, ROOM_B, ROOM_KEY, seedRoom } from "../lib/fixtures.mjs";

const RELAY = "ws://relay.test/ws";
const OTHER_RELAY = "ws://other.test/ws";

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
    deliver(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    },
  };
}

/** A fake `EventTarget`: counts listeners so add/remove can be asserted. */
function fakeEvents() {
  const listeners = new Map();
  return {
    addEventListener(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
    },
    removeEventListener(name, fn) {
      const list = listeners.get(name) ?? [];
      listeners.set(
        name,
        list.filter((entry) => entry !== fn),
      );
    },
    dispatch(name) {
      for (const fn of listeners.get(name) ?? []) fn();
    },
    count(name) {
      return (listeners.get(name) ?? []).length;
    },
  };
}

/** One worker host over the test's database, with a recording socket factory. */
function makeHost(db, options = {}) {
  const sockets = [];
  const host = createWorkerHost({
    db,
    getDeviceId: options.getDeviceId ?? (async () => DEVICE_A),
    // The harness database is already open; the app singleton is not this one.
    ensureOpen: async () => {},
    socketFactory: (url) => {
      const socket = fakeSocket(url);
      // The relay answers a `join` with `joined` (§9 multiplexing). A fake that
      // stayed silent would hold every non-primary room's frames forever, which
      // looks exactly like a broken engine.
      const record = socket.send.bind(socket);
      socket.send = (data) => {
        const frame = JSON.parse(data);
        record(data);
        if (frame.type === "join") {
          queueMicrotask(() =>
            socket.deliver({ type: "joined", hash: frame.hash, keyGen: frame.keyGen }),
          );
        }
      };
      sockets.push(socket);
      return socket;
    },
    defaultRelayUrl: options.defaultRelayUrl,
    // §6.6's 20 s window is real time; a test that waits it out is a test
    // nobody runs. `0` makes `suspend()` tear down on the next tick.
    hiddenDisconnect: options.hiddenDisconnect,
  });
  return { host, sockets };
}

/** A runtime wired to a fresh host, plus the pieces a test needs to poke. */
function makeRuntime(db, options = {}) {
  const { host, sockets } = makeHost(db, options);
  const events = fakeEvents();
  const client = createWorkerClient(localTransport(host));
  const runtime = new SyncRuntime({ db, getClient: async () => client, events });
  return { runtime, sockets, events, host, client };
}

export default {
  name: "syncRuntime — the app auto-connects every room (§7.1)",
  tests: [
    {
      name: "start opens ONE socket and joins every room on it",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          const { runtime, sockets, host } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();
          try {
            await tick();
            // §9 multiplexing: a socket is per DEVICE, not per room. That is the
            // number a per-IP cap can reason about, because a public IP is
            // shared by households under CGNAT.
            assertEqual(sockets.length, 1, "one socket for the device");
            assertEqual(runtime.rooms.length, 2, "two rooms handed to the worker");
            assertEqual(host.rooms.length, 2, "two engines in the worker");
            assertEqual(sockets[0].url, RELAY, "dialled the default relay");

            sockets[0].open();
            await tick();

            const hellos = sockets[0].sent.filter((frame) => frame.type === "hello");
            const joins = sockets[0].sent.filter((frame) => frame.type === "join");
            assertEqual(hellos.length, 1, "the first room opens the wire");
            assertEqual(joins.length, 1, "the second room joins the same wire");
            const joinedRooms = [hellos[0].roomId, joins[0].roomId].sort();
            assertDeepEqual(joinedRooms, [ROOM_A, ROOM_B], "both rooms, one socket");
            assertEqual(typeof joins[0].hash, "string", "the join names the room hash");
          } finally {
            runtime.stop();
          }
        });
      },
    },
    {
      // The plan's own behaviour: a room nobody has paired with stays offline.
      // `defaultRelayUrl: null` is how a caller opts back into it.
      name: "with no default relay, a room that has no relayUrl stays offline",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          const { runtime, sockets, host } = makeRuntime(db, { defaultRelayUrl: null });
          await runtime.start();
          try {
            await tick();
            assertEqual(sockets.length, 0, "no socket");
            assertEqual(host.rooms.length, 1, "the engine exists, it is just offline");
          } finally {
            runtime.stop();
          }
        });
      },
    },
    {
      name: "a room's own relayUrl wins over the default",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A, relayUrl: OTHER_RELAY });
          const { runtime, sockets } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();
          try {
            await tick();
            assertEqual(sockets.length, 1, "one socket");
            assertEqual(sockets[0].url, OTHER_RELAY, "the room's own URL");
          } finally {
            runtime.stop();
          }
        });
      },
    },
    {
      name: "a profile created after boot gets an engine without a reload",
      async run() {
        await withDb(async (db) => {
          const { runtime, sockets, host } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();
          try {
            await tick();
            assertEqual(sockets.length, 0, "fresh device: nothing to connect");

            // `createProfile` writes the room into `meta` in the same
            // transaction as the profile row.
            await seedRoom(db, { roomId: ROOM_A });
            await tick();

            assertEqual(sockets.length, 1, "the new room connected");
            assertEqual(host.rooms.length, 1, "one engine");
          } finally {
            runtime.stop();
          }
        });
      },
    },
    {
      name: "start twice does not double the sockets",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          const { runtime, sockets } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();
          try {
            await runtime.start();
            await tick();
            assertEqual(sockets.length, 1, "still one socket");
          } finally {
            runtime.stop();
          }
        });
      },
    },
    {
      // React StrictMode mounts, unmounts, and remounts every effect in
      // development. The first `start()` is async, so its `await` can resolve
      // AFTER the cleanup ran — the generation guard is what stops it from
      // installing anything into a stopped runtime.
      name: "start → stop → start leaves exactly one engine per room",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          const { runtime, sockets, host } = makeRuntime(db, { defaultRelayUrl: RELAY });

          const first = runtime.start();
          runtime.stop();
          await first;
          await runtime.start();
          try {
            await tick();
            assertEqual(host.rooms.length, 1, "one engine, not two");
            assertEqual(sockets.length, 1, "one socket, not two");
          } finally {
            runtime.stop();
          }
        });
      },
    },
    {
      name: "stop closes the wire and removes every listener",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          const { runtime, sockets, events, host } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();
          await tick();
          assertEqual(sockets.length, 1, "one wire before stop");
          sockets[0].open();
          await tick();

          runtime.stop();
          // `room-remove` is a port message, so the engine stops one turn later.
          await tick();

          assertEqual(runtime.rooms.length, 0, "no rooms left with the worker");
          assertEqual(host.rooms.length, 0, "no engines left");
          // The LAST room leaving closes the wire; the others just leave it.
          assert(sockets[0].closed !== null, "socket closed");
          assertEqual(sockets[0].closed.code, 1000, "closed normally");
          for (const name of ["visibilitychange", "online", "pageshow"]) {
            assertEqual(events.count(name), 0, `${name} listener removed`);
          }
        });
      },
    },
    {
      name: "the §7.1 resume events are wired while running",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          const { runtime, events } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();
          try {
            for (const name of ["visibilitychange", "online", "pageshow"]) {
              assertEqual(events.count(name), 1, `${name} listener added`);
            }
          } finally {
            runtime.stop();
          }
        });
      },
    },
    {
      // §7.1: "Window `online` event → resync all rooms". A dropped socket is
      // the observable form of that: `resume()` re-dials instead of waiting
      // out the backoff.
      name: "dispatching online re-dials a dropped socket",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          const { runtime, sockets, events } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();
          try {
            await tick();
            sockets[0].open();
            await tick();

            sockets[0].onclose?.({ code: 1006, reason: "" });
            await tick();

            events.dispatch("online");
            await tick();

            assertEqual(sockets.length, 2, "re-dialled on the online event");
          } finally {
            runtime.stop();
          }
        });
      },
    },
    {
      name: "resyncAll re-dials once for the device, and both rooms rejoin",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });
          const { runtime, sockets } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();
          try {
            await tick();
            sockets[0].open();
            await tick();

            sockets[0].onclose?.({ code: 1006, reason: "" });
            await tick();

            runtime.resyncAll();
            await tick();

            // Two rooms, one wire per attempt: the socket that died and the one
            // that replaced it. Before multiplexing this was four.
            assertEqual(sockets.length, 2, "one re-dial for the device");
            sockets[1].open();
            await tick();
            const hellos = sockets[1].sent.filter((frame) => frame.type === "hello");
            const joins = sockets[1].sent.filter((frame) => frame.type === "join");
            assertEqual(hellos.length, 1, "one hello reopens the wire");
            assertEqual(joins.length, 1, "the other room rejoins it");
          } finally {
            runtime.stop();
          }
        });
      },
    },
    {
      // A blocked or mid-upgrade database must not pin the app offline. The
      // runtime swallows the failure and leaves the liveQuery installed, whose
      // initial emission retries — no reload, no second `start()`.
      name: "a failing deviceId does not pin the runtime offline",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          let attempts = 0;
          const { runtime, sockets } = makeRuntime(db, {
            defaultRelayUrl: RELAY,
            getDeviceId: async () => {
              attempts += 1;
              if (attempts === 1) throw new Error("blocked");
              return DEVICE_A;
            },
          });

          await runtime.start();
          try {
            await tick();
            assert(attempts >= 2, "the first attempt failed and was retried");
            assertEqual(sockets.length, 1, "the room connected without a reload");
            assertEqual(runtime.rooms.length, 1, "and stayed handed over");
          } finally {
            runtime.stop();
          }
        });
      },
    },

    // ── The reason the engine moved (§5.5) ─────────────────────────────────

    {
      // Before the move, `syncRuntime` ran in every tab and constructed its own
      // engines, so two tabs meant two sockets per room. The relay's
      // `conns_per_ip = 3` counts across all rooms, so that was enough to hit
      // the cap with two profiles open.
      name: "two tabs asking for the same room share ONE socket",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          const { host, sockets } = makeHost(db, { defaultRelayUrl: RELAY });

          const tabA = new SyncRuntime({
            db,
            getClient: async () => createWorkerClient(localTransport(host)),
            events: fakeEvents(),
          });
          const tabB = new SyncRuntime({
            db,
            getClient: async () => createWorkerClient(localTransport(host)),
            events: fakeEvents(),
          });

          await tabA.start();
          await tabB.start();
          try {
            await tick();
            assertEqual(sockets.length, 1, "one socket for the room, not two");
            assertEqual(host.rooms.length, 1, "one engine");
          } finally {
            tabA.stop();
            tabB.stop();
          }
        });
      },
    },
    {
      // The other half of reference counting: one tab going away must not stop
      // an engine another tab is still using.
      name: "a tab that stops does not stop the engine another tab still wants",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          const { host, sockets } = makeHost(db, { defaultRelayUrl: RELAY });

          const tabA = new SyncRuntime({
            db,
            getClient: async () => createWorkerClient(localTransport(host)),
            events: fakeEvents(),
          });
          const tabB = new SyncRuntime({
            db,
            getClient: async () => createWorkerClient(localTransport(host)),
            events: fakeEvents(),
          });

          await tabA.start();
          await tabB.start();
          await tick();
          assertEqual(sockets.length, 1, "one socket");

          tabA.stop();
          await tick();

          assertEqual(host.rooms.length, 1, "the engine survives tab A");
          assert(sockets[0].closed === null, "and its socket is still open");

          tabB.stop();
          await tick();
          assertEqual(host.rooms.length, 0, "the last tab releases it");
          assert(sockets[0].closed !== null, "and the socket closes");
        });
      },
    },
    {
      // Rung 2's handoff, from the runtime's side. The leader owns a DEDICATED
      // worker, so it dies with the leader tab and the promoted tab spawns a
      // fresh one with an EMPTY engine map. `switchableTransport` re-sends
      // stranded requests, but a `room-add` that already got its reply is not
      // stranded — so the runtime has to re-announce every room it wants, or
      // the room silently stops syncing forever.
      name: "a promotion re-announces every room the tab wants",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          await seedRoom(db, { roomId: ROOM_B });

          const calls = [];
          let promote = null;
          const client = {
            roomAdd: async (roomId) => {
              calls.push(["roomAdd", roomId]);
            },
            roomRemove: async (roomId) => {
              calls.push(["roomRemove", roomId]);
            },
            setVisibility: (hidden) => {
              calls.push(["visibility", hidden]);
            },
            demandBlob: async () => false,
            onEvent: () => () => {},
            onPromote: (handler) => {
              promote = handler;
              return () => {
                promote = null;
              };
            },
          };

          const runtime = new SyncRuntime({
            db,
            getClient: async () => client,
            events: fakeEvents(),
          });
          await runtime.start();
          try {
            assertEqual(calls.length, 2, "both rooms announced on start");

            calls.length = 0;
            promote?.();
            await tick();

            assertDeepEqual(
              calls.map(([kind, roomId]) => [kind, roomId]).sort(),
              [
                ["roomAdd", ROOM_A],
                ["roomAdd", ROOM_B],
              ],
              "every wanted room was re-announced",
            );
          } finally {
            runtime.stop();
          }
        });
      },
    },
    {
      // §6.6: disconnect ~20 s after EVERY port reports hidden, reconnect on
      // ANY visible. `visibility` is the plan's only message for this, and it
      // is also §7.1's resume trigger — there is no separate `resync`.
      name: "every port hidden suspends; any port visible resumes",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A });
          const { host, sockets } = makeHost(db, { defaultRelayUrl: RELAY, hiddenDisconnect: 0 });
          const clientA = createWorkerClient(localTransport(host));
          const clientB = createWorkerClient(localTransport(host));
          await clientA.roomAdd(ROOM_A);
          await clientB.roomAdd(ROOM_A);
          await tick();
          sockets[0].open();
          await tick();

          clientA.setVisibility(true);
          await tick();
          assertEqual(sockets[0].closed, null, "one hidden tab is not enough");

          clientB.setVisibility(true);
          await tick();
          assert(sockets[0].closed !== null, "every tab hidden suspends the engine");

          clientA.setVisibility(false);
          await tick();
          assertEqual(sockets.length, 2, "any visible tab re-dials");
        });
      },
    },

    // ── The media demand path (§6.6, §8.1) ─────────────────────────────────
    //
    // These moved here from `syncStore.test.mjs` with the engine. The runtime
    // owns the demand path now, which is also the fix for a real bug: the
    // fetcher used to be registered by the dev panel, so a normal page load
    // could never pull a missing blob.

    {
      // The gap this closes: `requestBlob` had no caller in the app, so a
      // synced row's `idb://<hash>` resolved to `missing` forever. A render
      // that finds no bytes now publishes a demand, and the runtime answers it.
      name: "a media demand reaches the engine as a blob-request",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          resetBlobDemand();
          const { runtime, sockets } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();
          try {
            await tick();
            sockets[0].open();
            await tick();
            sockets[0].deliver({ type: "presence", hash: await roomHash(ROOM_KEY), members: ["conn-9"] });
            await tick();

            assertEqual(demandBlob(ROOM_A, "abc123"), true, "the demand was issued");
            await tick();

            const requests = sockets[0].sent.filter((f) => f.kind === "blob-request");
            assertEqual(requests.length, 1, "one blob-request went out");
            assertEqual(requests[0].to, "conn-9", "targeted at the member");
          } finally {
            runtime.stop();
            resetBlobDemand();
          }
        });
      },
    },
    {
      name: "a demand for a room with no engine is not sent on another room's socket",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roomId: ROOM_A, relayUrl: RELAY });
          resetBlobDemand();
          const { runtime, sockets } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();
          try {
            await tick();
            sockets[0].open();
            await tick();
            sockets[0].deliver({ type: "presence", hash: await roomHash(ROOM_KEY), members: ["conn-9"] });
            await tick();

            assertEqual(demandBlob(ROOM_B, "abc123"), true, "the demand was issued");
            await tick();

            assertEqual(
              sockets[0].sent.filter((f) => f.kind === "blob-request").length,
              0,
              "a foreign room's blob is not pulled into this one",
            );
          } finally {
            runtime.stop();
            resetBlobDemand();
          }
        });
      },
    },
    {
      name: "stop disarms the demand path",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          resetBlobDemand();
          const { runtime } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();
          await tick();
          runtime.stop();
          assertEqual(demandBlob(ROOM_A, "abc123"), false, "nothing to ask");
          resetBlobDemand();
        });
      },
    },
    {
      // End to end: a verified chunk lands in `files` AND wakes the media
      // cache. Without the second half the bytes arrive and the image stays
      // blank until a reload. The wake-up is a `blob-arrived` event now, so
      // this also covers the worker → tab broadcast.
      name: "a verified file-chunk stores the blob and wakes media consumers",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          resetBlobDemand();
          const { runtime, sockets } = makeRuntime(db, { defaultRelayUrl: RELAY });
          await runtime.start();

          const payload = new Uint8Array([1, 2, 3, 4, 5]);
          const hash = await sha256Hex(payload);
          const seen = [];
          const unsubscribe = subscribeMedia((roomId, changed) => {
            seen.push(`${roomId}/${changed}`);
          });

          try {
            await tick();
            sockets[0].open();
            await tick();
            sockets[0].deliver({ type: "presence", hash: await roomHash(ROOM_KEY), members: ["conn-9"] });
            await tick();

            assertEqual(demandBlob(ROOM_A, hash), true, "demand issued");
            await tick();

            const frame = sockets[0].sent.find((f) => f.kind === "blob-request");
            assert(frame, "a blob-request went out");
            const request = await open(ROOM_KEY, frame);
            assert(request && typeof request.requestId === "string", "the request is readable");

            const chunk = {
              requestId: request.requestId,
              seq: 0,
              bytes: bytesToB64(payload),
              totalBytes: payload.byteLength,
              totalChunks: 1,
              contentType: "image/webp",
              deviceId: DEVICE_B,
            };
            sockets[0].deliver(await seal(ROOM_KEY, ROOM_A, 1, "file-chunk", chunk));
            await tick();

            const row = await db.files.get([ROOM_A, hash]);
            assert(row, "the verified bytes were stored");
            assertEqual(seen.length, 1, "media consumers were woken");
            assertEqual(seen[0], `${ROOM_A}/${hash}`, "for the right blob");
          } finally {
            unsubscribe();
            runtime.stop();
            resetBlobDemand();
          }
        });
      },
    },
  ],
};
