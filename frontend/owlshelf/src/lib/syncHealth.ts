/**
 * syncHealth.ts — the app-wide answer to "is this shelf actually syncing?".
 *
 * Before this, the ONLY place a close code surfaced was the dev panel behind
 * `?sync=1`. A user saw a shelf that stopped updating and had nothing to read:
 * the engine retried quietly, the badge state §6.6 asks for was never rendered,
 * and every failure looked like the app being broken.
 *
 * The store is a single subscription to the worker's event stream, not one per
 * component: `sync-status` already fires on every transition, and N components
 * each polled `room-info` would put N requests on the single writer for a
 * number that one event already carries.
 *
 * `refresh()` exists for the cold case — a tab that loads *after* the failure
 * happened has missed the event, so the first subscriber asks once per room.
 */

import { getWorkerClient, type WorkerClient } from "@/lib/worker/client";
import { healthOf, type SyncHealth } from "@/lib/syncErrors";
import type { SyncStatus } from "@/lib/sync";
import type { WorkerEvent } from "@/lib/worker/protocol";

export interface HealthSnapshot extends SyncHealth {
  roomId: string;
  status: SyncStatus;
  peers: readonly string[];
  running: boolean;
  lastClose: { code: number; reason: string } | null;
}

const UNKNOWN: Omit<HealthSnapshot, "roomId"> = {
  status: "offline",
  peers: [],
  running: false,
  lastClose: null,
  tone: "busy",
  label: "Not connected yet",
  detail: "This device has not opened a connection for this shelf.",
  trouble: null,
};

export interface SyncHealthStore {
  subscribe(listener: () => void): () => void;
  /** Cached snapshot; stable between changes so `useSyncExternalStore` is happy. */
  get(roomId: string): HealthSnapshot;
  /** Ask the worker once. Safe to call repeatedly. */
  refresh(roomId: string): Promise<void>;
  /** Retry a failed shelf, then re-read its state. */
  retry(roomId: string): Promise<void>;
  /** Drop the cached state and the event subscription. */
  dispose(): void;
  /** The number of live listeners — the harness asserts the leak-free path. */
  listenerCount(): number;
}

export interface SyncHealthDeps {
  getClient?: () => Promise<WorkerClient>;
}

function snapshotOf(
  roomId: string,
  status: SyncStatus,
  peers: readonly string[],
  running: boolean,
  lastClose: { code: number; reason: string } | null,
): HealthSnapshot {
  return {
    roomId,
    status,
    peers,
    running,
    lastClose,
    ...healthOf(status, lastClose, peers, running),
  };
}

/**  resolves to the ladder's StartedClient; the port is on it. */
async function defaultClient(): Promise<WorkerClient> {
  const started = await getWorkerClient();
  return started.client;
}

export function createSyncHealthStore(deps: SyncHealthDeps = {}): SyncHealthStore {
  const getClient = deps.getClient ?? defaultClient;

  const snapshots = new Map<string, HealthSnapshot>();
  const listeners = new Set<() => void>();
  const asked = new Set<string>();
  /** `get` must return a STABLE reference between changes, or
   *  `useSyncExternalStore` re-renders forever. */
  const unknown = new Map<string, HealthSnapshot>();

  let unsubscribeEvents: (() => void) | null = null;
  /** Serialises the event subscription so two mounts do not attach twice. */
  let wiring: Promise<void> | null = null;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function set(roomId: string, next: HealthSnapshot): void {
    const previous = snapshots.get(roomId);
    if (
      previous !== undefined &&
      previous.status === next.status &&
      previous.running === next.running &&
      previous.label === next.label &&
      previous.detail === next.detail &&
      previous.tone === next.tone &&
      previous.lastClose?.code === next.lastClose?.code &&
      previous.lastClose?.reason === next.lastClose?.reason &&
      previous.peers.length === next.peers.length
    ) {
      return;
    }
    snapshots.set(roomId, next);
    emit();
  }

  async function ensureWired(): Promise<void> {
    if (wiring !== null) {
      await wiring;
      return;
    }
    wiring = (async () => {
      try {
        const client = await getClient();
        unsubscribeEvents = client.onEvent((event: WorkerEvent) => {
          if (event.kind !== "sync-status") return;
          const current = snapshots.get(event.roomId);
          set(
            event.roomId,
            snapshotOf(
              event.roomId,
              event.status,
              current?.peers ?? [],
              true,
              event.lastClose ?? current?.lastClose ?? null,
            ),
          );
        });
      } catch {
        // The worker is not up yet. The next `refresh` asks again; the store
        // must never become a place where a boot race throws into React.
        wiring = null;
      }
    })();
    await wiring;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      void ensureWired();
      return () => {
        listeners.delete(listener);
      };
    },

    get(roomId) {
      const known = snapshots.get(roomId);
      if (known !== undefined) return known;
      const cached = unknown.get(roomId);
      if (cached !== undefined) return cached;
      const fresh: HealthSnapshot = { ...UNKNOWN, roomId };
      unknown.set(roomId, fresh);
      return fresh;
    },

    async refresh(roomId) {
      await ensureWired();
      try {
        const client = await getClient();
        const info = await client.roomInfo(roomId);
        asked.add(roomId);
        set(
          roomId,
          snapshotOf(roomId, info.status, info.peers, info.running, info.lastClose),
        );
      } catch {
        // A closed worker or a purged room: leave the last known state alone.
        // Replacing it with an error would invent a failure the worker never
        // reported.
      }
    },

    async retry(roomId) {
      const client = await getClient();
      await client.syncRetry(roomId);
      // `resume()` flips the status synchronously in the worker, so the event
      // may arrive before this read; refreshing anyway covers a dropped event.
      await this.refresh(roomId);
    },

    listenerCount() {
      return listeners.size;
    },

    dispose() {
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      wiring = null;
      asked.clear();
      listeners.clear();
      snapshots.clear();
    },
  };
}

/** The app's instance. Tests build their own with `createSyncHealthStore`. */
export const syncHealth: SyncHealthStore = createSyncHealthStore();
