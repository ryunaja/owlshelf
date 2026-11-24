/**
 * audit.ts — the consistency audit's local half (§6.6).
 *
 * Determinism makes a cross-check redundant in theory and mandatory in
 * practice: the stored-conflict-flag bug was divergence by construction,
 * exactly the class a runtime audit exists to catch. The audit is the
 * production twin of Gate B's property tests — the tests prove the reducer
 * before shipping, the audit catches whatever the tests missed.
 *
 * This module is the LOCAL side only: what to digest, and what a disagreement
 * means. Sending and receiving live in `sync.ts`.
 */

import type { OwlshelfDB } from "./db";
import { auditDigest, type AuditRow } from "./canonical";
import { ROW_TABLES, type RowTable } from "./stores";

/** The three row tables, in the shape the digest wants. */
interface DigestibleRow {
  id: string;
  winner?: string;
  deletedAt?: number | null;
}

async function rowsOf(
  db: OwlshelfDB,
  table: RowTable,
  roomId: string,
): Promise<DigestibleRow[]> {
  // Profiles are keyed by roomId; every other row carries `profileId`
  // (reduce.ts sets it from the op's roomId, and it is never payload-writable).
  if (table === "profiles") {
    const row = await db.profiles.get(roomId);
    return row ? [row] : [];
  }
  if (table === "locations") {
    return db.locations.where("profileId").equals(roomId).toArray();
  }
  return db.items.where("profileId").equals(roomId).toArray();
}

/**
 * Every row in the room, tombstoned or not.
 *
 * Tombstones are INCLUDED: a device that dropped a tombstone and one that kept
 * it have different state, and a visible-rows-only digest would call them
 * converged. `deletedAt` is part of the tuple for the same reason.
 */
export async function collectAuditRows(
  db: OwlshelfDB,
  roomId: string,
): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  for (const table of ROW_TABLES) {
    for (const row of await rowsOf(db, table, roomId)) {
      rows.push({
        table,
        rowId: row.id,
        winner: row.winner ?? null,
        deletedAt: row.deletedAt ?? null,
      });
    }
  }
  return rows;
}

/**
 * Per-author adopted-op counts.
 *
 * audit-4 R4-P2-5: a rows-only digest made two devices with different
 * `pending` depths produce identical digests while their derived conflict
 * lists differed. The digest must see the log's shape, not just its rows.
 */
export async function countOpsByAuthor(
  db: OwlshelfDB,
  roomId: string,
): Promise<Record<string, number>> {
  const ops = await db.ops.where("roomId").equals(roomId).toArray();
  const counts: Record<string, number> = {};
  for (const op of ops) counts[op.deviceId] = (counts[op.deviceId] ?? 0) + 1;
  return counts;
}

/** This device's view of the room, as one digest. */
export async function localAuditDigest(db: OwlshelfDB, roomId: string): Promise<string> {
  return auditDigest(await collectAuditRows(db, roomId), await countOpsByAuthor(db, roomId));
}

// ─── The repair ladder ─────────────────────────────────────────────────────

export type AuditAction = "agree" | "catchup" | "rebuild";

export interface AuditView {
  digest: string;
  highWater: Record<string, number>;
}

function sameHighWater(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * What a digest disagreement means — never voting, never blind overwrite.
 *
 * Rung 1: the high-water marks differ, so a device is BEHIND, not divergent.
 * Normal catch-up fills it. This is the common case by a wide margin.
 *
 * Rung 2: the op sets are identical and the digests still differ, so the
 * reducer is non-deterministic — a bug, not a sync problem. The repair is a
 * deterministic rebuild (rows are a pure function of the log), and the durable
 * fix is a reducer release, otherwise the next op re-diverges the devices.
 */
export function auditMismatchAction(mine: AuditView, theirs: AuditView): AuditAction {
  if (mine.digest === theirs.digest) return "agree";
  if (!sameHighWater(mine.highWater, theirs.highWater)) return "catchup";
  return "rebuild";
}
