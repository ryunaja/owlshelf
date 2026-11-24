/**
 * sync.ts — the socket lifecycle and the frame dispatcher (plan §6.6, §9).
 *
 * One `SyncEngine` per room. It owns the socket, the hello, presence, the
 * catch-up orchestration, and the outbox drain. It does NOT own the database
 * write path — every inbound op goes through `admitRemoteOp`, which is the one
 * reducer entry point, so a remote op and a local command converge by
 * construction.
 *
 * The socket is injected. That is not test scaffolding: the same engine runs in
 * a worker, in a tab, and in the harness, and the only thing that differs is
 * which `WebSocket` implementation it is handed.
 */

import { admitRemoteOp } from "./reduce";
import { auditMismatchAction, countOpsByAuthor, localAuditDigest } from "./audit";
import {
  BlobTransfer,
  BLOB_TIMEOUT,
  serveBlob,
  type BlobRequest,
  type FileChunk,
} from "./blob";
import {
  CatchupCollector,
  RESPONDER_SUPPRESS,
  SETTLE,
  buildCatchupRequest,
  responderLadder,
  serveCatchup,
  type CatchupReplyBody,
  type CatchupRequest,
} from "./catchup";
import type { OwlshelfDB } from "./db";
import {
  isEnvelope,
  matchesRoom,
  open,
  roomHash,
  seal,
  type Envelope,
  type EnvelopeKind,
} from "./envelope";
import { applyControlOp, readControlOp } from "./control";
import { pruneRoom } from "./gc";
import { getDeviceKeys } from "./keys";
import { drainPlan, noteAttempt, recordPeerCursors, touchPeer } from "./outbox";
import { admitDevice } from "./rooms";
import { readRoom } from "./roomMeta";
import type { Room, RowOp } from "./stores";

// ─── Status (§15.14) ───────────────────────────────────────────────────────

/**
 * The badge enum. Exhaustive and exclusive — the UI is built from this, not
 * from prose. `attention` is composed by the caller from the room's flags
 * (forked, quarantine, conflicts, sole-copy, waiting-for-peer); the engine
 * only reports the transport states.
 */
export type SyncStatus = "offline" | "connecting" | "syncing" | "synced" | "attention";

// ─── Close codes (§15.4) ───────────────────────────────────────────────────

export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  TRY_LATER: 1013,
  ORIGIN_REFUSED: 4401,
  HANDSHAKE_TIMEOUT: 4402,
  ROOM_CAP: 4403,
  GENERATION_MISMATCH: 4404,
} as const;

/**
 * What to do about a close code.
 *
 * `stop` is the important one: 4401 means this origin will never be allowed,
 * and 4404 means the room was rotated and the device must re-pair. Retrying
 * either is an infinite loop against a permanent condition.
 */
export type CloseAction = "stop" | "reconnect" | "backoff";

export function closeAction(code: number): CloseAction {
  switch (code) {
    case CLOSE.NORMAL:
      return "stop";
    case CLOSE.GOING_AWAY:
      return "reconnect";
    case CLOSE.ORIGIN_REFUSED:
      return "stop";
    case CLOSE.GENERATION_MISMATCH:
      return "stop";
    case CLOSE.TRY_LATER:
    case CLOSE.HANDSHAKE_TIMEOUT:
    case CLOSE.ROOM_CAP:
      return "backoff";
    default:
      return "backoff";
  }
}

// ─── Backoff ───────────────────────────────────────────────────────────────

export const BACKOFF_BASE = 1000;
export const BACKOFF_MAX = 30_000;

/** §6.6: a socket is session-scoped — hidden for this long means disconnect. */
export const HIDDEN_DISCONNECT = 20_000;

/** §6.6: the audit rides the heartbeat, roughly every 5 minutes. */
export const AUDIT_INTERVAL = 5 * 60_000;

/**
 * How often a connected engine pushes its own pending ops.
 *
 * The outbox is written by `executeCommand`, which the engine never sees, so
 * there is no commit event to hook. Without a timer the push half of sync
 * never runs at all: a peer pulls history through catch-up and never sends
 * its own, so two devices with the same room key still never converge.
 *
 * An entry stays pending until a peer's cursor covers it, and `drainPlan` does
 * not gate on `attempts` — so every tick re-sends whatever is still unacked.
 * That is the intended "re-send until adopted" behaviour, and it is why this is
 * 5s rather than 1s: a peer that is simply offline should not be re-sent the
 * same op 60 times a minute. Presence triggers an immediate drain, so the first
 * send is never delayed by a tick.
 *
 * `attempts` is a gate in exactly ONE place, and it is not this one:
 * `decideAck` refuses to ack an entry with zero attempts, because "acked" means
 * every peer has it and zero sends means nobody does. Without that, this timer
 * would ack a fresh mint before its first send and the owner would never
 * announce anything (§5.6, defect 3).
 */
export const DRAIN_INTERVAL = 5_000;

