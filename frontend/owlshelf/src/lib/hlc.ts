/**
 * hlc.ts — the persisted hybrid logical clock (plan §6.2). WORKER ONLY.
 *
 * The clock is `{ ts, counter }` persisted inside the room's meta record
 * (§15.8: per-room, not a global row — a global row would serialize every
 * room's mints on one meta record). In-memory state is only a cache: both
 * mint and receive run inside the transaction that creates or adopts the op,
 * so the clock is loaded, advanced, and written back in the SAME commit.
 *
 * Two rules that are easy to get wrong and are therefore stated once, here:
 *
 *  - The counter is UNMASKED. No 1024-style wrap, no repeating values. A mint
 *    that would reach MAX_COUNTER fails loudly; it never wraps and never
 *    borrows a future timestamp (audit-2 N17).
 *  - `counter >= MAX_COUNTER` is MALFORMED on BOTH sides. Pass 4 absorbed a
 *    hostile MAX_COUNTER stamp by writing `ts + 1`, which is one millisecond
 *    PAST the MAX_SKEW horizon the same rule had just enforced — a device
 *    that missed that op then rejected every later mint from the absorbing
 *    device, permanently (audit-4 R4-P0-2, executed). Rejecting outright
 *    costs the hostile op exactly its own sequence slot and nothing more,
 *    because a quarantined slot never freezes its author's stream (§6.4/D1).
 */

/** Counters are valid in `[0, MAX_COUNTER)`. 2³¹ ops in one millisecond is
 *  not an honest device; it is a broken or hostile one. */
export const MAX_COUNTER = 2 ** 31;

/** ~24h. A stamp further ahead than this is rejected, never absorbed. */
export const MAX_SKEW = 86_400_000;

export interface Hlc {
  ts: number;
  counter: number;
}

export type HlcRejectReason = "malformed" | "overflow" | "skew";

export type HlcReceiveResult =
  | { ok: true; clock: Hlc }
  | { ok: false; reason: HlcRejectReason };

/** A local mint that cannot advance without wrapping. Local anomaly: this
 *  device's minting is broken, not the clock model. */
export class HlcOverflowError extends Error {
  clock: Hlc;

  constructor(clock: Hlc) {
    super(`hlc: counter overflow at ts=${clock.ts} (MAX_COUNTER=${MAX_COUNTER})`);
    this.name = "HlcOverflowError";
    this.clock = clock;
  }
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validate an inbound stamp against the local wall clock. Returns the reject
 * reason, or null when the stamp is admissible.
 *
 * Order matters only for the diagnostic: a negative or fractional field is
 * `malformed` before it can be `overflow` or `skew`.
 */
export function validateStamp(stamp: unknown, wall: number): HlcRejectReason | null {
  if (stamp === null || typeof stamp !== "object") return "malformed";
  const { ts, counter } = stamp as Partial<Hlc>;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) return "malformed";
  if (!isCounter(counter)) return "malformed";
  if (counter >= MAX_COUNTER) return "overflow";
  if (ts - wall > MAX_SKEW) return "skew";
  return null;
}

/**
 * Mint the next stamp. If the wall clock is past `ts`, take the wall time and
 * reset the counter; otherwise increment the counter.
 *
 * @throws HlcOverflowError when the counter would reach MAX_COUNTER.
 */
export function mintHlc(clock: Hlc, wall: number): Hlc {
  if (wall > clock.ts) return { ts: wall, counter: 0 };
  const counter = clock.counter + 1;
  if (counter >= MAX_COUNTER) throw new HlcOverflowError(clock);
  return { ts: clock.ts, counter };
}

/**
 * The standard max rule over both fields: `max(local ts, wall, remote ts)`,
 * with the counter one past the larger counter when timestamps tie.
 *
 * A receive that would itself reach MAX_COUNTER is rejected rather than
 * wrapped or pushed into the future — the same reason the absorb was deleted.
 */
export function receiveHlc(clock: Hlc, remote: Hlc, wall: number): HlcReceiveResult {
  const reject = validateStamp(remote, wall);
  if (reject) return { ok: false, reason: reject };

  const ts = Math.max(clock.ts, wall, remote.ts);
  let counter: number;
  if (ts === clock.ts && ts === remote.ts) {
    counter = Math.max(clock.counter, remote.counter) + 1;
  } else if (ts === clock.ts) {
    counter = clock.counter + 1;
  } else if (ts === remote.ts) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  if (counter >= MAX_COUNTER) return { ok: false, reason: "overflow" };
  return { ok: true, clock: { ts, counter } };
}

/** Total order over stamps alone (the reducer adds rank/device/opId). */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return 0;
}
