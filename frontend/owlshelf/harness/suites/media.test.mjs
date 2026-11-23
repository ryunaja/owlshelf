/**
 * media.test.mjs — the render allowlist for stored image references.
 *
 * `imageUrl` is user data (legacy database, import, or a peer), so the render
 * path must not be a passthrough. The case that motivated this: a stored
 * `file:///…` path makes the browser refuse the load with
 *
 *   Security Error: Content at http://localhost:4173/ may not load or link
 *   to file:///…
 *
 * and a stored `javascript:` value would be worse than a broken image.
 */

import { renderableImageUrl } from "../../src/lib/media.ts";
import { assertEqual } from "../lib/assert.mjs";

export default {
  name: "media — render allowlist for imageUrl",
  tests: [
    {
      name: "a file:// reference is refused (the reported security error)",
      run() {
        assertEqual(
          renderableImageUrl("file:///home/renako/photo.png"),
          undefined,
          "file:///home/... is not renderable",
        );
        assertEqual(renderableImageUrl("file:///"), undefined, "bare file:/// is not renderable");
        assertEqual(
          renderableImageUrl("FILE:///C:/Users/x/photo.png"),
          undefined,
          "the scheme check is case-insensitive",
        );
      },
    },
    {
      name: "a javascript: reference is refused",
      run() {
        assertEqual(renderableImageUrl("javascript:alert(1)"), undefined, "javascript: is not renderable");
      },
    },
    {
      name: "a bare Windows path is refused",
      run() {
        assertEqual(
          renderableImageUrl("C:\\fakepath\\photo.png"),
          undefined,
          "a filesystem path is not a URL",
        );
        assertEqual(renderableImageUrl("/relative/photo.png"), undefined, "a relative path is not renderable");
      },
    },
    {
      name: "the schemes the app actually writes pass through",
      run() {
        const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
        assertEqual(renderableImageUrl(dataUrl), dataUrl, "data: passes through");
        const blobUrl = "blob:http://localhost:4173/6f1c";
        assertEqual(renderableImageUrl(blobUrl), blobUrl, "blob: passes through");
        const httpsUrl = "https://covers.openlibrary.org/b/id/8226151-L.jpg";
        assertEqual(renderableImageUrl(httpsUrl), httpsUrl, "https: passes through");
        const httpUrl = "http://localhost:3000/photo.png";
        assertEqual(renderableImageUrl(httpUrl), httpUrl, "http: passes through");
      },
    },
    {
      name: "idb: passes through — a legitimate reference, not a bad one",
      run() {
        // It names a row in the `files` table, so an <img> cannot fetch it
        // until §8.1's resolver exists. Dropping it here would hide data
        // instead of fixing it.
        assertEqual(renderableImageUrl("idb://9f2c"), "idb://9f2c", "idb: passes through");
      },
    },
    {
      name: "absent and empty values render the placeholder",
      run() {
        assertEqual(renderableImageUrl(undefined), undefined, "undefined");
        assertEqual(renderableImageUrl(null), undefined, "null");
        assertEqual(renderableImageUrl(""), undefined, "empty string");
      },
    },
  ],
};
