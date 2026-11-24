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
import { roomMetaKey } from "./roomMeta";

const DB_NAME = "owlshelf-db";
const DB_VERSION = 2;

/** Dev-only seed gate. `import.meta.env` is a Vite define; under the Node
 *  harness it is absent, so the guard has to survive its absence rather than
 *  assume it (the harness opens this exact class — plan §13). */
const IS_DEV = (() => {
  try {
    return import.meta.env.DEV === true;
  } catch {
    return false;
  }
})();

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

  /** The name is a parameter so the execution harness (plan §13) opens the
   *  SHIPPED schema — same class, same upgrade transaction — under an
   *  isolated database per test instead of a re-declared copy of the stores. */
  constructor(name: string = DB_NAME) {
    super(name);

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

    // Demo data must never land on a real user's shelf (plan §6.1 rule 10).
    // Same gate the raw layer used: fresh installs only, dev builds only. The
    // seeds keep their legacy deterministic ids (p1, loc-storage, …) on
    // purpose: the migration then remaps them exactly as a real legacy
    // install would be, so every fresh dev install exercises that path.
    this.on("populate", (tx) => {
      if (!IS_DEV) return;
      mockProfiles.forEach((p) => tx.table("profiles").put(p));
      mockLocations.forEach((l) => tx.table("locations").put(l));
      mockItems.forEach((i) => tx.table("items").put(i));
    });
  }
}

export const db = new OwlshelfDB();

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

// Instance-scoped implementations live in roomMeta.ts so the worker and the
// execution harness run the same code; these are the singleton-bound aliases
// the app already imports.
export async function getRoom(roomId: string): Promise<Room | undefined> {
  const row = await db.meta.get(roomMetaKey(roomId));
  return (row as unknown as Room) ?? undefined;
}

export async function putRoom(room: Room): Promise<void> {
  await db.meta.put({ key: roomMetaKey(room.roomId), ...room });
}

// ─── profile creation ─────────────────────────────────────────────────────
//
// Creation lives in `rooms.ts` (`createRoom`), because a room is only usable
// once it has a SIGNED ROSTER ANCHOR — and this module cannot mint one without
// pulling the whole control plane in. The function that used to live here built
// a room with no `ownerPub` and no anchor, which made every profile created
// through it unpairable: `mintJoinFragment` refuses a room with no anchor, and
// `rejoinRoom` has nothing to verify against (code-vs-plan §5.6).

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
