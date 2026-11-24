/**
 * blob.ts — hash-verified, chunked blob transfer (§6.6, §15.4).
 *
 * Blobs never ride op envelopes: an op is a few hundred bytes and a blob is a
 * megabyte, so mixing them would make every catch-up chunk a lottery. Instead
 * a blob is fetched by content address over its own request/reply pair, and
 * the receiver refuses to store anything whose bytes do not hash to the name
 * it asked for.
 *
 * ── The chunk size is a WIRE budget, not a data budget ────────────────────
 *
 * §6.6 says "≤512 KB per chunk" and §9 says the relay's frame cap is ~512 KB.
 * Both cannot be literal, and the gap is bigger than it looks: the chunk's
 * `bytes` field is base64 (4/3), and then the whole body is base64 again
 * inside the sealed envelope (another 4/3). A 512 KB chunk becomes ~910 KB of
 * frame — 78% over the cap — and the relay drops it at the protocol layer.
 *
 * So `CHUNK_BYTES` is derived from `FRAME_CAP` through BOTH expansions rather
 * than stated, and the harness seals a full chunk and measures the frame. That
 * assertion is the point: the arithmetic is easy to get wrong, and the failure
 * is a silent drop on a large image, which is the worst kind of bug to find in
 * production.
 *
 * ── One outstanding transfer per room ─────────────────────────────────────
 *
 * §6.6's rule, enforced by the engine holding one `BlobTransfer` per
 * `requestId` and refusing a second concurrent request for the same hash.
 * Two interleaved transfers would double the memory for no gain, and a phone
 * is the device that runs out.
 */

import type { OwlshelfDB } from "./db";
import { b64ToBytes, bytesToB64 } from "./envelope";
import { sha256Hex } from "./hash";

/** The relay's `ws_max_size` (§9). A frame above this is dropped. */
export const FRAME_CAP = 512 * 1024;

/**
 * Plaintext bytes per chunk, derived so the SEALED frame stays under
 * `FRAME_CAP`. Two base64 expansions (the `bytes` field, then the body) cost
 * 4/3 each, so the budget is `FRAME_CAP * (3/4)²`; 1 KB of headroom covers the
 * nonce, the tag, and the envelope's JSON fields.
 */
export const CHUNK_BYTES = Math.floor((FRAME_CAP * 9) / 16) - 1024;

/** The raw-input cap (§8.1), so no legitimate blob exceeds it. */
export const MAX_BLOB_BYTES = 4 * 1024 * 1024;

/** `MAX_BLOB_BYTES / CHUNK_BYTES` rounded up, with headroom. */
export const MAX_CHUNKS = 16;

/** §15.4: "the requester moves to the next member or times out (30s)". */
export const BLOB_TIMEOUT = 30_000;

/** §15.4: the negative answer — "not held". */
export const NEGATIVE_SEQ = -1;

// ─── Wire shapes (§15.4) ───────────────────────────────────────────────────

export interface BlobRequest {
  requestId: string;
  hash: string;
  /** Sealed, like every other body: presence only names connectionIds. */
  deviceId: string;
}

export interface FileChunk {
  requestId: string;
  /** 0-based, or `NEGATIVE_SEQ` for "not held". */
  seq: number;
  /** base64. Absent on a negative answer. */
  bytes?: string;
  totalBytes?: number;
  totalChunks?: number;
  contentType?: string;
  /** The responder's deviceId, sealed. */
  deviceId?: string;
}

// ─── Serve ─────────────────────────────────────────────────────────────────

/** Always `ArrayBuffer`-backed: a stored row is untrusted input. */
function toBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  return null;
}

/**
 * Answer one request: every chunk, or a single negative answer.
 *
 * A row that exists but holds no usable bytes is answered NEGATIVE, not with
 * an empty stream — "I have nothing" is a bounded wait, while a zero-length
 * stream would fail the hash check at the far end and look like corruption.
 */
export async function serveBlob(
  db: OwlshelfDB,
  roomId: string,
  request: BlobRequest,
  options: { deviceId: string },
): Promise<FileChunk[]> {
  const negative: FileChunk = {
    requestId: request.requestId,
    seq: NEGATIVE_SEQ,
    deviceId: options.deviceId,
  };

  const row = await db.files.get([roomId, request.hash]);
  if (!row) return [negative];

  const bytes = toBytes(row.bytes);
  if (!bytes || bytes.byteLength === 0) return [negative];

  const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  const contentType = row.contentType || "application/octet-stream";

  const out: FileChunk[] = [];
  for (let seq = 0; seq < totalChunks; seq += 1) {
    const start = seq * CHUNK_BYTES;
    const slice = bytes.subarray(start, Math.min(start + CHUNK_BYTES, bytes.byteLength));
    out.push({
      requestId: request.requestId,
      seq,
      bytes: bytesToB64(slice),
      totalBytes: bytes.byteLength,
      totalChunks,
      contentType,
      deviceId: options.deviceId,
    });
  }
  return out;
}

// ─── Receive ───────────────────────────────────────────────────────────────

export type BlobAccept = "chunk" | "complete" | "negative" | "foreign" | "rejected";

