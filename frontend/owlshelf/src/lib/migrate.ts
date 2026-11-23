/**
 * migrate.ts — the resumable v1 → v2 migration task (plan §6.1; ships in the
 * FIRST sync-capable version, no network sync in this step).
 *
 * Invariants this implementation owns (each maps to a proven audit defect):
 *
 * - Stage into `migrateStaging`, NEVER into the live stores (review-2 P0-10,
 *   audit-2 N1): v1 rows live in the very same stores Dexie v2 opens, so
 *   remapped-live writes would show every row twice in every live query.
 * - Baseline ops are minted AT PROMOTE, not in staging (audit-2 N2): a fresh
 *   peer must restore the entire pre-migration state from them.
 * - The promote delete set is `meta.idmap`'s keys, iterated explicitly —
 *   never `store.clear()` (audit D6.1). Rows minted after staging began are
 *   not in the idmap and survive promote (D6.2).
 * - Baseline `authorSeq` starts at each room's `nextAuthorSeq`, not at 1
 *   (D6.3): identical for a fresh migration, load-bearing for a legacy
 *   `inventoryDB` import into an existing room.
 * - Every profile becomes a room whose minted roomId IS the profile's new
 *   id (profiles are room-keyed, §6.7); the minted 256-bit roomKey makes
 *   the room complete and pairable from migration onward (audit-2 N3).
 * - Idempotent resume: each staged row + its idmap mapping commit together,
 *   so a re-run after a crash re-stages deterministically instead of
 *   minting a second, different id for the same v1 row. Hashes (SHA-256)
 *   make media re-staging converge on the identical `files` row too.
 * - Crash/abort at any point leaves the live stores pristine and the
 *   originals recoverable (§6.1 step 8). Nothing is ever deleted as
 *   "cleanup".
 */

import type { OwlshelfDB } from "./db";
import { getDeviceId } from "./db";
import {
  META_KEYS,
  type MigrationProgress,
  type Room,
  type RowOp,
  type OutboxEntry,
  type RowTable,
  type FileRow,
} from "./stores";

const CHUNK_SIZE = 1;

// ─── smoke seam ─────────────────────────────────────────────────────────────

/** Harness-only fault injection (plan §13: deterministic seams so crash
 *  behavior is provable, not asserted). In-app this stays 0 forever. */
export const _migrationTestHooks = {
  failAfterStagedRows: 0,
  stagedRowCount: 0,
};

function noteStagedRow(): void {
  _migrationTestHooks.stagedRowCount++;
  if (
    _migrationTestHooks.failAfterStagedRows > 0 &&
    _migrationTestHooks.stagedRowCount >= _migrationTestHooks.failAfterStagedRows
  ) {
    throw new Error(`owlshelf: migration fault injection after ${_migrationTestHooks.stagedRowCount} staged rows`);
  }
}

// ─── ids & crypto (browser-safe APIs; deterministic injectable seams are
//     the step-3 harness's business) ────────────────────────────────────────

function nanoid(len = 10): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeDataUrl(url: string): { bytes: Uint8Array<ArrayBuffer>; contentType: string } | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!m || m[2] !== ";base64") return null;
  try {
    const bin = atob(m[3]);
    const bytes = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, contentType: m[1] || "application/octet-stream" };
  } catch {
    return null;
  }
}

// entry point ────────────────────────────────────────────────────────────

export async function runMigration(db: OwlshelfDB): Promise<void> {
  const progress = await readProgress(db);

  if (!progress) {
    // Fresh install (or a db that never had v1 rows): nothing to migrate.
    // Terminal phase for the nothing-to-do case — the record exists so
    // every query about migration state has exactly one answer.
    await db.meta.put({
      key: META_KEYS.migrate,
      phase: "promoted",
      startedAt: Date.now(),
      perTableCursors: {},
      chunkSize: CHUNK_SIZE,
      stagedCounts: {},
      lastCheckpointAt: Date.now(),
      orphans: 0,
    });
    return;
  }

  if (progress.phase === "promoted") return;

  // phase === "staging" — written inside the v2 upgrade transaction when
  // legacy rows were detected. Stage to completion, then promote once.
  await stageAll(db, progress);
  await promote(db);
}

// ─── progress ──────────────────────────────────────────────────────────────