/** Exponential with full jitter, capped. `attempt` is 0-based. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** Math.min(attempt, 10));
  return Math.floor(random() * ceiling);
}

// ─── Socket seam ───────────────────────────────────────────────────────────

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

const defaultSocketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as SocketLike;

/**
 * Where a room with no `relayUrl` of its own should dial.
 *
 * `relayUrl` is per-room and written by pairing (§6.7), which does not exist
 * yet — so every room ships `null` and `connect()` stays offline by design.
 * This is the app-level fallback that lets a fresh profile reach the relay
 * before pairing lands. `VITE_RELAY_URL` overrides it for a real deployment;
 * the localhost default is the dev relay (`backend/app/relay/app.py`).
 */
export const DEFAULT_RELAY_URL: string =
  (import.meta.env?.VITE_RELAY_URL as string | undefined) ?? "ws://localhost:8000/ws";

// ─── Engine ────────────────────────────────────────────────────────────────

export interface SyncEngineOptions {
  db: OwlshelfDB;
  roomId: string;
  deviceId: string;
  socketFactory?: SocketFactory;
  now?: () => number;
  randomUUID?: () => string;
  random?: () => number;
  onStatus?: (status: SyncStatus) => void;
  /** Called for every socket close, BEFORE the close is acted on.
   *
   *  Without this, a refused origin (4401) and an unreachable relay (1006)
   *  both surface as `offline` and nothing else — the operator cannot tell a
   *  misconfigured allowlist from a server that is not running. */
  onClose?: (code: number, reason: string) => void;
  /** Called for every successfully opened envelope, after dispatch. */
  onEnvelope?: (kind: EnvelopeKind, body: unknown, from: string | undefined) => void;
  /** Called when the room needs re-pairing (4404). */
  onRepairNeeded?: () => void;
  /** Called when a blob finished downloading and was verified + stored. */
  onBlob?: (hash: string) => void;
  /** Dialled when the room has no `relayUrl` of its own. Omit to keep the
   *  plan's "a room nobody has paired with stays offline" behaviour. */
  defaultRelayUrl?: string;
  /** Test seam: §6.6's 20s hidden-disconnect window. */
  hiddenDisconnect?: number;
  /** Test seam: §6.6's ~5 min audit cadence. */
  auditInterval?: number;
  /** Test seam: how often a connected engine pushes its pending ops. */
  drainInterval?: number;
  /** Test seam: §15.4's 30s blob timeout. */
  blobTimeout?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Node keeps the event loop alive for a pending timer; a browser does not.
 * Unref where the runtime offers it, so a harness run can exit with an audit
 * scheduled instead of hanging for five minutes.
 */
function unref(timer: ReturnType<typeof setTimeout>): void {
  const handle = timer as unknown as { unref?: () => void };
  if (typeof handle.unref === "function") handle.unref();
}

export class SyncEngine {
  private readonly db: OwlshelfDB;
  private readonly roomId: string;
  private readonly deviceId: string;
  private readonly socketFactory: SocketFactory;
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly random: () => number;
  private readonly onStatus: ((status: SyncStatus) => void) | undefined;
  private readonly onClose: ((code: number, reason: string) => void) | undefined;
  private readonly onEnvelope:
    | ((kind: EnvelopeKind, body: unknown, from: string | undefined) => void)
    | undefined;
  private readonly onRepairNeeded: (() => void) | undefined;
  private readonly onBlob: ((hash: string) => void) | undefined;
  private readonly defaultRelayUrl: string | undefined;
  private readonly hiddenDisconnect: number;
  private readonly auditInterval: number;
  private readonly drainInterval: number;
  private readonly blobTimeout: number;

  private room: Room | null = null;
  private socket: SocketLike | null = null;
  private connId: string | null = null;
  private presence: string[] = [];
  private status: SyncStatus = "offline";
  private attempt = 0;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a dial is in flight, so a retry and a `resume()` cannot both
   *  open a socket. */
  private connecting = false;

  /** Serialises frame handling: `open()` is async, and interleaving two
   *  frames' awaits would let a chunk land out of order. */
  private frameQueue: Promise<void> = Promise.resolve();

  private readonly collectors = new Map<string, CatchupCollector>();
  /** connId → the high-water marks that peer advertised in its last audit. */
  private readonly highWater = new Map<string, Record<string, number>>();

  /** requestId → the suppression timer for a non-elected ladder position. */
  private readonly pendingServe = new Map<string, ReturnType<typeof setTimeout>>();
  /** requestIds some member has announced it is serving. Bounded, see noteStarted. */
  private readonly startedRequests = new Set<string>();

  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private auditTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  /** requestId → the in-flight download. One per room (§6.6). */
  private readonly transfers = new Map<string, BlobTransfer>();
  private readonly blobTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: SyncEngineOptions) {
    this.db = options.db;
    this.roomId = options.roomId;
    this.deviceId = options.deviceId;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.now = options.now ?? Date.now;
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.random = options.random ?? Math.random;
    this.onStatus = options.onStatus;
    this.onClose = options.onClose;
    this.onEnvelope = options.onEnvelope;
    this.onRepairNeeded = options.onRepairNeeded;
    this.onBlob = options.onBlob;
    this.defaultRelayUrl = options.defaultRelayUrl;
    this.hiddenDisconnect = options.hiddenDisconnect ?? HIDDEN_DISCONNECT;
    this.auditInterval = options.auditInterval ?? AUDIT_INTERVAL;
    this.drainInterval = options.drainInterval ?? DRAIN_INTERVAL;
    this.blobTimeout = options.blobTimeout ?? BLOB_TIMEOUT;
  }

