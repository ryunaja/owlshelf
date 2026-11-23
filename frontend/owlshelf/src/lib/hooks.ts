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

import { useCallback, useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { createProfile, db, ensureOpen } from "./db";
import { CommandError, executeCommand, type Command, type CommandAck } from "./cmd";
import { idbUrl, acquireMedia, parseIdbUrl, releaseMedia, type MediaState } from "./mediaUrl";
import { isVisible } from "./visible";
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
  /** `null` until the first emission — that IS the loading state. */
  value: T | null;
  error: Error | null;
}

/**
 * Subscribe to a Dexie live query. The setState calls land in the
 * subscription callbacks, which is the "subscribe to an external system"
 * shape react-hooks/set-state-in-effect endorses — nothing is set
 * synchronously in the effect body.
 */
function useLive<T>(querier: () => Promise<T>): LiveResult<T> {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const subscription = liveQuery(querier).subscribe({
      next: (rows) => {
        setValue(rows);
        setError(null);
      },
      error: (e: unknown) => {
        setError(e instanceof Error ? e : new Error(String(e)));
        setValue(null);
      },
    });
    return () => subscription.unsubscribe();
  }, [querier]);

  return { value, error };
}

// ─── Command plumbing ──────────────────────────────────────────────────────

/** `Omit` over a union does not distribute; this does. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type CommandDraft = DistributiveOmit<Command, "cmdId">;

/**
 * Post one command and resolve on COMMIT. A fresh `cmdId` per call: a retry
 * that reuses one is the only way to get the original ack back, and a blind
 * retry with a new id mints a second op (§15.5).
 */
async function post(draft: CommandDraft): Promise<CommandAck> {
  await ensureOpen();
  return executeCommand(db, { ...draft, cmdId: crypto.randomUUID() } as Command);
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
    await ensureOpen();
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
    await createProfile(data);
  }, []);

  return {
    profiles: value ?? [],
    loading: value === null,
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
    await ensureOpen();
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
    loading: value === null,
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
   *  copy-then-delete (§6.4). Resolves with the destination row id. */
  moveItem: (
    itemId: string,
    destination: { roomId: string; locationId: string },
  ) => Promise<string>;
}

export function useItems(locationId: string): UseItemsResult {
  const querier = useCallback(async () => {
    await ensureOpen();
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
    async (itemId: string, destination: { roomId: string; locationId: string }) => {
      const roomId = await roomOfItem(itemId);
      const ack = await post({ kind: "moveItem", roomId, itemId, destination });
      return ack.rowId;
    },
    [],
  );

  return {
    items: value ?? [],
    loading: value === null,
    error,
    addItem,
    updateItem,
    deleteItem,
    moveItem,
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
    await ensureOpen();
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
  return { items: value ?? [], loading: value === null, error };
}

// ─── useMediaSrc ──────────────────────────────────────────────────────────

/**
 * Resolve a stored `imageUrl` to something an `<img>` can load.
 *
 * `idb://` needs the room as well as the hash (review-2 P1-3), so callers
 * pass the owning row's `profileId`. Every other scheme is returned as-is;
 * the render allowlist in `media.ts` is what keeps a `file://` or
 * `javascript:` value out of the DOM.
 */
export function useMediaSrc(imageUrl: string | undefined, roomId: string): MediaState {
  const hash = parseIdbUrl(imageUrl);
  const [resolved, setResolved] = useState<{ hash: string; state: MediaState } | null>(null);

  useEffect(() => {
    if (!hash) return;
    let cancelled = false;
    void acquireMedia(db, roomId, hash).then((state) => {
      if (!cancelled) setResolved({ hash, state });
    });
    return () => {
      cancelled = true;
      releaseMedia(roomId, hash);
    };
  }, [hash, roomId]);

  if (!hash) {
    return imageUrl ? { status: "ready", url: imageUrl } : { status: "missing" };
  }
  return resolved && resolved.hash === hash ? resolved.state : { status: "loading" };
}