/** A `meta.migrate` record written by an EARLIER build of this same v2
 *  schema carries `status`/`cursor` and a single-object `idmap`. Reading it
 *  as the current shape would leave `perTableCursors` undefined and crash
 *  the resume path — which rejects `ensureOpen` and takes every facade call
 *  (including profile creation) down with it. Normalize once, in place:
 *  a completed migration stays completed, an interrupted one resumes. */
function normalizeLegacyProgress(row: Record<string, unknown>): MigrationProgress {
  const legacyStatus = row.status;
  const phase: MigrationProgress["phase"] =
    legacyStatus === "promoted" || legacyStatus === "clean" ? "promoted" : "staging";
  return {
    phase,
    startedAt: typeof row.startedAt === "number" ? row.startedAt : Date.now(),
    perTableCursors: (row.cursor as MigrationProgress["perTableCursors"]) ?? {},
    chunkSize: CHUNK_SIZE,
    stagedCounts: {},
    lastCheckpointAt: Date.now(),
    orphans: typeof row.orphans === "number" ? row.orphans : 0,
  };
}

async function readProgress(db: OwlshelfDB): Promise<MigrationProgress | undefined> {
  const row = await db.meta.get(META_KEYS.migrate);
  if (!row) return undefined;
  if (typeof row.phase === "string") return row as unknown as MigrationProgress;
  const normalized = normalizeLegacyProgress(row as Record<string, unknown>);
  await db.meta.put({ key: META_KEYS.migrate, ...normalized });
  return normalized;
}

async function saveProgress(db: OwlshelfDB, progress: MigrationProgress): Promise<void> {
  await db.meta.put({ key: META_KEYS.migrate, ...progress });
}

// ─── idmap (§15.6: one row per mapping) ─────────────────────────────────────

function idmapKey(oldId: string): string {
  return `${META_KEYS.idmap}${oldId}`;
}

async function putIdMapping(db: OwlshelfDB, oldId: string, newId: string): Promise<void> {
  await db.meta.put({ key: idmapKey(oldId), value: newId });
}

async function getIdMapping(db: OwlshelfDB, oldId: string): Promise<string | undefined> {
  const row = await db.meta.get(idmapKey(oldId));
  return row?.value as string | undefined;
}

/** Prefix scan of the PK — an index walk, never a large-record read
 *  (the §15.6 rationale for one-row-per-mapping). The legacy single-object
 *  `idmap` row (key `idmap`, no colon) is merged in so a resume after an
 *  earlier build keeps every id it already minted. */
async function readIdMap(db: OwlshelfDB): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const legacy = await db.meta.get("idmap");
  if (legacy && typeof legacy === "object") {
    for (const [oldId, newId] of Object.entries(legacy)) {
      if (oldId !== "key" && typeof newId === "string") map[oldId] = newId;
    }
  }
  const rows = await db.meta.where("key").startsWith(META_KEYS.idmap).toArray();
  for (const row of rows) {
    if (typeof row.value === "string") {
      map[row.key.slice(META_KEYS.idmap.length)] = row.value;
    }
  }
  return map;
}

/** Staged row + idmap mapping + progress checkpoint commit in ONE
 *  transaction: a crash loses at most the row being staged, never a
 *  half-mapped one, and `meta.migrate` is a real checkpoint (§15.6) rather
 *  than a record written once at the end. Re-staging a row that a previous
 *  run already committed keeps its minted id (the idmap) and does not
 *  double-count it. */
async function putStaged(
  db: OwlshelfDB,
  content: { id: string; profileId?: string },
  table: RowTable,
  legacyId: string,
  progress: MigrationProgress,
): Promise<void> {
  await db.transaction("rw", db.migrateStaging, db.meta, async () => {
    const existing = await db.migrateStaging.get(content.id);
    await putIdMapping(db, legacyId, content.id);
    await db.migrateStaging.put({
      id: content.id,
      table,
      legacyId,
      roomId: table === "profiles" ? content.id : content.profileId ?? "",
      content,
    });
    progress.perTableCursors[table] = content.id;
    if (!existing) progress.stagedCounts[table] = (progress.stagedCounts[table] ?? 0) + 1;
    progress.lastCheckpointAt = Date.now();
    await saveProgress(db, progress);
  });
  noteStagedRow();
}

// ─── staging ───────────────────────────────────────────────────────────────

