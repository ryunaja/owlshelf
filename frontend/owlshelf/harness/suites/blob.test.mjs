/**
 * blob.test.mjs — hash-verified chunked transfer (§6.6, §15.4).
 *
 * The first test is the important one: §6.6 says chunks are ≤512 KB and §9
 * says the relay's frame cap is ~512 KB, and both cannot be literal because
 * base64 costs 4/3. `CHUNK_BYTES` is derived, and this suite SEALS a full
 * chunk and measures the frame — the arithmetic is easy to get wrong and the
 * failure mode is a silent drop on a large image.
 */

import {
  BLOB_TIMEOUT,
  BlobTransfer,
  CHUNK_BYTES,
  FRAME_CAP,
  MAX_BLOB_BYTES,
  MAX_CHUNKS,
  NEGATIVE_SEQ,
  serveBlob,
} from "../../src/lib/blob.ts";
import { bytesToB64, seal } from "../../src/lib/envelope.ts";
import { sha256Hex } from "../../src/lib/hash.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";
import { withDb } from "../lib/db.mjs";
import { DEVICE_A, DEVICE_B, ROOM_A, ROOM_KEY, seedRoom } from "../lib/fixtures.mjs";

function bytesOf(size, fill = 7) {
  return new Uint8Array(size).fill(fill);
}

async function fileRow(bytes, overrides = {}) {
  return {
    roomId: ROOM_A,
    hash: await sha256Hex(bytes),
    bytes,
    contentType: "image/webp",
    size: bytes.byteLength,
    createdAt: 0,
    ...overrides,
  };
}

function request(hash, requestId = "r1") {
  return { requestId, hash, deviceId: DEVICE_B };
}

