/**
 * outbox.test.mjs — the DERIVED ack rule over the REACHABLE set (§6.6).
 *
 * audit-4 D2/R4-P1-1 executed the roster version of this rule and found one
 * member absent for a week left 12,000 of 12,000 entries unacked, so every
 * resume re-sent 7.2 MB and the backlog grew without bound. The matrix below
 * is that defect, one row at a time.
 */

import {
  ACK_GRACE,
  DRAIN_BATCH,
  decideAck,
  drainPlan,
  evaluateAcks,
  pendingOutbox,
  recordPeerCursors,
  touchPeer,
  unackedOutbox,
} from "../../src/lib/outbox.ts";
import { assertDeepEqual, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, DEVICE_B, ROOM_A, makeRoom, seedRoom } from "../lib/fixtures.mjs";

const NOW = 1_000_000_000;

function room(overrides = {}) {
  return makeRoom({
    roster: [
      { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
      { deviceId: DEVICE_B, role: "member", addedAt: 0 },
    ],
    ...overrides,
  });
}

function entry(authorSeq, overrides = {}) {
  return {
    opId: `op-${authorSeq}`,
    roomId: ROOM_A,
    deviceId: DEVICE_A,
    authorSeq,
    state: "pending",
    // Already sent. The matrix below is about the REACHABLE SET; "has it been
    // sent at all" is a prior gate with its own tests.
    attempts: 1,
    createdAt: 0,
    ...overrides,
  };
}

async function addEntry(db, authorSeq, overrides = {}) {
  await db.outbox.put(entry(authorSeq, overrides));
}

export default {
  name: "outbox — derived acks over the reachable set (§6.6)",
  tests: [
    {
      name: "a single-device room acks once the entry has been sent",
      async run() {
        // `every()` over an empty peer set is true, and that is harmless: the
        // ops stay in `ops` and catch-up still serves them to a future joiner.
        const solo = makeRoom();
        assertEqual(decideAck(entry(1), solo, NOW).acked, true, "sent, then solo ack");
      },
    },
    {
      // The inverse of the row above, and the reason the drain's `send` list
      // cannot be derived from `state` alone: the first drain tick evaluates
      // acks BEFORE it sends, so an acked-but-never-sent entry would sit in the
      // outbox forever and the owner would never announce anything minted
      // before a peer appeared.
      name: "an entry that was never sent is not acked, even alone",
      async run() {
        const solo = makeRoom();
        const fresh = entry(1, { attempts: 0 });
        const decision = decideAck(fresh, solo, NOW);
        assertEqual(decision.acked, false, "never sent, so nobody can have it");
        assertDeepEqual(decision.blockedBy, [], "and no peer is to blame");
      },
    },
    {
      name: "a reachable peer whose cursor covers the entry acks it",
      async run() {
        const r = room({
          lastSeen: { [DEVICE_B]: NOW },
          peerCursors: { [DEVICE_B]: { [DEVICE_A]: 5 } },
        });
        assertEqual(decideAck(entry(5), r, NOW).acked, true, "cursor 5 covers seq 5");
        assertEqual(decideAck(entry(6), r, NOW).acked, false, "cursor 5 does not cover seq 6");
      },
    },
    {
      name: "a reachable peer with no cursor blocks the entry",
      async run() {
        const r = room({ lastSeen: { [DEVICE_B]: NOW } });
        const decision = decideAck(entry(1), r, NOW);
        assertEqual(decision.acked, false, "no evidence, no ack");
        assertDeepEqual(decision.blockedBy, [DEVICE_B], "blocked by the silent peer");
      },
    },
    {
      name: "a peer absent past ACK_GRACE stops blocking",
      async run() {
        // This is the R4-P1-1 fix. Without it the outbox grows without bound.
        const r = room({ lastSeen: { [DEVICE_B]: NOW - ACK_GRACE - 1 } });
        assertEqual(decideAck(entry(1), r, NOW).acked, true, "past the grace window");
      },
    },
    {
      name: "a peer absent WITHIN ACK_GRACE still blocks",
      async run() {
        const r = room({ lastSeen: { [DEVICE_B]: NOW - ACK_GRACE + 1 } });
        assertEqual(decideAck(entry(1), r, NOW).acked, false, "inside the grace window");
      },
    },
    {
      name: "a peer that never appeared at all does not block",
      async run() {
        // No lastSeen entry means we have never had authenticated contact, so
        // there is no evidence to wait for.
        const r = room();
        assertEqual(decideAck(entry(1), r, NOW).acked, true, "never seen");
      },
    },
    {
      name: "a peer that left the roster does not block",
      async run() {
        const r = room({
          roster: [{ deviceId: DEVICE_A, role: "owner", addedAt: 0 }],
          lastSeen: { [DEVICE_B]: NOW },
        });
        assertEqual(decideAck(entry(1), r, NOW).acked, true, "pruned on roster change");
      },
    },
    {
      name: "an entry is never blocked by its own author",
      async run() {
        const r = room({ lastSeen: { [DEVICE_A]: NOW } });
        assertEqual(decideAck(entry(1), r, NOW).acked, true, "the author is skipped");
      },
    },
    {
      // §6.7 replaced the dev stopgap (`admitPeerToRoster`) that used to do
      // this: a joining device could write itself into its LOCAL roster, so a
      // revoked device could re-admit itself and revocation was defeated. The
      // roster now grows only when the OWNER signs an epoch (rooms.ts),
      // which is `rooms.test.mjs`'s subject.
      name: "contact records cursors but NEVER extends the roster",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roster: [{ deviceId: DEVICE_A, role: "owner", addedAt: 0 }] });
          await recordPeerCursors(db, ROOM_A, DEVICE_B, { [DEVICE_A]: 3 }, NOW);

          const stored = await db.meta.get(`room:${ROOM_A}`);
          assertDeepEqual(
            stored.roster.map((m) => m.deviceId),
            [DEVICE_A],
            "the joiner is NOT a member until the owner signs it",
          );
          assertEqual(stored.lastSeen[DEVICE_B], NOW, "but the contact is recorded");
          assertEqual(stored.peerCursors[DEVICE_B][DEVICE_A], 3, "and so are its cursors");
        });
      },
    },
    {
      name: "recording contact twice does not duplicate a member",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, {
            roster: [
              { deviceId: DEVICE_A, role: "owner", addedAt: 0 },
              { deviceId: DEVICE_B, role: "member", addedAt: 5 },
            ],
          });
          await recordPeerCursors(db, ROOM_A, DEVICE_B, { [DEVICE_A]: 1 }, NOW);
          await touchPeer(db, ROOM_A, DEVICE_B, NOW + 1);

          const stored = await db.meta.get(`room:${ROOM_A}`);
          assertEqual(stored.roster.length, 2, "no duplicate member");
          const member = stored.roster.find((m) => m.deviceId === DEVICE_B);
          assertEqual(member.addedAt, 5, "the original addedAt is preserved");
        });
      },
    },
    {
      name: "recordPeerCursors is monotonic — a stale cursor never un-acks",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roster: room().roster });
          await recordPeerCursors(db, ROOM_A, DEVICE_B, { [DEVICE_A]: 5 }, NOW);
          await recordPeerCursors(db, ROOM_A, DEVICE_B, { [DEVICE_A]: 3 }, NOW + 1);

          const stored = await db.meta.get(`room:${ROOM_A}`);
          assertEqual(stored.peerCursors[DEVICE_B][DEVICE_A], 5, "cursor never moves backward");
          assertEqual(stored.lastSeen[DEVICE_B], NOW + 1, "lastSeen advances");
        });
      },
    },
    {
      name: "recordPeerCursors ignores a non-integer or negative seq",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roster: room().roster });
          await recordPeerCursors(db, ROOM_A, DEVICE_B, { [DEVICE_A]: 1.5 }, NOW);
          await recordPeerCursors(db, ROOM_A, DEVICE_B, { [DEVICE_A]: -1 }, NOW);
          const stored = await db.meta.get(`room:${ROOM_A}`);
          assertEqual(stored.peerCursors[DEVICE_B][DEVICE_A], undefined, "nothing recorded");
        });
      },
    },
    {
      name: "pendingOutbox enumerates via the [roomId+state] index",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await addEntry(db, 1);
          await addEntry(db, 2);
          await addEntry(db, 3, { state: "acked" });

          const pending = await pendingOutbox(db, ROOM_A);
          assertEqual(pending.length, 2, "only pending entries");
          assertDeepEqual(
            pending.map((e) => e.authorSeq).sort((a, b) => a - b),
            [1, 2],
            "seqs",
          );
        });
      },
    },
    {
      name: "pendingOutbox respects the batch bound",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          for (let i = 1; i <= 5; i += 1) await addEntry(db, i);
          assertEqual((await pendingOutbox(db, ROOM_A, 2)).length, 2, "bounded");
          assertEqual(DRAIN_BATCH, 500, "the default batch is §6.6's 500");
        });
      },
    },
    {
      name: "evaluateAcks flips only the entries the evidence covers",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, {
            roster: room().roster,
            lastSeen: { [DEVICE_B]: NOW },
            peerCursors: { [DEVICE_B]: { [DEVICE_A]: 2 } },
          });
          await addEntry(db, 1);
          await addEntry(db, 2);
          await addEntry(db, 3);

          const flipped = await evaluateAcks(db, ROOM_A, NOW);
          assertDeepEqual(flipped.sort(), ["op-1", "op-2"], "covered entries acked");

          const remaining = await unackedOutbox(db, ROOM_A);
          assertDeepEqual(remaining.map((e) => e.opId), ["op-3"], "seq 3 stays pending");
        });
      },
    },
    {
      name: "evaluateAcks is idempotent",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, {
            roster: room().roster,
            lastSeen: { [DEVICE_B]: NOW },
            peerCursors: { [DEVICE_B]: { [DEVICE_A]: 1 } },
          });
          await addEntry(db, 1);
          const first = await evaluateAcks(db, ROOM_A, NOW);
          const second = await evaluateAcks(db, ROOM_A, NOW);
          assertDeepEqual(first, ["op-1"], "first pass flips");
          assertDeepEqual(second, [], "second pass is a no-op");
        });
      },
    },
    {
      name: "drainPlan orders by authorSeq so a contiguous cursor advances",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, { roster: room().roster, lastSeen: { [DEVICE_B]: NOW } });
          await addEntry(db, 3);
          await addEntry(db, 1);
          await addEntry(db, 2);

          const plan = await drainPlan(db, ROOM_A, NOW);
          assertDeepEqual(plan.send.map((e) => e.authorSeq), [1, 2, 3], "ascending");
        });
      },
    },
    {
      name: "drainPlan reports what is still blocked, and by whom",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db, {
            roster: room().roster,
            lastSeen: { [DEVICE_B]: NOW },
            peerCursors: { [DEVICE_B]: { [DEVICE_A]: 1 } },
          });
          await addEntry(db, 1);
          await addEntry(db, 2);

          const plan = await drainPlan(db, ROOM_A, NOW);
          assertDeepEqual(plan.acked, ["op-1"], "seq 1 acked");
          assertDeepEqual(
            plan.blocked,
            [{ opId: "op-2", blockedBy: [DEVICE_B] }],
            "seq 2 blocked by the peer",
          );
        });
      },
    },
    {
      name: "an unknown room is a no-op, not a throw",
      async run() {
        await withDb(async (db) => {
          assertDeepEqual(await evaluateAcks(db, "no-such-room", NOW), [], "evaluateAcks");
          const plan = await drainPlan(db, "no-such-room", NOW);
          assertDeepEqual(plan.send, [], "drainPlan");
        });
      },
    },
  ],
};
