/**
 * stores.ts — the v2 schema of record.
 *
 * D5 (audit round 4): the plan REFERENCES this artifact; it never restates
 * the stores table. This file has been wrong in every audit round as a
 * markdown table — as code, the harness can execute it and the app runs it.
 *
 * v1 stores (profiles, locations, items) were created raw (lib/database.ts
 * before the Dexie adoption) and are declared here UNCHANGED so Dexie can
 * open an existing v1 install. v2 ADDS the sync stores; no data moves in
 * the upgrade transaction — the resumable migration task in migrate.ts does
 * that, staged through migrateStaging and promoted in one transaction.
 */

// ─── Sync stores ───────────────────────────────────────────────────────────

// Every store below exists for a named consumer (plan §6.1). No store or
// index without one.

/** ONE unique index serves dedup AND ordered author-range catch-up. */
export const OPS_STORE = "opId, &[roomId+deviceId+authorSeq], [roomId+table+rowId], roomId";

/** Plain `state` is load-bearing: without it the resume query throws
 *  SchemaError and the outbox never enumerates (review-2 P0-4, executed). */
export const OUTBOX_STORE = "opId, state, [roomId+state]";

/** The compound key IS the drain's lookup key. */
export const PENDING_STORE = "[roomId+deviceId+authorSeq]";

/** D1: a sequence slot spent but not adopted — bad-type, bad-seq, bad-stamp,
 *  cross-room, fork. The cursor advances over quarantined slots too. */
export const QUARANTINE_STORE = "[roomId+deviceId+authorSeq]";

/** Spec-gaps G2 (plan §6.1): compaction's missing store — the same defect
 *  class as N1's migrateStaging. Exactly ONE current snapshot per room
 *  (`put` replaces); the compaction path (step 7) is its consumer. */
export const SNAPSHOTS_STORE = "roomId";

/** Same-DB staging for the migration: a cross-database transaction is
 *  impossible in IndexedDB, so a one-transaction promote REQUIRES staging
 *  inside this db (audit-2 N1). */
export const MIGRATE_STAGING_STORE = "id, table";

/** Room-scoped content addressing: two rooms never share a blob row.
 *  Dexie source-verified (_parseStoresSpec): the FIRST store spec is the
 *  primary key regardless of prefix — a compound PK here is valid. */
export const FILES_STORE = "[roomId+hash]";

/** deviceId, clock, per-room metadata, idmap, migrate progress — the
 *  single-writer control state. */
export const META_STORE = "key";

/** Row tables gain two reducer-owned sync columns (winner, deletedAt).
 *  items also carries profileId (backfilled by the migration; written at
 *  mint from step 3 on). These Dexie declarations only add indexes — the
 *  columns themselves are plain row fields. */
export const V2_STORES = {
  profiles: "id",
  locations: "id, profileId",
  items: "id, locationId, profileId",
  ops: OPS_STORE,
  outbox: OUTBOX_STORE,
  pending: PENDING_STORE,
  quarantine: QUARANTINE_STORE,
  snapshots: SNAPSHOTS_STORE,
  migrateStaging: MIGRATE_STAGING_STORE,
  files: FILES_STORE,
  meta: META_STORE,
} as const;

/** The v1 schema exactly as the raw layer created it — never edited. */
export const V1_STORES = {
  profiles: "id",
  locations: "id, profileId",
  items: "id, locationId",
} as const;

/** Row tables the reducer may ever touch — a RUNTIME allowlist, never used
 *  to pick a store without a check (plan §6.4). */
export const ROW_TABLES = ["profiles", "locations", "items"] as const;
export type RowTable = (typeof ROW_TABLES)[number];

// ─── Row sync columns (reducer-owned; stripped at the facade boundary) ─────

export interface SyncColumns {
  /** Total-order key of the winning op: "hlcTs:hlcCounter:typeRank:deviceId:opId". */
  winner?: string;
  /** Tombstone. A row is visible iff deletedAt === null (STRICT null check —
   *  `deletedAt: 0` once rendered live under a falsy check, review-2 P2-1). */
  deletedAt?: number | null;
}

// ─── Op shape (plan §6.1) ─────────────────────────────────────────────────

export type OpType = "put" | "delete" | "resolve";

export interface RowOp {
  opId: string;
  roomId: string;
  deviceId: string;
  /** Positive, CONTIGUOUS per (roomId, deviceId); allocated inside the mint
   *  transaction. */
  authorSeq: number;
  hlcTs: number;
  hlcCounter: number;
  type: OpType;
  table: RowTable;
  rowId: string;
  payload?: unknown;
}

