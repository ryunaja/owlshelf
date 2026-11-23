/**
 * media.ts — which stored image references may reach the DOM.
 *
 * `imageUrl` is user data: it arrives from the legacy database, from an
 * import, or from a peer. Rendering it unchecked means a stored
 * `file:///…` path produces
 *
 *   Security Error: Content at http://localhost:4173/ may not load or link
 *   to file:///…
 *
 * because browsers refuse local resources from an http(s) page — and a
 * stored `javascript:` value would be worse than a broken image.
 *
 * So the render path is an allowlist, not a passthrough. `idb:` is allowed
 * even though an `<img>` cannot fetch it: it names a row in the `files`
 * table, so it is a legitimate reference that needs a resolver (§8.1), not
 * a bad one. Dropping it here would hide data instead of fixing it.
 */

const RENDERABLE = /^(data:|blob:|https?:|idb:)/i;

/** The URL to put in `src`, or `undefined` to render the placeholder. */
export function renderableImageUrl(
  url: string | undefined | null,
): string | undefined {
  if (typeof url !== "string" || url.length === 0) return undefined;
  return RENDERABLE.test(url) ? url : undefined;
}
