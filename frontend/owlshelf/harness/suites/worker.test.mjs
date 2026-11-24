/**
 * worker.test.mjs — plan §5's single-writer split, executed.
 *
 * §5 says the worker is the only writer and tabs post semantic commands. Node
 * has no `SharedWorker`, so the split is only testable because `createWorkerHost`
 * takes a port and a database instead of reaching for globals. This suite drives
 * that host with a fake port and an isolated database — the same code the
 * browser runs, minus the thread boundary.
 *
 * What is covered:
 *
 *  - the request/reply contract: every reply echoes its `id`, a failure is a
 *    reply and not a throw, and a `CommandError` keeps its code across the wire
 *  - the three write entry points (`cmd`, `move-many`, `create-profile`)
 *  - the two non-write messages (`visibility`, `blob-demand`)
 *  - the fallback ladder: SharedWorker, then Web Locks leader/follower over a
 *    BroadcastChannel, then tab mode with the single-tab warning
 *
 * The ladder test uses Node's real `BroadcastChannel` (same semantics as the
 * browser: no self-delivery) and a fake `LockManager`, because Node has no
 * `navigator.locks`.
 */

import { createWorkerHost } from "../../src/lib/worker/host.ts";
import {
  createWorkerClient,
  localTransport,
  startWorkerClient,
} from "../../src/lib/worker/client.ts";
import { CommandError } from "../../src/lib/cmd.ts";
import { roomHash } from "../../src/lib/envelope.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, ROOM_A, ROOM_KEY, seedRoom } from "../lib/fixtures.mjs";

/** A port that records what the host posts and lets a test push messages in. */
function fakePort() {
  const posted = [];
  let handler = null;
  return {
    posted,
    post: (message) => posted.push(message),
    onMessage: (fn) => {
      handler = fn;
    },
    /** Deliver a message as the tab would. */
    deliver: (message) => handler?.(message),
    /** The last reply, or undefined. */
    last: () => posted[posted.length - 1],
  };
}

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

/**
 * A `LockManager` that QUEUES, like the real one.
 *
 * `ifAvailable: true` answers "is it free right now" without queueing; a plain
 * request waits. That distinction is the whole handoff mechanism, so a fake
 * that ignores it would pass while the real browser never promotes anyone.
 *
 * `release()` is the test's stand-in for the leader tab unloading.
 */
function queuedLocks() {
  const state = { holder: null, queue: [] };

  function grant(entry) {
    state.holder = entry;
    const result = entry.callback({ name: "owlshelf-sync" });
    // The callback holds forever; only `release()` ends the tenure.
    Promise.resolve(result).catch(() => {});
    entry.resolve?.(result);
  }

  return {
    // `LockManager.request` has two overloads — `(name, callback)` and
    // `(name, options, callback)` — and the promotion path uses the short one.
    request(_name, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
      if (state.holder === null) {
        grant({ callback, resolve: null });
        return Promise.resolve(undefined);
      }
      if (options?.ifAvailable) return Promise.resolve(callback(null));
      return new Promise((resolve) => {
        state.queue.push({ callback, resolve });
      });
    },
    /** The current holder goes away; the next waiter is promoted. */
    release() {
      state.holder = null;
      const next = state.queue.shift();
      if (next) grant(next);
    },
    /** How many tabs are waiting for the writer role. */
    waiting: () => state.queue.length,
  };
}

/** A `MessageEndpoint` that answers nothing — enough to prove the ladder rung. */
function deadEndpoint() {
  return { postMessage() {}, onmessage: null };
}

const putItem = (overrides = {}) => ({
  cmdId: "c1",
  roomId: ROOM_A,
  kind: "putItem",
  locationId: "loc-1",
  item: { name: "Dune" },
  ...overrides,
});