export type BlobFailure =
  | "bad-shape"
  | "out-of-order"
  | "too-large"
  | "too-many-chunks"
  | "inconsistent"
  | "hash-mismatch";

/**
 * One in-flight download, keyed by `requestId`.
 *
 * Every rejection is a named failure rather than a boolean, because the caller
 * has to decide between "try another peer" (`not-held`) and "this peer is
 * lying" (`hash-mismatch`), and those are different actions.
 */
export class BlobTransfer {
  readonly requestId: string;
  readonly hash: string;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly parts: Uint8Array<ArrayBuffer>[] = [];

  private nextSeq = 0;
  private totalBytes = -1;
  private totalChunks = -1;
  private contentType = "";
  private received = 0;
  private complete = false;
  private failure: BlobFailure | null = null;
  /** Peers that answered "not held". NOT a failure — another peer may have it. */
  private readonly notHeldBy = new Set<string>();

  constructor(requestId: string, hash: string, now: () => number = Date.now) {
    this.requestId = requestId;
    this.hash = hash;
    this.now = now;
    this.startedAt = now();
  }

  get isComplete(): boolean {
    return this.complete;
  }

  get isFailed(): boolean {
    return this.failure !== null;
  }

  get failedWith(): BlobFailure | null {
    return this.failure;
  }

  /** Peers that said "not held". The transfer stays open for the others. */
  get notHeld(): readonly string[] {
    return [...this.notHeldBy];
  }

  get contentTypeValue(): string {
    return this.contentType;
  }

  get receivedBytes(): number {
    return this.received;
  }

  /** The reassembled bytes, or null until `isComplete`. */
  get bytes(): Uint8Array<ArrayBuffer> | null {
    return this.complete ? this.assemble() : null;
  }

  /**
   * Concatenate what has arrived so far.
   *
   * Separate from the `bytes` getter because the hash check runs BEFORE
   * `complete` is set — a getter that guarded on `complete` would hand the
   * digest a null and the transfer could never verify.
   */
  private assemble(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.received);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  /** §15.4's bounded wait. */
  isExpired(at: number = this.now()): boolean {
    return at - this.startedAt >= BLOB_TIMEOUT;
  }

  private fail(reason: BlobFailure): BlobAccept {
    this.failure = reason;
    return "rejected";
  }

  async accept(body: FileChunk): Promise<BlobAccept> {
    if (body.requestId !== this.requestId) return "foreign";
    if (this.complete || this.failure !== null) return "rejected";

    if (body.seq === NEGATIVE_SEQ) {
      // "Not held" is a positive statement, not an error: the requester moves
      // to the next member. It must NOT poison the transfer — a peer that
      // lacks the blob says nothing about the peers that have it.
      if (typeof body.deviceId === "string") this.notHeldBy.add(body.deviceId);
      return "negative";
    }

    if (typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 0) {
      return this.fail("bad-shape");
    }
    if (body.seq !== this.nextSeq) {
      // Continuity, not just ordering: a gap means a chunk was lost, and
      // reassembling around it would produce bytes that fail the hash anyway.
      return this.fail("out-of-order");
    }

    const totalChunks = body.totalChunks;
    const totalBytes = body.totalBytes;
    if (
      typeof totalChunks !== "number" ||
      !Number.isInteger(totalChunks) ||
      totalChunks < 1 ||
      totalChunks > MAX_CHUNKS
    ) {
      return this.fail("too-many-chunks");
    }
    if (
      typeof totalBytes !== "number" ||
      !Number.isInteger(totalBytes) ||
      totalBytes < 1 ||
      totalBytes > MAX_BLOB_BYTES
    ) {
      return this.fail("too-large");
    }
    if (typeof body.contentType !== "string" || body.contentType.length === 0) {
      return this.fail("bad-shape");
    }
    if (typeof body.bytes !== "string") return this.fail("bad-shape");

    // The declared shape must be the same on every chunk: a peer that changes
    // its mind mid-stream is either broken or probing.
    if (this.totalChunks === -1) {
      this.totalChunks = totalChunks;
      this.totalBytes = totalBytes;
      this.contentType = body.contentType;
    } else if (
      this.totalChunks !== totalChunks ||
      this.totalBytes !== totalBytes ||
      this.contentType !== body.contentType
    ) {
      return this.fail("inconsistent");
    }

    let part: Uint8Array<ArrayBuffer>;
    try {
      part = b64ToBytes(body.bytes);
    } catch {
      return this.fail("bad-shape");
    }
    if (part.byteLength > CHUNK_BYTES) return this.fail("too-large");
    if (this.received + part.byteLength > this.totalBytes) return this.fail("too-large");

    this.parts.push(part);
    this.received += part.byteLength;
    this.nextSeq += 1;

    if (this.nextSeq < this.totalChunks) return "chunk";

    // Last chunk. The count must be exact, and the bytes must hash to the name
    // we asked for — BEFORE anything is written (§6.6).
    if (this.received !== this.totalBytes) return this.fail("inconsistent");

    const digest = await sha256Hex(this.assemble());
    if (digest !== this.hash) return this.fail("hash-mismatch");

    this.complete = true;
    return "complete";
  }
}