async function stageAll(db: OwlshelfDB, progress: MigrationProgress): Promise<void> {
  const deviceId = await getDeviceId();
  const deviceId8 = deviceId.replace(/-/g, "").slice(0, 8);
  const mintId = () => `${deviceId8}-m${nanoid()}`;

  const idmap = await readIdMap(db);

  // Legacy profile id (v1) → roomId. Resumed runs recover the mapping from
  // the staged profile rows themselves (the profile's new id IS its roomId;
  // mappings and staged rows commit atomically, so the scan is complete —
  // location/item idmap rows are never profile lookups).
  const roomByProfile = new Map<string, string>();
  const stagedProfiles = await db.migrateStaging.where("table").equals("profiles").toArray();
  for (const rec of stagedProfiles) roomByProfile.set(rec.legacyId, rec.id);

  // Profiles first: each becomes a room; the ROOM-KEYED new id is the room.
  // The room row, the staged profile, and the idmap mapping commit in ONE
  // transaction — a crash can never orphan a room whose profile never
  // staged, nor re-mint a second room for a profile that already did.
  const profiles = await db.profiles.toArray();
  for (const p of profiles) {
    if (roomByProfile.has(p.id)) {
      continue; // staged in an interrupted run — never re-mint
    }
    const roomId = crypto.randomUUID();
    await db.transaction("rw", db.meta, db.migrateStaging, async () => {
      if (await getIdMapping(db, p.id)) return; // re-check under the lock
      const room: Room = {
        roomId,
        profileId: roomId,
        relayUrl: null,
        keyGen: 1,
        roomKey: b64url(crypto.getRandomValues(new Uint8Array(32))),
        roster: [{ deviceId, role: "owner", addedAt: Date.now() }],
        cursorIn: {},
        nextAuthorSeq: 1,
        clock: { ts: 0, counter: 0 },
        migration: "running",
        createdAt: Date.now(),
      };
      await db.meta.put({ key: `${META_KEYS.roomPrefix}${room.roomId}`, ...room });
      const freshProfile = { ...p, id: roomId };
      await db.migrateStaging.put({
        id: roomId,
        table: "profiles",
        legacyId: p.id,
        roomId,
        content: freshProfile,
      });
      await putIdMapping(db, p.id, roomId);
      progress.perTableCursors.profiles = roomId;
      progress.stagedCounts.profiles = (progress.stagedCounts.profiles ?? 0) + 1;
      progress.lastCheckpointAt = Date.now();
      await saveProgress(db, progress);
    });
    noteStagedRow();
    roomByProfile.set(p.id, roomId);
  }

  // Locations map into their profile's room; the new location's profileId
  // is the roomId (profiles are room-keyed).
  const locations = await db.locations.toArray();
  const newLocationIdByOld = new Map<string, string>();
  const roomIdByOldLocation = new Map<string, string>();
  for (const loc of locations) {
    const roomId = roomByProfile.get(loc.profileId);
    if (!roomId) {
      progress.orphans++; // location without a profile: untouched, never lost
      continue;
    }
    const newId = idmap[loc.id] ?? mintId();
    newLocationIdByOld.set(loc.id, newId);
    roomIdByOldLocation.set(loc.id, roomId);
    await putStaged(
      db,
      { ...loc, id: newId, profileId: roomId },
      "locations",
      loc.id,
      progress,
    );
  }

  // Items map through their (new) location's room; profileId is backfilled
  // (§6.1 step 3). Media: data URLs are decoded + hashed into `files` and
  // the reference becomes idb:// (§8.1); HTTPS URL policy is keep (§6.1
  // step 4); decode failure preserves the original reference.
  const items = await db.items.toArray();
  for (const it of items) {
    const newLocationId = newLocationIdByOld.get(it.locationId);
    if (!newLocationId) {
      progress.orphans++;
      continue;
    }
    const roomId = roomIdByOldLocation.get(it.locationId)!;
    const stagedItem: Record<string, unknown> = {
      ...it,
      id: idmap[it.id] ?? mintId(),
      locationId: newLocationId,
      profileId: roomId,
    };
    await stageItemMedia(db, stagedItem, roomId);
    await putStaged(db, stagedItem as { id: string; profileId: string }, "items", it.id, progress);
  }

  await saveProgress(db, progress);
}

async function stageItemMedia(
  db: OwlshelfDB,
  stagedItem: Record<string, unknown>,
  roomId: string,
): Promise<void> {
  const url = stagedItem.imageUrl;
  if (typeof url !== "string" || !url.startsWith("data:")) return;
  const decoded = decodeDataUrl(url);
  if (!decoded) return; // preserve the original reference on failure
  const hash = await sha256Hex(decoded.bytes);
  const file: FileRow = {
    roomId,
    hash,
    bytes: decoded.bytes,
    size: decoded.bytes.length,
    contentType: decoded.contentType,
  };
  await db.files.put(file);
  stagedItem.imageUrl = `idb://${hash}`;
}

