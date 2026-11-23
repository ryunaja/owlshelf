/**
 * owlshelf-db  –  Dexie-backed service layer (the facade).
 *
 * Object stores (schema of record: lib/stores.ts)
 *   profiles   keyPath=id
 *   locations  keyPath=id  index: profileId
 *   items      keyPath=id  index: locationId, profileId
 *   + v2 sync stores: ops, outbox, pending, quarantine, migrateStaging,
 *     files, meta  (plan §6.1; the op engine wires up in step 3)
 *
 * Version history
 *   1 – raw IndexedDB schema + dev seed (the pre-Dexie bundle)
 *   2 – Dexie adoption: sync stores added; legacy rows are re-ided and
 *       promoted by the resumable task in lib/migrate.ts
 *
 * The exported shapes are UNCHANGED from the raw layer (plan §2 step 2:
 * "preserve facade/hook contracts") — useDB.ts and every page keep their
 * exact destructure targets. Live queries and the command path arrive
 * with the worker (step 3); until then tabs read/write through this
 * facade, which serializes on the migration so no read ever observes the
 * staged-promote duplicates (or the pre-promote double view at all).
 */

import type { Profile, Location, Item } from "../types/item";
import { db, ensureOpen, createProfile } from "./db";
import type { RowTable } from "./stores";

/** Kept for contract compatibility with the raw layer. Returns the open
 *  Dexie instance once open + migration have settled. */
export async function openDB(): Promise<typeof db> {
  await ensureOpen();
  return db;
}

// ─── Generic async wrappers ────────────────────────────────────────────────

export async function dbGet<T>(storeName: string, id: string): Promise<T | undefined> {
  await ensureOpen();
  return db.table(storeName).get(id) as Promise<T | undefined>;
}

export async function dbGetAll<T>(storeName: string): Promise<T[]> {
  await ensureOpen();
  return db.table(storeName).toArray() as Promise<T[]>;
}

/** `dbGetByIndex` is read-path only; indexes are validated by the Dexie
 *  schema at open time (the schema IS the artifact, lib/stores.ts). */
export async function dbGetByIndex<T>(
  storeName: string,
  indexName: string,
  value: string
): Promise<T[]> {
  await ensureOpen();
  return db
    .table(storeName)
    .where(indexName)
    .equals(value)
    .toArray() as Promise<T[]>;
}

/** Row-table writes stamp the reducer-owned sync columns the step-3 engine
 *  expects: a session-local write is live (`deletedAt: null`), avoiding
 *  the absent-field trap of audit R4-P2-1, and carries no winner yet —
 *  baseline winners are the migration's, op minting is the worker's. */
export async function dbPut<T>(storeName: string, record: T): Promise<void> {
  await ensureOpen();
  await db.transaction("rw", db.table(storeName), async () => {
    if (isRowTable(storeName) && (record as Record<string, unknown>).deletedAt === undefined) {
      await db.table(storeName).put({ ...record, deletedAt: null });
    } else {
      await db.table(storeName).put(record);
    }
  });
}

export async function dbDelete(storeName: string, id: string): Promise<void> {
  await ensureOpen();
  await db.table(storeName).delete(id);
}

function isRowTable(name: string): name is RowTable {
  return name === "profiles" || name === "locations" || name === "items";
}

// ─── Typed store objects ───────────────────────────────────────────────────

export const profilesDB = {
  getAll:    ()            => dbGetAll<Profile>("profiles"),
  put:       (p: Profile) => dbPut("profiles", p),
  /** §6.7 create: mints the room and the profile row together, so a new
   *  profile is never a roomless row (profile.id === roomId). */
  create:    (data: Omit<Profile, "id">) => createProfile(data),
};

export const locationsDB = {
  getAll:       ()                  => dbGetAll<Location>("locations"),
  getByProfile: (profileId: string) => dbGetByIndex<Location>("locations", "profileId", profileId),
  get:          (id: string)        => dbGet<Location>("locations", id),
  put:          (l: Location)       => dbPut("locations", l),
  delete:       (id: string)        => dbDelete("locations", id),
};

export const itemsDB = {
  getAll:       ()                   => dbGetAll<Item>("items"),
  getByLocation:(locationId: string) => dbGetByIndex<Item>("items", "locationId", locationId),
  get:          (id: string)         => dbGet<Item>("items", id),
  put:          (i: Item)            => dbPut("items", i),
  delete:       (id: string)         => dbDelete("items", id),
};

export { db };
