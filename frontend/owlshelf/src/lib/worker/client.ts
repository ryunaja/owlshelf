/**
 * client.ts — the tab side of the single-writer split (plan §5).
 *
 * A tab never writes. It posts a semantic command and awaits the commit ack.
 * This file is the only place a tab talks to the writer, so the fallback
 * ladder lives here too:
 *
 *   1. **SharedWorker** — one writer per origin, every tab connects a port.
 *   2. **Web Locks + dedicated Worker + BroadcastChannel** — the lock elects
 *      one tab as leader; the leader owns the worker; followers relay their
 *      requests over the channel. Followers never write, so the single-writer
 *      rule survives the fallback.
 *   3. **Tab mode** — no SharedWorker, no Web Locks. The host runs in the tab
 *      and the app must show a "single-tab mode" notice, because a second tab
 *      would be a second writer.
 *
 * Request/reply correlation is by `id`, not by order: a port is one ordered
 * stream shared by every in-flight command in the tab, so two dialogs saving at
 * once would otherwise swap acks.
 *
 * Every seam is injectable (`StartOptions`) because Node has neither
 * `SharedWorker` nor `navigator.locks`. The harness drives the ladder with
 * fakes and the same code the browser runs.
 */

import { CommandError, type Command, type CommandAck, type MoveResult } from "../cmd";
import { db as appDb, getDeviceId as appGetDeviceId } from "../db";
import type { Profile } from "../../types/item";
import { createWorkerHost, type PortLike, type WorkerHost } from "./host";
import {
  isReply,
  type DevOp,
  type DevState,
  type MintReply,
  type MoveManyRequest,
  type PairingReply,
  type RoomInfo,
  type WorkerEvent,
  type WorkerReply,
  type WorkerRequest,
} from "./protocol";

// ─── Transport ─────────────────────────────────────────────────────────────

/**
 * What the client needs from whatever is carrying its messages.
 *
 * `onReply`/`onEvent` SUBSCRIBE rather than assign: the leader's relay and the
 * client both listen to the same inner transport, and an assigning API would
 * let the second subscriber silently steal the first one's messages.
 */
export interface Transport {
  send(request: WorkerRequest): void;
  onReply(handler: (reply: WorkerReply) => void): () => void;
  onEvent(handler: (event: WorkerEvent) => void): () => void;
  close(): void;
}

/**
 * The shape `MessagePort` and `Worker` share. `Worker` has no `start()`/`close()`
 * — it is already started and is stopped with `terminate()` — so both are
 * optional here and `portTransport` only calls what exists.
 */
export interface MessageEndpoint {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  start?(): void;
  close?(): void;
  terminate?(): void;
}

/** A `MessagePort` (SharedWorker) or `Worker` (dedicated) as a transport. */
export function portTransport(port: MessageEndpoint): Transport {
  const replies = new Set<(reply: WorkerReply) => void>();
  const events = new Set<(event: WorkerEvent) => void>();
  port.onmessage = (event) => {
    const message = event.data as WorkerReply | WorkerEvent;
    if (isReply(message)) for (const handler of replies) handler(message);
    else for (const handler of events) handler(message);
  };
  port.start?.();
  return {
    send: (request) => port.postMessage(request),
    onReply: (handler) => {
      replies.add(handler);
      return () => replies.delete(handler);
    },
    onEvent: (handler) => {
      events.add(handler);
      return () => events.delete(handler);
    },
    close: () => {
      port.close?.();
      port.terminate?.();
    },
  };
}

/**
 * An in-process transport over a `WorkerHost`.
 *
 * Two callers: tab mode (no SharedWorker, no Web Locks) and the harness. It is
 * the same host the worker runs, so tab mode is not a second implementation of
 * the write path — it is the same one without a thread boundary.
 *
 * It still ATTACHES a synthetic port, because the host's per-port state is
 * load-bearing: `visibility` is tracked per port (§6.6's "every port reports
 * hidden") and `room-add`/`room-remove` are reference-counted per port, so a
 * transport with no identity would make tab mode behave differently from the
 * real thing. The port also carries the host's broadcasts back to this tab.
 */
export function localTransport(host: WorkerHost): Transport {
  const replies = new Set<(reply: WorkerReply) => void>();
  const events = new Set<(event: WorkerEvent) => void>();
  const port: PortLike = {
    post: (message) => {
      if (isReply(message as WorkerReply)) {
        for (const handler of replies) handler(message as WorkerReply);
      } else {
        for (const handler of events) handler(message as WorkerEvent);
      }
    },
    onMessage: () => {
      /* requests go through `send` below, not through the port */
    },
  };
  const detach = host.attach(port);
  return {
    send: (request) => {
      void host.handle(request, port).then((reply) => port.post(reply));
    },
    onReply: (handler) => {
      replies.add(handler);
      return () => replies.delete(handler);
    },
    onEvent: (handler) => {
      events.add(handler);
      return () => events.delete(handler);
    },
    close: () => {
      detach();
      replies.clear();
      events.clear();
    },
  };
}

