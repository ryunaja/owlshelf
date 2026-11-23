/**
 * React hooks for accessing Owlshelf's IndexedDB stores.
 *
 * useProfiles()          – read profiles; add a profile
 * useLocations(id)       – read locations for a profile; add a location
 * useItems(id)           – read items for a location; add / update / delete
 *
 * `loading` is DERIVED from "do I hold rows for the current key", never set
 * from the effect. A synchronous `setLoading(true)` inside `useEffect` is a
 * cascading render (react-hooks/set-state-in-effect), and the keyed shape
 * also fixes a real bug: a read that resolves after the id changed used to
 * paint the previous profile's rows under the new one.
 */

import { useState, useEffect, useCallback } from "react";
import {
  profilesDB,
  locationsDB,
  itemsDB,
} from "@/lib/database";
import type { Profile, Location, Item, Condition, ItemType } from "@/types/item";

// ─── helpers ──────────────────────────────────────────────────────────────

function nanoid(): string {
  return Math.random().toString(36).slice(2, 9);
}

/** Rows plus the key they were read for. `null` means "no read yet". */
interface ReadState<T> {
  key: string;
  rows: T[];
}

/** Rows for `key`, or `null` while the read for that key is outstanding. */
function rowsFor<T>(state: ReadState<T> | null, key: string): T[] | null {
  return state !== null && state.key === key ? state.rows : null;
}

// ─── useProfiles ──────────────────────────────────────────────────────────

interface UseProfilesResult {
  profiles: Profile[];
  loading: boolean;
  error: string | null;
  addProfile: (data: Omit<Profile, "id">) => Promise<void>;
  /** Re-runs the read, and therefore `ensureOpen`: the migration promise
   *  resets on failure, so this is the retry path after a failed open. */
  reload: () => Promise<void>;
}

export function useProfiles(): UseProfilesResult {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The read is an external-system subscription, so the state lands in the
  // promise callback — the shape react-hooks/set-state-in-effect endorses.
  // It cannot see through `async`/`await`, so the equivalent async form is
  // reported even though the setState calls are equally deferred.
  const load = useCallback(
    () =>
      profilesDB.getAll().then(
        (rows) => {
          setProfiles(rows);
          setError(null);
        },
        (e: unknown) => {
          setError(String(e));
          // Stop the spinner: without rows the page would wait forever.
          setProfiles([]);
        },
      ),
    [],
  );

  useEffect(() => { void load(); }, [load]);

  const reload = useCallback(async () => {
    setProfiles(null);
    await load();
  }, [load]);

  const addProfile = useCallback(async (data: Omit<Profile, "id">) => {
    // The facade mints the room and the profile row in one transaction
    // (profile.id === roomId, plan §6.7) — never a roomless profile.
    const profile = await profilesDB.create(data);
    setProfiles((prev) => [...(prev ?? []), profile]);
  }, []);

  return {
    profiles: profiles ?? [],
    loading: profiles === null,
    error,
    addProfile,
    reload,
  };
}

// ─── useLocations ─────────────────────────────────────────────────────────

interface UseLocationsResult {
  locations: Location[];
  loading: boolean;
  error: string | null;
  addLocation: (data: Omit<Location, "id" | "itemCount">) => Promise<Location>;
  updateLocation: (updated: Location) => Promise<void>;
  deleteLocation: (id: string) => Promise<void>;
}

export function useLocations(profileId: string): UseLocationsResult {
  const [state, setState] = useState<ReadState<Location> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      locationsDB.getByProfile(profileId).then(
        (rows) => {
          setState({ key: profileId, rows });
          setError(null);
        },
        (e: unknown) => {
          setError(String(e));
          setState({ key: profileId, rows: [] });
        },
      ),
    [profileId],
  );

  useEffect(() => { void load(); }, [load]);

  const rows = rowsFor(state, profileId);

  const setRows = useCallback(
    (update: (rows: Location[]) => Location[]) => {
      setState((prev) => ({
        key: profileId,
        rows: update(rowsFor(prev, profileId) ?? []),
      }));
    },
    [profileId],
  );

  const addLocation = useCallback(
    async (data: Omit<Location, "id" | "itemCount">) => {
      const loc: Location = {
        id: `loc-${nanoid()}`,
        itemCount: 0,
        ...data,
      };
      await locationsDB.put(loc);
      setRows((prev) => [...prev, loc]);
      return loc;
    },
    [setRows]
  );

  const updateLocation = useCallback(async (updated: Location) => {
    await locationsDB.put(updated);
    setRows((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
  }, [setRows]);

  const deleteLocation = useCallback(async (id: string) => {
    await locationsDB.delete(id);
    setRows((prev) => prev.filter((l) => l.id !== id));
  }, [setRows]);

  return {
    locations: rows ?? [],
    loading: rows === null,
    error,
    addLocation,
    updateLocation,
    deleteLocation,
  };
}

// ─── useItems ─────────────────────────────────────────────────────────────

interface NewItemData {
  name: string;
  subtitle?: string;
  description?: string;
  stock?: number;
  tags?: string[];
  category?: string;
  itemType?: ItemType;
  condition?: Condition;
  imageUrl?: string;
}

interface UseItemsResult {
  items: Item[];
  loading: boolean;
  error: string | null;
  addItem: (locationId: string, data: NewItemData) => Promise<void>;
  updateItem: (updated: Item) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
}

export function useItems(locationId: string): UseItemsResult {
  const [state, setState] = useState<ReadState<Item> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      itemsDB.getByLocation(locationId).then(
        (rows) => {
          setState({ key: locationId, rows });
          setError(null);
        },
        (e: unknown) => {
          setError(String(e));
          setState({ key: locationId, rows: [] });
        },
      ),
    [locationId],
  );

  useEffect(() => { void load(); }, [load]);

  const rows = rowsFor(state, locationId);

  const setRows = useCallback(
    (update: (rows: Item[]) => Item[]) => {
      setState((prev) => ({
        key: locationId,
        rows: update(rowsFor(prev, locationId) ?? []),
      }));
    },
    [locationId],
  );

  const addItem = useCallback(async (locId: string, data: NewItemData) => {
    const item: Item = {
      id: `item-${nanoid()}`,
      locationId: locId,
      name: data.name || "Untitled",
      subtitle: data.subtitle ?? "",
      description: data.description ?? "",
      stock: data.stock ?? 1,
      tags: data.tags ?? [],
      category: data.category ?? "Uncategorized",
      itemType: data.itemType ?? "other",
      condition: data.condition ?? 3,
      imageUrl: data.imageUrl,
    };
    await itemsDB.put(item);

    // Update location count
    const loc = await locationsDB.get(locId);
    if (loc) {
      loc.itemCount++;
      await locationsDB.put(loc);
    }

    setRows((prev) => [...prev, item]);
  }, [setRows]);

  const updateItem = useCallback(async (updated: Item) => {
    await itemsDB.put(updated);
    setRows((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
  }, [setRows]);

  const deleteItem = useCallback(async (id: string) => {
    const item = await itemsDB.get(id);
    if (item) {
      const loc = await locationsDB.get(item.locationId);
      if (loc) {
        loc.itemCount = Math.max(0, loc.itemCount - 1);
        await locationsDB.put(loc);
      }
    }
    await itemsDB.delete(id);
    setRows((prev) => prev.filter((i) => i.id !== id));
  }, [setRows]);

  return {
    items: rows ?? [],
    loading: rows === null,
    error,
    addItem,
    updateItem,
    deleteItem,
  };
}