  get currentStatus(): SyncStatus {
    return this.status;
  }

  get members(): readonly string[] {
    return this.presence;
  }

  get connectionId(): string | null {
    return this.connId;
  }

  private setStatus(next: SyncStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.onStatus?.(next);
  }

  /**
   * Run a background attempt whose failure must not become an unhandled
   * rejection.
   *
   * The expected failure is `DatabaseClosedError`: a tab closed, the database
   * was deleted, or an older tab holds the upgrade — none of which is a sync
   * failure, and all of which make every read in `connect()` throw. Before
   * this, `resume()` and the retry timer `void`ed those promises, so a closed
   * database surfaced as an unhandled rejection (executed: the harness reported
   * `DatabaseClosedError` against four suites) and, under Node's default
   * policy, killed the process. Reporting `offline` is the whole truthful
   * outcome: the next resume or `room-add` dials from scratch.
   */
  private background(promise: Promise<unknown>): void {
    void promise.catch(() => {
      this.setStatus("offline");
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;
    // The dial comes FIRST. Retention is local storage work, and a `cmd:` scan
    // over a large `meta` table must not sit between the user and their
    // socket. Pruning first also opened a window in which `resume()` — a tab
    // reporting visible right after `room-add` does exactly that — could dial
    // before `connect()` did, leaving two sockets where the first is orphaned:
    // it keeps receiving frames, and its `onclose` later nulls `this.socket`
    // out from under the live one.
    await this.connect();
    await this.prune();
  }

  /**
   * §15.5/§6.6 retention, on the plan's own cadence ("checked on app open").
   *
   * A GC failure must never be a sync failure: a quota error or a corrupt
   * `cmd:` record here would otherwise leave the room permanently offline,
   * which is a far worse outcome than a table that stays too big for another
   * hour. The next start retries, and the floor row is only written after a
   * successful scan.
   */
  private async prune(): Promise<void> {
    try {
      await pruneRoom(this.db, this.roomId, this.now());
    } catch {
      // Deliberately swallowed — see above.
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.teardown(CLOSE.NORMAL, "client-stop");
    this.setStatus("offline");
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.hiddenTimer !== null) {
      clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
    if (this.auditTimer !== null) {
      clearTimeout(this.auditTimer);
      this.auditTimer = null;
    }
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    for (const timer of this.pendingServe.values()) clearTimeout(timer);
    this.pendingServe.clear();
  }

  // ── Session lifecycle (§6.6, §7.1) ───────────────────────────────────────

  /**
   * The tab became visible, the window came back online, or iOS restored the
   * page from BFCache.
   *
   * All three are the same action: resync. `pageshow` with `persisted` fires
   * NEITHER reload NOR `visibilitychange` on iOS, so a listener that only
   * watches visibility misses the most common mobile resume.
   */
  resume(): void {
    if (this.hiddenTimer !== null) {
      clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
    if (this.stopped) {
      this.stopped = false;
      this.background(this.connect());
      return;
    }
    if (!this.socket) {
      this.background(this.connect());
      return;
    }
    this.background(this.requestCatchup());
  }

  /**
   * The tab went hidden. Disconnect after `HIDDEN_DISCONNECT`, not at once:
   * a quick tab switch should not cost a reconnect, and a backgrounded phone
   * is going to be frozen by the OS anyway.
   */
  suspend(): void {
    if (this.hiddenTimer !== null) return;
    this.hiddenTimer = setTimeout(() => {
      this.hiddenTimer = null;
      if (this.stopped) return;
      // 1001 is "going away", which `closeAction` maps to an immediate
      // reconnect — so `resume()` finds a live socket rather than a backoff.
      this.teardown(CLOSE.GOING_AWAY, "hidden");
      this.setStatus("offline");
    }, this.hiddenDisconnect);
    unref(this.hiddenTimer);
  }

  private teardown(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.connId = null;
    this.presence = [];
    if (this.auditTimer !== null) {
      clearTimeout(this.auditTimer);
      this.auditTimer = null;
    }
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    for (const timer of this.pendingServe.values()) clearTimeout(timer);
    this.pendingServe.clear();
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(code, reason);
    } catch {
      /* already gone */
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    // A scheduled retry and a `resume()` can both reach here — `resume()` sees
    // `socket === null` after a drop and dials, while the backoff timer is
    // still pending. Two concurrent attempts would orphan the first socket:
    // it keeps receiving frames, and its `onclose` later nulls `this.socket`
    // out from under the live one. A new attempt supersedes the scheduled one.
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.connecting) return;
    this.connecting = true;
    try {
      await this.openSocket();
    } finally {
      this.connecting = false;
    }
  }

  private async openSocket(): Promise<void> {
    const room = await readRoom(this.db, this.roomId);
    // `stop()` may have run while the room was being read (React StrictMode
    // mounts, unmounts, and remounts every effect). Dialling now would leave a
    // socket nobody owns.
    if (this.stopped) return;
    if (!room) {
      this.setStatus("offline");
      return;
    }
    this.room = room;

    // `relayUrl` is per-room and written by pairing (§6.7). Until pairing
    // exists the app supplies a default, so a fresh profile can reach the
    // relay without a manual step; a room that has its own URL always wins.
    const relayUrl = room.relayUrl ?? this.defaultRelayUrl ?? null;
    if (!relayUrl) {
      // No relay configured: a local-only room is not an error, it is a room
      // nobody has paired with yet. Stay offline rather than retrying.
      this.setStatus("offline");
      return;
    }

    this.setStatus("connecting");
    const connId = this.randomUUID();
    this.connId = connId;

    let socket: SocketLike;
    try {
      socket = this.socketFactory(relayUrl);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      void this.sendHello(room, connId);
    };
    socket.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : null;
      if (raw === null) return;
      this.frameQueue = this.frameQueue
        .then(() => this.handleFrame(raw))
        .catch(() => {
          /* a bad frame is dropped, never fatal */
        });
    };
    socket.onclose = (event) => {
      this.onClose?.(event.code, event.reason);
      this.handleClose(event.code);
    };
    socket.onerror = () => {
      /* onclose always follows; nothing to do here */
    };
  }

  /**
   * Re-read the room so `cursorIn` and `nextAuthorSeq` are CURRENT.
   *
   * `this.room` is loaded once in `connect()`. Every path that ADVERTISES our
   * position — catch-up requests, catch-up replies, audits — reads the
   * counters from it, so a long-lived connection would advertise the position
   * it had at connect time. The visible symptom is the peer's outbox never
   * clearing: it is told we adopted nothing, so it keeps the entry pending
   * forever. The counters only ever move forward, so refreshing is safe.
   */
  private async currentRoom(): Promise<Room | null> {
    const room = await readRoom(this.db, this.roomId);
    if (!room) return null;
    this.room = room;
    return room;
  }

  private async sendHello(room: Room, connId: string): Promise<void> {
    const hash = await roomHash(room.roomKey);
    this.sendRaw({
      v: 1,
      type: "hello",
      connId,
      roomId: room.roomId,
      keyGen: room.keyGen,
      hash,
    });
    this.scheduleAudit();
    this.scheduleDrain();
  }

  /** The audit rides the heartbeat cadence (§6.6). */
  private scheduleAudit(): void {
    if (this.auditTimer !== null) clearTimeout(this.auditTimer);
    this.auditTimer = setTimeout(() => {
      this.auditTimer = null;
      void this.sendAudit().finally(() => {
        if (!this.stopped && this.socket) this.scheduleAudit();
      });
    }, this.auditInterval);
    unref(this.auditTimer);
  }

  /**
   * Push our own pending ops, on a loop, while connected.
   *
   * This is the push half of sync. `drainOutbox` had no caller in the app at
   * all: the engine pulled history through catch-up and never sent its own
   * ops, so two devices sharing a room key still never converged — the outbox
   * just grew. The trigger cannot be a commit event, because `executeCommand`
   * lives in the tab and the engine never sees it, so it is a timer.
   */
  private scheduleDrain(): void {
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drainOutbox()
        .catch(() => {
          /* a closed DB or a dead socket: the next tick retries */
        })
        .finally(() => {
          if (!this.stopped && this.socket) this.scheduleDrain();
        });
    }, this.drainInterval);
    unref(this.drainTimer);
  }

