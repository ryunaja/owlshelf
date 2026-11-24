/**
 * syncRuntime.ts — the app's sync host: it tells the worker which rooms to sync.
 *
 * Plan §7.1's trigger map, executed:
 *
 *   | App open / worker restart        | resume outbox, then catch up ALL rooms |
 *   | Tab visible (`visibilitychange`) | resync all rooms                       |
 *   | Window `online`                  | resync all rooms                       |
 *   | `pageshow` with `persisted`      | resync all rooms                       |
 *
 * Before this module the engine had exactly one call site — the dev panel
 * behind `?sync=1` — so a normal page load never opened a socket. Sync was
 * implemented, tested, and unreachable.
 *
 * ── What changed when the engine moved into the worker ────────────────────
 *
 * This module used to CONSTRUCT engines. It no longer does, and that is the
 * whole point: `syncRuntime` ran in every tab, so N tabs meant N sockets per
 * room, and the relay's `conns_per_ip = 3` counts across all rooms — two tabs
 * with two profiles already hit the cap.
 *
 * Now it is a client of the plan's own port protocol (§6.6):
 *
 *  - `room-add` for every `room:` meta row, and for every new one a liveQuery
 *    reports. The worker reference-counts these per port, so this tab
 *    unmounting cannot stop an engine another tab is still using.
 *  - `visibility {hidden: false}` for §7.1's three resume triggers. That IS
 *    the resync — the plan has no separate message for it, and inventing one
 *    would have been a divergence.
 *  - `blob-arrived` back, which invalidates this tab's media cache. That used
 *    to happen only when the dev panel was open; it now happens on every page.
 *
 * The room LIST is still read here, because §5 gives tabs reads. Only the
 * engine moved.
 *
 * Instance-scoped on purpose (same rule as `roomMeta.ts`): the app passes the
 * `db` singleton, the harness passes an isolated database and a fake client,
 * and both run this exact code. `syncRuntime` is the app's instance.
 */

import { liveQuery } from "dexie";
import { db as appDb } from "@/lib/db";
import { getWorkerClient, type WorkerClient } from "@/lib/worker/client";
import { clearBlobDemand, registerBlobFetcher } from "@/lib/blobDemand";
import { invalidateMedia } from "@/lib/mediaUrl";
import type { OwlshelfDB } from "@/lib/db";
import type { Room } from "@/lib/stores";

export interface SyncRuntimeDeps {
  db: OwlshelfDB;
  /** Test seam: the writer. Production walks the ladder in `getWorkerClient`. */
  getClient?: () => Promise<WorkerClient>;
  /** Test seam: the event target. Defaults to `globalThis`. */
  events?: EventTarget | null;
}

/** The three §7.1 resume triggers, as one list so a listener cannot be added
 *  without a matching removal. */
const RESUME_EVENTS = ["visibilitychange", "online", "pageshow"] as const;

export class SyncRuntime {
  private readonly db: OwlshelfDB;
  private readonly getClient: () => Promise<WorkerClient>;
  private readonly events: EventTarget | null;

  private client: WorkerClient | null = null;
  private subscription: { unsubscribe: () => void } | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private unregisterBlobFetcher: (() => void) | null = null;
  private unsubscribePromote: (() => void) | null = null;
  /** Rooms this tab has asked the worker to sync. Named `wanted` rather than
   *  `rooms` so it cannot shadow the public getter of that name. */
  private readonly wanted = new Set<string>();
  private started = false;
  /** Bumped by every `start()`/`stop()`. An async `start()` that resolves after
   *  a `stop()` must not install anything — React StrictMode runs exactly that
   *  sequence in development. */
  private generation = 0;

  constructor(deps: SyncRuntimeDeps) {
    this.db = deps.db;
    this.getClient = deps.getClient ?? (async () => (await getWorkerClient()).client);
    this.events = deps.events === undefined ? globalThis : deps.events;
  }

  /** Room ids this tab has handed to the worker. Read-only, for tests. */
  get rooms(): string[] {
    return [...this.wanted];
  }

