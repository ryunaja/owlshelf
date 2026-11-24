/**
 * gc.ts — the cheap half of storage GC: `cmd:` records and acked outbox
 * entries (plan §15.5, §6.6, §8.2). WORKER ONLY.
 *
 * Both are pure deletes with no reachability question, which is why they can
 * land before step 7's compaction. Blob GC and op pruning cannot: with no
 * snapshot, the retained op tail references every blob, so a correct blob GC
 * would delete nothing today (code-vs-plan §5.1).
 *
 * Neither delete can lose data:
 *
 *  - A `cmd:` record is an idempotency RECEIPT, not the op. The op is in
 *    `ops` and its send record is in `outbox`; deleting the receipt only
 *    re-opens the window in which a retry would mint a second op.
 *  - An acked outbox entry is a send record whose job is finished. The op it
 *    names is in `ops`, and catch-up serves from `ops`, so a late joiner is
 *    unaffected. `drainPlan` already filters acked entries out, so nothing
 *    reads them — the only consumer is the dev panel's counter.
 *
 * ── The one residual, stated rather than hidden ───────────────────────────
 *
 * Pruning a `cmd:` record re-opens the idempotency window. §15.5 sets the TTL
 * at 24 h and the port timeout at 10 s, so a retry can only arrive inside the
 * window if a tab was frozen for a full day with an unanswered command still
 * in `inflight` — and then resumed and re-sent it. That is outside the plan's
 * model (a frozen tab's timers do not run, so `portRpc` never rejects, so the
 * request is still "stranded" and `switchableTransport` re-sends it on
 * promotion). The bound is the plan's, not an oversight: a longer TTL trades a
 * narrower duplicate window for a larger `meta` table, and 24 h is already
 * 8,640× the timeout.
 */

import type { OwlshelfDB } from "./db";
import type { MetaRow } from "./stores";

/** §15.5: "`cmd:` records are pruned after 24h." */
export const CMD_TTL = 24 * 60 * 60 * 1000;

/**
 * §6.6: "Acked entries are pruned after a grace period."
 *
 * Deliberately NOT `ACK_GRACE` (7 days). That constant answers a different
 * question — when an unreachable peer stops blocking an ack — and reusing it
 * here would keep every acked entry for a week for no reason. An outbox
 * entry's only job is to be sent; once acked it is dead weight.
 */
export const OUTBOX_TTL = 24 * 60 * 60 * 1000;

/**
 * The `cmd:` scan is global and walks the `meta` primary key, so it is
 * floored. The outbox scan is a room-scoped index range over `acked` rows and
 * needs no floor — after the first prune it is near-empty.
 */
export const CMD_PRUNE_FLOOR = 60 * 60 * 1000;

/** `meta` row recording the last global `cmd:` scan. */
export const CMD_PRUNE_KEY = "prune:cmd";

export interface PruneOptions {
  cmdTtl?: number;
  outboxTtl?: number;
  cmdFloor?: number;
}

export interface PruneResult {
  /** `cmd:` records deleted. */
  commands: number;
  /** Acked outbox entries deleted. */
  outbox: number;
}

/**
 * Delete `cmd:` records older than `ttl`.
 *
 * A record with NO `createdAt` is treated as expired, not as immortal. It was
 * written by a build that had no TTL, and a build upgrade reloads every tab —
 * so the tab that minted it is gone and no retry can arrive for it. Keeping it
 * forever is the leak this function exists to fix.
 */
export async function pruneCommandRecords(
  db: OwlshelfDB,
  now: number,
  ttl: number = CMD_TTL,
): Promise<number> {
  const rows = await db.meta.where("key").startsWith("cmd:").toArray();
  const cutoff = now - ttl;
  const expired = rows.filter((row) => {
    const createdAt = (row as MetaRow).createdAt;
    return typeof createdAt !== "number" || createdAt < cutoff;
  });
  if (expired.length === 0) return 0;
  await db.meta.bulkDelete(expired.map((row) => row.key));
  return expired.length;
}

/**
 * Delete a room's acked outbox entries older than `ttl`.
 *
 * `pending` and `dead` are never touched: pending is the backlog, and dead is
 * a diagnostic a human may still want. Only `acked` is provably finished.
 */
export async function pruneAckedOutbox(
  db: OwlshelfDB,
  roomId: string,
  now: number,
  ttl: number = OUTBOX_TTL,
): Promise<number> {
  const rows = await db.outbox.where("[roomId+state]").equals([roomId, "acked"]).toArray();
  const cutoff = now - ttl;
  const expired = rows.filter((row) => row.createdAt < cutoff);
  if (expired.length === 0) return 0;
  await db.outbox.bulkDelete(expired.map((row) => row.opId));
  return expired.length;
}

/**
 * The `cmd:` scan, gated by the floor.
 *
 * The floor row is written only AFTER a successful scan, so a throw leaves the
 * gate open and the next start retries instead of waiting an hour for nothing.
 */
async function pruneCommandsIfDue(
  db: OwlshelfDB,
  now: number,
  options: PruneOptions,
): Promise<number> {
  const floor = options.cmdFloor ?? CMD_PRUNE_FLOOR;
  const last = await db.meta.get(CMD_PRUNE_KEY);
  const at = typeof last?.at === "number" ? last.at : 0;
  if (now - at < floor) return 0;

  const deleted = await pruneCommandRecords(db, now, options.cmdTtl ?? CMD_TTL);
  await db.meta.put({ key: CMD_PRUNE_KEY, at: now });
  return deleted;
}

/**
 * Everything this module collects, for one room.
 *
 * Called from `SyncEngine.start()` — the plan's own cadence ("checked on app
 * open", §15.7/§15.11). A tab that never reloads therefore prunes once per
 * app open, which is the intended frequency; these deletes are not urgent.
 */
export async function pruneRoom(
  db: OwlshelfDB,
  roomId: string,
  now: number,
  options: PruneOptions = {},
): Promise<PruneResult> {
  const outbox = await pruneAckedOutbox(db, roomId, now, options.outboxTtl ?? OUTBOX_TTL);
  const commands = await pruneCommandsIfDue(db, now, options);
  return { commands, outbox };
}
