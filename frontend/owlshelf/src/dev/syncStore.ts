/**
 * syncStore.ts — the dev sync panel's state (plan §13, Gate G).
 *
 * ── What this is now ──────────────────────────────────────────────────────
 *
 * A VIEW. It used to own a `SyncEngine`; the engine lives in the worker now
 * (§5.5), so this module reads the database and asks the worker for the
 * engine's live state. It constructs nothing and stops nothing.
 *
 * That is not a demotion — it is the fix. The panel used to open its own
 * socket for the selected room while `syncRuntime` opened one per room for the
 * app, so opening the panel doubled the connections for that room. The relay's
 * `conns_per_ip = 3` counts across all rooms, so that was enough to hit the cap.
 *
 * ── The split, and why it is the plan's ───────────────────────────────────
 *
 * §5 gives tabs reads, so everything durable is read here directly: the room
 * list, the op count, the outbox buckets, `cursorIn`, `peerCursors`. Only the
 * engine's non-durable state (status, connId, members, the envelope log) and
 * its operations (catch-up, audit, drain, suspend, resume, blob request) cross
 * the port, and they cross it as the `dev-*` block — instrumentation, not the
 * app's protocol.
 *
 * State is published through `useSyncExternalStore`, not `useState` in an
 * effect: `react-hooks/set-state-in-effect` is an error in this repo, and this
 * is an external mutable object anyway. `getSnapshot` returns a cached object
 * that is only replaced when something actually changed, which is what
 * `useSyncExternalStore` requires to avoid an infinite render loop.
 *
 * DEV ONLY. Nothing here is imported unless `?sync=1` is on the URL.
 */

import { liveQuery } from "dexie";
import { db as appDb } from "@/lib/db";
import { getWorkerClient, type WorkerClient } from "@/lib/worker/client";
import { readRoom } from "@/lib/roomMeta";
import { DEFAULT_RELAY_URL, type SyncStatus } from "@/lib/sync";
import type { SyncLogEntry } from "@/lib/worker/protocol";
import type { OwlshelfDB } from "@/lib/db";
import type { Room } from "@/lib/stores";

export type { SyncLogEntry };

export interface SyncSnapshot {
  /** Engine status, or `offline` when the worker holds no engine. */
  status: SyncStatus;
  connId: string | null;
  members: readonly string[];
  roomId: string | null;
  /** Every room in the DB, for the picker. */
  rooms: readonly string[];
  deviceId: string | null;
  relayUrl: string;
  /** Durable op count for the room. */
  ops: number;
  outbox: { pending: number; acked: number; dead: number };
  /** What WE have adopted from each author. */
  cursorIn: Record<string, number>;
  /** What each PEER has adopted from each author (the ack rule's input). */
  peerCursors: Record<string, Record<string, number>>;
  lastSeen: Record<string, number>;
  log: readonly SyncLogEntry[];
  error: string | null;
  /** The last socket close, so `offline` is never unexplained. */
  lastClose: { code: number; reason: string } | null;
  running: boolean;
}

export interface SyncStoreDeps {
  db: OwlshelfDB;
  /** Test seam: the writer. Production walks the ladder. */
  getClient?: () => Promise<WorkerClient>;
}

/** Re-exported for the panel: the default lives in `sync.ts`, because the
 *  app's runtime needs it too and a lib module must not import a dev one. */
export { DEFAULT_RELAY_URL };

const INITIAL: SyncSnapshot = {
  status: "offline",
  connId: null,
  members: [],
  roomId: null,
  rooms: [],
  deviceId: null,
  relayUrl: DEFAULT_RELAY_URL,
  ops: 0,
  outbox: { pending: 0, acked: 0, dead: 0 },
  cursorIn: {},
  peerCursors: {},
  lastSeen: {},
  log: [],
  error: null,
  lastClose: null,
  running: false,
};

/**
 * Turn a close code into the thing the operator actually has to fix.
 *
 * `offline` alone is useless: a refused origin, a relay that is not running,
 * and a room at capacity all look identical. These are the §15.4 codes plus
 * 1006, which is what a browser reports when the TCP connection never opened.
 */