export interface OutboxEntry {
  opId: string;
  roomId: string;
  /** Carried so the derived-ack rule can map an entry to a peer cursor
   *  (audit-2 N8). */
  deviceId: string;
  authorSeq: number;
  state: "pending" | "acked" | "dead";
  attempts: number;
  createdAt: number;
}

export interface QuarantineEntry {
  roomId: string;
  deviceId: string;
  authorSeq: number;
  opId: string | null;
  reason: "bad-type" | "bad-seq" | "bad-stamp" | "cross-room" | "fork";
  receivedAt: number;
}

export interface FileRow {
  roomId: string;
  hash: string;
  bytes: Uint8Array<ArrayBuffer>;
  size: number;
  contentType: string;
}

/** meta rows are heterogeneous (deviceId, idmap, rooms, migrate progress):
 *  `key` is the only invariant. */
export interface MetaRow {
  key: string;
  [k: string]: unknown;
}

/** A staged row in migrateStaging — content is the remapped row, `legacyId`
 *  is its v1 id (the promote delete set is built from these). */
export interface StagedRow {
  id: string;
  table: RowTable;
  legacyId: string;
  roomId: string;
  content: Record<string, unknown>;
}

/** One current snapshot per room (plan §15.2): a serialized blob row the
 *  compaction path (step 7) writes and catch-up serves as ONE sealed blob.
 *  A pure function of the log prefix it covers, so compaction is
 *  idempotent and crash-safe. The exact payload fields are step 7's to
 *  define; the store and the one-per-room invariant land now so the v2
 *  schema does not need a second version bump. */
export interface SnapshotRow {
  roomId: string;
  createdAt: number;
  cutoffs: Record<string, number>;
  rows: unknown;
  tombstones: unknown;
  rosterChain: unknown;
  highWater: Record<string, number>;
  mediaRefs: string[];
  digest: string;
}

// ─── Room metadata (plan §6.1 step 2) ──────────────────────────────────────

export interface RosterMember {
  deviceId: string;
  role: "owner" | "member";
  addedAt: number;
}

export interface Room {
  roomId: string;
  /** Profiles are room-keyed: profile.id === roomId (plan §6.7). */
  profileId: string;
  relayUrl: string | null;
  keyGen: number;
  /** Fresh 256-bit room key, base64url — the room is COMPLETE and pairable
   *  from migration onward (audit-2 N3). Never leaves the device except in
   *  person (QR / export, step 6+). */
  roomKey: string;
  roster: RosterMember[];
  cursorIn: Record<string, number>;
  nextAuthorSeq: number;
  /** PER-ROOM clock (plan §15.8): a global `clock` row would serialize every
   *  room's mints on one meta record, and the mint transaction loads the room
   *  anyway (§6.2–§6.3). Baseline ops stamp it at promote. */
  clock: { ts: number; counter: number };
  migration: "running" | "promoted";
  createdAt: number;
}

// ─── Meta keys ─────────────────────────────────────────────────────────────

export const META_KEYS = {
  deviceId: "deviceId",
  /** §15.6/§15.8: ONE meta row per mapping, `idmap:<oldId>` → newId — a
   *  single large-object rewrite per chunk is a hot spot; the prefix scan
   *  of the PK is an index walk. */
  idmap: "idmap:",
  migrate: "migrate",
  roomPrefix: "room:",
} as const;

/** The meta.migrate record (plan §15.6 — shape is normative): state machine
 *  idle → scanning → staging → promoting → promoted | failed. This step-2
 *  task folds scanning into the v2 upgrade transaction (legacy rows are
 *  counted there exactly, atomically) and promoting into one transaction,
 *  so the durable phases are `staging` and `promoted`. */
export interface MigrationProgress {
  phase: "staging" | "promoted" | "failed";
  startedAt: number;
  /** Last staged newId per table — the resume point after a crash (the real
   *  resume authority is the idmap rows; this is the observable cursor). */
  perTableCursors: Partial<Record<RowTable | "media", string>>;
  chunkSize: number;
  stagedCounts: Partial<Record<RowTable, number>>;
  lastCheckpointAt: number;
  /** Rows unreachable from any profile (plan §15.16 orphan handling): left
   *  untouched in the live stores, never silently destroyed. */
  orphans: number;
  error?: string;
}

/** Each staged row + its idmap mapping commit together (crash loses at most
 *  the row in flight). §15.6's default of 500 is a bulk-perf knob this
 *  scale doesn't need yet — the recorded value is honest, not decorative. */
export const MIGRATION_CHUNK_SIZE = 1;