// ─── Client ────────────────────────────────────────────────────────────────

/**
 * A transport whose backing can be replaced, re-sending whatever is still
 * unanswered.
 *
 * This is what makes leader promotion safe. A follower's command goes out on
 * the BroadcastChannel addressed to the leader; if the leader tab dies before
 * answering, that request is stranded. On promotion the tab swaps to its own
 * worker and re-sends every stranded request.
 *
 * Re-sending is safe because a command is idempotent on `cmdId` (§15.5): if the
 * dead leader had committed it, the new leader reads the same IndexedDB, sees
 * the `cmdId` already recorded, and returns the ORIGINAL ack; if it had not, the
 * new leader mints it exactly once. Without that invariant this would be a
 * duplicate-write bug, which is why the two are documented together.
 */
function switchableTransport(initial: Transport): {
  transport: Transport;
  swap: (next: Transport) => void;
} {
  let current = initial;
  const inflight = new Map<number, WorkerRequest>();
  const replies = new Set<(reply: WorkerReply) => void>();
  const events = new Set<(event: WorkerEvent) => void>();

  const forwardReply = (reply: WorkerReply) => {
    inflight.delete(reply.id);
    for (const handler of replies) handler(reply);
  };
  const forwardEvent = (event: WorkerEvent) => {
    for (const handler of events) handler(event);
  };

  let unsubscribeReply = current.onReply(forwardReply);
  let unsubscribeEvent = current.onEvent(forwardEvent);

  return {
    transport: {
      send: (request) => {
        inflight.set(request.id, request);
        current.send(request);
      },
      onReply: (handler) => {
        replies.add(handler);
        return () => replies.delete(handler);
      },
      onEvent: (handler) => {
        events.add(handler);
        return () => events.delete(handler);
      },
      close: () => {
        unsubscribeReply();
        unsubscribeEvent();
        current.close();
      },
    },
    swap(next) {
      unsubscribeReply();
      unsubscribeEvent();
      current = next;
      unsubscribeReply = next.onReply(forwardReply);
      unsubscribeEvent = next.onEvent(forwardEvent);
      for (const request of inflight.values()) next.send(request);
    },
  };
}

export interface WorkerClient {
  post(cmd: Command): Promise<CommandAck>;
  moveMany(request: MoveManyRequest): Promise<MoveResult[]>;
  createProfile(data: Omit<Profile, "id">): Promise<Profile>;
  /** §5 detail 1: the worker has no `document`, so the tab proxies this.
   *  `hidden: false` is also §7.1's "resync all rooms". */
  setVisibility(hidden: boolean): void;
  /** §6.6: put a room in the worker's engine set. Reference-counted per port,
   *  so a tab unmounting cannot stop an engine another tab is using. */
  roomAdd(roomId: string): Promise<void>;
  roomRemove(roomId: string): Promise<void>;
  /** §6.6 pull side: ask the writer to fetch a blob this tab cannot find. */
  demandBlob(roomId: string, hash: string): Promise<boolean>;
  // ── Pairing (§6.7) ───────────────────────────────────────────────────────
  /** The QR fragment for a room at its CURRENT generation (create + re-pair). */
  mintInvite(roomId: string): Promise<MintReply>;
  /** Join a new room. Refuses a room this device already holds data for. */
  joinRoom(text: string, name?: string): Promise<PairingReply>;
  /** Adopt a rotation code for a room this device already holds. */
  adoptRotation(text: string): Promise<PairingReply>;
  /** Owner-only: remove a device from the roster and rotate the key. */
  revokeDevice(roomId: string, deviceId: string): Promise<PairingReply>;
  /** Purge this device's copy, keeping the signed leave statement. */
  leaveRoom(roomId: string): Promise<void>;
  /** Accept or ignore a staged relay move (§6.7's trust prompt). */
  resolveRehome(roomId: string, accept: boolean): Promise<void>;
  /** Roster, role, generation, rotation state and engine status in one read. */
  roomInfo(roomId: string): Promise<RoomInfo>;
  /** "Try again" on a failed shelf: dial now instead of waiting out the backoff. */
  syncRetry(roomId: string): Promise<void>;
  /** Unsolicited worker → tab messages (`blob-arrived`, `sync-status`). */
  onEvent(handler: (event: WorkerEvent) => void): () => void;
  /**
   * This tab became the writer.
   *
   * Rung 2 only: the leader owns a DEDICATED worker, so when the leader tab
   * unloads that worker dies with it and the promoted tab spawns a fresh one
   * with an empty engine map. `switchableTransport` re-sends stranded
   * REQUESTS, but a `room-add` that already got its reply is not stranded — so
   * without this hook every engine is silently lost on handoff.
   *
   * A no-op on rungs 1 and 3, where the writer never moves.
   */
  onPromote(handler: () => void): () => void;
  // ── Dev-only (Gate G instrumentation) ────────────────────────────────────
  devOp(roomId: string, op: DevOp, hash?: string): Promise<unknown>;
  devState(roomId: string): Promise<DevState>;
  devExportRoom(roomId: string): Promise<string | null>;
  devImportRoom(text: string): Promise<void>;
  devSetRelay(roomId: string, url: string): Promise<void>;
  close(): void;
}

