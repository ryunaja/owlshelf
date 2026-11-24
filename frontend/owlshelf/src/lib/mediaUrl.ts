/**
 * mediaUrl.ts — `idb://` → object-URL resolver (plan §8.1, audit 4.1.1).
 *
 * `idb://` is NOT renderable: browsers cannot resolve a custom scheme out of
 * IndexedDB, so `<img src="idb://abc">` fails with ERR_UNKNOWN_URL_SCHEME.
 * The bytes live in the `files` store keyed by the compound primary key
 * `[roomId+hash]`, so the resolver takes the ROOM as well as the hash
 * (review-2 P1-3): a bare hash cannot find the blob. The roomId is the
 * owning row's `profileId` — encoding it into the URL was rejected because
 * it would rewrite every stored `imageUrl` at migration for no gain.
 *
 * Object URLs are cached with reference counting and revoked at zero, so a
 * list of 200 cards does not leak 200 blobs. The cache is keyed by
 * `roomId + hash`, which is exactly the store's primary key: two rooms never
 * share a blob row, so one room's release can never revoke another's URL.
 *
 * Four states, because "no image" and "the image is gone" are different
 * things to show a user: loading, ready, missing (no row), corrupt (a row
 * whose bytes are not bytes).
 */

import type { OwlshelfDB } from "./db";

export type MediaStatus = "loading" | "ready" | "missing" | "corrupt";

export interface MediaState {
  status: MediaStatus;
  /** Present only when `status === "ready"`. */
  url?: string;
}

const LOADING: MediaState = { status: "loading" };
const MISSING: MediaState = { status: "missing" };
const CORRUPT: MediaState = { status: "corrupt" };

/** `idb://<hash>` → `<hash>`; anything else → null. */
export function parseIdbUrl(url: string | undefined | null): string | null {
  if (typeof url !== "string") return null;
  const match = /^idb:\/\/(.+)$/.exec(url);
  return match ? match[1] : null;
}

/** The stored reference for a blob. */
export function idbUrl(hash: string): string {
  return `idb://${hash}`;
}

interface Entry {
  refs: number;
  state: MediaState;
  url: string | null;
  promise: Promise<MediaState>;
}

const cache = new Map<string, Entry>();

function cacheKey(roomId: string, hash: string): string {
  // The store's primary key is the pair; a separator that cannot appear in
  // either half keeps the map key collision-free.
  return `${roomId}\u0000${hash}`;
}

/** Always returns an `ArrayBuffer`-backed view: `BlobPart` rejects a
 *  `SharedArrayBuffer`-backed one, and a stored row is untrusted input. */
function toBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  return null;
}

async function load(
  db: OwlshelfDB,
  roomId: string,
  hash: string,
): Promise<MediaState> {
  const row = await db.files.get([roomId, hash]);
  if (!row) return MISSING;

  const bytes = toBytes(row.bytes);
  if (!bytes || bytes.byteLength === 0) return CORRUPT;

  try {
    const blob = new Blob([bytes], {
      type: row.contentType || "application/octet-stream",
    });
    return { status: "ready", url: URL.createObjectURL(blob) };
  } catch {
    return CORRUPT;
  }
}

/**
 * Take a reference on a blob and resolve it. Every call must be paired with
 * `releaseMedia` — the URL is revoked when the last reference goes away.
 */
export function acquireMedia(
  db: OwlshelfDB,
  roomId: string,
  hash: string,
): Promise<MediaState> {
  const key = cacheKey(roomId, hash);
  const existing = cache.get(key);
  if (existing) {
    existing.refs += 1;
    return existing.promise;
  }

  const entry: Entry = {
    refs: 1,
    state: LOADING,
    url: null,
    promise: Promise.resolve(LOADING),
  };

  entry.promise = load(db, roomId, hash).then(
    (state) => {
      entry.state = state;
      entry.url = state.url ?? null;
      // Released while the read was in flight: nothing will ever call
      // release again, so revoke here instead of leaking the URL.
      if (entry.refs === 0) {
        if (entry.url) URL.revokeObjectURL(entry.url);
        cache.delete(key);
      }
      return state;
    },
    () => {
      entry.state = CORRUPT;
      if (entry.refs === 0) cache.delete(key);
      return CORRUPT;
    },
  );

  cache.set(key, entry);
  return entry.promise;
}

/** Drop a reference; the last one revokes the object URL. */
export function releaseMedia(roomId: string, hash: string): void {
  const key = cacheKey(roomId, hash);
  const entry = cache.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (entry.url) URL.revokeObjectURL(entry.url);
  cache.delete(key);
}

// ─── Invalidation ──────────────────────────────────────────────────────────

type MediaListener = (roomId: string, hash: string) => void;

const listeners = new Set<MediaListener>();

/** Notified when a blob for `(roomId, hash)` changes. Returns an unsubscribe. */
export function subscribeMedia(listener: MediaListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forget the cached answer for one blob and tell every consumer.
 *
 * `missing` is a cacheable answer only while nothing can change it. A blob a
 * peer has not sent yet is missing now and present in ten seconds, so a cached
 * `missing` outlives the truth and the image never appears without a reload —
 * which is exactly what happened before this existed. The sync engine calls
 * this when a blob lands.
 *
 * Deleting the entry drops its refcount, so the holders' later `releaseMedia`
 * calls find nothing and no-op — the fresh entry they acquire next carries
 * their references instead. That is why this is safe to call while components
 * are mounted. The URL is revoked here rather than left to the refcount: the
 * bytes behind it are the OLD answer, and a component that kept rendering it
 * would show a stale image after a re-fetch.
 */
export function invalidateMedia(roomId: string, hash: string): void {
  const key = cacheKey(roomId, hash);
  const entry = cache.get(key);
  if (entry) {
    if (entry.url) URL.revokeObjectURL(entry.url);
    cache.delete(key);
  }
  for (const listener of listeners) listener(roomId, hash);
}

/** Test seam: the cache size, so a leak is observable. */
export function mediaCacheSize(): number {
  return cache.size;
}
