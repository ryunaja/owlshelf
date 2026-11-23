/**
 * hlc.test.mjs — plan §6.2, executed.
 *
 * The two rules that cost the most to get wrong: the counter is unmasked, and
 * `counter >= MAX_COUNTER` is malformed on BOTH sides (the pass-4 absorb wrote
 * `ts + 1`, one millisecond past the horizon it had just enforced).
 */

import {
  HlcOverflowError,
  MAX_COUNTER,
  MAX_SKEW,
  compareHlc,
  mintHlc,
  receiveHlc,
  validateStamp,
} from "../../src/lib/hlc.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";

const WALL = 1_700_000_000_000;

export default {
  name: "hlc — persisted, validated, unmasked (§6.2)",
  tests: [
    {
      name: "mint: a wall clock past ts takes the wall time and resets the counter",
      run() {
        assertDeepEqual(mintHlc({ ts: WALL - 5, counter: 7 }, WALL), { ts: WALL, counter: 0 }, "mint");
      },
    },
    {
      name: "mint: a wall clock at or behind ts increments the counter",
      run() {
        assertDeepEqual(mintHlc({ ts: WALL, counter: 7 }, WALL), { ts: WALL, counter: 8 }, "mint");
        assertDeepEqual(mintHlc({ ts: WALL + 10, counter: 7 }, WALL), { ts: WALL + 10, counter: 8 }, "mint");
      },
    },
    {
      name: "mint: reaching MAX_COUNTER throws instead of wrapping",
      run() {
        let threw = null;
        try {
          mintHlc({ ts: WALL, counter: MAX_COUNTER - 1 }, WALL);
        } catch (error) {
          threw = error;
        }
        assert(threw instanceof HlcOverflowError, "expected HlcOverflowError");
        assertEqual(threw.clock.counter, MAX_COUNTER - 1, "the error carries the clock it refused to advance");
      },
    },
    {
      name: "receive: a stamp beyond MAX_SKEW is rejected, never absorbed",
      run() {
        const result = receiveHlc({ ts: WALL, counter: 0 }, { ts: WALL + MAX_SKEW + 1, counter: 0 }, WALL);
        assertEqual(result.ok, false, "rejected");
        assertEqual(result.reason, "skew", "reason");
      },
    },
    {
      name: "receive: counter === MAX_COUNTER is malformed (N5 / R4-P0-2)",
      run() {
        const result = receiveHlc({ ts: WALL, counter: 0 }, { ts: WALL, counter: MAX_COUNTER }, WALL);
        assertEqual(result.ok, false, "rejected");
        assertEqual(result.reason, "overflow", "reason");
      },
    },
    {
      name: "receive: the exact boundary the pass-4 absorb broke is rejected",
      run() {
        // ts at exactly wall + MAX_SKEW passes the skew check; the absorb then
        // wrote ts + 1, one millisecond PAST the horizon. The counter is what
        // has to reject it, and it does.
        const result = receiveHlc(
          { ts: WALL, counter: 0 },
          { ts: WALL + MAX_SKEW, counter: MAX_COUNTER },
          WALL,
        );
        assertEqual(result.ok, false, "rejected");
        assertEqual(result.reason, "overflow", "reason");
      },
    },
    {
      name: "receive: a legal far-ahead stamp advances the clock before the next mint (P0-8)",
      run() {
        const received = receiveHlc({ ts: WALL, counter: 0 }, { ts: WALL + 60_000, counter: 3 }, WALL);
        assertEqual(received.ok, true, "accepted");
        const minted = mintHlc(received.clock, WALL);
        assert(minted.ts > WALL + 60_000 || (minted.ts === WALL + 60_000 && minted.counter > 3), "mint dominates the received stamp");
      },
    },
    {
      name: "receive: malformed stamps are rejected before overflow or skew",
      run() {
        for (const stamp of [
          null,
          undefined,
          "x",
          { ts: -1, counter: 0 },
          { ts: 1.5, counter: 0 },
          { ts: WALL, counter: -1 },
          { ts: WALL, counter: 1.5 },
          { ts: Number.NaN, counter: 0 },
        ]) {
          assertEqual(validateStamp(stamp, WALL), "malformed", `stamp ${JSON.stringify(stamp)}`);
        }
      },
    },
    {
      name: "receive: a tie on ts takes one past the larger counter",
      run() {
        const result = receiveHlc({ ts: WALL, counter: 4 }, { ts: WALL, counter: 9 }, WALL);
        assertEqual(result.ok, true, "accepted");
        assertDeepEqual(result.clock, { ts: WALL, counter: 10 }, "clock");
      },
    },
    {
      name: "receive: a wall clock ahead of both resets the counter",
      run() {
        const result = receiveHlc({ ts: WALL - 10, counter: 4 }, { ts: WALL - 5, counter: 9 }, WALL);
        assertEqual(result.ok, true, "accepted");
        assertDeepEqual(result.clock, { ts: WALL, counter: 0 }, "clock");
      },
    },
    {
      name: "compareHlc orders by ts then counter",
      run() {
        assertEqual(compareHlc({ ts: 1, counter: 9 }, { ts: 2, counter: 0 }), -1, "ts dominates");
        assertEqual(compareHlc({ ts: 2, counter: 1 }, { ts: 2, counter: 0 }), 1, "counter breaks the tie");
        assertEqual(compareHlc({ ts: 2, counter: 1 }, { ts: 2, counter: 1 }), 0, "equal");
      },
    },
  ],
};
