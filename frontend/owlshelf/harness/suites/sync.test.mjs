/**
 * sync.test.mjs — the socket lifecycle and the frame dispatcher (§6.6, §9).
 *
 * The engine takes an injected `SocketLike`, so this suite drives it with a
 * fake socket and never opens a real connection. What is under test is the
 * decision table, not the transport: which close code stops, which reconnects,
 * which backs off, and what a frame is allowed to reach.
 */

import {
  BACKOFF_BASE,
  BACKOFF_MAX,
  CLOSE,
  SyncEngine,
  backoffDelay,
  closeAction,
} from "../../src/lib/sync.ts";
import { RESPONDER_SUPPRESS } from "../../src/lib/catchup.ts";
import { NEGATIVE_SEQ } from "../../src/lib/blob.ts";
import { localAuditDigest } from "../../src/lib/audit.ts";
import { bytesToB64, open, seal } from "../../src/lib/envelope.ts";
import { sha256Hex } from "../../src/lib/hash.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, DEVICE_B, ROOM_A, ROOM_KEY, makeOp, seedRoom } from "../lib/fixtures.mjs";

const RELAY = "ws://relay.test/room-a";
const NOW = 1_000_000_000;

/** Let queued microtasks and zero-delay timers run. */
const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A `SocketLike` that records what the engine sent and lets the test fire the
 * four events. `close()` is recorded but does not fire `onclose` — the engine
 * nulls the handlers before closing, so a real socket's echo is a no-op and
 * firing it here would test the fake, not the engine.
 */
function fakeSocket() {
  const sent = [];
  return {
    sent,
    closed: null,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      sent.push(JSON.parse(data));
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
    deliverRaw(data) {
      this.onmessage?.({ data });
    },
    fail(code) {
      this.onclose?.({ code, reason: "" });
    },
  };
}

/** An engine plus the sockets it created, in order. */
function makeEngine(db, overrides = {}) {
  const sockets = [];
  const statuses = [];
  let repairs = 0;
  const engine = new SyncEngine({
    db,
    roomId: ROOM_A,
    deviceId: DEVICE_A,
    socketFactory: () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => NOW,
    randomUUID: (() => {
      let n = 0;
      return () => `conn-${++n}`;
    })(),
    random: () => 0,
    onStatus: (status) => statuses.push(status),
    onRepairNeeded: () => {
      repairs += 1;
    },
    ...overrides,
  });
  return { engine, sockets, statuses, repairs: () => repairs };
}

