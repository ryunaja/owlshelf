/**
 * hooks.ts — the tab-side facade (plan §6.5).
 *
 * Tabs read through LIVE QUERIES and write through COMMANDS; they never touch
 * row tables directly. That is what makes a remote op repaint the inventory
 * without a manual refresh, and it is why `loading` is derived from "have I
 * received a first emission" rather than set from an effect.
 *
 * Three rules this file owns:
 *
 *  1. ONE tombstone predicate (`visible.ts`). Inventory, global search,
 *     category counts, location counts and stock totals all filter through
 *     it, so every view agrees by construction.
 *  2. Counts are DERIVED from live visible items, never a stored counter
 *     (audit 4.2.6): nothing to sync, no lost-update window, no remote
 *     recount drift. `Location.itemCount` no longer exists on the type.
 *  3. Command wrappers preserve the EXACT signatures `useDB`'s consumers
 *     already destructure (review-2 P1-1), and every one awaits the commit
 *     ack before resolving — so a dialog can keep the user's input on
 *     rejection instead of closing over a write that never landed.
 *
 * `error` is an `Error | null` (was `string | null`): a caller that wants to
 * branch on the cause needs the object, and `String(e)` threw the cause away.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { liveQuery } from "dexie";
import { db, ensureOpen } from "./db";
import { CommandError, type Command, type CommandAck, type MoveResult } from "./cmd";
import { getWorkerClient, type WorkerClient } from "./worker/client";
import { idbUrl, acquireMedia, parseIdbUrl, releaseMedia, subscribeMedia, type MediaState } from "./mediaUrl";
import { demandBlob } from "./blobDemand";
import { syncHealth, type HealthSnapshot } from "./syncHealth";
import { isVisible } from "./visible";
import { readRoom } from "./roomMeta";
import { META_KEYS, type Room } from "./stores";
import type { MintReply, PairingReply, RoomInfo } from "./worker/protocol";
import type { Condition, Item, ItemType, Location, LocationWithCount, Profile } from "../types/item";

// ─── Row shapes (a stored row carries the reducer-owned columns) ───────────

interface SyncColumns {
  winner?: string;
  deletedAt?: number | null;
}

type ProfileRow = Profile & SyncColumns;
type LocationRow = Location & SyncColumns;
type ItemRow = Item & SyncColumns;

/** Drop the reducer-owned columns at the facade boundary (plan §6.1). */
function stripSync<T>(row: object): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "winner" || key === "deletedAt") continue;
    out[key] = value;
  }
  return out as T;
}

// ─── Live query plumbing ───────────────────────────────────────────────────

interface LiveResult<T> {
  /** `null` until the first emission. Loading is `value === null && !error`:
   *  a failed query leaves `value` null forever, and reporting that as
   *  "loading" is what left the retry button permanently disabled. */
  value: T | null;
  error: Error | null;
}

/**
 * Subscribe to a Dexie live query, AFTER the database is open.
 *
 * `ensureOpen()` must NOT run inside the querier. It opens read-write
 * transactions (the migration), and Dexie rejects those inside a liveQuery
 * context with "Readwrite transaction in liveQuery context" — the query then
 * fails permanently, `value` stays null, and the page renders its loading
 * skeleton forever with no way to create anything. So the open happens here,
 * once, and every querier stays a pure read.
 *
 * The setState calls land in promise and subscription callbacks, which is the
 * "subscribe to an external system" shape react-hooks/set-state-in-effect
 * endorses — nothing is set synchronously in the effect body.
 */