// ─── promote (§6.1 steps 6–7 + audit D6) ───────────────────────────────────

async function promote(db: OwlshelfDB): Promise<void> {
  const deviceId = await getDeviceId();
  const promoteTs = Date.now();

  await db.transaction(
    "rw",
    [db.profiles, db.locations, db.items, db.ops, db.outbox, db.meta, db.migrateStaging, db.files],
    async () => {
      const staged = await db.migrateStaging.toArray();
      const progress = await readProgress(db);
      if (!progress) throw new Error("promote: no migration progress row");

      // D6.1 — the delete set is the idmap's keys, iterated explicitly.
      // Never store.clear(): rows minted AFTER staging began (facade
      // writes during migration) are not in the idmap and MUST survive.
      const tableByLegacyId = new Map<string, RowTable>();
      for (const rec of staged) {
        if (rec.legacyId && !tableByLegacyId.has(rec.legacyId)) {
          tableByLegacyId.set(rec.legacyId, rec.table);
        }
      }
      for (const [legacyId, table] of tableByLegacyId) {
        await db.table(table).delete(legacyId);
      }

      // Rooms (seq baseline per D6.3).
      const roomRows = await db.meta.where("key").startsWith(META_KEYS.roomPrefix).toArray();
      const roomByRoomId = new Map<string, Room>();
      for (const r of roomRows) {
        const room = r as unknown as Room;
        roomByRoomId.set(room.roomId, room);
      }

      // Staged rows live in step 2 without reducer columns; at promote each
      // baseline op IS the winning op, so the materialized rows carry the
      // winner metadata and an explicit `deletedAt: null` (the absent-field
      // trap of audit R4-P2-1 avoided by construction).
      const nextSeq = new Map<string, number>();
      const outbox: OutboxEntry[] = [];

      for (const rec of staged) {
        const room = roomByRoomId.get(rec.roomId);
        if (!room) continue; // should not happen: room minted with its profile
        const seq = nextSeq.get(rec.roomId) ?? room.nextAuthorSeq ?? 1;
        const opId = crypto.randomUUID();
        const winner = `${promoteTs}:0:0:${deviceId}:${opId}`;

        await db.table(rec.table).put({ ...rec.content, winner, deletedAt: null });

        const op: RowOp = {
          opId,
          roomId: rec.roomId,
          deviceId,
          authorSeq: seq,
          hlcTs: promoteTs,
          hlcCounter: 0,
          type: "put",
          table: rec.table,
          rowId: rec.id,
          payload: stripSyncColumns(rec.content),
        };
        await db.ops.put(op);
        outbox.push({
          opId,
          roomId: rec.roomId,
          deviceId,
          authorSeq: seq,
          state: "pending",
          attempts: 0,
          createdAt: promoteTs,
        });
        nextSeq.set(rec.roomId, seq + 1);
      }
      await db.outbox.bulkPut(outbox);

      for (const room of roomByRoomId.values()) {
        await db.meta.put({
          key: `${META_KEYS.roomPrefix}${room.roomId}`,
          ...room,
          nextAuthorSeq: nextSeq.get(room.roomId) ?? room.nextAuthorSeq,
          // The baseline ops stamp the room's per-room clock (§15.8): every
          // mint from step 3 on is dominated by the promote stamps.
          clock: { ts: promoteTs, counter: 0 },
          migration: "promoted",
        });
      }

      await db.migrateStaging.clear();
      await db.meta.put({
        key: META_KEYS.migrate,
        ...progress,
        phase: "promoted",
        lastCheckpointAt: promoteTs,
      });
    },
  );
}

/** The op payload is the row content WITHOUT reducer-owned sync columns;
 *  winner/tombstone state is written by the reducer only (plan §6.1). */
function stripSyncColumns(content: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...content };
  delete clone.winner;
  delete clone.deletedAt;
  return clone;
}

// NOTE (plan §6.1 step 10 / spec-gaps W1): the legacy `inventoryDB`
// second-database import path is DELETED by pass 6 — `src/data/database.ts`
// defined it but no released bundle ever imported it, so no browser has ever
// opened the db. If a real-user census ever proves otherwise, the import
// (and its field mapping) is specified THEN, never before.
