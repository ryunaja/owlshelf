/**
 * catchup.test.mjs — symmetric, targeted, contiguous catch-up (§6.6).
 *
 * Four rules, each a defect in an earlier pass: fan-out for the request,
 * election for the replies, cursors in the end marker, and completion gated on
 * SETTLE. Each gets a positive and a negative test, because a catch-up that
 * reports "complete" while missing history is worse than one that never
 * finishes.
 */

import {
  CatchupCollector,
  RESPONDER_SUPPRESS,
  SETTLE,
  buildCatchupRequest,
  chunkByBytes,
  covers,
  electResponder,
  responderLadder,
  serveCatchup,
} from "../../src/lib/catchup.ts";
import { endDigest } from "../../src/lib/canonical.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, DEVICE_B, ROOM_A, makeOp, makeRoom, seedRoom } from "../lib/fixtures.mjs";

function op(deviceId, authorSeq, opId) {
  return makeOp({ opId, deviceId, authorSeq, hlcTs: 1000 + authorSeq });
}

async function putOps(db, ops) {
  for (const item of ops) await db.ops.put(item);
}

export default {
  name: "catchup — request, election, serve, settle (§6.6)",
  tests: [
    {
      name: "a request carries the room's inbound cursors verbatim",
      async run() {
        const room = makeRoom({ cursorIn: { [DEVICE_B]: 4 } });
        const request = buildCatchupRequest(room, "r1", DEVICE_A);
        assertEqual(request.requestId, "r1", "requestId");
        assertEqual(request.deviceId, DEVICE_A, "deviceId");
        assertDeepEqual(request.cursors, { [DEVICE_B]: 4 }, "cursors");
      },
    },
    {
      name: "covers() is true only when the peer holds something we lack",
      async run() {
        assert(covers({ [DEVICE_B]: 5 }, { [DEVICE_B]: 4 }), "5 > 4");
        assert(!covers({ [DEVICE_B]: 4 }, { [DEVICE_B]: 4 }), "equal is not covering");
        assert(!covers({ [DEVICE_B]: 3 }, { [DEVICE_B]: 4 }), "behind is not covering");
        assert(covers({ [DEVICE_B]: 1 }, {}), "an absent author means cursor 0");
        assert(!covers({}, { [DEVICE_B]: 4 }), "no marks, no coverage");
      },
    },
    {
      name: "the election picks the LOWEST covering connectionId",
      async run() {
        const highWater = new Map([
          ["conn-c", { [DEVICE_B]: 9 }],
          ["conn-a", { [DEVICE_B]: 9 }],
          ["conn-b", { [DEVICE_B]: 9 }],
        ]);
        assertEqual(
          electResponder(["conn-c", "conn-a", "conn-b"], highWater, { [DEVICE_B]: 1 }),
          "conn-a",
          "lowest wins",
        );
      },
    },
    {
      name: "the election skips a member that does not cover the request",
      async run() {
        const highWater = new Map([
          ["conn-a", { [DEVICE_B]: 1 }],
          ["conn-b", { [DEVICE_B]: 9 }],
        ]);
        assertEqual(
          electResponder(["conn-a", "conn-b"], highWater, { [DEVICE_B]: 5 }),
          "conn-b",
          "conn-a is behind",
        );
      },
    },
    {
      name: "the election skips a member whose high-water mark is unknown",
      async run() {
        // An unknown peer might be the stale one that answers "complete" while
        // missing history — the exact failure the fan-out exists to survive.
        const highWater = new Map([["conn-b", { [DEVICE_B]: 9 }]]);
        assertEqual(
          electResponder(["conn-a", "conn-b"], highWater, { [DEVICE_B]: 1 }),
          "conn-b",
          "unknown conn-a is not elected",
        );
      },
    },
    {
      name: "the election returns null when nobody covers",
      async run() {
        assertEqual(electResponder(["conn-a"], new Map(), { [DEVICE_B]: 1 }), null, "no candidates");
        assertEqual(electResponder([], new Map(), {}), null, "empty presence");
      },
    },
    {
      name: "the ladder is every covering member, lowest first",
      async run() {
        const highWater = new Map([
          ["conn-c", { [DEVICE_B]: 9 }],
          ["conn-a", { [DEVICE_B]: 9 }],
          ["conn-b", { [DEVICE_B]: 9 }],
        ]);
        assertDeepEqual(
          responderLadder(["conn-c", "conn-a", "conn-b"], highWater, { [DEVICE_B]: 1 }),
          ["conn-a", "conn-b", "conn-c"],
          "ordered, complete",
        );
      },
    },
    {
      name: "the ladder excludes a member that does not cover",
      async run() {
        const highWater = new Map([
          ["conn-a", { [DEVICE_B]: 1 }],
          ["conn-b", { [DEVICE_B]: 9 }],
        ]);
        assertDeepEqual(
          responderLadder(["conn-a", "conn-b"], highWater, { [DEVICE_B]: 5 }),
          ["conn-b"],
          "conn-a is behind",
        );
      },
    },
    {
      name: "the ladder excludes a member whose high-water is unknown",
      async run() {
        const highWater = new Map([["conn-b", { [DEVICE_B]: 9 }]]);
        assertDeepEqual(
          responderLadder(["conn-a", "conn-b"], highWater, { [DEVICE_B]: 1 }),
          ["conn-b"],
          "unknown conn-a is not a candidate",
        );
      },
    },
    {
      name: "the ladder is empty when nobody covers",
      async run() {
        assertDeepEqual(responderLadder(["conn-a"], new Map(), {}), [], "no candidates");
        assertDeepEqual(responderLadder([], new Map(), {}), [], "empty presence");
      },
    },
    {
      name: "the ladder's head IS the election",
      async run() {
        const highWater = new Map([
          ["conn-b", { [DEVICE_B]: 9 }],
          ["conn-a", { [DEVICE_B]: 9 }],
        ]);
        const ladder = responderLadder(["conn-b", "conn-a"], highWater, {});
        assertEqual(electResponder(["conn-b", "conn-a"], highWater, {}), ladder[0], "same head");
      },
    },
    {
      name: "chunkByBytes respects the byte budget",
      async run() {
        const ops = [op(DEVICE_A, 1, "op-1"), op(DEVICE_A, 2, "op-2"), op(DEVICE_A, 3, "op-3")];
        const oneSize = JSON.stringify(ops[0]).length;
        const chunks = chunkByBytes(ops, oneSize + 1);
        assertEqual(chunks.length, 3, "one op per chunk");
        assertEqual(chunkByBytes(ops, 10 ** 6).length, 1, "all in one chunk");
      },
    },
    {
      name: "chunkByBytes gives an oversize op its own chunk",
      async run() {
        const big = op(DEVICE_A, 1, "op-big");
        big.payload = { name: "x".repeat(5000), locationId: "loc-1" };
        const chunks = chunkByBytes([big, op(DEVICE_A, 2, "op-2")], 100);
        assertEqual(chunks.length, 2, "the oversize op is not split");
        assertEqual(chunks[0].length, 1, "alone");
      },
    },
    {
      name: "chunkByBytes of nothing is nothing",
      async run() {
        assertDeepEqual(chunkByBytes([], 100), [], "empty");
      },
    },
    {
      name: "serveCatchup sends only what is above the requester's cursor",
      async run() {
        await withDb(async (db) => {
          const room = await seedRoom(db);
          await putOps(db, [
            op(DEVICE_B, 1, "op-b1"),
            op(DEVICE_B, 2, "op-b2"),
            op(DEVICE_B, 3, "op-b3"),
          ]);

          const replies = await serveCatchup(
            db,
            room,
            { requestId: "r1", cursors: { [DEVICE_B]: 1 }, deviceId: DEVICE_A },
            { deviceId: DEVICE_A },
          );
          const served = replies.flatMap((r) => r.ops.map((o) => o.opId));
          assertDeepEqual(served, ["op-b2", "op-b3"], "only above the cursor");
        });
      },
    },
    {
      name: "serveCatchup treats an absent author as cursor 0",
      async run() {
        await withDb(async (db) => {
          const room = await seedRoom(db);
          await putOps(db, [op(DEVICE_B, 1, "op-b1"), op(DEVICE_B, 2, "op-b2")]);

          const replies = await serveCatchup(
            db,
            room,
            { requestId: "r1", cursors: {}, deviceId: DEVICE_A },
            { deviceId: DEVICE_A },
          );
          const served = replies.flatMap((r) => r.ops.map((o) => o.opId));
          assertDeepEqual(served, ["op-b1", "op-b2"], "full history");
        });
      },
    },
    {
      name: "serveCatchup attaches the end marker to the LAST chunk only",
      async run() {
        await withDb(async (db) => {
          const room = await seedRoom(db);
          await putOps(db, [op(DEVICE_B, 1, "op-b1"), op(DEVICE_B, 2, "op-b2")]);

          const replies = await serveCatchup(
            db,
            room,
            { requestId: "r1", cursors: {}, deviceId: DEVICE_A },
            { deviceId: DEVICE_A, chunkBytes: 1 },
          );
          assert(replies.length > 1, "more than one chunk");
          for (const reply of replies.slice(0, -1)) {
            assertEqual(reply.end, undefined, "no end marker before the last chunk");
          }
          assert(replies.at(-1).end !== undefined, "end marker on the last chunk");
        });
      },
    },
    {
      name: "serveCatchup's end digest verifies against the served opIds",
      async run() {
        await withDb(async (db) => {
          const room = await seedRoom(db);
          await putOps(db, [op(DEVICE_B, 1, "op-b1"), op(DEVICE_B, 2, "op-b2")]);

          const replies = await serveCatchup(
            db,
            room,
            { requestId: "r1", cursors: {}, deviceId: DEVICE_A },
            { deviceId: DEVICE_A },
          );
          const end = replies.at(-1).end;
          const served = replies.flatMap((r) => r.ops.map((o) => o.opId));
          assertEqual(end.count, served.length, "count");
          assertEqual(end.digest, await endDigest(served), "digest");
        });
      },
    },
    {
      name: "serveCatchup's end marker carries the responder's cursors",
      async run() {
        // audit-2 N8: ops alone are a delivery proof; cursors are the adoption
        // proof the outbox needs.
        await withDb(async (db) => {
          const room = await seedRoom(db, { cursorIn: { [DEVICE_B]: 7 }, nextAuthorSeq: 4 });
          const replies = await serveCatchup(
            db,
            room,
            { requestId: "r1", cursors: {}, deviceId: DEVICE_B },
            { deviceId: DEVICE_A },
          );
          const end = replies.at(-1).end;
          assertEqual(end.responderCursors[DEVICE_B], 7, "inbound cursor");
          assertEqual(end.responderCursors[DEVICE_A], 3, "own nextAuthorSeq - 1");
          assertEqual(end.deviceId, DEVICE_A, "who answered");
        });
      },
    },
    {
      name: "serveCatchup with nothing to send still sends a verifiable end marker",
      async run() {
        await withDb(async (db) => {
          const room = await seedRoom(db);
          const replies = await serveCatchup(
            db,
            room,
            { requestId: "r1", cursors: {}, deviceId: DEVICE_A },
            { deviceId: DEVICE_A },
          );
          assertEqual(replies.length, 1, "one chunk");
          assertDeepEqual(replies[0].ops, [], "no ops");
          assertEqual(replies[0].end.count, 0, "count 0");
          assertEqual(replies[0].end.digest, await endDigest([]), "empty digest");
        });
      },
    },
    {
      name: "a collector accepts ordered chunks and verifies the end marker",
      async run() {
        await withDb(async (db) => {
          const room = await seedRoom(db);
          await putOps(db, [op(DEVICE_B, 1, "op-b1"), op(DEVICE_B, 2, "op-b2")]);
          const replies = await serveCatchup(
            db,
            room,
            { requestId: "r1", cursors: {}, deviceId: DEVICE_A },
            { deviceId: DEVICE_A, chunkBytes: 1 },
          );

          const collector = new CatchupCollector("r1", () => 0);
          for (const reply of replies) await collector.accept(reply);

          assertEqual(collector.ops.length, 2, "both ops collected");
          assertEqual(collector.responderDeviceId, DEVICE_A, "responder attributed");
          assertEqual(collector.state, "verifying", "verified but not settled");
        });
      },
    },
    {
      name: "a duplicate chunk is a no-op, not an error",
      async run() {
        await withDb(async (db) => {
          const room = await seedRoom(db);
          await putOps(db, [op(DEVICE_B, 1, "op-b1")]);
          const replies = await serveCatchup(
            db,
            room,
            { requestId: "r1", cursors: {}, deviceId: DEVICE_A },
            { deviceId: DEVICE_A },
          );

          const collector = new CatchupCollector("r1", () => 0);
          await collector.accept(replies[0]);
          const again = await collector.accept(replies[0]);
          assertEqual(again, "duplicate", "re-delivery");
          assertEqual(collector.ops.length, 1, "not double-counted");
        });
      },
    },
    {
      name: "a chunk gap breaks the session rather than verifying a partial range",
      async run() {
        const collector = new CatchupCollector("r1", () => 0);
        const result = await collector.accept({ requestId: "r1", chunkNo: 2, ops: [] });
        assertEqual(result, "out-of-order", "gap detected");
        assertEqual(collector.state, "broken", "cannot complete");
        assertEqual(collector.isComplete(10 ** 9), false, "never complete");
      },
    },
    {
      name: "a reply for another requestId is ignored",
      async run() {
        const collector = new CatchupCollector("r1", () => 0);
        assertEqual(
          await collector.accept({ requestId: "r2", chunkNo: 0, ops: [] }),
          "foreign",
          "foreign request",
        );
        assertEqual(collector.ops.length, 0, "nothing collected");
      },
    },
    {
      name: "a wrong digest is a contradiction",
      async run() {
        const collector = new CatchupCollector("r1", () => 0);
        const result = await collector.accept({
          requestId: "r1",
          chunkNo: 0,
          ops: [op(DEVICE_B, 1, "op-b1")],
          end: { count: 1, digest: "0".repeat(64), responderCursors: {}, deviceId: DEVICE_A },
        });
        assertEqual(result, "contradiction", "bad digest");
        assertEqual(collector.state, "contradicted", "state");
      },
    },
    {
      name: "a wrong count is a contradiction",
      async run() {
        const collector = new CatchupCollector("r1", () => 0);
        const ops = [op(DEVICE_B, 1, "op-b1")];
        const result = await collector.accept({
          requestId: "r1",
          chunkNo: 0,
          ops,
          end: {
            count: 2,
            digest: await endDigest(["op-b1"]),
            responderCursors: {},
            deviceId: DEVICE_A,
          },
        });
        assertEqual(result, "contradiction", "count mismatch");
      },
    },
    {
      name: "a second, DIFFERENT end marker inside SETTLE re-opens the room",
      async run() {
        // audit-4 R4-P1-3: "first end marker wins" made the disagreement check
        // unreachable, so a stale responder could masquerade as completeness.
        // Both markers here VERIFY against what was collected — the second one
        // simply covers more — so only the disagreement rule can catch it.
        let clock = 0;
        const collector = new CatchupCollector("r1", () => clock);

        await collector.accept({
          requestId: "r1",
          chunkNo: 0,
          ops: [op(DEVICE_B, 1, "op-b1")],
          end: {
            count: 1,
            digest: await endDigest(["op-b1"]),
            responderCursors: {},
            deviceId: DEVICE_A,
          },
        });
        clock = 100;
        const result = await collector.accept({
          requestId: "r1",
          chunkNo: 1,
          ops: [op(DEVICE_B, 2, "op-b2")],
          end: {
            count: 2,
            digest: await endDigest(["op-b1", "op-b2"]),
            responderCursors: {},
            deviceId: DEVICE_B,
          },
        });

        assertEqual(result, "contradiction", "disagreement detected");
        assertEqual(collector.state, "contradicted", "state");
        assertEqual(collector.isComplete(clock + SETTLE + 1), false, "never completes");
      },
    },
    {
      name: "the SAME end marker twice is a re-delivery, not a contradiction",
      async run() {
        const collector = new CatchupCollector("r1", () => 0);
        const body = {
          requestId: "r1",
          chunkNo: 0,
          ops: [op(DEVICE_B, 1, "op-b1")],
          end: {
            count: 1,
            digest: await endDigest(["op-b1"]),
            responderCursors: {},
            deviceId: DEVICE_A,
          },
        };
        assertEqual(await collector.accept(body), "end", "first");
        assertEqual(await collector.accept({ ...body, chunkNo: 1, ops: [] }), "duplicate", "second");
        assertEqual(collector.state, "verifying", "still healthy");
      },
    },
    {
      name: "completion waits the SETTLE window",
      async run() {
        let clock = 0;
        const collector = new CatchupCollector("r1", () => clock);
        const ops = [op(DEVICE_B, 1, "op-b1")];
        await collector.accept({
          requestId: "r1",
          chunkNo: 0,
          ops,
          end: {
            count: 1,
            digest: await endDigest(["op-b1"]),
            responderCursors: {},
            deviceId: DEVICE_A,
          },
        });

        assertEqual(collector.isComplete(0), false, "immediately after the end marker");
        assertEqual(collector.isComplete(SETTLE - 1), false, "one ms before SETTLE");
        assertEqual(collector.isComplete(SETTLE), true, "at SETTLE");
      },
    },
    {
      name: "the protocol constants are §6.6's numbers",
      async run() {
        assertEqual(SETTLE, 2000, "SETTLE");
        assertEqual(RESPONDER_SUPPRESS, 500, "RESPONDER_SUPPRESS");
      },
    },
  ],
};
