/**
 * visible.ts — the ONE tombstone predicate (plan §6.5).
 *
 * Shared by the worker and the tabs so inventory, global search, category
 * counts, location counts, and stock totals agree by construction.
 *
 * The check is STRICT null, not falsy: `deletedAt: 0` is a tombstone, and a
 * falsy check once rendered it live (review-2 P2-1). The mirror-image trap is
 * an ABSENT field: a live row that never wrote `deletedAt` is invisible under
 * this predicate, which is why the reducer always writes the field (`null`
 * for a live row — audit-4 R4-P2-1, executed). The invariant is closed on the
 * write side; this predicate does not tolerate absence.
 */

export interface Tombstoned {
  deletedAt?: number | null;
}

/** A row is visible iff `deletedAt` is exactly `null`. */
export function isVisible(row: Tombstoned | null | undefined): boolean {
  return row != null && row.deletedAt === null;
}

/** A row is a tombstone iff `deletedAt` is present and not `null` (0 counts). */
export function isTombstone(row: Tombstoned | null | undefined): boolean {
  return row != null && row.deletedAt !== null && row.deletedAt !== undefined;
}

/** The visible subset, preserving order. */
export function visibleOnly<T extends Tombstoned>(rows: readonly T[]): T[] {
  return rows.filter(isVisible);
}
