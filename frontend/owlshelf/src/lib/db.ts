/**
 * db.ts — Dexie adoption of the existing `owlshelf-db`.
 *
 * v1 is declared to match the raw schema EXACTLY, so an install created by
 * the pre-Dexie bundle opens in place and upgrades to v2 additively (no
 * data moves here). The resumable migration task lives in migrate.ts.
 *
 * Compat behavior (plan §12.6): the raw-IDB release could never ship its
 * versionchange handler to already-deployed bundles, so old tabs holding a
 * v1 connection are handled the other way around: Dexie fires `blocked`
 * until they close, and this module surfaces that to the UI as a reload
 * banner (`subscribeDbBlocked`), never as a silent failure.
 */

import Dexie, { type Table } from "dexie";
import { mockProfiles, mockLocations, mockItems } from "../data/mockItems";
import type { Profile } from "../types/item";
import {
  V1_STORES,
  V2_STORES,
  META_KEYS,
  MIGRATION_CHUNK_SIZE,
  type MigrationProgress,
  type Room,
  type RowOp,
  type OutboxEntry,
  type QuarantineEntry,
  type FileRow,
  type MetaRow,
  type StagedRow,
  type SnapshotRow,
} from "./stores";

const DB_NAME = "owlshelf-db";
const DB_VERSION = 2;

export class OwlshelfDB extends Dexie {
  profiles!: Table<{ id: string }, string>;
  locations!: Table<{ id: string; profileId: string }, string>;
  items!: Table<{ id: string; locationId: string; profileId?: string }, string>;
  ops!: Table<RowOp, string>;
  outbox!: Table<OutboxEntry, string>;
  pending!: Table<{ roomId: string; deviceId: string; authorSeq: number }, [string, string, number]>;
  quarantine!: Table<QuarantineEntry, [string, string, number]>;
  migrateStaging!: Table<StagedRow, string>;
  files!: Table<FileRow, [string, string]>;
  meta!: Table<MetaRow, string>;
  snapshots!: Table<SnapshotRow, string>;

  constructor() {
    super(DB_NAME);

    // v1 — the raw schema exactly as the pre-Dexie bundle created it.
    this.version(1).stores(V1_STORES);

    // v2 — adds sync stores and indexes only. DATA migration is the
    // resumable task (migrate.ts); the upgrade transaction never moves rows.
    //
    // Legacy detection happens HERE, inside the upgrade transaction, so it
    // is exact: oldVersion 1 means raw rows may exist in the live stores.
    // The whole upgrade (stores + this seed row) commits atomically; a crash
    // re-runs it cleanly.
    this.version(2)
      .stores(V2_STORES)
      .upgrade(async (tx): Promise<void> => {
        const profiles = await tx.table("profiles").count();
        const locations = await tx.table("locations").count();
        const items = await tx.table("items").count();
        if (profiles + locations + items === 0) return;
        const progress: MigrationProgress = {
          phase: "staging",
          startedAt: Date.now(),
          perTableCursors: {},
          chunkSize: MIGRATION_CHUNK_SIZE,
          stagedCounts: {},
          lastCheckpointAt: Date.now(),
          orphans: 0,
        };
        await tx.table("meta").put({ key: META_KEYS.migrate, ...progress });
      });
  }
}

export const db = new OwlshelfDB();

// ─── Dev seed (unchanged contract; never in prod) ──────────────────────────

// Demo data must never land on a real user's shelf (plan §6.1 rule 10).
// Same gate the raw layer used: fresh installs only, dev builds only. The
// seeds keep their legacy deterministic ids (p1, loc-storage, …) on purpose:
// the migration then remaps them exactly as a real legacy install would be,
// so every fresh dev install exercises the migration path.
db.on("populate", (tx) => {
  if (!import.meta.env.DEV) return;
  mockProfiles.forEach((p) => tx.table("profiles").put(p));
  mockLocations.forEach((l) => tx.table("locations").put(l));
  mockItems.forEach((i) => tx.table("items").put(i));
});

// ─── upgrade-blocking banner (plan §12.6) ─────────────────────────────────

type BlockedListener = () => void;
let dbBlocked = false;
const blockedListeners = new Set<BlockedListener>();

db.on("blocked", () => {
  // An old bundle's tab holds a v1 connection and cannot be told to
  // close-and-reload (that handler ships only with this version). Surface
  // it; the banner asks the user to close the other tabs.
  dbBlocked = true;
  blockedListeners.forEach((l) => l());
});

export function subscribeDbBlocked(listener: BlockedListener): () => void {
  blockedListeners.add(listener);
  if (dbBlocked) listener();
  return () => blockedListeners.delete(listener);
}