export function createWorkerClient(
  transport: Transport,
  /** Rung 2's promotion subscription. Omitted on rungs 1 and 3, where the
   *  writer never moves, so `onPromote` is a no-op there. */
  promotions?: (handler: () => void) => () => void,
): WorkerClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  transport.onReply((reply) => {
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.ok) waiter.resolve(reply.value);
    // The code is preserved so a caller can branch on `quota` vs `validation`
    // without importing the worker's error class.
    else waiter.reject(new CommandError(reply.error.code as never, reply.error.message));
  });

  function request<T>(build: (id: number) => WorkerRequest): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      transport.send(build(id));
    });
  }

  /** A request whose reply carries nothing. The host answers `null`; the
   *  interface says `void`, so the mapping lives here and no call site has to
   *  know the wire detail. */
  function requestVoid(build: (id: number) => WorkerRequest): Promise<void> {
    return request<null>(build).then(() => undefined);
  }

  return {
    post: (cmd) => request<CommandAck>((id) => ({ id, kind: "cmd", cmd })),
    moveMany: (moveRequest) =>
      request<MoveResult[]>((id) => ({ id, kind: "move-many", request: moveRequest })),
    createProfile: (data) => request<Profile>((id) => ({ id, kind: "create-profile", data })),
    setVisibility: (hidden) => {
      // Fire and forget: a visibility change is not worth a round trip, and
      // the reply would have no caller to receive it.
      transport.send({ id: nextId++, kind: "visibility", hidden });
    },
    roomAdd: (roomId) => requestVoid((id) => ({ id, kind: "room-add", roomId })),
    roomRemove: (roomId) => requestVoid((id) => ({ id, kind: "room-remove", roomId })),
    demandBlob: (roomId, hash) =>
      request<boolean>((id) => ({ id, kind: "blob-demand", roomId, hash })),
    mintInvite: (roomId) =>
      request<MintReply>((id) => ({ id, kind: "pairing-mint", roomId })),
    joinRoom: (text, name) =>
      request<PairingReply>((id) => ({
        id,
        kind: "pairing-join",
        text,
        ...(name === undefined ? {} : { name }),
      })),
    adoptRotation: (text) =>
      request<PairingReply>((id) => ({ id, kind: "pairing-adopt", text })),
    revokeDevice: (roomId, deviceId) =>
      request<PairingReply>((id) => ({ id, kind: "pairing-revoke", roomId, deviceId })),
    leaveRoom: (roomId) => requestVoid((id) => ({ id, kind: "pairing-leave", roomId })),
    resolveRehome: (roomId, accept) =>
      requestVoid((id) => ({ id, kind: "pairing-rehome", roomId, accept })),
    roomInfo: (roomId) => request<RoomInfo>((id) => ({ id, kind: "room-info", roomId })),
    syncRetry: (roomId) => requestVoid((id) => ({ id, kind: "sync-retry", roomId })),
    onEvent: (handler) => transport.onEvent(handler),
    onPromote: (handler) => promotions?.(handler) ?? (() => {}),
    devOp: (roomId, op, hash) =>
      request<unknown>((id) => ({ id, kind: "dev-op", roomId, op, hash })),
    devState: (roomId) => request<DevState>((id) => ({ id, kind: "dev-state", roomId })),
    devExportRoom: (roomId) =>
      request<string | null>((id) => ({ id, kind: "dev-export-room", roomId })),
    devImportRoom: (text) =>
      requestVoid((id) => ({ id, kind: "dev-import-room", text })),
    devSetRelay: (roomId, url) =>
      requestVoid((id) => ({ id, kind: "dev-set-relay", roomId, url })),
    close: () => {
      for (const waiter of pending.values()) {
        waiter.reject(new CommandError("internal", "worker client closed"));
      }
      pending.clear();
      transport.close();
    },
  };
}