export default {
  name: "worker — the single writer and the fallback ladder (§5)",
  tests: [
    {
      name: "a cmd round-trips through the port and commits",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const host = createWorkerHost({ db, getDeviceId: async () => DEVICE_A });
          const port = fakePort();
          host.attach(port);

          port.deliver({ id: 7, kind: "cmd", cmd: putItem() });
          // `attach` replies asynchronously; one macrotask is enough for a
          // fake-indexeddb transaction.
          await new Promise((resolve) => setTimeout(resolve, 50));

          const reply = port.last();
          assertEqual(reply.id, 7, "the reply echoes the request id");
          assertEqual(reply.ok, true, "the command committed");
          assertEqual(reply.value.opIds.length, 1, "one op minted");
          assertEqual((await db.ops.count()), 1, "the op is in the database");
        });
      },
    },
    {
      name: "a CommandError keeps its code across the wire",
      async run() {
        await withDb(async (db) => {
          // No room seeded: the command path rejects with `validation`.
          const host = createWorkerHost({ db, getDeviceId: async () => DEVICE_A });
          const port = fakePort();
          host.attach(port);

          port.deliver({ id: 1, kind: "cmd", cmd: putItem() });
          await new Promise((resolve) => setTimeout(resolve, 50));

          const reply = port.last();
          assertEqual(reply.ok, false, "the failure is a reply, not a throw");
          assertEqual(reply.error.code, "validation", "the code survives");
          assert(reply.error.message.length > 0, "the message survives");
        });
      },
    },
    {
      name: "an unknown request kind is rejected, not ignored",
      async run() {
        await withDb(async (db) => {
          const host = createWorkerHost({ db, getDeviceId: async () => DEVICE_A });
          const reply = await host.handle({ id: 3, kind: "nonsense" });
          assertEqual(reply.id, 3, "the reply echoes the id");
          assertEqual(reply.ok, false, "rejected");
          assertEqual(reply.error.code, "validation", "reported as a validation error");
        });
      },
    },
    {
      name: "move-many reports per item and leaves the failures alone",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const host = createWorkerHost({ db, getDeviceId: async () => DEVICE_A });
          const port = fakePort();
          host.attach(port);

          // Two items on the shelf, then a move of one real and one unknown id.
          for (const name of ["Dune", "Emma"]) {
            port.deliver({
              id: 1,
              kind: "cmd",
              cmd: putItem({ cmdId: `seed-${name}`, item: { name } }),
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const items = await db.items.toArray();
          assertEqual(items.length, 2, "two items seeded");

          port.deliver({
            id: 2,
            kind: "move-many",
            request: {
              cmdId: "bulk",
              roomId: ROOM_A,
              itemIds: [items[0].id, "no-such-item"],
              destination: { roomId: ROOM_A, locationId: "loc-2" },
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 100));

          const results = port.last().value;
          assertEqual(results.length, 2, "one result per input item");
          assertEqual(results[0].ok, true, "the real item moved");
          assertEqual(results[1].ok, false, "the unknown item failed");
          assertEqual(results[1].itemId, "no-such-item", "in input order");
        });
      },
    },
    {
      name: "create-profile writes the room and the profile in one transaction",
      async run() {
        await withDb(async (db) => {
          const host = createWorkerHost({
            db,
            getDeviceId: async () => "17e3bf35-da77-4cba-993a-7214cf445373",
            ensureOpen: async () => {},
          });
          const reply = await host.handle({
            id: 1,
            kind: "create-profile",
            data: { name: "Home", type: "personal", avatarEmoji: "🏠" },
          });

          assertEqual(reply.ok, true, "created");
          const profile = reply.value;
          assertEqual(profile.name, "Home", "the profile row");
          assertEqual(profile.id.startsWith("17e3bf35-"), true, "roomId carries the device prefix");
          assertEqual(await db.profiles.count(), 1, "one profile row");

          // `meta` holds TWO rows now, and both are load-bearing: the room, and
          // the device keypair that signed its roster anchor. §6.7's create
          // cannot skip the anchor — a room without one is unpairable, which is
          // exactly what the old `db.createProfile` produced.
          const roomKeys = await db.meta.where("key").startsWith("room:").primaryKeys();
          assertEqual(roomKeys.length, 1, "one room row");
          const room = await db.meta.get(roomKeys[0]);
          assertEqual(typeof room.ownerPub, "string", "the owner key is pinned");
          assertEqual(room.rosterAnchor?.epoch, 1, "epoch 1 is signed and stored");
          assertEqual(room.rosterAnchor?.members.length, 1, "the owner is the only member");
          assertEqual(
            (await db.meta.get("deviceKeys")) !== undefined,
            true,
            "the device keypair exists to sign epochs with",
          );
        });
      },
    },
    {
      // §6.6's two non-write messages. `visibility` is accepted and has no
      // value; `blob-demand` now reaches a REAL engine, because the engine
      // lives here (§5.5) — the old `onBlobDemand` seam is gone.
      name: "visibility is accepted, and blob-demand needs a live engine",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: "ws://relay.test/ws" });
          const sockets = [];
          const host = createWorkerHost({
            db,
            getDeviceId: async () => DEVICE_A,
            ensureOpen: async () => {},
            socketFactory: (url) => {
              const socket = fakeSocket(url);
              sockets.push(socket);
              return socket;
            },
          });

          const hidden = await host.handle({ id: 1, kind: "visibility", hidden: true });
          assertEqual(hidden.ok, true, "visibility accepted");
          assertEqual(hidden.value, null, "and has no value");

          // No engine yet: the demand is answered `false`, not an error.
          const before = await host.handle({
            id: 2,
            kind: "blob-demand",
            roomId: ROOM_A,
            hash: "h1",
          });
          assertEqual(before.value, false, "nothing to ask");

          await host.handle({ id: 3, kind: "room-add", roomId: ROOM_A });
          await new Promise((resolve) => setTimeout(resolve, 50));
          sockets[0].open();
          await new Promise((resolve) => setTimeout(resolve, 50));
          sockets[0].deliver({
            type: "presence",
            // Presence is per ROOM now (§9 multiplexing): one socket holds
            // several, so the hash is what tells the hub which engine hears it.
            hash: await roomHash(ROOM_KEY),
            members: ["conn-9"],
          });
          await new Promise((resolve) => setTimeout(resolve, 50));

          const after = await host.handle({
            id: 4,
            kind: "blob-demand",
            roomId: ROOM_A,
            hash: "h1",
          });
          assertEqual(after.value, true, "the engine issued a blob-request");
          const requests = sockets[0].sent.filter((frame) => frame.kind === "blob-request");
          assertEqual(requests.length, 1, "one request went out");
          assertEqual(requests[0].to, "conn-9", "targeted at the member");
          host.stop();
        });
      },
    },
    {
      // §6.6's `room-add`/`room-remove`. The engine set belongs to the worker,
      // so a tab can only ask for a room to be in it — and asking for a room
      // that is not in the database is a caller bug, reported as a reply.
      name: "room-add opens an engine, room-remove closes it, and a bad room is refused",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: "ws://relay.test/ws" });
          const sockets = [];
          const host = createWorkerHost({
            db,
            getDeviceId: async () => DEVICE_A,
            ensureOpen: async () => {},
            socketFactory: (url) => {
              const socket = fakeSocket(url);
              sockets.push(socket);
              return socket;
            },
          });

          const added = await host.handle({ id: 1, kind: "room-add", roomId: ROOM_A });
          assertEqual(added.ok, true, "accepted");
          await new Promise((resolve) => setTimeout(resolve, 50));
          assertEqual(host.rooms.length, 1, "one engine");
          assertEqual(sockets.length, 1, "one socket");

          // Idempotent: a second add from the same port is a reference, not a
          // second engine.
          await host.handle({ id: 2, kind: "room-add", roomId: ROOM_A });
          await new Promise((resolve) => setTimeout(resolve, 50));
          assertEqual(sockets.length, 1, "still one socket");

          const missing = await host.handle({ id: 3, kind: "room-add", roomId: "nope" });
          assertEqual(missing.ok, false, "a room that is not there is refused");
          assertEqual(missing.error.code, "validation", "as a validation error");

          await host.handle({ id: 4, kind: "room-remove", roomId: ROOM_A });
          assertEqual(host.rooms.length, 0, "the engine is gone");
          assert(sockets[0].closed !== null, "and the socket is closed");
        });
      },
    },
    {
      name: "dev-state reports the engine's live state and the deviceId",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: "ws://relay.test/ws" });
          const host = createWorkerHost({
            db,
            getDeviceId: async () => DEVICE_A,
            ensureOpen: async () => {},
            socketFactory: (url) => fakeSocket(url),
          });

          const idle = await host.handle({ id: 1, kind: "dev-state", roomId: ROOM_A });
          assertEqual(idle.value.running, false, "no engine yet");
          assertEqual(idle.value.status, "offline", "offline");
          assertEqual(idle.value.deviceId, DEVICE_A, "deviceId travels over the port");

          await host.handle({ id: 2, kind: "room-add", roomId: ROOM_A });
          await new Promise((resolve) => setTimeout(resolve, 50));

          const live = await host.handle({ id: 3, kind: "dev-state", roomId: ROOM_A });
          assertEqual(live.value.running, true, "running");
          assertEqual(live.value.status, "connecting", "connecting");
          assert(live.value.connId !== null, "connId is set");
          assert(
            live.value.log.some((entry) => entry.kind === "status"),
            "the status transition is logged",
          );
          host.stop();
        });
      },
    },
    {
      name: "the client correlates two concurrent commands by id",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const host = createWorkerHost({ db, getDeviceId: async () => DEVICE_A });
          const client = createWorkerClient(localTransport(host));

          // Both in flight at once: a reply matched by arrival order would
          // hand the second command's ack to the first caller.
          const [first, second] = await Promise.all([
            client.post(putItem({ cmdId: "a", item: { name: "Dune" } })),
            client.post(putItem({ cmdId: "b", item: { name: "Emma" } })),
          ]);
          assertEqual(first.opIds.length, 1, "first ack");
          assertEqual(second.opIds.length, 1, "second ack");
          assert(first.opIds[0] !== second.opIds[0], "distinct ops");
          assertEqual(await db.ops.count(), 2, "both committed");
        });
      },
    },
    {
      // The silent-failure report, pinned at the worker boundary: a closed
      // socket must be READABLE from a tab (code + status), and the retry must
      // actually dial rather than return a happy no-op.
      name: "a failed connection is readable, and sync-retry dials again",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: "ws://relay.test/ws" });
          const sockets = [];
          const host = createWorkerHost({
            db,
            getDeviceId: async () => DEVICE_A,
            ensureOpen: async () => {},
            socketFactory: (url) => {
              const socket = fakeSocket(url);
              sockets.push(socket);
              return socket;
            },
          });

          await host.handle({ id: 1, kind: "room-add", roomId: ROOM_A });
          await new Promise((resolve) => setTimeout(resolve, 50));
          sockets[0].open();
          await new Promise((resolve) => setTimeout(resolve, 50));

          // The relay dies under it.
          sockets[0].onclose?.({ code: 1006, reason: "" });
          await new Promise((resolve) => setTimeout(resolve, 50));

          const info = await host.handle({ id: 2, kind: "room-info", roomId: ROOM_A });
          assertEqual(info.ok, true, "room-info answered");
          assertEqual(info.value.status, "offline", "the tab can see it is offline");
          assertEqual(info.value.lastClose.code, 1006, "WITH the close code");

          const retried = await host.handle({ id: 3, kind: "sync-retry", roomId: ROOM_A });
          assertEqual(retried.ok, true, "retry accepted");
          await new Promise((resolve) => setTimeout(resolve, 50));
          assertEqual(sockets.length, 2, "it dialled again instead of waiting out the backoff");

          // No engine means nothing to retry, and saying "ok" would tell the
          // user something was retried when nothing was.
          const missing = await host.handle({ id: 4, kind: "sync-retry", roomId: "nope" });
          assertEqual(missing.ok, false, "refused");
          assertEqual(missing.error.code, "validation", "as a validation error");

          host.stop();
        });
      },
    },
    {
      name: "the client re-raises a CommandError with its code",
      async run() {
        await withDb(async (db) => {
          const host = createWorkerHost({ db, getDeviceId: async () => DEVICE_A });
          const client = createWorkerClient(localTransport(host));
          try {
            await client.post(putItem());
          } catch (error) {
            assert(error instanceof CommandError, "a CommandError, not a bare Error");
            assertEqual(error.code, "validation", "the code survives the round trip");
            return;
          }
          throw new Error("expected the command to reject");
        });
      },
    },
    {
      name: "ladder rung 1: a SharedWorker port is used when one exists",
      async run() {
        const started = await startWorkerClient({
          createSharedWorker: () => deadEndpoint(),
          locks: null,
          channel: null,
        });
        assertEqual(started.mode, "shared", "shared mode");
        assertEqual(started.singleTabOnly, false, "multi-tab is safe");
      },
    },
    {
      name: "ladder rung 3: no SharedWorker and no Web Locks means single-tab mode",
      async run() {
        await withDb(async (db) => {
          const host = createWorkerHost({ db, getDeviceId: async () => DEVICE_A });
          const started = await startWorkerClient({
            createSharedWorker: () => null,
            locks: null,
            channel: null,
            host,
          });
          assertEqual(started.mode, "tab", "tab mode");
          assertEqual(started.singleTabOnly, true, "the app must warn");
        });
      },
    },
    {
      name: "ladder rung 2: the lock holder writes, the follower relays to it",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const host = createWorkerHost({ db, getDeviceId: async () => DEVICE_A });
          const name = `owlshelf-worker-test-${Date.now()}`;
          const locks = queuedLocks();

          // Leader: granted the lock, no dedicated worker, so the host runs
          // in-process. It listens on its channel before the follower starts.
          const leaderChannel = new BroadcastChannel(name);
          const leader = await startWorkerClient({
            createSharedWorker: () => null,
            createDedicatedWorker: () => null,
            locks,
            channel: leaderChannel,
            host,
          });
          assertEqual(leader.mode, "dedicated", "the leader owns the writer");
          assertEqual(leader.isLeader(), true, "the probe won the lock");

          const followerChannel = new BroadcastChannel(name);
          const follower = await startWorkerClient({
            createSharedWorker: () => null,
            createDedicatedWorker: () => null,
            locks,
            channel: followerChannel,
            host,
          });
          assertEqual(follower.mode, "dedicated", "the follower is on the same rung");
          assertEqual(follower.singleTabOnly, false, "a follower is not a second writer");
          assertEqual(follower.isLeader(), false, "the follower does not hold the lock");
          assertEqual(locks.waiting(), 1, "the follower queued for the writer role");

          // The follower's command must commit through the LEADER's host.
          const ack = await follower.client.post(putItem({ cmdId: "relayed" }));
          assertEqual(ack.opIds.length, 1, "the relayed command committed");
          assertEqual(await db.ops.count(), 1, "written by the leader's host");

          // And the leader's own client still works: the relay rewrites ids,
          // so the two id spaces cannot collide.
          const own = await leader.client.post(putItem({ cmdId: "own", item: { name: "Emma" } }));
          assertEqual(own.opIds.length, 1, "the leader's own command committed");
          assertEqual(await db.ops.count(), 2, "two ops");

          leader.client.close();
          follower.client.close();
          leaderChannel.close();
          followerChannel.close();
        });
      },
    },
    {
      name: "ladder rung 2: a follower is promoted when the leader tab goes away",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const host = createWorkerHost({ db, getDeviceId: async () => DEVICE_A });
          const name = `owlshelf-worker-promote-${Date.now()}`;
          const locks = queuedLocks();

          const leaderChannel = new BroadcastChannel(name);
          const leader = await startWorkerClient({
            createSharedWorker: () => null,
            createDedicatedWorker: () => null,
            locks,
            channel: leaderChannel,
            host,
          });

          const followerChannel = new BroadcastChannel(name);
          const follower = await startWorkerClient({
            createSharedWorker: () => null,
            createDedicatedWorker: () => null,
            locks,
            channel: followerChannel,
            host,
          });
          assertEqual(follower.isLeader(), false, "a follower to start");

          // The leader tab unloads: its client and channel go away, so nothing
          // can answer on the channel any more.
          leader.client.close();
          leaderChannel.close();

          // A command posted NOW is stranded — it goes out on the channel and
          // no one is listening. It must still resolve, because promotion
          // re-sends it to the new leader's own worker.
          const stranded = follower.client.post(putItem({ cmdId: "stranded" }));

          locks.release();

          const ack = await stranded;
          assertEqual(ack.opIds.length, 1, "the stranded command committed after promotion");
          assertEqual(follower.isLeader(), true, "the follower took over");
          assertEqual(await db.ops.count(), 1, "exactly one op — the re-send did not duplicate");

          // And it keeps working as the leader.
          const after = await follower.client.post(putItem({ cmdId: "after", item: { name: "Emma" } }));
          assertEqual(after.opIds.length, 1, "the promoted tab writes directly");
          assertEqual(await db.ops.count(), 2, "two ops");

          follower.client.close();
          followerChannel.close();
        });
      },
    },
    {
      // Rung 2's two holes, both found by asking "does the engine actually
      // survive a handoff?".
      //
      // 1. The leader owns a DEDICATED worker, so it dies with the leader tab.
      //    The promoted tab spawns a fresh one with an EMPTY engine map, and
      //    `switchableTransport` only re-sends requests that never got a reply
      //    — a `room-add` that already succeeded is not one of those. Without
      //    `onPromote` every engine is silently lost.
      // 2. `leaderRelay` forwarded replies but not EVENTS, so a follower never
      //    saw `blob-arrived` and its thumbnails stayed blank until a reload.
      name: "ladder rung 2: a promoted tab re-announces its rooms and events reach followers",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: "ws://relay.test/ws" });
          const name = `owlshelf-worker-promote-rooms-${Date.now()}`;
          const locks = queuedLocks();

          // Each tab gets its OWN host, because a dedicated worker is per-tab.
          const leaderHost = createWorkerHost({
            db,
            getDeviceId: async () => DEVICE_A,
            ensureOpen: async () => {},
            socketFactory: (url) => fakeSocket(url),
          });
          const followerHost = createWorkerHost({
            db,
            getDeviceId: async () => DEVICE_A,
            ensureOpen: async () => {},
            socketFactory: (url) => fakeSocket(url),
          });

          const leaderChannel = new BroadcastChannel(name);
          const followerChannel = new BroadcastChannel(name);
          // A failed assertion must not leave a channel open: an open
          // BroadcastChannel keeps Node's event loop alive, so a regression
          // would HANG the suite instead of failing it.
          try {
            const leader = await startWorkerClient({
              createSharedWorker: () => null,
              createDedicatedWorker: () => null,
              locks,
              channel: leaderChannel,
              host: leaderHost,
            });

            const follower = await startWorkerClient({
              createSharedWorker: () => null,
              createDedicatedWorker: () => null,
              locks,
              channel: followerChannel,
              host: followerHost,
            });
            assertEqual(follower.isLeader(), false, "a follower to start");

            // Subscribe BEFORE the room is added, so the engine's first status
            // transition is the event under test.
            const seen = [];
            follower.client.onEvent((event) => seen.push(event.kind));
            let promoted = 0;
            follower.client.onPromote(() => {
              promoted += 1;
            });

            // The follower asks for a room; the leader's host serves it and
            // broadcasts `sync-status`. That broadcast has to cross the channel
            // — `leaderRelay` used to forward replies only, so a follower never
            // saw `blob-arrived` and its thumbnails stayed blank until a reload.
            await follower.client.roomAdd(ROOM_A);
            await new Promise((resolve) => setTimeout(resolve, 50));
            assertEqual(leaderHost.rooms.length, 1, "the leader's host holds the engine");
            assert(seen.includes("sync-status"), "the follower received the broadcast event");

            // The leader goes away.
            leader.client.close();
            leaderChannel.close();
            locks.release();
            await new Promise((resolve) => setTimeout(resolve, 50));

            assertEqual(follower.isLeader(), true, "the follower took over");
            assertEqual(promoted, 1, "the promotion hook fired");

            // The hook is what re-announces the rooms. Without it the new host
            // would be empty and the room would stop syncing forever.
            await follower.client.roomAdd(ROOM_A);
            assertEqual(followerHost.rooms.length, 1, "the new host holds the engine");

            const state = await follower.client.devState(ROOM_A);
            assertEqual(state.running, true, "the engine is live on the new leader");

            follower.client.close();
          } finally {
            leaderChannel.close();
            followerChannel.close();
            leaderHost.stop();
            followerHost.stop();
          }
        });
      },
    },
  ],
};
