/**
 * owlshelf-db  –  IndexedDB service layer
 *
 * Object stores
 *   profiles   keyPath=id
 *   locations  keyPath=id  index: profileId
 *   items      keyPath=id  index: locationId
 *
 * Version history
 *   1 – initial schema + seed data
 */

import type { Profile, Location, Item } from "@/types/item";
import { mockProfiles, mockLocations, mockItems } from "@/data/mockItems";

const DB_NAME = "owlshelf-db";
const DB_VERSION = 1;

// ─── Singleton promise ─────────────────────────────────────────────────────

let _dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => {
      _dbPromise = null; // allow retry
      reject(req.error);
    };

    req.onsuccess = () => resolve(req.result);

    // Runs only on first install (v1) or when DB_VERSION is bumped
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      // The implicit upgrade transaction — we MUST use this one
      const upgradeTx = (event.target as IDBOpenDBRequest).transaction!;

      // ── Create stores ──────────────────────────────────────────────────
      if (!db.objectStoreNames.contains("profiles")) {
        db.createObjectStore("profiles", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("locations")) {
        const locStore = db.createObjectStore("locations", { keyPath: "id" });
        locStore.createIndex("profileId", "profileId", { unique: false });
      }

      if (!db.objectStoreNames.contains("items")) {
        const itemStore = db.createObjectStore("items", { keyPath: "id" });
        itemStore.createIndex("locationId", "locationId", { unique: false });
      }

      // ── Seed on first install (version 1 only) ─────────────────────────
      if (event.oldVersion === 0) {
        const profileStore  = upgradeTx.objectStore("profiles");
        const locationStore = upgradeTx.objectStore("locations");
        const itemStore     = upgradeTx.objectStore("items");

        mockProfiles.forEach((p) => profileStore.put(p));
        mockLocations.forEach((l) => locationStore.put(l));
        mockItems.forEach((i) => itemStore.put(i));
      }
    };
  });

  return _dbPromise;
}

// ─── Generic async wrappers ────────────────────────────────────────────────

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}

export async function dbGet<T>(storeName: string, id: string): Promise<T | undefined> {
  const db = await openDB();
  const tx = db.transaction(storeName, "readonly");
  return idbRequest<T | undefined>(tx.objectStore(storeName).get(id));
}

export async function dbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDB();
  const tx = db.transaction(storeName, "readonly");
  return idbRequest<T[]>(tx.objectStore(storeName).getAll());
}

export async function dbGetByIndex<T>(
  storeName: string,
  indexName: string,
  value: string
): Promise<T[]> {
  const db = await openDB();
  const tx = db.transaction(storeName, "readonly");
  const index = tx.objectStore(storeName).index(indexName);
  return idbRequest<T[]>(index.getAll(value));
}

export async function dbPut<T>(storeName: string, record: T): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(storeName, "readwrite");
  await idbRequest(tx.objectStore(storeName).put(record));
}

export async function dbDelete(storeName: string, id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(storeName, "readwrite");
  await idbRequest(tx.objectStore(storeName).delete(id));
}

// ─── Typed store objects ───────────────────────────────────────────────────

export const profilesDB = {
  getAll:    ()            => dbGetAll<Profile>("profiles"),
  put:       (p: Profile)  => dbPut("profiles", p),
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
