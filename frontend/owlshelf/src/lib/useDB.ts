/**
 * React hooks for accessing Owlshelf's IndexedDB stores.
 *
 * useProfiles()          – read profiles; add a profile
 * useLocations(id)       – read locations for a profile; add a location
 * useItems(id)           – read items for a location; add / update / delete
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

// ─── useProfiles ──────────────────────────────────────────────────────────

interface UseProfilesResult {
  profiles: Profile[];
  loading: boolean;
  error: string | null;
  addProfile: (data: Omit<Profile, "id">) => Promise<void>;
}

export function useProfiles(): UseProfilesResult {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setProfiles(await profilesDB.getAll());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addProfile = useCallback(async (data: Omit<Profile, "id">) => {
    const profile: Profile = { id: `profile-${nanoid()}`, ...data };
    await profilesDB.put(profile);
    setProfiles((prev) => [...prev, profile]);
  }, []);

  return { profiles, loading, error, addProfile };
}

// ─── useLocations ─────────────────────────────────────────────────────────

interface UseLocationsResult {
  locations: Location[];
  loading: boolean;
  error: string | null;
  addLocation: (data: Omit<Location, "id" | "itemCount">) => Promise<Location>;
  deleteLocation: (id: string) => Promise<void>;
}

export function useLocations(profileId: string): UseLocationsResult {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLocations(await locationsDB.getByProfile(profileId));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => { load(); }, [load]);

  const addLocation = useCallback(
    async (data: Omit<Location, "id" | "itemCount">) => {
      const loc: Location = {
        id: `loc-${nanoid()}`,
        itemCount: 0,
        ...data,
      };
      await locationsDB.put(loc);
      setLocations((prev) => [...prev, loc]);
      return loc;
    },
    []
  );

  const deleteLocation = useCallback(async (id: string) => {
    await locationsDB.delete(id);
    setLocations((prev) => prev.filter((l) => l.id !== id));
  }, []);

  return { locations, loading, error, addLocation, deleteLocation };
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
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setItems(await itemsDB.getByLocation(locationId));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [locationId]);

  useEffect(() => { load(); }, [load]);

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
    setItems((prev) => [...prev, item]);
  }, []);

  const updateItem = useCallback(async (updated: Item) => {
    await itemsDB.put(updated);
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
  }, []);

  const deleteItem = useCallback(async (id: string) => {
    await itemsDB.delete(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  return { items, loading, error, addItem, updateItem, deleteItem };
}