  /**
   * Send one consistency audit.
   *
   * Always asynchronous: local transactions commit immediately (offline-first)
   * and nothing ever blocks on a peer's confirmation. This is an audit, not a
   * distributed commit.
   */
  async sendAudit(): Promise<boolean> {
    const room = await this.currentRoom();
    if (!room || !this.socket) return false;
    const digest = await localAuditDigest(this.db, room.roomId);
    const counts = await countOpsByAuthor(this.db, room.roomId);
    const highWater = { ...room.cursorIn, [this.deviceId]: room.nextAuthorSeq - 1 };
    // `deviceId` is sealed alongside the marks for the same reason the catch-up
    // bodies carry it: presence only names connectionIds, and the ack rule
    // needs to attribute these marks to a roster member. Without it the audit
    // is unattributable and its adoption proof is discarded.
    return this.sendEnvelope("audit", {
      highWater,
      counts,
      digest,
      deviceId: this.deviceId,
    });
  }

  private handleClose(code: number): void {
    this.socket = null;
    this.connId = null;
    this.presence = [];
    if (this.stopped) {
      this.setStatus("offline");
      return;
    }

    const action = closeAction(code);
    if (action === "stop") {
      this.stopped = true;
      this.setStatus("offline");
      if (code === CLOSE.GENERATION_MISMATCH) this.onRepairNeeded?.();
      return;
    }
    if (action === "reconnect") {
      // 1001 is a tab going hidden, not a failure: reconnect immediately and
      // do not inflate the backoff, or a backgrounded phone would take 30s to
      // resume after every visibility change.
      this.attempt = 0;
      this.background(this.connect());
      return;
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.setStatus("offline");
    const delay = backoffDelay(this.attempt, this.random);
    this.attempt += 1;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.background(this.connect());
    }, delay);
    unref(this.retryTimer);
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  private sendRaw(frame: unknown): void {
    if (!this.socket) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      /* the socket died between the check and the send */
    }
  }

  /** Seal and send one body. Returns false when there is no socket. */
  async sendEnvelope(
    kind: EnvelopeKind,
    body: unknown,
    to?: string,
  ): Promise<boolean> {
    const room = this.room;
    if (!room || !this.socket) return false;
    const envelope = await seal(room.roomKey, room.roomId, room.keyGen, kind, body, { to });
    this.sendRaw(envelope);
    return true;
  }

  /** Push one op to the room. The outbox is the durable record; this is the
   *  transport attempt. */
  async sendOp(op: RowOp): Promise<boolean> {
    const sent = await this.sendEnvelope("op", op);
    if (sent) await noteAttempt(this.db, op.opId);
    return sent;
  }

  /** Resume the outbox: evaluate acks, then send a bounded batch. */
  async drainOutbox(): Promise<number> {
    const plan = await drainPlan(this.db, this.roomId, this.now());
    let sent = 0;
    for (const entry of plan.send) {
      const op = await this.db.ops.get(entry.opId);
      if (!op) continue;
      if (await this.sendOp(op)) sent += 1;
    }
    return sent;
  }

  // ── Catch-up ─────────────────────────────────────────────────────────────

  /**
   * Ask EVERY presence member for what we are missing.
   *
   * Fan-out is for the request only; the replies are elected by the responder.
   * A single named peer may be stale and answer "complete" while missing
   * history (audit-2 N12).
   */
  async requestCatchup(): Promise<string | null> {
    const room = await this.currentRoom();
    if (!room || this.presence.length === 0) return null;

    const requestId = this.randomUUID();
    const request = buildCatchupRequest(room, requestId, this.deviceId);
    this.collectors.set(requestId, new CatchupCollector(requestId, this.now));
    this.setStatus("syncing");

    for (const connId of this.presence) {
      await this.sendEnvelope("catchup-request", request, connId);
    }
    return requestId;
  }

  /** The collector for a request, for tests and for the status badge. */
  collector(requestId: string): CatchupCollector | undefined {
    return this.collectors.get(requestId);
  }

  // ── Receiving ────────────────────────────────────────────────────────────

  private async handleFrame(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    const type = parsed.type;
    if (type === "presence") {
      this.handlePresence(parsed);
      return;
    }
    if (type === "ping") {
      this.sendRaw({ type: "pong" });
      return;
    }
    if (type === "pong") return;
    if (type === "moved") return;

    if (!isEnvelope(parsed)) return;

    const room = this.room;
    if (!room) return;
    // Gate two of three: the client's socket-room check, before the decrypt.
    if (!matchesRoom(parsed, room.roomId, room.keyGen)) return;

    // Gate three: the AEAD tag. A tampered, injected, or replayed envelope
    // fails here and is dropped without touching durable state (P0-7).
    const body = await open(room.roomKey, parsed);
    if (body === null) return;

    await this.dispatch(parsed, body);
    this.onEnvelope?.(parsed.kind, body, parsed.from);
  }

  private handlePresence(frame: Record<string, unknown>): void {
    const members = frame.members;
    if (!Array.isArray(members)) return;
    this.presence = members.filter((m): m is string => typeof m === "string");
    // A newcomer means there may be history we do not have. Asking on every
    // presence change is cheap (one sealed frame per member) and is what makes
    // a fresh device converge without a manual sync button.
    if (this.presence.length > 0) {
      this.background(this.requestCatchup());
      // And push what we have: a peer appearing is the first moment a send can
      // succeed, so waiting for the drain timer would delay the first op by a
      // whole interval for no reason.
      void this.drainOutbox().catch(() => {
        /* the timer retries */
      });
    }
  }

  private async dispatch(envelope: Envelope, body: unknown): Promise<void> {
    // Any sealed body that names its sender's deviceId is AUTHENTICATED
    // evidence of who is on that connection — the peer cannot claim to be
    // someone else without failing the AEAD tag. This is the only source of
    // the connId → deviceId mapping the ack rule needs.
    if (isRecord(body) && typeof body.deviceId === "string" && envelope.from) {
      this.connToDevice.set(envelope.from, body.deviceId);
    }

    switch (envelope.kind) {
      case "op": {
        if (!isRecord(body)) return;
        await admitRemoteOp(this.db, body as unknown as RowOp, { now: this.now });
        return;
      }
      case "catchup-request": {
        await this.handleCatchupRequest(envelope, body);
        return;
      }
      case "catchup-reply": {
        await this.handleCatchupReply(envelope, body);
        return;
      }
      case "audit": {
        await this.handleAudit(envelope, body);
        return;
      }
      case "control": {
        await this.handleControl(body);
        return;
      }
      case "blob-request": {
        await this.handleBlobRequest(envelope, body);
        return;
      }
      case "file-chunk": {
        await this.handleFileChunk(envelope, body);
        return;
      }
      default:
        // audit-bisect belongs to step 7; an unknown kind is dropped, never
        // guessed at.
        return;
    }
  }

  private async handleCatchupRequest(envelope: Envelope, body: unknown): Promise<void> {
    const room = await this.currentRoom();
    if (!room || !isRecord(body)) return;
    const request = body as unknown as CatchupRequest;
    if (typeof request.requestId !== "string") return;
    if (!isRecord(request.cursors)) return;

    // Adoption proof #1 of three (§6.6): the cursors a peer advertises in its
    // catch-up request. Recorded BEFORE serving, so a peer that asks and then
    // disconnects still unblocks our outbox.
    if (typeof request.deviceId === "string") {
      await recordPeerCursors(
        this.db,
        this.roomId,
        request.deviceId,
        request.cursors,
        this.now(),
      );
      await this.admitPeer(request.deviceId);
    }

    // Our own coverage is known exactly, and it must be on the ladder: the
    // high-water map only ever holds PEERS (we never receive our own audit), so
    // without this seed the lowest covering member could never be elected and
    // every request would fall through to the liveness fallback.
    const highWater = new Map(this.highWater);
    if (this.connId !== null) {
      highWater.set(this.connId, {
        ...room.cursorIn,
        [this.deviceId]: room.nextAuthorSeq - 1,
      });
    }

    const ladder = responderLadder(this.presence, highWater, request.cursors);
    const rank = this.connId === null ? -1 : ladder.indexOf(this.connId);

    if (rank === 0) {
      await this.serveRequest(request, envelope.from);
      return;
    }
    if (rank > 0) {
      // Suppress, then answer only if nobody announced they started. The
      // ladder position sets the delay, so a dead elected responder costs one
      // window rather than stalling the room until the next presence change.
      this.scheduleServe(request, envelope.from, rank * RESPONDER_SUPPRESS);
      return;
    }

    // Nobody is known to cover the request. High-water marks only arrive with
    // the audit (~5 min), so a fresh connection has none and a spec-literal
    // election would deadlock. The lowest OTHER connection tries immediately.
    if (lowestOther(this.presence, envelope.from) === this.connId) {
      await this.serveRequest(request, envelope.from);
    }
  }

  private scheduleServe(
    request: CatchupRequest,
    from: string | undefined,
    delay: number,
  ): void {
    this.cancelServe(request.requestId);
    const timer = setTimeout(() => {
      this.pendingServe.delete(request.requestId);
      if (this.startedRequests.has(request.requestId)) return;
      void this.serveRequest(request, from);
    }, delay);
    unref(timer);
    this.pendingServe.set(request.requestId, timer);
  }

  private cancelServe(requestId: string): void {
    const timer = this.pendingServe.get(requestId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingServe.delete(requestId);
  }

  /**
   * Bounded on purpose: a duplicate serve is harmless (dedup absorbs it), so
   * clearing the set under pressure is cheaper than tracking expiry.
   */
  private noteStarted(requestId: string): void {
    if (this.startedRequests.size >= 256) this.startedRequests.clear();
    this.startedRequests.add(requestId);
  }

  private async serveRequest(
    request: CatchupRequest,
    from: string | undefined,
  ): Promise<void> {
    const room = await this.currentRoom();
    if (!room) return;
    if (this.startedRequests.has(request.requestId)) return;
    this.noteStarted(request.requestId);
    this.cancelServe(request.requestId);

    // Announce, so the rest of the ladder cancels its timers. Without this the
    // suppression window is a guess rather than a handshake.
    await this.sendEnvelope("control", {
      type: "catchup-started",
      requestId: request.requestId,
    });

    const replies = await serveCatchup(this.db, room, request, { deviceId: this.deviceId });
    for (const reply of replies) {
      await this.sendEnvelope("catchup-reply", reply, from);
    }
  }

  private async handleControl(body: unknown): Promise<void> {
    if (!isRecord(body)) return;

    // §6.7's signed room control. A body that is not a well-formed op is
    // dropped, never "best-effort applied": the shape check IS the admission
    // step for control traffic (§6.4 — control ops have no `table`, so the row
    // path's allowlist cannot admit them).
    if (body.type === "control-op") {
      const op = readControlOp(body.op);
      if (!op) return;
      if (op.roomId !== this.roomId) return;
      const result = await applyControlOp(this.db, this.roomId, op);
      if (!result.ok) return;
      if (result.applied === "rotate-key") {
        // STOP minting into a room nobody will read (§6.7 step 3). The UI
        // surfaces "re-pair with the owner"; the honest state is that this
        // device's edits are stranded until it does.
        this.setStatus("attention");
        this.onRepairNeeded?.();
      }
      return;
    }

    if (body.type !== "catchup-started") return;
    const requestId = body.requestId;
    if (typeof requestId !== "string") return;
    this.noteStarted(requestId);
    this.cancelServe(requestId);
  }

  /**
   * The owner's half of "the roster grows by signature" (§6.7, `rooms.ts`).
   *
   * Called when a peer authenticates contact. A peer cannot add itself — that
   * stopgap let a revoked device re-admit itself — so the owner mints epoch + 1
   * and broadcasts it. Being automatic is deliberate: possession of the room key
   * is already the membership credential, and revocation is key rotation, so
   * this changes no access; it only lets the ack rule wait for the peer.
   *
   * Failures are swallowed. A roster that cannot be extended must not take the
   * connection down with it.
   */
  private async admitPeer(peerDeviceId: string): Promise<void> {
    try {
      const room = await this.currentRoom();
      if (!room) return;
      if (room.ownerPub === undefined) return;
      // A pending rotation means this room is on its way out; admitting a peer
      // to it would tell them they belong somewhere that no longer exists.
      if (room.rotationPending !== undefined) return;
      if (room.roster.some((member) => member.deviceId === peerDeviceId)) return;

      const keys = await getDeviceKeys(this.db);
      const result = await admitDevice(room.roomId, peerDeviceId, {
        db: this.db,
        getDeviceId: async () => this.deviceId,
        keys,
        now: () => this.now(),
      });
      if (result.ok) {
        await this.sendEnvelope("control", { type: "control-op", op: result.op });
      }
    } catch {
      /* see the doc comment: never fatal */
    }
  }

  // ── Blobs (§6.6, §15.4) ──────────────────────────────────────────────────

  /**
   * Ask every presence member for a blob.
   *
   * Fan-out for the same reason catch-up fans out: the peer that has the row
   * is not necessarily the peer that has the bytes, and a negative answer is
   * cheap. The first complete, hash-verified stream wins; the rest are
   * dropped when the transfer is removed.
   */
  async requestBlob(hash: string): Promise<string | null> {
    const room = this.room;
    if (!room || this.presence.length === 0) return null;

    // One outstanding transfer per room (§6.6): a second request for a hash
    // already in flight would double the memory for no gain.
    for (const transfer of this.transfers.values()) {
      if (transfer.hash === hash && !transfer.isFailed) return transfer.requestId;
    }

    const requestId = this.randomUUID();
    this.transfers.set(requestId, new BlobTransfer(requestId, hash, this.now));

    const request: BlobRequest = { requestId, hash, deviceId: this.deviceId };
    for (const connId of this.presence) {
      await this.sendEnvelope("blob-request", request, connId);
    }

    const timer = setTimeout(() => {
      this.blobTimers.delete(requestId);
      this.transfers.delete(requestId);
    }, this.blobTimeout);
    unref(timer);
    this.blobTimers.set(requestId, timer);

    return requestId;
  }

  /** The in-flight transfer for a request, for tests and for the UI. */
  transfer(requestId: string): BlobTransfer | undefined {
    return this.transfers.get(requestId);
  }

  /** Hashes currently downloading. GC must not delete these (§8.2). */
  activeTransfers(): string[] {
    return [...this.transfers.values()].map((transfer) => transfer.hash);
  }

  private async handleBlobRequest(envelope: Envelope, body: unknown): Promise<void> {
    const room = this.room;
    if (!room || !isRecord(body)) return;
    const request = body as unknown as BlobRequest;
    if (typeof request.requestId !== "string") return;
    if (typeof request.hash !== "string" || request.hash.length === 0) return;

    const chunks = await serveBlob(this.db, room.roomId, request, {
      deviceId: this.deviceId,
    });
    for (const chunk of chunks) {
      await this.sendEnvelope("file-chunk", chunk, envelope.from);
    }
  }

  private async handleFileChunk(_envelope: Envelope, body: unknown): Promise<void> {
    if (!isRecord(body)) return;
    const chunk = body as unknown as FileChunk;
    if (typeof chunk.requestId !== "string") return;

    const transfer = this.transfers.get(chunk.requestId);
    if (!transfer) return;

    const result = await transfer.accept(chunk);
    if (result === "negative") {
      // This peer does not hold it. Others may, so the transfer stays open
      // until the 30s bound — "not held" is a bounded wait, not an error.
      return;
    }
    if (result !== "complete") return;

    this.transfers.delete(chunk.requestId);
    this.clearBlobTimer(chunk.requestId);

    const bytes = transfer.bytes;
    if (!bytes) return;

    // Verified BEFORE the write: `accept` only returns "complete" once
    // sha256(bytes) === hash, so nothing unverified ever reaches `files`.
    await this.db.files.put({
      roomId: this.roomId,
      hash: transfer.hash,
      bytes,
      contentType: transfer.contentTypeValue,
      size: bytes.byteLength,
      createdAt: this.now(),
    });
    this.onBlob?.(transfer.hash);
  }

  private clearBlobTimer(requestId: string): void {
    const timer = this.blobTimers.get(requestId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.blobTimers.delete(requestId);
  }

  private async handleCatchupReply(_envelope: Envelope, body: unknown): Promise<void> {
    if (!isRecord(body)) return;
    const reply = body as unknown as CatchupReplyBody;
    if (typeof reply.requestId !== "string") return;

    const collector = this.collectors.get(reply.requestId);
    if (!collector) return;

    const result = await collector.accept(reply);
    if (result === "out-of-order") {
      // A lost chunk. The session cannot verify a partial range, so drop it and
      // start a fresh one — "restartable" is the step's own word for this, and
      // a collector that stays broken forever is a room that never converges.
      this.collectors.delete(reply.requestId);
      this.background(this.requestCatchup());
      return;
    }
    if (result === "contradiction") {
      this.setStatus("attention");
      return;
    }
    if (result !== "end") return;

    // The end marker carries the responder's CURSORS (audit-2 N8): ops alone
    // are a delivery proof, cursors are the adoption proof the outbox needs.
    const responderDevice = collector.responderDeviceId;
    if (responderDevice) {
      await recordPeerCursors(
        this.db,
        this.roomId,
        responderDevice,
        collector.responderCursors,
        this.now(),
      );
      await this.admitPeer(responderDevice);
    }

    // Adopt the ops. `admitRemoteOp` is the one reducer entry point, so this
    // is the same path a live op takes.
    for (const op of collector.ops) {
      await admitRemoteOp(this.db, op, { now: this.now });
    }

    // Completion waits SETTLE: a contradiction arriving inside the window
    // re-opens the room, and media GC must not run before it closes.
    const settleTimer = setTimeout(() => {
      if (collector.isComplete(this.now())) this.setStatus("synced");
    }, SETTLE);
    unref(settleTimer);
  }

  private async handleAudit(envelope: Envelope, body: unknown): Promise<void> {
    if (!isRecord(body)) return;
    const highWater = body.highWater;
    if (!isRecord(highWater)) return;
    const from = typeof envelope.from === "string" ? envelope.from : null;
    if (!from) return;

    const marks: Record<string, number> = {};
    for (const [author, seq] of Object.entries(highWater)) {
      if (typeof seq === "number" && Number.isInteger(seq) && seq >= 0) marks[author] = seq;
    }
    this.highWater.set(from, marks);

    const deviceId = this.deviceIdOf(from);
    if (deviceId) {
      await touchPeer(this.db, this.roomId, deviceId, this.now());
      // Adoption proof #3 of three (§6.6): the audit's high-water marks.
      await recordPeerCursors(this.db, this.roomId, deviceId, marks, this.now());
      await this.admitPeer(deviceId);
    }

    if (typeof body.digest !== "string") return;
    const room = await this.currentRoom();
    if (!room) return;

    const mine = {
      digest: await localAuditDigest(this.db, room.roomId),
      highWater: { ...room.cursorIn, [this.deviceId]: room.nextAuthorSeq - 1 },
    };
    const action = auditMismatchAction(mine, { digest: body.digest, highWater: marks });

    if (action === "catchup") {
      // Rung 1: a device is behind, not divergent. The common case.
      this.background(this.requestCatchup());
      return;
    }
    if (action === "rebuild") {
      // Rung 2: same log, different rows — reducer non-determinism, a bug. The
      // rebuild is step 7's compaction path; until then the badge is the honest
      // signal, and a silent "synced" would be a lie.
      this.setStatus("attention");
    }
  }

  /**
   * Map a connectionId to a deviceId.
   *
   * The spec never defines this mapping: presence carries connectionIds, but
   * the ack rule needs deviceIds. It is resolved from the sealed bodies, which
   * carry the sender's deviceId — authenticated, so a peer cannot claim to be
   * someone else. A connection that has never sent a sealed body is unknown,
   * and an unknown peer simply does not count as reachable, which keeps its
   * ops pending rather than acking them on no evidence.
   */
  private readonly connToDevice = new Map<string, string>();

  private deviceIdOf(connId: string): string | null {
    return this.connToDevice.get(connId) ?? null;
  }

  /** Record the authenticated deviceId of a peer connection. */
  notePeerDevice(connId: string, deviceId: string): void {
    this.connToDevice.set(connId, deviceId);
  }
}

/**
 * The lowest presence member that is not the requester.
 *
 * Used only when no member is known to cover the request — see the election
 * comment in `handleCatchupRequest`. Deterministic, so two members never both
 * decide they are the fallback.
 */
function lowestOther(presence: readonly string[], exclude: string | undefined): string | null {
  const candidates = presence.filter((connId) => connId !== exclude).sort();
  return candidates[0] ?? null;
}