// ─── The fallback ladder ───────────────────────────────────────────────────

export type WorkerMode = "shared" | "dedicated" | "tab";

export interface StartedClient {
  client: WorkerClient;
  mode: WorkerMode;
  /** True when the app must warn that a second tab would be a second writer. */
  singleTabOnly: boolean;
  /** Whether this tab holds the writer role RIGHT NOW. A follower can be
   *  promoted when the leader tab goes away, so this is a function, not a
   *  snapshot. Always true on rungs 1 and 3. */
  isLeader: () => boolean;
}

export interface StartOptions {
  /** Test seams. Production passes nothing and the real globals are used. */
  createSharedWorker?: () => MessageEndpoint | null;
  createDedicatedWorker?: () => MessageEndpoint | null;
  locks?: LockManager | null;
  channel?: BroadcastChannel | null;
  /** Tab-mode host. Production builds one over the app singleton. */
  host?: WorkerHost;
}

const LOCK_NAME = "owlshelf-sync";
const CHANNEL_NAME = "owlshelf-sync";

// Vite only rewrites a worker URL it can see statically, so `new URL(...,
// import.meta.url)` has to sit inline in the constructor call. Hoisting it to a
// const would ship a literal `./entry.ts` path to the browser.
function defaultSharedWorker(): MessageEndpoint | null {
  if (typeof SharedWorker === "undefined") return null;
  try {
    return new SharedWorker(new URL("./entry.ts", import.meta.url), {
      type: "module",
      name: CHANNEL_NAME,
    }).port;
  } catch {
    return null;
  }
}

function defaultDedicatedWorker(): MessageEndpoint | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./entry.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

/** The tab-mode host over the app singleton. */
function defaultHost(): WorkerHost {
  return createWorkerHost({ db: appDb, getDeviceId: appGetDeviceId });
}

/**
 * A follower's transport: requests go out on the channel addressed to the
 * leader, replies come back addressed to this tab.
 *
 * The leader is the only tab holding the Web Lock, so it is the only tab with
 * a writer. A follower that cannot reach the leader fails its command rather
 * than writing locally — a second writer is the bug this whole file prevents.
 */
function relayTransport(channel: BroadcastChannel, tabId: string): Transport {
  const replies = new Set<(reply: WorkerReply) => void>();
  const events = new Set<(event: WorkerEvent) => void>();
  channel.onmessage = (event) => {
    const message = event.data as
      | { to: string; reply: WorkerReply }
      | { to: string; event: WorkerEvent };
    // `"*"` is a broadcast: events are not addressed to one tab, because every
    // tab has its own media cache to invalidate.
    if (message.to !== tabId && message.to !== "*") return;
    if ("reply" in message) for (const handler of replies) handler(message.reply);
    else for (const handler of events) handler(message.event);
  };
  return {
    send: (request) => channel.postMessage({ to: "leader", request, from: tabId }),
    onReply: (handler) => {
      replies.add(handler);
      return () => replies.delete(handler);
    },
    onEvent: (handler) => {
      events.add(handler);
      return () => events.delete(handler);
    },
    close: () => channel.close(),
  };
}

/**
 * The leader's side of the relay: forward follower requests to the real
 * transport and broadcast the replies back.
 *
 * The leader REWRITES the id. `id` is unique per tab, not globally, so a
 * follower's id 1 and the leader's own id 1 would otherwise collide and the
 * follower would resolve its command with the leader's ack. The relay keeps its
 * own counter and maps back on the way out.
 *
 * Events are BROADCAST (`to: "*"`), not addressed. A reply belongs to the tab
 * that asked; a `blob-arrived` belongs to every tab, because each one holds its
 * own media cache. Without this a follower's thumbnails stay blank until a
 * reload — the exact bug the `blob-arrived` event exists to prevent.
 */
function leaderRelay(channel: BroadcastChannel, inner: Transport): () => void {
  const asker = new Map<number, { from: string; originalId: number }>();
  let nextRelayId = 1;

  const onMessage = (event: MessageEvent) => {
    const message = event.data as { to: string; request: WorkerRequest; from: string };
    if (message.to !== "leader") return;
    const relayId = nextRelayId++;
    asker.set(relayId, { from: message.from, originalId: message.request.id });
    inner.send({ ...message.request, id: relayId });
  };
  channel.addEventListener("message", onMessage);

  const unsubscribeReply = inner.onReply((reply) => {
    const entry = asker.get(reply.id);
    if (entry === undefined) return;
    asker.delete(reply.id);
    channel.postMessage({ to: entry.from, reply: { ...reply, id: entry.originalId } });
  });

  const unsubscribeEvent = inner.onEvent((event) => {
    channel.postMessage({ to: "*", event });
  });

  return () => {
    channel.removeEventListener("message", onMessage);
    unsubscribeReply();
    unsubscribeEvent();
  };
}