function useLive<T>(querier: () => Promise<T>): LiveResult<T> {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let subscription: { unsubscribe: () => void } | null = null;

    ensureOpen()
      .then(() => {
        if (cancelled) return;
        subscription = liveQuery(querier).subscribe({
          next: (rows) => {
            if (cancelled) return;
            setValue(rows);
            setError(null);
          },
          error: (e: unknown) => {
            if (cancelled) return;
            setError(e instanceof Error ? e : new Error(String(e)));
            setValue(null);
          },
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setValue(null);
      });

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [querier]);

  return { value, error };
}

// ─── Command plumbing ──────────────────────────────────────────────────────

/** `Omit` over a union does not distribute; this does. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type CommandDraft = DistributiveOmit<Command, "cmdId">;

/**
 * The single writer (plan §5). `getWorkerClient` walks the ladder — SharedWorker,
 * then Web Locks + dedicated Worker + BroadcastChannel, then tab mode — once per
 * tab, and warns when the last rung means a second tab would be a second writer.
 */
async function getClient(): Promise<WorkerClient> {
  const started = await getWorkerClient();
  if (started.singleTabOnly && !warnedSingleTab) {
    warnedSingleTab = true;
    console.warn(
      "[owlshelf] single-tab mode: this browser has no SharedWorker and no Web Locks, " +
        "so a second tab would be a second writer. Keep one tab open.",
    );
  }
  return started.client;
}

let warnedSingleTab = false;

/**
 * Post one command and resolve on COMMIT. A fresh `cmdId` per call: a retry
 * that reuses one is the only way to get the original ack back, and a blind
 * retry with a new id mints a second op (§15.5).
 */
async function post(draft: CommandDraft): Promise<CommandAck> {
  const client = await getClient();
  return client.post({ ...draft, cmdId: crypto.randomUUID() } as Command);
}

async function roomOfLocation(locationId: string): Promise<string> {
  const location = await db.locations.get(locationId);
  if (!location) throw new CommandError("validation", `unknown location ${locationId}`);
  return location.profileId;
}

async function roomOfItem(itemId: string): Promise<string> {
  const item = await db.items.get(itemId);
  if (!item?.profileId) throw new CommandError("validation", `unknown item ${itemId}`);
  return item.profileId;
}

// ─── useProfiles ──────────────────────────────────────────────────────────

export interface UseProfilesResult {
  profiles: Profile[];
  loading: boolean;
  error: Error | null;
  addProfile: (data: Omit<Profile, "id">) => Promise<void>;
  /** Re-subscribes the live query, and therefore re-runs `ensureOpen`: the
   *  migration promise resets on failure, so this is the retry path after a
   *  failed open. */
  reload: () => Promise<void>;
}

export function useProfiles(): UseProfilesResult {
  const [reloadToken, setReloadToken] = useState(0);

  const querier = useCallback(async () => {
    // Reading the token is what makes the retry work: a new querier identity
    // re-subscribes the live query, and a query that already errored will
    // not retry on its own. `ensureOpen` resets its promise on failure, so
    // the re-subscribe is the retry.
    void reloadToken;
    const rows = (await db.profiles.toArray()) as unknown as ProfileRow[];
    return rows.filter(isVisible).map((row) => stripSync<Profile>(row));
  }, [reloadToken]);

  const { value, error } = useLive(querier);

  const reload = useCallback(async () => {
    setReloadToken((n) => n + 1);
  }, []);

  const addProfile = useCallback(async (data: Omit<Profile, "id">) => {
    // §6.7 create: the room and the profile row commit together, so a new
    // profile is never a roomless row (profile.id === roomId).
    const client = await getClient();
    await client.createProfile(data);
  }, []);

  return {
    profiles: value ?? [],
    loading: value === null && error === null,
    error,
    addProfile,
    reload,
  };
}

// ─── useLocations ─────────────────────────────────────────────────────────

export interface UseLocationsResult {
  locations: LocationWithCount[];
  loading: boolean;
  error: Error | null;
  addLocation: (data: Omit<Location, "id">) => Promise<LocationWithCount>;
  updateLocation: (updated: Location) => Promise<void>;
  /** Tombstones the location AND its items: the dialog promises "all items
   *  inside will be permanently deleted", and a tombstoned location with
   *  live items would leave rows nothing can reach. */
  deleteLocation: (id: string) => Promise<void>;
}

export function useLocations(profileId: string): UseLocationsResult {
  const querier = useCallback(async () => {
    const [locationRows, itemRows] = await Promise.all([
      db.locations.where("profileId").equals(profileId).toArray(),
      db.items.where("profileId").equals(profileId).toArray(),
    ]);

    const counts = new Map<string, number>();
    for (const item of itemRows as unknown as ItemRow[]) {
      if (!isVisible(item)) continue;
      counts.set(item.locationId, (counts.get(item.locationId) ?? 0) + 1);
    }

    return (locationRows as unknown as LocationRow[])
      .filter(isVisible)
      .map((row) => ({
        ...stripSync<Location>(row),
        itemCount: counts.get(row.id) ?? 0,
      }));
  }, [profileId]);

  const { value, error } = useLive(querier);

  const addLocation = useCallback(
    async (data: Omit<Location, "id">): Promise<LocationWithCount> => {
      const ack = await post({
        kind: "putLocation",
        roomId: data.profileId,
        location: { ...data },
      });
      return { ...data, id: ack.rowId, itemCount: 0 };
    },
    [],
  );

  const updateLocation = useCallback(async (updated: Location) => {
    await post({
      kind: "putLocation",
      roomId: updated.profileId,
      location: { ...updated },
    });
  }, []);

  const deleteLocation = useCallback(async (id: string) => {
    const roomId = await roomOfLocation(id);
    const items = (await db.items.where("locationId").equals(id).toArray()) as unknown as ItemRow[];
    for (const item of items) {
      if (!isVisible(item)) continue;
      await post({ kind: "deleteItem", roomId, itemId: item.id });
    }
    await post({ kind: "deleteLocation", roomId, locationId: id });
  }, []);

  return {
    locations: value ?? [],
    loading: value === null && error === null,
    error,
    addLocation,
    updateLocation,
    deleteLocation,
  };
}

// ─── useItems ─────────────────────────────────────────────────────────────

export interface NewItemData {
  name: string;
  subtitle?: string;
  description?: string;
  stock?: number;
  tags?: string[];
  category?: string;
  itemType?: ItemType;
  condition?: Condition;
  /** An existing reference carried through an edit (`idb:`, `data:`, `https:`). */
  imageUrl?: string;
  /** A freshly captured image. The hook writes the blob to `files` and stores
   *  `idb://<hash>`: a data URL cannot ride the op payload (64 KB cap). */
  image?: { bytes: Uint8Array<ArrayBuffer>; contentType: string; hash: string };
}

export interface UseItemsResult {
  items: Item[];
  loading: boolean;
  error: Error | null;
  addItem: (locationId: string, data: NewItemData) => Promise<void>;
  /** `image` is a freshly captured blob for an edit; omit it to keep the
   *  row's existing reference. */
  updateItem: (updated: Item, image?: NewItemData["image"]) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  /** Same-room moves are one put; cross-room moves are the two-op
   *  copy-then-delete (§6.4). Resolves with the destination row id.
   *  `amount` moves only that many copies, splitting the row. */
  moveItem: (
    itemId: string,
    destination: { roomId: string; locationId: string },
    amount?: number,
  ) => Promise<string>;
  /** Move a selection, reporting per item (Gate E). One bad item does not
   *  roll back the rest, so the caller can mark the failures. */
  moveItems: (
    itemIds: readonly string[],
    destination: { roomId: string; locationId: string },
    amount?: number,
  ) => Promise<MoveResult[]>;
}

export function useItems(locationId: string): UseItemsResult {
  const querier = useCallback(async () => {
    const rows = (await db.items.where("locationId").equals(locationId).toArray()) as unknown as ItemRow[];
    return rows.filter(isVisible).map((row) => stripSync<Item>(row));
  }, [locationId]);

  const { value, error } = useLive(querier);

  const addItem = useCallback(async (locId: string, data: NewItemData) => {
    const roomId = await roomOfLocation(locId);

    let imageUrl = data.imageUrl;
    if (data.image) {
      // The tab owns image capture (§5): the blob is written here, the op
      // only ever carries the content-addressed reference.
      await db.files.put({
        roomId,
        hash: data.image.hash,
        bytes: data.image.bytes,
        size: data.image.bytes.byteLength,
        contentType: data.image.contentType,
        createdAt: Date.now(),
      });
      imageUrl = idbUrl(data.image.hash);
    }

    await post({
      kind: "putItem",
      roomId,
      locationId: locId,
      item: {
        name: data.name || "Untitled",
        subtitle: data.subtitle ?? "",
        description: data.description ?? "",
        stock: data.stock ?? 1,
        tags: data.tags ?? [],
        category: data.category ?? "Uncategorized",
        itemType: data.itemType ?? "other",
        condition: data.condition ?? 3,
        ...(imageUrl ? { imageUrl } : {}),
      },
    });
  }, []);

  const updateItem = useCallback(async (updated: Item, image?: NewItemData["image"]) => {
    let imageUrl = updated.imageUrl;
    if (image) {
      await db.files.put({
        roomId: updated.profileId,
        hash: image.hash,
        bytes: image.bytes,
        size: image.bytes.byteLength,
        contentType: image.contentType,
        createdAt: Date.now(),
      });
      imageUrl = idbUrl(image.hash);
    }
    await post({
      kind: "putItem",
      roomId: updated.profileId,
      locationId: updated.locationId,
      item: { ...updated, imageUrl },
    });
  }, []);

  const deleteItem = useCallback(async (id: string) => {
    const roomId = await roomOfItem(id);
    await post({ kind: "deleteItem", roomId, itemId: id });
  }, []);

  const moveItem = useCallback(
    async (
      itemId: string,
      destination: { roomId: string; locationId: string },
      amount?: number,
    ) => {
      const roomId = await roomOfItem(itemId);
      const ack = await post({ kind: "moveItem", roomId, itemId, destination, amount });
      return ack.rowId;
    },
    [],
  );

  const moveItems = useCallback(
    async (
      itemIds: readonly string[],
      destination: { roomId: string; locationId: string },
      amount?: number,
    ) => {
      if (itemIds.length === 0) return [];
      // Every item in a selection comes from the same shelf, so one room
      // lookup covers the batch.
      const roomId = await roomOfItem(itemIds[0]);
      const client = await getClient();
      return client.moveMany({
        cmdId: crypto.randomUUID(),
        roomId,
        itemIds,
        destination,
        amount,
      });
    },
    [],
  );

  return {
    items: value ?? [],
    loading: value === null && error === null,
    error,
    addItem,
    updateItem,
    deleteItem,
    moveItem,
    moveItems,
  };
}

// ─── useSearch ────────────────────────────────────────────────────────────

export interface SearchResult extends Item {
  locationName: string;
  locationIcon: string;
  location: Location;
}

export interface UseSearchResult {
  items: SearchResult[];
  loading: boolean;
  error: Error | null;
}

/**
 * Global search over one room, as a LIVE query — a remote op repaints the
 * results instead of leaving a stale list until the next mount. Items whose
 * location is tombstoned are dropped: a result you cannot navigate to is
 * worse than no result.
 */
export function useSearch(profileId: string): UseSearchResult {
  const querier = useCallback(async () => {
    const [locationRows, itemRows] = await Promise.all([
      db.locations.where("profileId").equals(profileId).toArray(),
      db.items.where("profileId").equals(profileId).toArray(),
    ]);

    const locations = new Map<string, Location>();
    for (const row of locationRows as unknown as LocationRow[]) {
      if (isVisible(row)) locations.set(row.id, stripSync<Location>(row));
    }

    const out: SearchResult[] = [];
    for (const row of itemRows as unknown as ItemRow[]) {
      if (!isVisible(row)) continue;
      const location = locations.get(row.locationId);
      if (!location) continue;
      out.push({
        ...stripSync<Item>(row),
        locationName: location.name,
        locationIcon: location.icon,
        location,
      });
    }
    return out;
  }, [profileId]);

  const { value, error } = useLive(querier);
  return { items: value ?? [], loading: value === null && error === null, error };
}

// ─── useMediaSrc ──────────────────────────────────────────────────────────

/**
 * Resolve a stored `imageUrl` to something an `<img>` can load.
 *
 * `idb://` needs the room as well as the hash (review-2 P1-3), so callers
 * pass the owning row's `profileId`. Every other scheme is returned as-is;
 * the render allowlist in `media.ts` is what keeps a `file://` or
 * `javascript:` value out of the DOM.
 *
 * A `missing` answer is not final: the row may have synced from a peer whose
 * bytes have not arrived yet, so it triggers a demand (§6.6) and the hook
 * re-resolves when `invalidateMedia` reports the blob landed. Without both
 * halves the image stayed missing until a reload — the transfer code existed
 * but nothing asked and nothing re-read.
 */
export function useMediaSrc(imageUrl: string | undefined, roomId: string): MediaState {
  const hash = parseIdbUrl(imageUrl);
  const [resolved, setResolved] = useState<{ hash: string; state: MediaState } | null>(null);
  const [generation, setGeneration] = useState(0);

  // Re-resolve when this exact blob changes. Keyed on the pair, so a card
  // showing room A's cover is not woken by room B's.
  useEffect(() => {
    if (!hash) return;
    return subscribeMedia((changedRoom, changedHash) => {
      if (changedRoom === roomId && changedHash === hash) setGeneration((n) => n + 1);
    });
  }, [hash, roomId]);

  useEffect(() => {
    if (!hash) return;
    let cancelled = false;
    void acquireMedia(db, roomId, hash).then((state) => {
      if (cancelled) return;
      setResolved({ hash, state });
      // Demand AFTER the local read, never before: a blob we already hold
      // must not cost a round trip.
      if (state.status === "missing") demandBlob(roomId, hash);
    });
    return () => {
      cancelled = true;
      releaseMedia(roomId, hash);
    };
  }, [hash, roomId, generation]);

  if (!hash) {
    return imageUrl ? { status: "ready", url: imageUrl } : { status: "missing" };
  }
  return resolved && resolved.hash === hash ? resolved.state : { status: "loading" };
}

// ─── Pairing and shared shelves (§6.7) ────────────────────────────────────
//
// The rule from §5 is unchanged: tabs READ, the worker WRITES. A join, a
// re-pair, a revoke and a leave are all writes (plus `getDeviceId`, which mints
// on first call), so they travel as worker requests; what the screens need to
// RENDER — the roster, the generation, the rotation flag — is read here.

export interface RoomSummary {
  roomId: string;
  keyGen: number;
  /** Everyone the roster knows, including this device. */
  memberCount: number;
  /** A signed `rotate-key` notice arrived and this room has moved on. */
  rotationPending: number | null;
  /** A verified `rehome` op is waiting for the user's consent. */
  pendingRelayUrl: string | null;
}

/**
 * Every room record, for the profile list.
 *
 * A room with `memberCount > 1` is a shared shelf, and the card says so. The
 * OWNER/member distinction is deliberately NOT computed here: `role` is data,
 * and answering "am I the owner" honestly needs `getDeviceId`, which is a write
 * the tab cannot do. The share screen asks the worker instead.
 */
export function useRooms(): { rooms: RoomSummary[]; loading: boolean; error: Error | null } {
  const querier = useCallback(async () => {
    const keys = (await db.meta
      .where("key")
      .startsWith(META_KEYS.roomPrefix)
      .primaryKeys()) as string[];
    const rows = await Promise.all(keys.map((key) => db.meta.get(key)));
    return rows
      .filter((row) => row !== undefined)
      .map((row) => row as unknown as Room)
      .filter((room) => typeof room.roomId === "string")
      .map((room) => ({
        roomId: room.roomId,
        keyGen: room.keyGen,
        memberCount: room.roster?.length ?? 0,
        rotationPending: room.rotationPending ?? null,
        pendingRelayUrl: room.pendingRelayUrl ?? null,
      }));
  }, []);

  const { value, error } = useLive(querier);
  return { rooms: value ?? [], loading: value === null && error === null, error };
}

export interface RoomInfoState {
  /** The live room record. Rotation and rehome flags arrive through control
   *  ops, so this half must be a live query, not a poll. */
  room: Room | null;
  /** Device id, ownership, engine status and op count. `null` until answered. */
  info: RoomInfo | null;
  error: Error | null;
}

/**
 * Live room record + worker-side facts.
 *
 * `pollMs` exists because the worker half is a request/response: a status
 * change (`connecting` → `synced`) or an op count is not a database write, so
 * nothing pushes it. The share screen polls while it is open; the rotation gate
 * does not, because its whole state is in the live room record.
 */
export function useRoomInfo(roomId: string | null, pollMs = 0): RoomInfoState {
  const querier = useCallback(async () => {
    if (!roomId) return null;
    return (await readRoom(db, roomId)) ?? null;
  }, [roomId]);

  const { value } = useLive(querier);
  const [info, setInfo] = useState<RoomInfo | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const ask = () => {
      void getClient()
        .then((client) => client.roomInfo(roomId))
        .then((next) => {
          if (cancelled) return;
          setInfo(next);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        })
        .finally(() => {
          if (cancelled || pollMs <= 0) return;
          timer = setTimeout(ask, pollMs);
        });
    };
    ask();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [roomId, pollMs]);

  return { room: value ?? null, info, error };
}

