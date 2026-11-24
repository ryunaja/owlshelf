/**
 * socketHub.test.mjs — one wire, many rooms (§9 amendment), executed.
 *
 * The relay's tests (`tests/test_multiplex.py`) prove the frames; this suite
 * proves the CLIENT half: that an engine which still thinks it owns a socket
 * ends up sharing one, that its frames cannot leak into another room, and that
 * a per-room failure stays per-room.
 *
 * The fake relay below answers exactly what the real one does — `joined` for a
 * `join`, presence tagged with a hash, envelopes tagged with `roomId` — because
 * a fake that is more forgiving than the relay tests a client that will not
 * work against it.
 */

import { createSocketHub } from "../../src/lib/socketHub.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";

const RELAY = "ws://relay.test/ws";
const OTHER = "ws://other.test/ws";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** A wire socket whose frames the test can inspect and drive. */
function wire() {
  return {
    url: null,
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
    drop(code, reason) {
      this.onclose?.({ code, reason });
    },
  };
}

function makeHub() {
  const wires = [];
  const hub = createSocketHub({
    dial: (url) => {
      const socket = wire();
      socket.url = url;
      wires.push(socket);
      return socket;
    },
  });
  return { hub, wires };
}

function hello(roomId, hash, keyGen = 1) {
  return JSON.stringify({ v: 1, type: "hello", connId: `conn-${roomId}`, roomId, keyGen, hash });
}

const sentOf = (socket, type) => socket.sent.filter((frame) => frame.type === type);
const sentKind = (socket, kind) => socket.sent.filter((frame) => frame.kind === kind);