export default {
  name: "blob — chunk budget, serve, verify (§6.6, §15.4)",
  tests: [
    {
      name: "a full chunk's SEALED frame fits under the relay's frame cap",
      async run() {
        // The whole reason CHUNK_BYTES is derived rather than stated.
        const chunk = {
          requestId: "r1",
          seq: 0,
          bytes: bytesToB64(bytesOf(CHUNK_BYTES)),
          totalBytes: CHUNK_BYTES,
          totalChunks: 1,
          contentType: "image/webp",
          deviceId: DEVICE_A,
        };
        const envelope = await seal(ROOM_KEY, ROOM_A, 1, "file-chunk", chunk);
        const wire = JSON.stringify(envelope).length;
        assert(
          wire <= FRAME_CAP,
          `sealed chunk is ${wire} bytes, over the ${FRAME_CAP} frame cap`,
        );
        assert(wire > FRAME_CAP * 0.9, "and it is not wastefully small");
      },
    },
    {
      name: "the chunk budget leaves room for the nonce, tag, and JSON",
      async run() {
        assert(CHUNK_BYTES < FRAME_CAP, "plaintext is smaller than the frame");
        // Two base64 expansions put the ceiling at 9/16 of the frame; anything
        // much below that is wasting round trips.
        assert(CHUNK_BYTES > FRAME_CAP * 0.5, "but not absurdly small");
        assertEqual(MAX_CHUNKS * CHUNK_BYTES >= MAX_BLOB_BYTES, true, "enough chunks for the cap");
      },
    },
    {
      name: "a missing blob is answered NEGATIVE, not with an empty stream",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const chunks = await serveBlob(db, ROOM_A, request("nope"), { deviceId: DEVICE_A });
          assertEqual(chunks.length, 1, "one frame");
          assertEqual(chunks[0].seq, NEGATIVE_SEQ, "seq -1");
          assertEqual(chunks[0].bytes, undefined, "no bytes");
        });
      },
    },
    {
      name: "a row with no usable bytes is also NEGATIVE",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          await db.files.put({
            roomId: ROOM_A,
            hash: "abc",
            bytes: new Uint8Array(0),
            contentType: "image/webp",
            size: 0,
            createdAt: 0,
          });
          const chunks = await serveBlob(db, ROOM_A, request("abc"), { deviceId: DEVICE_A });
          assertEqual(chunks[0].seq, NEGATIVE_SEQ, "not held");
        });
      },
    },
    {
      name: "a blob in another room is not served",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const bytes = bytesOf(100);
          await db.files.put(await fileRow(bytes, { roomId: "room-b" }));
          const hash = await sha256Hex(bytes);
          const chunks = await serveBlob(db, ROOM_A, request(hash), { deviceId: DEVICE_A });
          assertEqual(chunks[0].seq, NEGATIVE_SEQ, "room-scoped");
        });
      },
    },
    {
      name: "a small blob is one chunk and reassembles exactly",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const bytes = bytesOf(1000, 3);
          await db.files.put(await fileRow(bytes));
          const hash = await sha256Hex(bytes);

          const chunks = await serveBlob(db, ROOM_A, request(hash), { deviceId: DEVICE_A });
          assertEqual(chunks.length, 1, "one chunk");
          assertEqual(chunks[0].totalChunks, 1, "totalChunks");
          assertEqual(chunks[0].totalBytes, 1000, "totalBytes");
          assertEqual(chunks[0].contentType, "image/webp", "contentType");

          const transfer = new BlobTransfer("r1", hash, () => 0);
          assertEqual(await transfer.accept(chunks[0]), "complete", "complete");
          assertDeepEqual(Array.from(transfer.bytes), Array.from(bytes), "identical bytes");
        });
      },
    },
    {
      name: "a large blob is chunked, and every chunk is under the budget",
      async run() {
        await withDb(async (db) => {
          await seedRoom(db);
          const bytes = bytesOf(CHUNK_BYTES + 5000, 9);
          await db.files.put(await fileRow(bytes));
          const hash = await sha256Hex(bytes);

          const chunks = await serveBlob(db, ROOM_A, request(hash), { deviceId: DEVICE_A });
          assertEqual(chunks.length, 2, "two chunks");
          for (const chunk of chunks) {
            // base64 length is ceil(n/3)*4, not ceil(n*4/3) — they differ by 1.
            assert(chunk.bytes.length <= Math.ceil(CHUNK_BYTES / 3) * 4, "under budget");
          }

          const transfer = new BlobTransfer("r1", hash, () => 0);
          for (const chunk of chunks) await transfer.accept(chunk);
          assertEqual(transfer.isComplete, true, "complete");
          assertDeepEqual(Array.from(transfer.bytes), Array.from(bytes), "identical bytes");
        });
      },
    },
    {
      name: "a gap is rejected, not reassembled around",
      async run() {
        const transfer = new BlobTransfer("r1", "abc", () => 0);
        const result = await transfer.accept({
          requestId: "r1",
          seq: 1,
          bytes: bytesToB64(bytesOf(10)),
          totalBytes: 20,
          totalChunks: 2,
          contentType: "image/webp",
        });
        assertEqual(result, "rejected", "rejected");
        assertEqual(transfer.failedWith, "out-of-order", "named failure");
        assertEqual(transfer.isComplete, false, "never complete");
      },
    },
    {
      name: "a hash mismatch is rejected BEFORE anything is stored",
      async run() {
        const bytes = bytesOf(100, 1);
        const wrongHash = await sha256Hex(bytesOf(100, 2));
        const transfer = new BlobTransfer("r1", wrongHash, () => 0);
        const result = await transfer.accept({
          requestId: "r1",
          seq: 0,
          bytes: bytesToB64(bytes),
          totalBytes: 100,
          totalChunks: 1,
          contentType: "image/webp",
        });
        assertEqual(result, "rejected", "rejected");
        assertEqual(transfer.failedWith, "hash-mismatch", "named failure");
        assertEqual(transfer.bytes, null, "no bytes exposed");
      },
    },
    {
      name: "a chunk over the budget is rejected",
      async run() {
        const transfer = new BlobTransfer("r1", "abc", () => 0);
        const result = await transfer.accept({
          requestId: "r1",
          seq: 0,
          bytes: bytesToB64(bytesOf(CHUNK_BYTES + 1)),
          totalBytes: CHUNK_BYTES + 1,
          totalChunks: 1,
          contentType: "image/webp",
        });
        assertEqual(result, "rejected", "rejected");
        assertEqual(transfer.failedWith, "too-large", "named failure");
      },
    },
    {
      name: "a declared size over the blob cap is rejected",
      async run() {
        const transfer = new BlobTransfer("r1", "abc", () => 0);
        const result = await transfer.accept({
          requestId: "r1",
          seq: 0,
          bytes: bytesToB64(bytesOf(10)),
          totalBytes: MAX_BLOB_BYTES + 1,
          totalChunks: 1,
          contentType: "image/webp",
        });
        assertEqual(transfer.failedWith, "too-large", "named failure");
        assertEqual(result, "rejected", "rejected");
      },
    },
    {
      name: "a declared chunk count over the cap is rejected",
      async run() {
        const transfer = new BlobTransfer("r1", "abc", () => 0);
        await transfer.accept({
          requestId: "r1",
          seq: 0,
          bytes: bytesToB64(bytesOf(10)),
          totalBytes: 10,
          totalChunks: MAX_CHUNKS + 1,
          contentType: "image/webp",
        });
        assertEqual(transfer.failedWith, "too-many-chunks", "named failure");
      },
    },
    {
      name: "a peer that changes its declared shape mid-stream is rejected",
      async run() {
        const transfer = new BlobTransfer("r1", "abc", () => 0);
        await transfer.accept({
          requestId: "r1",
          seq: 0,
          bytes: bytesToB64(bytesOf(10)),
          totalBytes: 20,
          totalChunks: 2,
          contentType: "image/webp",
        });
        await transfer.accept({
          requestId: "r1",
          seq: 1,
          bytes: bytesToB64(bytesOf(10)),
          totalBytes: 30,
          totalChunks: 2,
          contentType: "image/webp",
        });
        assertEqual(transfer.failedWith, "inconsistent", "named failure");
      },
    },
    {
      name: "a negative answer is 'not held', not a transfer failure",
      async run() {
        const transfer = new BlobTransfer("r1", "abc", () => 0);
        const result = await transfer.accept({
          requestId: "r1",
          seq: NEGATIVE_SEQ,
          deviceId: DEVICE_B,
        });
        assertEqual(result, "negative", "negative");
        assertEqual(transfer.isFailed, false, "not a failure");
        assertEqual(transfer.isComplete, false, "not complete");
        assertDeepEqual(transfer.notHeld, [DEVICE_B], "recorded who lacks it");
      },
    },
    {
      name: "a negative answer from one peer does not poison the transfer",
      async run() {
        // Peer A lacking the blob says nothing about peer B having it.
        const bytes = bytesOf(10);
        const hash = await sha256Hex(bytes);
        const transfer = new BlobTransfer("r1", hash, () => 0);

        await transfer.accept({ requestId: "r1", seq: NEGATIVE_SEQ, deviceId: DEVICE_B });
        const result = await transfer.accept({
          requestId: "r1",
          seq: 0,
          bytes: bytesToB64(bytes),
          totalBytes: 10,
          totalChunks: 1,
          contentType: "image/webp",
          deviceId: DEVICE_A,
        });

        assertEqual(result, "complete", "the other peer's chunk still lands");
        assertEqual(transfer.isComplete, true, "complete");
      },
    },
    {
      name: "a chunk for another request is ignored",
      async run() {
        const transfer = new BlobTransfer("r1", "abc", () => 0);
        assertEqual(
          await transfer.accept({ requestId: "r2", seq: 0, bytes: "" }),
          "foreign",
          "foreign",
        );
        assertEqual(transfer.failedWith, null, "not a failure");
      },
    },
    {
      name: "a chunk after completion is rejected",
      async run() {
        const bytes = bytesOf(10);
        const hash = await sha256Hex(bytes);
        const transfer = new BlobTransfer("r1", hash, () => 0);
        const chunk = {
          requestId: "r1",
          seq: 0,
          bytes: bytesToB64(bytes),
          totalBytes: 10,
          totalChunks: 1,
          contentType: "image/webp",
        };
        assertEqual(await transfer.accept(chunk), "complete", "first");
        assertEqual(await transfer.accept(chunk), "rejected", "second");
      },
    },
    {
      name: "a transfer expires at the 30s bound",
      async run() {
        let clock = 0;
        const transfer = new BlobTransfer("r1", "abc", () => clock);
        assertEqual(transfer.isExpired(), false, "fresh");
        clock = BLOB_TIMEOUT - 1;
        assertEqual(transfer.isExpired(), false, "one ms before");
        clock = BLOB_TIMEOUT;
        assertEqual(transfer.isExpired(), true, "at the bound");
      },
    },
  ],
};
