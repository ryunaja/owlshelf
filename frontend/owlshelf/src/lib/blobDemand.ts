/**
 * blobDemand.ts — the pull side of media sync (§6.6, §8.1).
 *
 * `blob-request` / `file-chunk` were fully implemented and had no caller: the
 * engine could answer a request and store a verified chunk, but nothing ever
 * ASKED. So a row synced from a peer arrived with `imageUrl: "idb://<hash>"`,
 * `files` had no row for it, and the image was permanently missing — the
 * transfer machinery was a library, not a feature.
 *
 * The trigger is demand, not replication: a blob is fetched when something
 * tries to RENDER it and the bytes are absent. That is the only signal that
 * exists in a tab (the engine never sees a render), and it is also the right
 * policy — a room with 500 covers must not pull 500 blobs onto a phone that
 * will only ever show twelve.
 *
 * ── Why a registry instead of a direct call ───────────────────────────────
 *
 * `useMediaSrc` is a tab-side hook; the engine is owned by whoever started it.
 * Today that is the dev panel, and step 5 moves it into a worker, at which
 * point this registration becomes a port message and nothing else changes.
 * The hook must not import the engine, or the media path would drag the whole
 * sync stack into every page that shows a thumbnail.
 *
 * ── Why a cooldown ────────────────────────────────────────────────────────
 *
 * A blob nobody holds is missing forever, and a list of cards re-renders on
 * every scroll. Without a floor, one absent cover becomes a request storm
 * against every peer in the room. `DEMAND_COOLDOWN` is per `(roomId, hash)`,
 * so a genuinely absent blob is retried once a minute and a present one is
 * fetched once.
 */

/** What the engine registers. Room-aware: one engine serves one room. */
export type BlobFetcher = (roomId: string, hash: string) => void | Promise<void>;

/** How long a failed demand waits before it is retried. */
export const DEMAND_COOLDOWN = 60_000;

let fetcher: BlobFetcher | null = null;

/** `(roomId, hash)` → the time of the last demand. */
const asked = new Map<string, number>();

function demandKey(roomId: string, hash: string): string {
  return `${roomId}\u0000${hash}`;
}

/**
 * Install the fetcher. Returns an unsubscribe that is a no-op if a newer
 * fetcher has since replaced this one — a stale teardown must not disarm the
 * engine that replaced it.
 */
export function registerBlobFetcher(next: BlobFetcher): () => void {
  fetcher = next;
  return () => {
    if (fetcher === next) fetcher = null;
  };
}

/** Whether anything can serve a demand. The panel shows this as "no engine". */
export function hasBlobFetcher(): boolean {
  return fetcher !== null;
}

/**
 * Ask for a blob, at most once per cooldown.
 *
 * Returns whether a request was actually issued, so a caller (and the tests)
 * can tell "asked" from "already asked" from "nobody to ask".
 */
export function demandBlob(roomId: string, hash: string, now: number = Date.now()): boolean {
  if (fetcher === null) return false;
  if (hash.length === 0) return false;

  const key = demandKey(roomId, hash);
  const last = asked.get(key);
  if (last !== undefined && now - last < DEMAND_COOLDOWN) return false;

  asked.set(key, now);
  // A rejected fetch is not a reason to stop rendering: the cooldown already
  // bounds the retry, and an unhandled rejection here would surface as a
  // console error on a page that is merely missing a thumbnail.
  void Promise.resolve(fetcher(roomId, hash)).catch(() => undefined);
  return true;
}

/**
 * The bytes arrived, so the next demand is a fresh question.
 *
 * Without this, a blob that is fetched, GC'd, and needed again would wait out
 * the cooldown for no reason.
 */
export function clearBlobDemand(roomId: string, hash: string): void {
  asked.delete(demandKey(roomId, hash));
}

/** Test seam: forget every registration and every cooldown. */
export function resetBlobDemand(): void {
  fetcher = null;
  asked.clear();
}