export default {
  name: "socketHub — one socket per device, not one per room (§9)",
  tests: [
    {
      name: "two rooms on one relay share ONE wire, and the second joins it",
      async run() {
        const { hub, wires } = makeHub();
        const a = hub.socketFactory(RELAY);
        const b = hub.socketFactory(RELAY);

        a.send(hello("room-a", HASH_A));
        b.send(hello("room-b", HASH_B));
        assertEqual(wires.length, 1, "one socket for the device");
        assertEqual(hub.socketCount(), 1, "the hub counts wires");

        wires[0].open();
        await tick();

        assertEqual(sentOf(wires[0], "hello").length, 1, "one hello opens the wire");
        const joins = sentOf(wires[0], "join");
        assertEqual(joins.length, 1, "the second room joins it");
        assertEqual(joins[0].roomId, "room-b", "and names its own room");
        assertEqual(joins[0].hash, HASH_B, "with its hash");
        hub.stop();
      },
    },
    {
      name: "a room whose hello arrives while the wire is dialling joins after it",
      async run() {
        const { hub, wires } = makeHub();
        const a = hub.socketFactory(RELAY);
        const b = hub.socketFactory(RELAY);
        a.send(hello("room-a", HASH_A));
        b.send(hello("room-b", HASH_B));
        // Not open yet: sending a join now would name a room the relay has not
        // admitted, and the relay drops it as a shape error.
        assertEqual(sentOf(wires[0], "join").length, 0, "no join before the hello");

        wires[0].open();
        await tick();
        assertDeepEqual(
          wires[0].sent.map((frame) => frame.type),
          ["hello", "join"],
          "hello first, then the join",
        );
        hub.stop();
      },
    },
    {
      name: "a non-primary room's frames are held until the relay says joined",
      async run() {
        const { hub, wires } = makeHub();
        const a = hub.socketFactory(RELAY);
        const b = hub.socketFactory(RELAY);
        a.send(hello("room-a", HASH_A));
        b.send(hello("room-b", HASH_B));
        wires[0].open();
        await tick();

        b.send(JSON.stringify({ v: 1, roomId: "room-b", keyGen: 1, kind: "op", body: "eA==" }));
        assertEqual(sentKind(wires[0], "op").length, 0, "held, not sent into a room nobody routed");

        wires[0].deliver({ type: "joined", hash: HASH_B, keyGen: 1 });
        await tick();
        assertEqual(sentKind(wires[0], "op").length, 1, "flushed once joined");
        hub.stop();
      },
    },
    {
      name: "inbound frames reach only the room they name",
      async run() {
        const { hub, wires } = makeHub();
        const a = hub.socketFactory(RELAY);
        const b = hub.socketFactory(RELAY);
        const seenA = [];
        const seenB = [];
        a.onmessage = (event) => seenA.push(JSON.parse(event.data));
        b.onmessage = (event) => seenB.push(JSON.parse(event.data));
        a.send(hello("room-a", HASH_A));
        b.send(hello("room-b", HASH_B));
        wires[0].open();
        await tick();
        wires[0].deliver({ type: "joined", hash: HASH_B, keyGen: 1 });

        wires[0].deliver({ type: "presence", hash: HASH_A, members: ["c1"] });
        wires[0].deliver({ v: 1, roomId: "room-b", keyGen: 1, kind: "op", body: "eA==" });

        assertEqual(seenA.length, 1, "A saw exactly its presence");
        assertEqual(seenA[0].type, "presence", "and it is presence");
        assertEqual(seenB.length, 1, "B saw exactly its envelope");
        assertEqual(seenB[0].kind, "op", "and it is the envelope");
        hub.stop();
      },
    },
    {
      name: "the relay heartbeat is answered once per wire, not once per room",
      async run() {
        const { hub, wires } = makeHub();
        const a = hub.socketFactory(RELAY);
        const b = hub.socketFactory(RELAY);
        let pingsSeen = 0;
        a.onmessage = () => (pingsSeen += 1);
        b.onmessage = () => (pingsSeen += 1);
        a.send(hello("room-a", HASH_A));
        b.send(hello("room-b", HASH_B));
        wires[0].open();
        await tick();

        wires[0].deliver({ type: "ping" });
        await tick();
        assertEqual(sentOf(wires[0], "pong").length, 1, "one pong");
        assertEqual(pingsSeen, 0, "the engines never see the wire heartbeat");
        hub.stop();
      },
    },
    {
      name: "a refused join closes THAT room and leaves the others connected",
      async run() {
        const { hub, wires } = makeHub();
        const a = hub.socketFactory(RELAY);
        const b = hub.socketFactory(RELAY);
        const closedA = [];
        const closedB = [];
        a.onclose = (event) => closedA.push(event);
        b.onclose = (event) => closedB.push(event);
        a.send(hello("room-a", HASH_A));
        b.send(hello("room-b", HASH_B));
        wires[0].open();
        await tick();

        // A rotation on one shelf: the stale generation is refused, and the
        // other shelf must not notice.
        wires[0].deliver({ type: "join-refused", hash: HASH_B, code: 4404, reason: "generation" });
        await tick();

        assertEqual(closedA.length, 0, "the healthy room stays open");
        assertEqual(closedB.length, 1, "the refused room is closed");
        assertEqual(closedB[0].code, 4404, "with the relay's code, so the engine re-pairs");
        assertEqual(wires[0].closed, null, "the wire itself is untouched");
        hub.stop();
      },
    },
    {
      name: "a wire death closes every room on it, with the same code",
      async run() {
        const { hub, wires } = makeHub();
        const a = hub.socketFactory(RELAY);
        const b = hub.socketFactory(RELAY);
        const codes = [];
        a.onclose = (event) => codes.push(event.code);
        b.onclose = (event) => codes.push(event.code);
        a.send(hello("room-a", HASH_A));
        b.send(hello("room-b", HASH_B));
        wires[0].open();
        await tick();

        wires[0].drop(1006, "");
        assertDeepEqual(codes.sort(), [1006, 1006], "both rooms told");
        assertEqual(hub.socketCount(), 0, "and the wire is forgotten");
        hub.stop();
      },
    },
    {
      name: "closing one room leaves the wire up with a leave frame",
      async run() {
        const { hub, wires } = makeHub();
        const a = hub.socketFactory(RELAY);
        const b = hub.socketFactory(RELAY);
        a.send(hello("room-a", HASH_A));
        b.send(hello("room-b", HASH_B));
        wires[0].open();
        await tick();
        wires[0].deliver({ type: "joined", hash: HASH_B, keyGen: 1 });

        b.close(1000, "rotation");
        await tick();

        assertDeepEqual(
          sentOf(wires[0], "leave").map((frame) => frame.hash),
          [HASH_B],
          "the room said goodbye",
        );
        assertEqual(wires[0].closed, null, "the wire is still open");
        assertEqual(hub.socketCount(), 1, "one wire");

        // ... and the LAST room out closes it.
        a.close(1000, "stop");
        await tick();
        assertEqual(wires[0].closed?.code, 1000, "wire closed with the last room");
        assertEqual(hub.socketCount(), 0, "no wires left");
      },
    },
    {
      name: "different relay URLs get different wires",
      async run() {
        const { hub, wires } = makeHub();
        const a = hub.socketFactory(RELAY);
        const b = hub.socketFactory(OTHER);
        a.send(hello("room-a", HASH_A));
        b.send(hello("room-b", HASH_B));
        assertEqual(wires.length, 2, "one per relay");
        for (const socket of wires) socket.open();
        await tick();
        assertEqual(sentOf(wires[0], "hello").length, 1, "each opens with its own hello");
        assertEqual(sentOf(wires[1], "hello").length, 1, "each opens with its own hello");
        assertEqual(sentOf(wires[0], "join").length, 0, "no cross-relay join");
        hub.stop();
      },
    },
    {
      name: "a rotation reconnects one room without a second wire",
      async run() {
        const { hub, wires } = makeHub();
        const a = hub.socketFactory(RELAY);
        const b = hub.socketFactory(RELAY);
        a.send(hello("room-a", HASH_A));
        b.send(hello("room-b", HASH_B, 1));
        wires[0].open();
        await tick();
        wires[0].deliver({ type: "joined", hash: HASH_B, keyGen: 1 });

        // The engine re-pairs: it closes its socket and dials again. The hub
        // must NOT open a second wire just because one room restarted.
        b.close(1000, "rotation");
        await tick();
        const b2 = hub.socketFactory(RELAY);
        b2.send(hello("room-b", HASH_B, 2));
        await tick();

        assertEqual(wires.length, 1, "same wire");
        const joins = sentOf(wires[0], "join").filter((frame) => frame.hash === HASH_B);
        assertEqual(joins.length, 2, "the room rejoined");
        assertEqual(joins[1].keyGen, 2, "at the NEW generation");
        assertEqual(joins[1].roomId, "room-b", "same room id");
        hub.stop();
      },
    },
    {
      name: "stop closes every wire and forgets every room",
      async run() {
        const { hub, wires } = makeHub();
        const a = hub.socketFactory(RELAY);
        const b = hub.socketFactory(OTHER);
        a.send(hello("room-a", HASH_A));
        b.send(hello("room-b", HASH_B));
        wires[0].open();
        wires[1].open();
        await tick();

        hub.stop();
        assertEqual(hub.socketCount(), 0, "nothing counted");
        for (const socket of wires) {
          assert(socket.closed !== null, "closed");
          assertEqual(socket.closed.code, 1000, "normally");
        }
      },
    },
  ],
};