/**
 * The pairing actions, as the worker sees them.
 *
 * Returned refusals are VALUES: an invite is untrusted input, and the dialog
 * needs the reason to pick the sentence (`pairingErrors.ts`). Only a transport
 * failure (a closed port, a dead worker) throws.
 */
export const pairing = {
  mint: (roomId: string): Promise<MintReply> =>
    getClient().then((client) => client.mintInvite(roomId)),
  join: (text: string, name?: string): Promise<PairingReply> =>
    getClient().then((client) => client.joinRoom(text, name)),
  adopt: (text: string): Promise<PairingReply> =>
    getClient().then((client) => client.adoptRotation(text)),
  revoke: (roomId: string, deviceId: string): Promise<PairingReply> =>
    getClient().then((client) => client.revokeDevice(roomId, deviceId)),
  leave: (roomId: string): Promise<void> =>
    getClient().then((client) => client.leaveRoom(roomId)),
  /** Accept or ignore a staged relay move (§6.7's trust prompt). */
  rehome: (roomId: string, accept: boolean): Promise<void> =>
    getClient().then((client) => client.resolveRehome(roomId, accept)),
};

// ─── Sync health (the badge §6.6 asks for) ────────────────────────────────

/**
 * The watchable health of one shelf, from the worker's own event stream.
 *
 * Deliberately NOT `useState` plus an effect: the value lives in a shared store
 * (`syncHealth.ts`) because every mounted surface must agree, and because the
 * event that changes it can arrive while no dialog is open. A `useState`
 * version would have each component subscribe separately and each miss the
 * events that fired before it mounted.
 */
export function useSyncHealth(roomId: string | null): HealthSnapshot | null {
  const subscribe = useCallback(
    (onChange: () => void) => syncHealth.subscribe(onChange),
    [],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (roomId === null ? null : syncHealth.get(roomId)),
    () => null,
  );

  useEffect(() => {
    if (roomId !== null) void syncHealth.refresh(roomId);
  }, [roomId]);

  return snapshot;
}

/** "Try again" for a failed shelf. Resolves when the worker has dialled. */
export function retrySync(roomId: string): Promise<void> {
  return syncHealth.retry(roomId);
}
