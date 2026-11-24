/**
 * blobDemand.test.mjs — the pull side of media sync (§6.6, §8.1).
 *
 * `blob-request` / `file-chunk` were implemented and had no caller: the engine
 * could answer and store, but nothing ever asked, so a synced row's
 * `idb://<hash>` resolved to `missing` forever. This suite pins the trigger.
 *
 * The cooldown is the part worth testing hardest: a list of cards re-renders
 * on every scroll, and without a floor one absent cover becomes a request
 * storm against every peer in the room.
 */

import {
  DEMAND_COOLDOWN,
  clearBlobDemand,
  demandBlob,
  hasBlobFetcher,
  registerBlobFetcher,
  resetBlobDemand,
} from "../../src/lib/blobDemand.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";

const ROOM_A = "room-a";
const ROOM_B = "room-b";
const HASH = "9f2c";

/** A fetcher that records what it was asked for. */
function recorder() {
  const calls = [];
  const fetcher = (roomId, hash) => {
    calls.push(`${roomId}/${hash}`);
  };
  return { calls, fetcher };
}

export default {
  name: "blobDemand — demand-driven blob pull, room-scoped and rate-limited",
  tests: [
    {
      name: "with no fetcher registered, a demand is a no-op",
      run() {
        resetBlobDemand();
        assertEqual(hasBlobFetcher(), false, "nothing registered");
        assertEqual(demandBlob(ROOM_A, HASH), false, "no request issued");
      },
    },
    {
      name: "a registered fetcher receives the room and the hash",
      run() {
        resetBlobDemand();
        const { calls, fetcher } = recorder();
        registerBlobFetcher(fetcher);
        assertEqual(hasBlobFetcher(), true, "registered");
        assertEqual(demandBlob(ROOM_A, HASH), true, "request issued");
        assertDeepEqual(calls, [`${ROOM_A}/${HASH}`], "the fetcher was called once");
        resetBlobDemand();
      },
    },
    {
      name: "a second demand inside the cooldown is suppressed",
      run() {
        resetBlobDemand();
        const { calls, fetcher } = recorder();
        registerBlobFetcher(fetcher);

        assertEqual(demandBlob(ROOM_A, HASH, 1_000), true, "first ask");
        assertEqual(demandBlob(ROOM_A, HASH, 1_000 + DEMAND_COOLDOWN - 1), false, "inside the cooldown");
        assertEqual(calls.length, 1, "still one request");

        assertEqual(demandBlob(ROOM_A, HASH, 1_000 + DEMAND_COOLDOWN), true, "the cooldown expired");
        assertEqual(calls.length, 2, "retried");
        resetBlobDemand();
      },
    },
    {
      name: "the cooldown is per (roomId, hash), not global",
      run() {
        resetBlobDemand();
        const { calls, fetcher } = recorder();
        registerBlobFetcher(fetcher);

        assertEqual(demandBlob(ROOM_A, HASH, 1_000), true, "room A");
        assertEqual(demandBlob(ROOM_B, HASH, 1_000), true, "room B is a different question");
        assertEqual(demandBlob(ROOM_A, "other", 1_000), true, "a different hash too");
        assertEqual(calls.length, 3, "three distinct demands");
        resetBlobDemand();
      },
    },
    {
      name: "clearBlobDemand lets an arrival be re-demanded immediately",
      run() {
        resetBlobDemand();
        const { calls, fetcher } = recorder();
        registerBlobFetcher(fetcher);

        assertEqual(demandBlob(ROOM_A, HASH, 1_000), true, "first ask");
        clearBlobDemand(ROOM_A, HASH);
        assertEqual(demandBlob(ROOM_A, HASH, 1_001), true, "no cooldown after an arrival");
        assertEqual(calls.length, 2, "asked twice");
        resetBlobDemand();
      },
    },
    {
      name: "an empty hash is never demanded",
      run() {
        resetBlobDemand();
        const { calls, fetcher } = recorder();
        registerBlobFetcher(fetcher);
        assertEqual(demandBlob(ROOM_A, ""), false, "no hash, no request");
        assertEqual(calls.length, 0, "the fetcher was not called");
        resetBlobDemand();
      },
    },
    {
      name: "unregistering disarms the fetcher",
      run() {
        resetBlobDemand();
        const { calls, fetcher } = recorder();
        const unsubscribe = registerBlobFetcher(fetcher);
        unsubscribe();
        assertEqual(hasBlobFetcher(), false, "disarmed");
        assertEqual(demandBlob(ROOM_A, HASH), false, "no request");
        assertEqual(calls.length, 0, "the fetcher was not called");
        resetBlobDemand();
      },
    },
    {
      name: "a stale unsubscribe does not disarm the fetcher that replaced it",
      run() {
        resetBlobDemand();
        const first = recorder();
        const second = recorder();
        const unsubscribeFirst = registerBlobFetcher(first.fetcher);
        registerBlobFetcher(second.fetcher);

        unsubscribeFirst();
        assertEqual(hasBlobFetcher(), true, "the newer fetcher survives");
        assertEqual(demandBlob(ROOM_A, HASH), true, "still serving");
        assertEqual(second.calls.length, 1, "the newer fetcher answered");
        assertEqual(first.calls.length, 0, "the old one did not");
        resetBlobDemand();
      },
    },
    {
      name: "a rejecting fetcher does not throw out of demandBlob",
      async run() {
        resetBlobDemand();
        registerBlobFetcher(() => Promise.reject(new Error("socket gone")));
        assertEqual(demandBlob(ROOM_A, HASH), true, "the demand was issued");
        // Let the rejection settle: an unhandled one would fail the harness.
        await new Promise((resolve) => setTimeout(resolve, 0));
        resetBlobDemand();
      },
    },
  ],
};