/** Stable getSnapshot for useSyncExternalStore(subscribeDbBlocked, isDbBlocked). */
export function isDbBlocked(): boolean {
  return dbBlocked;
}

// Versions of Dexie expose a "ready" Promise; blocked can also fire after
// open. A versionchange prompt for the FUTURE (v3) features the same way:
db.on("versionchange", () => {
  // Another tab upgraded the schema — reload promptly so this bundle's
  // old assumptions never run against a newer store set.
  if (typeof location !== "undefined" && typeof location.reload === "function") {
    location.reload();
  }
});

// ─── deviceId (plan §12.3) ───────────────────────────────────────────────

let deviceIdPromise: Promise<string> | null = null;

/** Transactional check-then-put creation; module-level promise — every
 *  caller in this context shares one id (plan §12.3). No legacy
 *  localStorage key ever existed in a released bundle, so the "migrate
 *  then delete the key" step is vacuous today and stays here only as a
 *  reminder that post-release changes to this id ARE a migration. */
export function getDeviceId(): Promise<string> {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      const existing = await db.meta.get(META_KEYS.deviceId);
      const existingValue = existing?.value;
      if (typeof existingValue === "string") return existingValue;
      const value = crypto.randomUUID();
      await db.transaction("rw", db.meta, async () => {
        const again = await db.meta.get(META_KEYS.deviceId);
        if (!again) await db.meta.put({ key: META_KEYS.deviceId, value });
      });
      return value;
    })().catch((e) => {
      deviceIdPromise = null;
      throw e;
    });
  }
  return deviceIdPromise;
}

// ─── meta helpers ─────────────────────────────────────────────────────────

export async function getRoom(roomId: string): Promise<Room | undefined> {
  const row = await db.meta.get(`${META_KEYS.roomPrefix}${roomId}`);
  return (row as unknown as Room) ?? undefined;
}

export async function putRoom(room: Room): Promise<void> {
  await db.meta.put({ key: `${META_KEYS.roomPrefix}${room.roomId}`, ...room });
}

// ─── profile creation (plan §6.7 create) ──────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function nanoid(len = 10): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** §6.7 create, in order: mint a collision-safe roomId (8-char deviceId
 *  prefix + nanoid) and a fresh 256-bit roomKey, persist COMPLETE room
 *  metadata, then write the profile row whose id IS the roomId — one
 *  transaction, so a crash never leaves a profile without its room (or a
 *  room without its profile). The room is BOUND before any QR is minted
 *  (step 6); nothing here is pairable yet. */
export async function createProfile(data: Omit<Profile, "id">): Promise<Profile> {
  await ensureOpen();
  const deviceId = await getDeviceId();
  const deviceId8 = deviceId.replace(/-/g, "").slice(0, 8);
  const roomId = `${deviceId8}-${nanoid()}`;
  const now = Date.now();
  const room: Room = {
    roomId,
    profileId: roomId,
    relayUrl: null,
    keyGen: 1,
    roomKey: b64url(crypto.getRandomValues(new Uint8Array(32))),
    roster: [{ deviceId, role: "owner", addedAt: now }],
    cursorIn: {},
    nextAuthorSeq: 1,
    clock: { ts: 0, counter: 0 },
    migration: "promoted",
    createdAt: now,
  };
  const profile: Profile = { ...data, id: roomId };
  await db.transaction("rw", db.meta, db.profiles, async () => {
    await db.meta.put({ key: `${META_KEYS.roomPrefix}${roomId}`, ...room });
    // Row tables carry the reducer-owned tombstone column; a live row says
    // so explicitly (audit R4-P2-1's absent-field trap).
    await db.table("profiles").put({ ...profile, deletedAt: null });
  });
  return profile;
}

// ─── open + migration trigger ──────────────────────────────────────────────

let migrationReadyPromise: Promise<void> | null = null;

/** Opens the db and runs the resumable migration to completion (or resolves
 *  immediately when there is nothing to migrate). Read paths in the facade
 *  await this so no view ever renders the pre-migration duplicates that
 *  staged promotes exist to prevent. */
export function ensureOpen(): Promise<void> {
  if (!migrationReadyPromise) {
    migrationReadyPromise = (async () => {
      await db.open();
      const { runMigration } = await import("./migrate");
      await runMigration(db);
    })().catch((e) => {
      migrationReadyPromise = null;
      throw e;
    });
  }
  return migrationReadyPromise;
}

/** Best-effort durability ask from a tab context (plan §12.15). The storage
 *  guarantees section of the sync plan treats refusal as honest, not fatal. */
export function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.().then((granted) => {
      if (!granted) console.info("[owlshelf] persistent storage not granted");
    });
  } catch {
    /* unavailable — fine */
  }
}

export { DB_VERSION };