export default {
  name: "sync — close codes, backoff, hello, dispatch (§6.6, §9)",
  tests: [
    {
      name: "every close code maps to exactly one action",
      async run() {
        assertEqual(closeAction(CLOSE.NORMAL), "stop", "1000");
        assertEqual(closeAction(CLOSE.ORIGIN_REFUSED), "stop", "4401");
        assertEqual(closeAction(CLOSE.GENERATION_MISMATCH), "stop", "4404");
        assertEqual(closeAction(CLOSE.GOING_AWAY), "reconnect", "1001");
        assertEqual(closeAction(CLOSE.TRY_LATER), "backoff", "1013");
        assertEqual(closeAction(CLOSE.HANDSHAKE_TIMEOUT), "backoff", "4402");
        assertEqual(closeAction(CLOSE.ROOM_CAP), "backoff", "4403");
        assertEqual(closeAction(4999), "backoff", "an unknown code backs off");
      },
    },
    {
      name: "backoff is exponential, jittered, and capped",
      async run() {
        // A fixed random makes the doubling exact; the jitter is the multiplier.
        assertEqual(backoffDelay(0, () => 0), 0, "attempt 0 floor");
        assertEqual(backoffDelay(0, () => 0.5), BACKOFF_BASE / 2, "attempt 0");
        assertEqual(backoffDelay(1, () => 0.5), BACKOFF_BASE, "attempt 1 doubles");
        assertEqual(backoffDelay(3, () => 0.5), 4 * BACKOFF_BASE, "attempt 3");
        assertEqual(backoffDelay(50, () => 0.5), BACKOFF_MAX / 2, "capped");
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const ceiling = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** Math.min(attempt, 10));
          const delay = backoffDelay(attempt, () => 0.999);
          assert(delay >= 0 && delay < ceiling, `attempt ${attempt} stays under ${ceiling}`);
        }
      },
    },
    {
      name: "a room with no relay stays offline and opens no socket",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: null });
          const { engine, sockets, statuses } = makeEngine(db);
          await engine.start();
          assertEqual(sockets.length, 0, "no socket");
          assertEqual(engine.currentStatus, "offline", "offline");
          assertDeepEqual(statuses, [], "no transition to announce");
        });
      },
    },
    {
      name: "a room with no relayUrl dials the engine's default",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: null });
          const { engine, sockets } = makeEngine(db, { defaultRelayUrl: RELAY });
          await engine.start();
          try {
            await tick();
            assertEqual(sockets.length, 1, "one socket");
            assertEqual(engine.currentStatus, "connecting", "connecting");
          } finally {
            engine.stop();
          }
        });
      },
    },
    {
      name: "a room's own relayUrl beats the default",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: "ws://own.test/ws" });
          const { engine, sockets } = makeEngine(db, { defaultRelayUrl: RELAY });
          await engine.start();
          try {
            await tick();
            assertEqual(sockets.length, 1, "one socket");
          } finally {
            engine.stop();
          }
        });
      },
    },
    {
      // `resume()` sees `socket === null` after a drop and dials, while the
      // backoff timer is still pending. Two concurrent attempts would orphan
      // the first socket: it keeps receiving frames, and its `onclose` later
      // nulls `this.socket` out from under the live one. `random: () => 0`
      // makes the backoff delay 0, so the race is deterministic here.
      name: "a resume during a pending retry opens one socket, not two",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          try {
            await tick();
            sockets[0].open();
            await tick();
            assertEqual(sockets.length, 1, "one socket to start");

            sockets[0].fail(1006);
            engine.resume();
            await tick(60);

            assertEqual(sockets.length, 2, "one re-dial");
          } finally {
            engine.stop();
          }
        });
      },
    },
    {
      // React StrictMode mounts, unmounts, and remounts every effect, so
      // `stop()` can land while `connect()` is still awaiting the room read.
      // Dialling after that leaves a socket nobody owns and nobody closes.
      name: "stop during an in-flight dial leaves no socket",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const { engine, sockets } = makeEngine(db);
          const started = engine.start();
          engine.stop();
          await started;
          await tick(60);
          assertEqual(sockets.length, 0, "no orphan socket");
        });
      },
    },
    {
      name: "an unknown room stays offline rather than throwing",
      async run() {
        await withDb(async (db) => {
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          assertEqual(sockets.length, 0, "no socket");
          assertEqual(engine.currentStatus, "offline", "offline");
        });
      },
    },
    {
      name: "start() connects and the hello carries the room's identity",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets, statuses } = makeEngine(db);
          await engine.start();

          assertEqual(sockets.length, 1, "one socket");
          assertEqual(engine.currentStatus, "connecting", "connecting");
          assertDeepEqual(statuses, ["connecting"], "one transition");

          sockets[0].open();
          await tick();

          const hello = sockets[0].sent[0];
          assertEqual(hello.type, "hello", "type");
          assertEqual(hello.v, 1, "version");
          assertEqual(hello.connId, "conn-1", "connId");
          assertEqual(hello.roomId, ROOM_A, "roomId");
          assertEqual(hello.keyGen, 1, "keyGen");
          assertEqual(typeof hello.hash, "string", "hash present");
          assertEqual(hello.hash.length, 64, "sha256 hex");
          assertEqual(hello.roomKey, undefined, "the key itself never leaves", );
        });
      },
    },
    {
      name: "presence fans a catch-up request out to EVERY member",
      async run() {
        // audit-2 N12: a single named peer may be stale and answer "complete"
        // while missing history, so the request is not targeted.
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].deliver({ type: "presence", members: ["conn-9", "conn-8"] });
          await tick();

          const requests = sockets[0].sent.filter((f) => f.kind === "catchup-request");
          assertEqual(requests.length, 2, "one per member");
          assertDeepEqual(
            requests.map((f) => f.to).sort(),
            ["conn-8", "conn-9"],
            "targeted at each member",
          );
          assertEqual(engine.currentStatus, "syncing", "syncing");
        });
      },
    },
    {
      name: "an empty presence sends nothing",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].deliver({ type: "presence", members: [] });
          await tick();

          assertEqual(
            sockets[0].sent.filter((f) => f.kind === "catchup-request").length,
            0,
            "no request",
          );
        });
      },
    },
    {
      name: "a ping is answered with a pong",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].deliver({ type: "ping" });
          await tick();

          assertDeepEqual(sockets[0].sent.at(-1), { type: "pong" }, "pong");
        });
      },
    },
    {
      name: "a malformed frame is dropped, never fatal",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].deliverRaw("not json");
          sockets[0].deliverRaw("null");
          sockets[0].deliver({ type: "presence", members: "nope" });
          sockets[0].deliver({ v: 1, roomId: ROOM_A, keyGen: 1, kind: "op", body: "" });
          await tick();

          assertEqual(engine.currentStatus, "connecting", "still connected");
          assertEqual(sockets[0].closed, null, "socket not closed");
        });
      },
    },
    {
      name: "4401 stops for good — retrying a permanent refusal is a loop",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].fail(CLOSE.ORIGIN_REFUSED);
          await tick(60);

          assertEqual(engine.currentStatus, "offline", "offline");
          assertEqual(sockets.length, 1, "no reconnect");
        });
      },
    },
    {
      name: "onClose reports the code before the close is acted on",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const closes = [];
          const { engine, sockets } = makeEngine(db, {
            onClose: (code, reason) => closes.push({ code, reason }),
          });
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].fail(CLOSE.ORIGIN_REFUSED);
          await tick(60);

          assertEqual(closes.length, 1, "one close reported");
          assertEqual(closes[0].code, CLOSE.ORIGIN_REFUSED, "the code");
          // Without this the panel can only say "offline", which is the same
          // word for a refused origin and a relay that is not running.
          assertEqual(engine.currentStatus, "offline", "and the close still acted on");
        });
      },
    },
    {
      name: "4404 stops AND asks for a re-pair",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets, repairs } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].fail(CLOSE.GENERATION_MISMATCH);
          await tick(60);

          assertEqual(repairs(), 1, "re-pair requested");
          assertEqual(sockets.length, 1, "no reconnect");
        });
      },
    },
    {
      name: "1001 reconnects immediately without inflating the backoff",
      async run() {
        // A tab going hidden is not a failure. Backing off here would make a
        // backgrounded phone take 30s to resume after every visibility change.
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].fail(CLOSE.GOING_AWAY);
          await tick(60);

          assertEqual(sockets.length, 2, "reconnected");
          assertEqual(engine.currentStatus, "connecting", "connecting again");
        });
      },
    },
    {
      name: "1013 backs off instead of hammering the relay",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].fail(CLOSE.TRY_LATER);
          assertEqual(engine.currentStatus, "offline", "offline while waiting");
          assertEqual(sockets.length, 1, "not yet reconnected");

          await tick(60);
          assertEqual(sockets.length, 2, "retried after the delay");
        });
      },
    },
    {
      name: "stop() closes the socket and clears presence",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-9"] });
          await tick();

          engine.stop();

          assertEqual(sockets[0].closed.code, CLOSE.NORMAL, "closed 1000");
          assertEqual(engine.currentStatus, "offline", "offline");
          assertDeepEqual(engine.members, [], "presence cleared");
          assertEqual(engine.connectionId, null, "connId cleared");
        });
      },
    },
    {
      name: "a sealed op from a peer is admitted and repaints",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          const op = makeOp({ opId: "op-remote", deviceId: DEVICE_B, authorSeq: 1 });
          const envelope = await seal(ROOM_KEY, ROOM_A, 1, "op", op, { to: "conn-1" });
          sockets[0].deliver({ ...envelope, from: "conn-9" });
          await tick();

          const row = await db.items.get("item-1");
          assert(row !== undefined, "the row exists");
          assertEqual(row.name, "Book", "payload applied");
        });
      },
    },
    {
      name: "a tampered envelope never reaches durable state",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          const op = makeOp({ opId: "op-remote", deviceId: DEVICE_B, authorSeq: 1 });
          const envelope = await seal(ROOM_KEY, ROOM_A, 1, "op", op);
          const bytes = Buffer.from(envelope.body, "base64");
          bytes[bytes.length - 1] ^= 0xff;
          sockets[0].deliver({ ...envelope, body: bytes.toString("base64"), from: "conn-9" });
          await tick();

          assertEqual(await db.items.get("item-1"), undefined, "nothing written");
          assertEqual(await db.ops.get("op-remote"), undefined, "no op recorded");
        });
      },
    },
    {
      name: "an envelope for another room is dropped before the decrypt",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          const op = makeOp({ opId: "op-remote", deviceId: DEVICE_B, authorSeq: 1 });
          const envelope = await seal(ROOM_KEY, "room-other", 1, "op", op);
          sockets[0].deliver({ ...envelope, from: "conn-9" });
          await tick();

          assertEqual(await db.items.get("item-1"), undefined, "nothing written");
        });
      },
    },
    {
      name: "a sealed body's deviceId is attributed to its connection",
      async run() {
        // The spec never defines connId → deviceId, but the ack rule needs it.
        // The sealed body is the only authenticated source.
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          const request = { requestId: "r1", cursors: {}, deviceId: DEVICE_B };
          const envelope = await seal(ROOM_KEY, ROOM_A, 1, "catchup-request", request);
          sockets[0].deliver({ ...envelope, from: "conn-9" });
          await tick();

          assertEqual(engine.deviceIdOf("conn-9"), DEVICE_B, "attributed");
          assertEqual(engine.deviceIdOf("conn-8"), null, "unknown stays unknown");
        });
      },
    },
    {
      name: "sendOp seals the op and counts the attempt",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          const op = makeOp({ opId: "op-1", authorSeq: 1 });
          await db.ops.put(op);
          await db.outbox.put({
            opId: "op-1",
            roomId: ROOM_A,
            deviceId: DEVICE_A,
            authorSeq: 1,
            state: "pending",
            attempts: 0,
            createdAt: 0,
          });

          assertEqual(await engine.sendOp(op), true, "sent");
          const frame = sockets[0].sent.at(-1);
          assertEqual(frame.kind, "op", "kind");
          assertEqual(frame.roomId, ROOM_A, "roomId");
          assertEqual((await db.outbox.get("op-1")).attempts, 1, "attempt counted");
        });
      },
    },
    {
      name: "sendOp with no socket reports failure and counts nothing",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: null });
          const { engine } = makeEngine(db);
          await engine.start();

          const op = makeOp({ opId: "op-1", authorSeq: 1 });
          await db.outbox.put({
            opId: "op-1",
            roomId: ROOM_A,
            deviceId: DEVICE_A,
            authorSeq: 1,
            state: "pending",
            attempts: 0,
            createdAt: 0,
          });

          assertEqual(await engine.sendOp(op), false, "not sent");
          assertEqual((await db.outbox.get("op-1")).attempts, 0, "no attempt");
        });
      },
    },
    {
      name: "drainOutbox sends in authorSeq order",
      async run() {
        await withDb(async (db) => {
          // A reachable peer with no cursor keeps the entries pending; a solo
          // room would ack them all and leave nothing to send.
          await seedRoom(db, {
            relayUrl: RELAY,
            roster: [
              { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
              { deviceId: DEVICE_B, role: "member", addedAt: 0 },
            ],
            lastSeen: { [DEVICE_B]: NOW },
          });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          for (const seq of [3, 1, 2]) {
            await db.ops.put(makeOp({ opId: `op-${seq}`, authorSeq: seq }));
            await db.outbox.put({
              opId: `op-${seq}`,
              roomId: ROOM_A,
              deviceId: DEVICE_A,
              authorSeq: seq,
              state: "pending",
              attempts: 0,
              createdAt: 0,
            });
          }

          assertEqual(await engine.drainOutbox(), 3, "three sent");
          const sent = sockets[0].sent.filter((f) => f.kind === "op");
          assertEqual(sent.length, 3, "three op frames");
        });
      },
    },
    {
      name: "presence PUSHES our pending ops, not just pulls history",
      async run() {
        // The bug this pins: `drainOutbox` had no caller in the app at all.
        // The engine pulled through catch-up and never sent its own ops, so
        // two devices sharing a room key still never converged — the outbox
        // just grew while the panel showed "pending N".
        await withDb(async (db) => {
          await seedRoom(db, {
            relayUrl: RELAY,
            roster: [
              { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
              { deviceId: DEVICE_B, role: "member", addedAt: 0 },
            ],
            lastSeen: { [DEVICE_B]: NOW },
          });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          await db.ops.put(makeOp({ opId: "op-1", authorSeq: 1 }));
          await db.outbox.put({
            opId: "op-1",
            roomId: ROOM_A,
            deviceId: DEVICE_A,
            authorSeq: 1,
            state: "pending",
            attempts: 0,
            createdAt: 0,
          });

          sockets[0].deliver({ type: "presence", members: ["conn-9"] });
          await tick();

          const sent = sockets[0].sent.filter((f) => f.kind === "op");
          assertEqual(sent.length, 1, "the pending op went out on presence");
        });
      },
    },
    {
      name: "the drain timer pushes an op minted after presence settled",
      async run() {
        // Presence only fires on a membership change, so an op created while
        // the room is already connected needs the timer or it never leaves.
        await withDb(async (db) => {
          await seedRoom(db, {
            relayUrl: RELAY,
            roster: [
              { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
              { deviceId: DEVICE_B, role: "member", addedAt: 0 },
            ],
            lastSeen: { [DEVICE_B]: NOW },
          });
          const { engine, sockets } = makeEngine(db, { drainInterval: 20 });
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-9"] });
          await tick();

          await db.ops.put(makeOp({ opId: "op-1", authorSeq: 1 }));
          await db.outbox.put({
            opId: "op-1",
            roomId: ROOM_A,
            deviceId: DEVICE_A,
            authorSeq: 1,
            state: "pending",
            attempts: 0,
            createdAt: 0,
          });

          await tick(80);
          const sent = sockets[0].sent.filter((f) => f.kind === "op");
          // More than one is correct: the entry stays pending until a peer's
          // cursor covers it, so every tick re-sends. The assertion is that
          // the timer drained it at all — without the timer it is zero.
          assert(sent.length >= 1, `the timer drained it, got ${sent.length}`);
          assertEqual(sent[0].kind, "op", "an op frame");
          engine.stop();
        });
      },
    },
    {
      name: "requestCatchup with no presence is a no-op",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          assertEqual(await engine.requestCatchup(), null, "no requestId");
          assertEqual(
            sockets[0].sent.filter((f) => f.kind === "catchup-request").length,
            0,
            "nothing sent",
          );
        });
      },
    },
    {
      name: "the room key never appears in a plaintext frame",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-9"] });
          await tick();

          const wire = JSON.stringify(sockets[0].sent);
          assert(!wire.includes(ROOM_KEY), "the key is not on the wire");
          assert(!wire.includes("roomKey"), "no frame names the key");
          for (const frame of sockets[0].sent) {
            if (frame.kind === undefined) continue;
            assertEqual(typeof frame.body, "string", "sealed frames carry only a body");
          }
        });
      },
    },

    // ── Adoption proofs (§6.6: three sources, all of them) ─────────────────

    {
      name: "a catch-up request's cursors are recorded as adoption proof",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          const request = { requestId: "r1", cursors: { [DEVICE_A]: 3 }, deviceId: DEVICE_B };
          const envelope = await seal(ROOM_KEY, ROOM_A, 1, "catchup-request", request);
          sockets[0].deliver({ ...envelope, from: "conn-9" });
          await tick();

          const room = await db.meta.get(`room:${ROOM_A}`);
          assertEqual(room.peerCursors[DEVICE_B][DEVICE_A], 3, "recorded");
        });
      },
    },
    {
      name: "an audit's high-water marks are recorded as adoption proof",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          const audit = { highWater: { [DEVICE_A]: 4 }, counts: {}, digest: "x", deviceId: DEVICE_B };
          const envelope = await seal(ROOM_KEY, ROOM_A, 1, "audit", audit);
          sockets[0].deliver({ ...envelope, from: "conn-9" });
          await tick();

          const room = await db.meta.get(`room:${ROOM_A}`);
          assertEqual(room.peerCursors[DEVICE_B][DEVICE_A], 4, "recorded");
        });
      },
    },
    {
      name: "sendAudit seals high-water, counts, and a digest",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY, nextAuthorSeq: 3 });
          await db.ops.put(makeOp({ opId: "op-1", authorSeq: 1 }));
          await db.ops.put(makeOp({ opId: "op-2", authorSeq: 2 }));

          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          assertEqual(await engine.sendAudit(), true, "sent");
          const frame = sockets[0].sent.at(-1);
          assertEqual(frame.kind, "audit", "kind");

          const body = await open(ROOM_KEY, frame);
          assertEqual(body.highWater[DEVICE_A], 2, "own nextAuthorSeq - 1");
          assertEqual(body.counts[DEVICE_A], 2, "two ops authored");
          assertEqual(typeof body.digest, "string", "digest present");
          assertEqual(body.digest.length, 64, "sha256 hex");
        });
      },
    },
    {
      name: "an audit that agrees changes nothing",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY, nextAuthorSeq: 2 });
          await db.ops.put(makeOp({ opId: "op-1", authorSeq: 1 }));

          const { engine, sockets, statuses } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          const digest = await localAuditDigest(db, ROOM_A);
          const audit = { highWater: { [DEVICE_A]: 1 }, counts: { [DEVICE_A]: 1 }, digest };
          const envelope = await seal(ROOM_KEY, ROOM_A, 1, "audit", audit);
          sockets[0].deliver({ ...envelope, from: "conn-9" });
          await tick();

          assert(!statuses.includes("attention"), "no attention");
          assertEqual(
            sockets[0].sent.filter((f) => f.kind === "catchup-request").length,
            0,
            "no catch-up",
          );
        });
      },
    },
    {
      name: "an audit mismatch with different high-water is rung 1: catch up",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY, nextAuthorSeq: 2 });
          await db.ops.put(makeOp({ opId: "op-1", authorSeq: 1 }));

          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-9"] });
          await tick();
          const before = sockets[0].sent.filter((f) => f.kind === "catchup-request").length;

          const audit = { highWater: { [DEVICE_A]: 9 }, counts: {}, digest: "wrong" };
          const envelope = await seal(ROOM_KEY, ROOM_A, 1, "audit", audit);
          sockets[0].deliver({ ...envelope, from: "conn-9" });
          await tick();

          const after = sockets[0].sent.filter((f) => f.kind === "catchup-request").length;
          assert(after > before, "a catch-up was requested");
        });
      },
    },
    {
      name: "an audit mismatch with the SAME high-water is rung 2: attention",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY, nextAuthorSeq: 2 });
          await db.ops.put(makeOp({ opId: "op-1", authorSeq: 1 }));

          const { engine, sockets, statuses } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          const audit = { highWater: { [DEVICE_A]: 1 }, counts: {}, digest: "wrong" };
          const envelope = await seal(ROOM_KEY, ROOM_A, 1, "audit", audit);
          sockets[0].deliver({ ...envelope, from: "conn-9" });
          await tick();

          assert(statuses.includes("attention"), "reducer non-determinism surfaced");
        });
      },
    },

    // ── The suppression ladder (§6.6 step 1) ───────────────────────────────

    {
      name: "a non-elected member serves after RESPONDER_SUPPRESS if nobody starts",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY, nextAuthorSeq: 2 });
          await db.ops.put(makeOp({ opId: "op-1", authorSeq: 1 }));

          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          // conn-0 is lower and covers, so we are rank 1.
          sockets[0].deliver({ type: "presence", members: ["conn-0", "conn-1"] });
          await tick();
          const audit = { highWater: { [DEVICE_B]: 5 }, counts: {}, digest: "x" };
          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "audit", audit)),
            from: "conn-0",
          });
          await tick();

          const request = { requestId: "r1", cursors: {}, deviceId: DEVICE_B };
          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "catchup-request", request)),
            from: "conn-9",
          });

          await tick(50);
          assertEqual(
            sockets[0].sent.filter((f) => f.kind === "catchup-reply").length,
            0,
            "suppressed at first",
          );

          await tick(RESPONDER_SUPPRESS + 150);
          assert(
            sockets[0].sent.filter((f) => f.kind === "catchup-reply").length > 0,
            "served after the window",
          );
        });
      },
    },
    {
      name: "a catchup-started notice cancels the suppression timer",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY, nextAuthorSeq: 2 });
          await db.ops.put(makeOp({ opId: "op-1", authorSeq: 1 }));

          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].deliver({ type: "presence", members: ["conn-0", "conn-1"] });
          await tick();
          const audit = { highWater: { [DEVICE_B]: 5 }, counts: {}, digest: "x" };
          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "audit", audit)),
            from: "conn-0",
          });
          await tick();

          const request = { requestId: "r1", cursors: {}, deviceId: DEVICE_B };
          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "catchup-request", request)),
            from: "conn-9",
          });
          await tick(20);

          // conn-0 announces it started, so we stand down.
          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "control", {
              type: "catchup-started",
              requestId: "r1",
            })),
            from: "conn-0",
          });

          await tick(RESPONDER_SUPPRESS + 150);
          assertEqual(
            sockets[0].sent.filter((f) => f.kind === "catchup-reply").length,
            0,
            "never served",
          );
        });
      },
    },
    {
      name: "the elected member announces before it serves",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY, nextAuthorSeq: 2 });
          await db.ops.put(makeOp({ opId: "op-1", authorSeq: 1 }));

          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-1"] });
          await tick();

          const request = { requestId: "r1", cursors: {}, deviceId: DEVICE_B };
          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "catchup-request", request)),
            from: "conn-9",
          });
          await tick();

          const kinds = sockets[0].sent.map((f) => f.kind).filter(Boolean);
          const startedAt = kinds.indexOf("control");
          const replyAt = kinds.indexOf("catchup-reply");
          assert(startedAt !== -1, "announced");
          assert(replyAt !== -1, "served");
          assert(startedAt < replyAt, "announcement precedes the reply");
        });
      },
    },

    // ── Restartable catch-up ───────────────────────────────────────────────

    {
      name: "a chunk gap restarts the catch-up instead of stalling forever",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-9"] });
          await tick();

          const requestId = await engine.requestCatchup();
          assert(typeof requestId === "string", "a request was made");
          const before = sockets[0].sent.filter((f) => f.kind === "catchup-request").length;

          // chunkNo 1 with no chunk 0: a lost chunk. The session cannot verify
          // a partial range, so it must restart rather than stay broken.
          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "catchup-reply", {
              requestId,
              chunkNo: 1,
              ops: [],
            })),
            from: "conn-9",
          });
          await tick();

          assertEqual(engine.collector(requestId), undefined, "the broken collector is dropped");
          const after = sockets[0].sent.filter((f) => f.kind === "catchup-request").length;
          assert(after > before, "a fresh catch-up was requested");
        });
      },
    },
    {
      name: "a reply for a request we never made is ignored",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "catchup-reply", {
              requestId: "unknown",
              chunkNo: 0,
              ops: [],
            })),
            from: "conn-9",
          });
          await tick();

          assertEqual(engine.collector("unknown"), undefined, "no collector invented");
          assertEqual(sockets[0].closed, null, "socket still open");
        });
      },
    },

    // ── Session lifecycle (§6.6, §7.1) ─────────────────────────────────────

    {
      name: "suspend then resume inside the window keeps the socket",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db, { hiddenDisconnect: 40 });
          await engine.start();
          sockets[0].open();
          await tick();

          engine.suspend();
          await tick(10);
          engine.resume();
          await tick(60);

          assertEqual(sockets[0].closed, null, "never closed");
          assertEqual(sockets.length, 1, "no reconnect");
        });
      },
    },
    {
      name: "suspend past the window disconnects with 1001",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db, { hiddenDisconnect: 20 });
          await engine.start();
          sockets[0].open();
          await tick();

          engine.suspend();
          await tick(60);

          assertEqual(sockets[0].closed.code, CLOSE.GOING_AWAY, "1001");
          assertEqual(engine.currentStatus, "offline", "offline");
        });
      },
    },
    {
      name: "resume after stop reconnects",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          engine.stop();
          assertEqual(engine.currentStatus, "offline", "stopped");

          engine.resume();
          await tick(60);

          assertEqual(sockets.length, 2, "reconnected");
          assertEqual(engine.currentStatus, "connecting", "connecting");
        });
      },
    },
    {
      name: "resume on a live socket asks for catch-up",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-9"] });
          await tick();
          const before = sockets[0].sent.filter((f) => f.kind === "catchup-request").length;

          engine.resume();
          await tick();

          const after = sockets[0].sent.filter((f) => f.kind === "catchup-request").length;
          assert(after > before, "resync on resume");
        });
      },
    },

    // ── Replay (Gate D) ────────────────────────────────────────────────────

    {
      name: "a replayed envelope is absorbed, not re-applied",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          const op = makeOp({ opId: "op-remote", deviceId: DEVICE_B, authorSeq: 1 });
          const envelope = await seal(ROOM_KEY, ROOM_A, 1, "op", op);
          sockets[0].deliver({ ...envelope, from: "conn-9" });
          await tick();
          sockets[0].deliver({ ...envelope, from: "conn-9" });
          await tick();

          assertEqual((await db.ops.toArray()).length, 1, "one op");
          assertEqual((await db.items.toArray()).length, 1, "one row");
        });
      },
    },
    // ── Blobs (§6.6, §15.4) ────────────────────────────────────────────────

    {
      name: "requestBlob fans out to every presence member",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-8", "conn-9"] });
          await tick();

          const requestId = await engine.requestBlob("abc123");
          assert(typeof requestId === "string", "a requestId");

          const requests = sockets[0].sent.filter((f) => f.kind === "blob-request");
          assertEqual(requests.length, 2, "one per member");
          assertDeepEqual(
            requests.map((f) => f.to).sort(),
            ["conn-8", "conn-9"],
            "targeted at each",
          );
        });
      },
    },
    {
      name: "requestBlob with no presence is a no-op",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          assertEqual(await engine.requestBlob("abc123"), null, "no requestId");
          assertEqual(
            sockets[0].sent.filter((f) => f.kind === "blob-request").length,
            0,
            "nothing sent",
          );
        });
      },
    },
    {
      name: "a second request for the same hash reuses the transfer",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-9"] });
          await tick();

          const first = await engine.requestBlob("abc123");
          const second = await engine.requestBlob("abc123");
          assertEqual(first, second, "one outstanding transfer per room");
        });
      },
    },
    {
      name: "a verified blob is written to files and announced",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const blobs = [];
          const { engine, sockets } = makeEngine(db, { onBlob: (hash) => blobs.push(hash) });
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-9"] });
          await tick();

          const bytes = new Uint8Array(500).fill(4);
          const hash = await sha256Hex(bytes);
          const requestId = await engine.requestBlob(hash);

          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "file-chunk", {
              requestId,
              seq: 0,
              bytes: bytesToB64(bytes),
              totalBytes: bytes.byteLength,
              totalChunks: 1,
              contentType: "image/webp",
              deviceId: DEVICE_B,
            })),
            from: "conn-9",
          });
          await tick();

          const row = await db.files.get([ROOM_A, hash]);
          assert(row !== undefined, "stored");
          assertEqual(row.contentType, "image/webp", "contentType");
          assertEqual(row.size, 500, "size");
          assertDeepEqual(blobs, [hash], "announced once");
          assertEqual(engine.transfer(requestId), undefined, "transfer retired");
        });
      },
    },
    {
      name: "a blob whose bytes do not hash to its name is never stored",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-9"] });
          await tick();

          const bytes = new Uint8Array(500).fill(4);
          const wrongHash = await sha256Hex(new Uint8Array(500).fill(5));
          const requestId = await engine.requestBlob(wrongHash);

          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "file-chunk", {
              requestId,
              seq: 0,
              bytes: bytesToB64(bytes),
              totalBytes: bytes.byteLength,
              totalChunks: 1,
              contentType: "image/webp",
              deviceId: DEVICE_B,
            })),
            from: "conn-9",
          });
          await tick();

          assertEqual(await db.files.get([ROOM_A, wrongHash]), undefined, "nothing written");
          assertEqual(engine.transfer(requestId).failedWith, "hash-mismatch", "named failure");
        });
      },
    },
    {
      name: "a negative answer keeps the transfer open for other peers",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-8", "conn-9"] });
          await tick();

          const requestId = await engine.requestBlob("abc123");
          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "file-chunk", {
              requestId,
              seq: NEGATIVE_SEQ,
              deviceId: DEVICE_B,
            })),
            from: "conn-8",
          });
          await tick();

          const transfer = engine.transfer(requestId);
          assert(transfer !== undefined, "still open");
          assertEqual(transfer.isFailed, false, "not a failure");
          assertDeepEqual(transfer.notHeld, [DEVICE_B], "recorded");
        });
      },
    },
    {
      name: "activeTransfers lists what GC must not delete",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();
          sockets[0].deliver({ type: "presence", members: ["conn-9"] });
          await tick();

          await engine.requestBlob("abc123");
          assertDeepEqual(engine.activeTransfers(), ["abc123"], "in flight");
        });
      },
    },
    {
      name: "a blob-request for a held blob is answered with its chunks",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const bytes = new Uint8Array(300).fill(6);
          const hash = await sha256Hex(bytes);
          await db.files.put({
            roomId: ROOM_A,
            hash,
            bytes,
            contentType: "image/webp",
            size: bytes.byteLength,
            createdAt: 0,
          });

          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "blob-request", {
              requestId: "r1",
              hash,
              deviceId: DEVICE_B,
            })),
            from: "conn-9",
          });
          await tick();

          const chunks = sockets[0].sent.filter((f) => f.kind === "file-chunk");
          assertEqual(chunks.length, 1, "one chunk");
          assertEqual(chunks[0].to, "conn-9", "routed to the requester only");
        });
      },
    },
    {
      name: "a blob-request for a missing blob is answered NEGATIVE",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { relayUrl: RELAY });
          const { engine, sockets } = makeEngine(db);
          await engine.start();
          sockets[0].open();
          await tick();

          sockets[0].deliver({
            ...(await seal(ROOM_KEY, ROOM_A, 1, "blob-request", {
              requestId: "r1",
              hash: "nope",
              deviceId: DEVICE_B,
            })),
            from: "conn-9",
          });
          await tick();

          const chunks = sockets[0].sent.filter((f) => f.kind === "file-chunk");
          assertEqual(chunks.length, 1, "one frame");
          const body = await open(ROOM_KEY, chunks[0]);
          assertEqual(body.seq, NEGATIVE_SEQ, "seq -1");
        });
      },
    },
  ],
};
