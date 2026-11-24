/**
 * catchup.ts — symmetric, targeted, contiguous catch-up (plan §6.6).
 *
 * Both sides advertise per-author cursors; either can serve the other's
 * missing ranges. Four rules, each of which was a defect in an earlier pass:
 *
 *   1. The REQUEST fans out to every presence member (audit-2 N12) — a single
 *      named peer may be stale and answer "complete" while missing history.
 *   2. The REPLIES are ELECTED (audit-4 R4-P1-2) — unelected fan-out was 9
 *      responders × ~10 MB history = 90 MB on a phone for a 10 MB room.
 *   3. The end marker carries the responder's CURSORS (audit-2 N8) — ops alone
 *      are a delivery proof; cursors are the adoption proof the outbox needs.
 *   4. Completion is one verified end marker AND no contradicting marker
 *      within SETTLE (audit-4 R4-P1-3) — "first end marker wins" made the
 *      disagreement check unreachable, and "wait for all" let one silent
 *      responder block completion forever.
 */

import type { OwlshelfDB } from "./db";
import { endDigest } from "./canonical";
import type { Room, RowOp } from "./stores";

/** §6.6: a non-elected responder waits this long before answering. */
export const RESPONDER_SUPPRESS = 500;

/** §6.6: a contradiction inside this window re-opens the room as INCOMPLETE. */
export const SETTLE = 2000;

/** §6.6: chunks are bounded by total bytes, not op count. */
export const CHUNK_BYTES = 512 * 1024;

// ─── Request ───────────────────────────────────────────────────────────────

export interface CatchupRequest {
  requestId: string;
  /** The requester's per-author cursors. An absent author means 0. */
  cursors: Record<string, number>;
  /** The requester's deviceId, sealed so the responder can attribute the
   *  cursors it learns. See the note in outbox.ts on why this is in the body
   *  and not in the plaintext hello. */
  deviceId: string;
}

/**
 * Build a request from the room's inbound cursors.
 *
 * `cursorIn` is exactly "what we have adopted per author", which is what a
 * responder needs to compute the missing range. An author absent from the map
 * is cursor 0 = full history, so the map is sent as-is rather than padded.
 */
export function buildCatchupRequest(
  room: Room,
  requestId: string,
  deviceId: string,
): CatchupRequest {
  return {
    requestId,
    cursors: { ...room.cursorIn },
    deviceId,
  };
}

// ─── Election ──────────────────────────────────────────────────────────────

/**
 * The ordered list of members that could answer this request, lowest
 * connectionId first.
 *
 * Index 0 is the elected responder. Index `n` waits `RESPONDER_SUPPRESS * n`
 * before answering, and answers only if no `catchup-started` notice arrived.
 * That is §6.6's "every other member suppresses for `RESPONDER_SUPPRESS` and
 * answers only if the elected one never starts", generalised to a ladder: with
 * a single 500 ms window, a dead elected responder stalls the room until the
 * next presence change, which on a quiet room is never.
 *
 * A candidate whose high-water marks are unknown cannot be on the ladder — it
 * might be the stale peer that answers "complete" while missing history, which
 * is the exact failure the fan-out exists to survive.
 */
export function responderLadder(
  presence: readonly string[],
  highWaterByConn: ReadonlyMap<string, Readonly<Record<string, number>> | undefined>,
  requestCursors: Readonly<Record<string, number>>,
): string[] {
  const candidates: string[] = [];
  for (const connId of presence) {
    const highWater = highWaterByConn.get(connId);
    if (!highWater) continue;
    if (covers(highWater, requestCursors)) candidates.push(connId);
  }
  candidates.sort();
  return candidates;
}

/**
 * Pick the responder: the LOWEST connectionId among members whose high-water
 * mark covers the request — the head of the ladder.
 */
export function electResponder(
  presence: readonly string[],
  highWaterByConn: ReadonlyMap<string, Readonly<Record<string, number>> | undefined>,
  requestCursors: Readonly<Record<string, number>>,
): string | null {
  return responderLadder(presence, highWaterByConn, requestCursors)[0] ?? null;
}

/** Does `highWater` hold anything the requester is missing? */
export function covers(
  highWater: Readonly<Record<string, number>>,
  requestCursors: Readonly<Record<string, number>>,
): boolean {
  for (const [author, seq] of Object.entries(highWater)) {
    if (seq > (requestCursors[author] ?? 0)) return true;
  }
  return false;
}

// ─── Serve ─────────────────────────────────────────────────────────────────

export interface CatchupEnd {
  count: number;
  digest: string;
  responderCursors: Record<string, number>;
  /** The responder's deviceId, sealed. The ack rule needs to attribute
   *  `responderCursors` to a roster member, and presence only carries
   *  connectionIds — see the note on `SyncEngine.deviceIdOf`. */
  deviceId: string;
}

export interface CatchupReplyBody {
  requestId: string;
  chunkNo: number;
  ops: RowOp[];
  end?: CatchupEnd;
}

export interface ServeOptions {
  chunkBytes?: number;
  /** The responder's own deviceId, sealed so the requester can attribute the
   *  cursors in the end marker. */
  deviceId: string;
}

/**
 * Serve one request: every op above the requester's cursors, chunked by bytes,
 * with an authenticated end marker on the last chunk.
 *
 * Reads via the `roomId` index and groups in memory. The compound
 * `[roomId+deviceId+authorSeq]` index would let this be one range walk per
 * author, but bookshelf scale makes the simpler read correct and the
 * optimisation premature — and a wrong compound-key bound silently serves a
 * partial range, which is the failure mode this protocol exists to prevent.
 */