export function closeHint(code: number): string | null {
  switch (code) {
    case 1006:
      return "Relay unreachable — is it running on that host and port?";
    case 4401:
      return "Origin refused — add this page's origin to ALLOWED_ORIGINS.";
    case 4402:
      return "Handshake timed out — the relay never saw a valid hello.";
    case 4403:
      return "Room is full (10 connections).";
    case 4404:
      return "Generation mismatch — this device needs re-pairing.";
    case 1013:
      return "Relay at capacity — backing off.";
    default:
      return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SyncStore {
  private readonly db: OwlshelfDB;
  private readonly getClient: () => Promise<WorkerClient>;

  private snapshot: SyncSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SyncStoreDeps) {
    this.db = deps.db;
    this.getClient = deps.getClient ?? (async () => (await getWorkerClient()).client);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SyncSnapshot => this.snapshot;

  private set(patch: Partial<SyncSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Persist the relay URL onto the room. `connect()` gates on this field. */
  async setRelayUrl(url: string): Promise<void> {
    this.set({ relayUrl: url });
    const roomId = this.snapshot.roomId;
    if (!roomId) return;
    try {
      const client = await this.getClient();
      await client.devSetRelay(roomId, url);
    } catch (e) {
      this.set({ error: message(e) });
    }
  }

  /** Read every `room:` meta row. */
  private async readRooms(): Promise<Room[]> {
    const rows = await this.db.meta.toArray();
    return rows
      .filter((row) => row.key.startsWith("room:"))
      .map((row) => row as unknown as Room);
  }

  /** Adopt a room list: keep the selection if it still exists, otherwise take
   *  the first.
   *
   *  `relayUrl` is only reset when the SELECTION changes. A live emission
   *  fires on every write to `meta`, and resetting the field each time would
   *  overwrite whatever the user is typing into it. */
  private async applyRooms(rooms: Room[]): Promise<void> {
    if (rooms.length === 0) {
      this.set({
        error: "No room yet — create a profile in the app; this panel picks it up automatically.",
        rooms: [],
        roomId: null,
      });
      return;
    }
    const current = this.snapshot.roomId;
    const selected = rooms.find((r) => r.roomId === current) ?? rooms[0];
    const changed = selected.roomId !== current;
    this.set({
      roomId: selected.roomId,
      rooms: rooms.map((r) => r.roomId),
      ...(changed ? { relayUrl: selected.relayUrl ?? DEFAULT_RELAY_URL } : {}),
      error: null,
    });
    await this.refresh();
  }

  /** One-shot load. */
  async loadRooms(): Promise<void> {
    await this.applyRooms(await this.readRooms());
  }

  /**
   * Keep the room list live, and return the unsubscribe.
   *
   * A one-shot load is wrong on first use: the panel mounts before any profile
   * exists, caches "no rooms", and then never notices the profile the user
   * creates a moment later — so the device looks like it cannot create a room
   * and therefore cannot sync. `liveQuery` re-emits on every write to `meta`,
   * which is where `createProfile` puts the room.
   */
  watchRooms(): () => void {
    const subscription = liveQuery(() => this.readRooms()).subscribe({
      next: (rooms) => {
        void this.applyRooms(rooms);
      },
      error: () => {
        /* a failed read leaves the last good list in place */
      },
    });
    return () => subscription.unsubscribe();
  }

  async selectRoom(roomId: string): Promise<void> {
    const room = await readRoom(this.db, roomId);
    if (!room) return;
    this.set({
      roomId,
      relayUrl: room.relayUrl ?? DEFAULT_RELAY_URL,
      cursorIn: room.cursorIn,
      peerCursors: room.peerCursors ?? {},
      lastSeen: room.lastSeen ?? {},
    });
    await this.refresh();
  }

  // ── Dev-only room sharing ────────────────────────────────────────────────
  //
  // This is NOT §6.7's pairing. It carries no roster anchor, no owner
  // signature, and no revocation story — it is exactly what two devices need
  // to decrypt each other's envelopes, so op convergence can be tested before
  // step 6 exists. Treat the payload as a secret: it contains the room key in
  // the clear, which is equally true of the real QR fragment.
  //
  // Both halves WRITE, so both live in the worker (`lib/roomShare.ts`) and are
  // reached through `dev-export-room` / `dev-import-room`.

  /** Serialise the selected room for pasting into another origin. */
  async exportRoom(): Promise<string | null> {
    const roomId = this.snapshot.roomId;
    if (!roomId) return null;
    try {
      const client = await this.getClient();
      return await client.devExportRoom(roomId);
    } catch (e) {
      this.set({ error: message(e) });
      return null;
    }
  }

  /** Adopt an exported room on this device. */
  async importRoom(text: string): Promise<void> {
    try {
      const client = await this.getClient();
      await client.devImportRoom(text);
    } catch (e) {
      this.set({ error: message(e) });
      return;
    }
    await this.loadRooms();
  }

  /**
   * Re-read everything the panel displays.
   *
   * Two sources, deliberately: the durable counters are a tab-side READ (§5
   * gives tabs reads), and the engine's live state is a `dev-state` request
   * because it is not in the database.
   */
  async refresh(): Promise<void> {
    const roomId = this.snapshot.roomId;
    if (!roomId) return;
    // `ops` has a standalone `roomId` index; `outbox` does not (its indexes are
    // `opId`, `state`, and `[roomId+state]`), so filtering in memory is the
    // only option that does not need a compound-range query. The outbox is
    // small — it is pruned by the ack rule, not accumulated.
    const [ops, outboxRows, room] = await Promise.all([
      this.db.ops.where("roomId").equals(roomId).count(),
      this.db.outbox.toArray(),
      readRoom(this.db, roomId),
    ]);
    const outbox = { pending: 0, acked: 0, dead: 0 };
    for (const row of outboxRows) {
      if (row.roomId === roomId) outbox[row.state] += 1;
    }
    this.set({
      ops,
      outbox,
      cursorIn: room?.cursorIn ?? {},
      peerCursors: room?.peerCursors ?? {},
      lastSeen: room?.lastSeen ?? {},
    });

    try {
      const client = await this.getClient();
      const state = await client.devState(roomId);
      this.set({
        running: state.running,
        status: state.status,
        connId: state.connId,
        members: state.members,
        lastClose: state.lastClose,
        log: state.log,
        deviceId: state.deviceId,
      });
      const hint = state.lastClose ? closeHint(state.lastClose.code) : null;
      if (hint) this.set({ error: hint });
    } catch {
      /* the worker is not up yet; the next poll retries */
    }
  }

  /**
   * Ask the worker to sync this room.
   *
   * `room-add` is the plan's message and it is reference-counted per port, so
   * this is safe even though `syncRuntime` has already asked for the same room
   * — the engine is shared, not duplicated.
   */
  async connect(): Promise<void> {
    const { roomId, relayUrl } = this.snapshot;
    if (!roomId) {
      this.set({ error: "No room — create a profile first." });
      return;
    }
    if (relayUrl.trim() === "") {
      this.set({ error: "Set a relay URL first." });
      return;
    }
    try {
      const client = await this.getClient();
      // `connect()` reads the room from the DB, so the URL must be durable
      // before the engine dials — setting it in memory only would be ignored.
      await client.devSetRelay(roomId, relayUrl);
      await client.roomAdd(roomId);
      await client.devOp(roomId, "resume");
      this.set({ error: null });
    } catch (e) {
      this.set({ error: message(e) });
    }
    await this.refresh();
  }

  /**
   * Suspend this room's engine.
   *
   * Not `room-remove`: the engine is shared with every other tab, and
   * `syncRuntime` still holds a reference. Suspending is the honest verb for
   * what a single tab can do to a shared engine.
   */
  async disconnect(): Promise<void> {
    const roomId = this.snapshot.roomId;
    if (!roomId) return;
    try {
      const client = await this.getClient();
      await client.devOp(roomId, "suspend");
    } catch (e) {
      this.set({ error: message(e) });
    }
    this.set({ status: "offline", connId: null, members: [] });
    await this.refresh();
  }

  async catchup(): Promise<void> {
    await this.op("catchup");
  }

  async audit(): Promise<void> {
    await this.op("audit");
  }

  /** Push pending ops now, instead of waiting for the drain tick. */
  async drain(): Promise<void> {
    await this.op("drain");
  }

  async suspend(): Promise<void> {
    await this.op("suspend");
  }

  async resume(): Promise<void> {
    await this.op("resume");
  }

  async requestBlob(hash: string): Promise<void> {
    await this.op("blob-request", hash);
  }

  private async op(
    op: "catchup" | "audit" | "drain" | "suspend" | "resume" | "blob-request",
    hash?: string,
  ): Promise<void> {
    const roomId = this.snapshot.roomId;
    if (!roomId) return;
    try {
      const client = await this.getClient();
      // The worker logs the operation and its result, so the panel's log stays
      // one stream instead of a local one that `refresh()` would clobber.
      await client.devOp(roomId, op, hash);
    } catch (e) {
      this.set({ error: message(e) });
    }
    await this.refresh();
  }

  /** Poll the counters. The engine writes to IndexedDB, not to this store, so
   *  there is nothing to subscribe to. 1 s is fast enough to watch a catch-up
   *  land and slow enough not to matter. */
  startPolling(intervalMs = 1000): () => void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    return () => {
      if (this.pollTimer !== null) clearInterval(this.pollTimer);
      this.pollTimer = null;
    };
  }
}

/** The app's instance: the shipped singleton DB and the real worker ladder. */
export const syncStore = new SyncStore({ db: appDb });