/**
 * Start the client, walking the ladder.
 *
 * `navigator.locks.request` with `{ ifAvailable: true }` resolves to `null`
 * when another tab holds the lock, which is exactly the leader test. The lock
 * is held for the tab's lifetime by never resolving the callback.
 */
export async function startWorkerClient(options: StartOptions = {}): Promise<StartedClient> {
  const shared = (options.createSharedWorker ?? defaultSharedWorker)();
  if (shared) {
    return {
      client: createWorkerClient(portTransport(shared)),
      mode: "shared",
      singleTabOnly: false,
      isLeader: () => true,
    };
  }

  // `??` would treat an explicit `null` as "not provided" and fall through to
  // the real global, which is the opposite of what a test passing `null` means.
  // `in` distinguishes the two.
  const locks = "locks" in options ? options.locks : typeof navigator !== "undefined" ? navigator.locks : null;
  const channel =
    "channel" in options
      ? options.channel
      : typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(CHANNEL_NAME)
        : null;

  if (locks && channel) {
    const tabId = crypto.randomUUID();
    let leader = false;
    /** Tabs that want to know when the writer role lands here. */
    const promoteHandlers = new Set<() => void>();

    const { transport, swap } = switchableTransport(relayTransport(channel, tabId));

    // The writer role, installed on this tab. Called at startup when the probe
    // wins, and again later when a queued request is granted.
    const becomeLeader = () => {
      leader = true;
      const port = (options.createDedicatedWorker ?? defaultDedicatedWorker)();
      const inner = port ? portTransport(port) : localTransport(options.host ?? defaultHost());
      leaderRelay(channel, inner);
      swap(inner);
      // A dedicated worker dies with the tab that owned it, so the new leader's
      // host starts with an EMPTY engine map. `swap` re-sends stranded requests,
      // but a `room-add` that already got its reply is not stranded — so the
      // rooms have to be re-announced explicitly or every engine is lost.
      for (const handler of promoteHandlers) handler();
    };

    // Probe: `ifAvailable` answers "is the lock free RIGHT NOW" without
    // queueing, so the initial role is known before the first command.
    const granted = await new Promise<boolean>((resolve) => {
      void locks
        .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          resolve(lock !== null);
          // Hold for the tab's lifetime. Releasing would hand the writer role
          // to a tab that has not installed its worker yet.
          return lock === null ? undefined : new Promise<void>(() => {});
        })
        .catch(() => resolve(false));
    });

    if (granted) {
      becomeLeader();
    } else {
      // Queue WITHOUT `ifAvailable`. This is the handoff: when the leader tab
      // unloads the browser releases the lock and grants it to the next
      // waiter, which is this tab. `ifAvailable` here would be the bug — it
      // returns `null` immediately and the follower would never be promoted.
      void locks
        .request(LOCK_NAME, () => {
          becomeLeader();
          return new Promise<void>(() => {});
        })
        .catch(() => {
          /* the document is going away; nothing to promote */
        });
    }

    return {
      client: createWorkerClient(transport, (handler) => {
        promoteHandlers.add(handler);
        return () => promoteHandlers.delete(handler);
      }),
      mode: "dedicated",
      singleTabOnly: false,
      isLeader: () => leader,
    };
  }

  // No SharedWorker and no Web Locks: the host runs in this tab, and a second
  // tab would be a second writer. The app must say so.
  return {
    client: createWorkerClient(localTransport(options.host ?? defaultHost())),
    mode: "tab",
    singleTabOnly: true,
    isLeader: () => true,
  };
}

// ─── The per-tab singleton ─────────────────────────────────────────────────

let started: Promise<StartedClient> | null = null;

/**
 * The one client this tab uses.
 *
 * Cached so the ladder runs once — a second `SharedWorker` would be a second
 * writer, and a second Web Lock request would deadlock against the first. A
 * FAILED start is not cached: a rejected promise kept forever would make every
 * later write fail with the first error, and the retry path is the whole point
 * of `ensureOpen` resetting its own promise.
 */
export function getWorkerClient(): Promise<StartedClient> {
  if (!started) {
    started = startWorkerClient();
    started.catch(() => {
      started = null;
    });
  }
  return started;
}
