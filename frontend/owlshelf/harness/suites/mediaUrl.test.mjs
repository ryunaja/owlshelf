/**
 * mediaUrl.test.mjs — the `idb://` resolver (plan §8.1, audit 4.1.1).
 *
 * `idb://` is not renderable: browsers cannot resolve a custom scheme out of
 * IndexedDB. The bytes live in `files` keyed by `[roomId+hash]`, so the
 * resolver takes the ROOM as well as the hash (review-2 P1-3) — a bare hash
 * cannot find the blob.
 *
 * The cache is reference counted, so the leak test matters as much as the
 * happy path: a list of 200 cards must not leak 200 object URLs.
 */

import {
  acquireMedia,
  idbUrl,
  mediaCacheSize,
  parseIdbUrl,
  releaseMedia,
} from "../../src/lib/mediaUrl.ts";
import { assert, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";

const ROOM_A = "room-a";
const ROOM_B = "room-b";
const HASH = "9f2c";

function bytes(...values) {
  return new Uint8Array(values);
}

async function seedFile(db, roomId, hash, payload = bytes(1, 2, 3)) {
  await db.files.put({
    roomId,
    hash,
    bytes: payload,
    size: payload.byteLength,
    contentType: "image/webp",
  });
}

export default {
  name: "mediaUrl — idb:// resolver, room-scoped and ref-counted",
  tests: [
    {
      name: "parseIdbUrl accepts only the idb: scheme",
      run() {
        assertEqual(parseIdbUrl("idb://9f2c"), "9f2c", "idb:// extracts the hash");
        assertEqual(parseIdbUrl("data:image/png;base64,AA"), null, "data: is not idb:");
        assertEqual(parseIdbUrl("https://example.com/x.png"), null, "https: is not idb:");
        assertEqual(parseIdbUrl("file:///x.png"), null, "file: is not idb:");
        assertEqual(parseIdbUrl(undefined), null, "undefined");
        assertEqual(parseIdbUrl(""), null, "empty");
      },
    },
    {
      name: "idbUrl round-trips through parseIdbUrl",
      run() {
        assertEqual(parseIdbUrl(idbUrl(HASH)), HASH, "idbUrl → parseIdbUrl");
      },
    },
    {
      name: "a missing row is 'missing', not an error",
      async run() {
        await withDb(async (db) => {
          const state = await acquireMedia(db, ROOM_A, "nope");
          assertEqual(state.status, "missing", "no row → missing");
          releaseMedia(ROOM_A, "nope");
          assertEqual(mediaCacheSize(), 0, "a missing row leaves nothing cached");
        });
      },
    },
    {
      name: "a stored blob resolves to an object URL",
      async run() {
        await withDb(async (db) => {
          await seedFile(db, ROOM_A, HASH);
          const state = await acquireMedia(db, ROOM_A, HASH);
          assertEqual(state.status, "ready", "ready");
          assert(typeof state.url === "string" && state.url.startsWith("blob:"), "a blob: URL");
          releaseMedia(ROOM_A, HASH);
          assertEqual(mediaCacheSize(), 0, "released");
        });
      },
    },
    {
      name: "the room is part of the lookup: the same hash in two rooms is two blobs",
      async run() {
        await withDb(async (db) => {
          await seedFile(db, ROOM_A, HASH, bytes(1));
          await seedFile(db, ROOM_B, HASH, bytes(2));

          const a = await acquireMedia(db, ROOM_A, HASH);
          const b = await acquireMedia(db, ROOM_B, HASH);
          assertEqual(a.status, "ready", "room A resolves");
          assertEqual(b.status, "ready", "room B resolves");
          assert(a.url !== b.url, "two rooms never share one object URL");

          releaseMedia(ROOM_A, HASH);
          releaseMedia(ROOM_B, HASH);
          assertEqual(mediaCacheSize(), 0, "both released");
        });
      },
    },
    {
      name: "reference counting: the URL survives until the LAST release",
      async run() {
        await withDb(async (db) => {
          await seedFile(db, ROOM_A, HASH);

          const first = await acquireMedia(db, ROOM_A, HASH);
          const second = await acquireMedia(db, ROOM_A, HASH);
          assertEqual(first.url, second.url, "one URL for two holders");
          assertEqual(mediaCacheSize(), 1, "one cache entry");

          releaseMedia(ROOM_A, HASH);
          assertEqual(mediaCacheSize(), 1, "still held by the second reference");

          releaseMedia(ROOM_A, HASH);
          assertEqual(mediaCacheSize(), 0, "revoked at zero");
        });
      },
    },
    {
      name: "a row whose bytes are not bytes is 'corrupt', not a crash",
      async run() {
        await withDb(async (db) => {
          await db.files.put({
            roomId: ROOM_A,
            hash: HASH,
            bytes: "not bytes",
            size: 9,
            contentType: "image/webp",
          });
          const state = await acquireMedia(db, ROOM_A, HASH);
          assertEqual(state.status, "corrupt", "corrupt");
          releaseMedia(ROOM_A, HASH);
          assertEqual(mediaCacheSize(), 0, "released");
        });
      },
    },
    {
      name: "an empty blob is 'corrupt' — a zero-byte image is not an image",
      async run() {
        await withDb(async (db) => {
          await seedFile(db, ROOM_A, HASH, new Uint8Array(0));
          const state = await acquireMedia(db, ROOM_A, HASH);
          assertEqual(state.status, "corrupt", "corrupt");
          releaseMedia(ROOM_A, HASH);
        });
      },
    },
    {
      name: "releasing before the read settles does not leak the URL",
      async run() {
        await withDb(async (db) => {
          await seedFile(db, ROOM_A, HASH);
          const pending = acquireMedia(db, ROOM_A, HASH);
          releaseMedia(ROOM_A, HASH);
          const state = await pending;
          assertEqual(state.status, "ready", "the read still resolves");
          assertEqual(mediaCacheSize(), 0, "the late URL was revoked, not cached");
        });
      },
    },
  ],
};