export async function serveCatchup(
  db: OwlshelfDB,
  room: Room,
  request: CatchupRequest,
  options: ServeOptions,
): Promise<CatchupReplyBody[]> {
  const all = await db.ops.where("roomId").equals(room.roomId).toArray();

  const byAuthor = new Map<string, RowOp[]>();
  for (const op of all) {
    const list = byAuthor.get(op.deviceId);
    if (list) list.push(op);
    else byAuthor.set(op.deviceId, [op]);
  }

  const served: RowOp[] = [];
  for (const author of [...byAuthor.keys()].sort()) {
    const cursor = request.cursors[author] ?? 0;
    const range = byAuthor
      .get(author)!
      .filter((op) => op.authorSeq > cursor)
      .sort((a, b) => a.authorSeq - b.authorSeq);
    served.push(...range);
  }

  const responderCursors: Record<string, number> = {
    ...room.cursorIn,
    [options.deviceId]: room.nextAuthorSeq - 1,
  };

  const chunks = chunkByBytes(served, options.chunkBytes ?? CHUNK_BYTES);
  const opIds = served.map((op) => op.opId);
  const digest = await endDigest(opIds);

  if (chunks.length === 0) {
    // An empty reply still needs an end marker: "nothing to send" is a
    // positive statement the requester can verify, not an absence.
    return [
      {
        requestId: request.requestId,
        chunkNo: 0,
        ops: [],
        end: { count: 0, digest, responderCursors, deviceId: options.deviceId },
      },
    ];
  }

  return chunks.map((ops, index) => {
    const body: CatchupReplyBody = {
      requestId: request.requestId,
      chunkNo: index,
      ops,
    };
    if (index === chunks.length - 1) {
      body.end = { count: opIds.length, digest, responderCursors, deviceId: options.deviceId };
    }
    return body;
  });
}

/** Split ops into byte-bounded chunks. A single oversize op gets its own. */
export function chunkByBytes(ops: readonly RowOp[], budget: number): RowOp[][] {
  const chunks: RowOp[][] = [];
  let current: RowOp[] = [];
  let size = 0;

  for (const op of ops) {
    const opSize = JSON.stringify(op).length;
    if (current.length > 0 && size + opSize > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(op);
    size += opSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ─── Collect ───────────────────────────────────────────────────────────────

export type CatchupState =
  | "collecting"
  | "verifying"
  | "complete"
  | "contradicted"
  | "broken";

export type AcceptResult =
  | "chunk"
  | "end"
  | "duplicate"
  | "foreign"
  | "out-of-order"
  | "contradiction";

/**
 * One in-flight catch-up, keyed by `requestId`.
 *
 * `requestId` is REQUIRED (§15.4): two concurrent catch-ups after a reconnect
 * cannot be told apart without it, and mixing their chunks produces a digest
 * that verifies against neither responder.
 */
export class CatchupCollector {
  readonly requestId: string;
  private readonly now: () => number;
  private nextChunk = 0;
  private readonly collected: RowOp[] = [];
  private end: CatchupEnd | null = null;
  private endAt = 0;
  private contradicted = false;
  private broken = false;

  constructor(requestId: string, now: () => number = Date.now) {
    this.requestId = requestId;
    this.now = now;
  }

  get ops(): readonly RowOp[] {
    return this.collected;
  }

  get responderCursors(): Record<string, number> {
    return this.end?.responderCursors ?? {};
  }

  /** Who answered. Null until a verified end marker arrives. */
  get responderDeviceId(): string | null {
    return this.end?.deviceId ?? null;
  }

  get state(): CatchupState {
    if (this.contradicted) return "contradicted";
    if (this.broken) return "broken";
    if (!this.end) return "collecting";
    return this.isComplete() ? "complete" : "verifying";
  }

  async accept(body: CatchupReplyBody): Promise<AcceptResult> {
    if (body.requestId !== this.requestId) return "foreign";

    // Chunks of one reply are strictly ordered by chunkNo and never
    // interleave with another reply to the same requester (§15.4).
    if (body.chunkNo < this.nextChunk) return "duplicate";
    if (body.chunkNo > this.nextChunk) {
      // A gap means a chunk was lost. The session cannot complete, and
      // pretending otherwise would verify a digest over a partial range.
      this.broken = true;
      return "out-of-order";
    }

    this.collected.push(...body.ops);
    this.nextChunk += 1;

    if (!body.end) return "chunk";

    const verified = await this.verify(body.end);
    if (!verified) {
      this.contradicted = true;
      return "contradiction";
    }

    if (this.end) {
      // A second, DIFFERENT end marker inside SETTLE re-opens the room. The
      // same marker twice is just a re-delivery.
      if (this.end.digest !== body.end.digest || this.end.count !== body.end.count) {
        this.contradicted = true;
        return "contradiction";
      }
      return "duplicate";
    }

    this.end = body.end;
    this.endAt = this.now();
    return "end";
  }

  private async verify(end: CatchupEnd): Promise<boolean> {
    if (end.count !== this.collected.length) return false;
    const digest = await endDigest(this.collected.map((op) => op.opId));
    return digest === end.digest;
  }

  /**
   * Complete iff an end marker verified AND SETTLE has passed with no
   * contradiction. Media GC and the "synced" badge wait on this (§8.2): the
   * wrong reading deleted blobs a peer still needed.
   */
  isComplete(at: number = this.now()): boolean {
    if (this.contradicted || this.broken || !this.end) return false;
    return at - this.endAt >= SETTLE;
  }
}