  /**
   * Hand every room to the worker, then keep watching for new ones.
   *
   * Idempotent: a second call while running is a no-op, so a re-render cannot
   * double the reference counts.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const generation = ++this.generation;

    try {
      const client = await this.getClient();
      if (generation !== this.generation) return;
      this.client = client;

      // The bytes arrived, so every mounted consumer must re-read: a cached
      // `missing` would otherwise outlive the arrival and the image would stay
      // blank until a reload.
      this.unsubscribeEvents = client.onEvent((event) => {
        if (event.kind !== "blob-arrived") return;
        invalidateMedia(event.roomId, event.hash);
        clearBlobDemand(event.roomId, event.hash);
      });

      // The pull side of media sync (§6.6). `useMediaSrc` cannot import the
      // engine — that would drag the sync stack into every page with a
      // thumbnail — so it publishes a demand and this answers it.
      this.unregisterBlobFetcher = registerBlobFetcher((roomId, hash) => {
        void client.demandBlob(roomId, hash);
      });

      // Rung 2 only: the leader owns a dedicated worker, so a handoff gives the
      // new leader a host with an empty engine map. Every room this tab wants
      // has to be re-announced or the engines are silently lost.
      this.unsubscribePromote = client.onPromote(() => {
        for (const roomId of this.wanted) {
          void client.roomAdd(roomId).catch(() => undefined);
        }
      });

      const rooms = await this.readRooms();
      if (generation !== this.generation) return;
      for (const room of rooms) await this.add(room.roomId);

      // A profile created after boot must not need a reload. `createProfile`
      // writes the room into `meta`, so a live query is the whole subscription.
      this.subscription = liveQuery(() => this.readRooms()).subscribe({
        next: (next) => {
          if (generation !== this.generation) return;
          const present = new Set(next.map((room) => room.roomId));
          for (const room of next) {
            if (!this.wanted.has(room.roomId)) void this.add(room.roomId);
          }
          // A room REMOVED from `meta` must stop syncing in this tab too. The
          // only writer that deletes one is a leave (§15.17), and without this
          // the engine keeps dialling a room whose key has just been purged —
          // visible as a reconnect loop after "leave", and as a `room-add` that
          // fails forever if the app is reopened from a live query snapshot.
          for (const roomId of [...this.wanted]) {
            if (present.has(roomId)) continue;
            this.wanted.delete(roomId);
            void this.client?.roomRemove(roomId).catch(() => undefined);
          }
        },
        error: () => {
          /* a failed read leaves the running engines alone */
        },
      });

      for (const name of RESUME_EVENTS) {
        this.events?.addEventListener(name, this.handleResume);
      }
    } catch {
      // A blocked or mid-upgrade database is not a sync failure — the app has
      // its own banner for that (§12.6). Leave `started` false so the next
      // call retries instead of pinning the app offline forever.
      if (generation === this.generation) this.started = false;
    }
  }

  /** Release every room and drop every listener. Safe to call when not started. */
  stop(): void {
    this.started = false;
    this.generation += 1;
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.unregisterBlobFetcher?.();
    this.unregisterBlobFetcher = null;
    this.unsubscribePromote?.();
    this.unsubscribePromote = null;
    for (const name of RESUME_EVENTS) {
      this.events?.removeEventListener(name, this.handleResume);
    }

    const client = this.client;
    this.client = null;
    const rooms = [...this.wanted];
    this.wanted.clear();
    if (!client) return;
    // Fire and forget: `stop()` is called from an effect cleanup, which cannot
    // await. The worker reference-counts, so a failed release only means the
    // engine outlives this tab — never that it stops under another one.
    for (const roomId of rooms) {
      void client.roomRemove(roomId).catch(() => undefined);
    }
  }

  /** §7.1's "resync all rooms". Public so a caller can force it (the harness
   *  does). Sends `visibility {hidden: false}`, which is the plan's resume
   *  trigger — there is no separate message for it. */
  resyncAll(): void {
    this.client?.setVisibility(false);
  }

  private readonly handleResume = (): void => {
    // `visibilitychange` fires on the way OUT too, and resyncing a hidden tab
    // is wasted work — the engine's own `suspend()` is what handles that.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    this.resyncAll();
  };

  /** Every `room:` meta row.
   *
   *  Indexed, not `toArray().filter()`: `meta` also holds `cmd:` idempotency
   *  records and `idmap:` rows, and this runs on every write to `meta` — which
   *  includes every cursor advance the engines make. */
  private async readRooms(): Promise<Room[]> {
    const rows = await this.db.meta.where("key").startsWith("room:").toArray();
    return rows.map((row) => row as unknown as Room);
  }

  private async add(roomId: string): Promise<void> {
    if (this.wanted.has(roomId)) return;
    // Added before the await so two liveQuery emissions cannot both send it.
    this.wanted.add(roomId);
    const client = this.client;
    if (!client) return;
    try {
      await client.roomAdd(roomId);
    } catch {
      // A room that vanished between the read and the add is not a sync
      // failure; forget it so a later emission can retry.
      this.wanted.delete(roomId);
    }
  }
}

/** The app's instance. `App.tsx` starts it once on mount. */
export const syncRuntime = new SyncRuntime({ db: appDb });
