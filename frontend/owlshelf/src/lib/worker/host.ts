/**
 * host.ts — the worker side of the single-writer split (plan §5, §6.6).
 *
 * Everything that WRITES lives behind this: `executeCommand` (mint + reduce +
 * outbox), `executeMoveMany`, `createProfile`, room import — and, since the
 * engine moved here, the sync sockets themselves.
 *
 * Why this is stronger than "the worker owns sync": one clock/sequence
 * authority kills the two-tabs-mint-identical-timestamps dedup bug, and routing
 * local writes through the same reducer as remote ones means a stale local op
 * can LOSE to a newer remote winner locally instead of silently diverging.
 *
 * ── One engine per room, for the whole origin ─────────────────────────────
 *
 * This is the point of the move. Before it, `syncRuntime` ran in the tab and
 * `syncStore` ran in the dev panel, so N tabs meant N sockets per room — and
 * the relay's `conns_per_ip = 3` counts across all rooms, so two tabs with two
 * profiles already hit the cap. Now there is one `engines` map, in one thread,
 * and a tab can only ask for a room to be in it.
 *
 * `room-add`/`room-remove` are REFERENCE-COUNTED per port. One worker serves
 * every tab, so tab A unmounting must not stop the engine tab B is still
 * using; the engine stops when the last port that asked for the room lets go.
 * A closed tab leaves its count behind — which is correct, because the room
 * should keep syncing, and the browser terminates the SharedWorker when the
 * last tab goes away.
 *
 * ── `visibility` is two things ────────────────────────────────────────────
 *
 * §5 detail 1: the worker has no `document`, so tabs proxy `visibilityState`.
 * §7.1: a visible tab, an `online` event and a `pageshow` all "resync all
 * rooms". Both are the same message. Any port reporting `hidden: false` resumes
 * every engine — that IS the resync, and it is why there is no `resync` message.
 *
 * ── Testable by construction ──────────────────────────────────────────────
 *
 * The host takes a `PortLike` and a `db`, so the harness drives it with a fake
 * port and an isolated database — the same code the worker runs, with no
 * browser. That is the only way §5's split gets executed coverage at all, since
 * Node has no `SharedWorker`.
 */

import { CommandError, executeCommand, executeMoveMany } from "../cmd";
import { ensureOpen as ensureOpenSingleton } from "../db";
import { DEFAULT_RELAY_URL, SyncEngine, type SocketFactory } from "../sync";
import { createSocketHub } from "../socketHub";
import { readRoom } from "../roomMeta";
import { exportRoom, importRoom, setRoomRelayUrl } from "../roomShare";
import { mintJoinFragment } from "../pairing";
import { confirmRehome, dismissRehome } from "../control";
import { createRoom, joinRoom, leaveRoom, rejoinRoom, repairRoom, repairRosters, revokeDevice } from "../rooms";
import type { OwlshelfDB } from "../db";
import type { Room } from "../stores";
import type {
  DevState,
  PairingReply,
  RoomInfo,
  SyncLogEntry,
  WorkerError,
  WorkerEvent,
  WorkerReply,
  WorkerRequest,
} from "./protocol";

/** The two methods a `MessagePort` and a fake port share. */
export interface PortLike {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

export interface WorkerHostDeps {
  db: OwlshelfDB;
  getDeviceId: () => Promise<string>;
  /** Opens the db and finishes the migration. Defaults to the app singleton;
   *  the harness injects one bound to its isolated database. */
  ensureOpen?: () => Promise<void>;
  /** Test seam: the engine's socket. Production omits it and gets a real one. */
  socketFactory?: SocketFactory;
  /** Dialled when a room has no `relayUrl`. `null` keeps the plan's "a room
   *  nobody has paired with stays offline" behaviour. */
  defaultRelayUrl?: string | null;
  /** Test seams, forwarded to every engine. */
  hiddenDisconnect?: number;
  auditInterval?: number;
  drainInterval?: number;
  blobTimeout?: number;
}

export interface WorkerHost {
  /** Handle one request. Never throws: a failure becomes an `ok: false` reply.
   *  `from` identifies the calling port, which is what makes `visibility` and
   *  the room reference counts per-tab. */
  handle(request: WorkerRequest, from?: PortLike): Promise<WorkerReply>;
  /** Wire the host to a port. Returns an unsubscribe. */
  attach(port: PortLike): () => void;
  /** Room ids with a live engine. Read-only, for tests and diagnostics. */
  readonly rooms: readonly string[];
  /** Stop every engine and drop every port. */
  stop(): void;
}

const LOG_LIMIT = 100;

/** A `CommandError` keeps its code; anything else is `internal`. */
function toWorkerError(error: unknown): WorkerError {
  if (error instanceof CommandError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Compact one-line rendering of an envelope body for the log. */
function summarize(body: unknown): string {
  if (body === null || typeof body !== "object") return String(body);
  const record = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["requestId", "chunkNo", "seq", "hash", "count", "digest"]) {
    const value = record[key];
    if (value === undefined) continue;
    parts.push(`${key}=${typeof value === "string" ? value.slice(0, 8) : String(value)}`);
  }
  if (Array.isArray(record.ops)) parts.push(`ops=${record.ops.length}`);
  if (record.cursors && typeof record.cursors === "object") {
    parts.push(`cursors=${Object.keys(record.cursors as object).length}`);
  }
  return parts.length > 0 ? parts.join(" ") : "—";
}

export function createWorkerHost(deps: WorkerHostDeps): WorkerHost {
  const { db, getDeviceId } = deps;
  const ensureOpen = deps.ensureOpen ?? ensureOpenSingleton;

  /**
   * ONE socket for every room on a relay (§9 amendment).
   *
   * The engines are unchanged: each still gets a `SocketLike`, sends its own
   * `hello` and reads its own presence. The hub behind those adapters turns the
   * second and later rooms into `join` frames on the same wire, so the relay
   * counts one connection per DEVICE instead of one per room. That is what makes
   * a per-IP cap meaningful: a public IP is shared by households under CGNAT, so
   * "rooms installed" was never a number the relay could reason about.
   *
   * `deps.socketFactory` is the transport seam, and the hub is what dials with
   * it — so a harness that injects fake sockets still sees the real count, one
   * per relay URL rather than one per room.
   */
  const hub = createSocketHub(deps.socketFactory ? { dial: deps.socketFactory } : {});

  /**
   * `ensureOpen` plus a ONE-TIME roster repair.
   *
   * Rooms written before `createRoom` minted anchors — every room the deleted
   * `newRoom`/`createProfile` paths produced, and every room staged by the v1
   * migration before it anchored — have a key and an id but no roster. The
   * minter refuses those (an invite with no pin lets any member claim
   * ownership), so the owner's share button used to fail with no way out.
   *
   * It runs once, lazily, and a failure is logged rather than propagated: a
   * room with a broken roster must never make the rest of the shelf unopenable.
   */
  let repairOnce: Promise<void> | null = null;
  async function ready(): Promise<void> {
    await ensureOpen();
    if (repairOnce === null) {
      repairOnce = repairRosters({ db, getDeviceId })
        .then((fixed) => {
          for (const roomId of fixed) log(roomId, "roster-repaired", undefined, "signed epoch 1");
        })
        .catch((error: unknown) => {
          log("", "repair-failed", undefined, error instanceof Error ? error.message : String(error));
        });
    }
    await repairOnce;
  }
  const defaultRelayUrl =
    deps.defaultRelayUrl === undefined ? DEFAULT_RELAY_URL : deps.defaultRelayUrl;

  const engines = new Map<string, SyncEngine>();
  /** roomId → the ports that asked for it. The engine lives while this is
   *  non-empty. */
  const wanters = new Map<string, Set<PortLike | undefined>>();
  /** port → whether it last reported itself hidden. */
  const hidden = new Map<PortLike | undefined, boolean>();
  const ports = new Set<PortLike>();
  const logs = new Map<string, SyncLogEntry[]>();
  const closes = new Map<string, { code: number; reason: string }>();

  function broadcast(event: WorkerEvent): void {
    for (const port of ports) port.post(event);
  }

  function log(roomId: string, kind: string, from: string | undefined, detail: string): void {
    const entry: SyncLogEntry = { at: Date.now(), kind, from, detail };
    const next = [entry, ...(logs.get(roomId) ?? [])].slice(0, LOG_LIMIT);
    logs.set(roomId, next);
  }

  /**
   * §6.6: disconnect ~20 s after EVERY port reports hidden, reconnect on ANY
   * visible.
   *
   * A port that has not reported yet counts as VISIBLE. That is not a
   * convenience: a tab attaches its port and only then reads
   * `document.visibilityState`, so treating "no report" as hidden would
   * suspend every engine in the window between the two — and a freshly booted
   * worker would come up offline until something happened to poke it.
   */
  function applyVisibility(): void {
    let anyVisible = ports.size === 0;
    for (const port of ports) {
      if (hidden.get(port) !== true) {
        anyVisible = true;
        break;
      }
    }
    for (const engine of engines.values()) {
      if (anyVisible) engine.resume();
      else engine.suspend();
    }
  }

  function attachEngine(room: Room, deviceId: string): void {
    const roomId = room.roomId;
    const engine = new SyncEngine({
      db,
      roomId,
      deviceId,
      socketFactory: hub.socketFactory,
      defaultRelayUrl: defaultRelayUrl ?? undefined,
      hiddenDisconnect: deps.hiddenDisconnect,
      auditInterval: deps.auditInterval,
      drainInterval: deps.drainInterval,
      blobTimeout: deps.blobTimeout,
      onStatus: (status) => {
        log(roomId, "status", undefined, status);
        // A `synced` session is proof the last failure is history, so the code
        // is cleared. Every other status keeps it: the user must still be able
        // to read what happened while the engine retries in the background.
        if (status === "synced") closes.delete(roomId);
        broadcast({
          kind: "sync-status",
          roomId,
          status,
          lastClose: closes.get(roomId) ?? null,
        });
      },
      onClose: (code, reason) => {
        closes.set(roomId, { code, reason });
        log(roomId, "close", undefined, `${code}${reason ? ` ${reason}` : ""}`);
      },
      onEnvelope: (kind, body, from) => log(roomId, kind, from, summarize(body)),
      onBlob: (hash) => {
        log(roomId, "blob", undefined, `stored ${hash.slice(0, 8)}`);
        // Every tab must re-read: a cached `missing` would otherwise outlive
        // the arrival and the image would stay blank until a reload.
        broadcast({ kind: "blob-arrived", roomId, hash });
      },
      onRepairNeeded: () => log(roomId, "repair", undefined, "4404"),
    });
    engines.set(roomId, engine);
    // `start()` is not awaited: `room-add` must not block on a socket dial,
    // which can hang for the whole handshake deadline. It CAN reject — a
    // database closed under it (a test tearing down, a tab closing mid-dial)
    // surfaces as `DatabaseClosedError` — and a floating rejection would take
    // the whole worker down. Log it instead.
    void engine.start().catch((error: unknown) => {
      log(roomId, "start-failed", undefined, error instanceof Error ? error.message : String(error));
    });
  }

  async function addRoom(roomId: string, from: PortLike | undefined): Promise<void> {
    await ready();
    let set = wanters.get(roomId);
    if (!set) {
      set = new Set();
      wanters.set(roomId, set);
    }
    set.add(from);
    if (engines.has(roomId)) return;

    const room = await readRoom(db, roomId);
    if (!room) {
      // A `room-add` for a room that is not there is a caller bug, not a
      // protocol event: the tab read the room list from the same database.
      throw new CommandError("validation", `no room ${roomId}`);
    }
    attachEngine(room, await getDeviceId());
  }

  function removeRoom(roomId: string, from: PortLike | undefined): void {
    const set = wanters.get(roomId);
    if (set) {
      set.delete(from);
      if (set.size > 0) return;
      wanters.delete(roomId);
    }
    const engine = engines.get(roomId);
    if (!engine) return;
    engine.stop();
    engines.delete(roomId);
  }

  function engineFor(roomId: string): SyncEngine {
    const engine = engines.get(roomId);
    if (!engine) throw new CommandError("validation", `no engine for ${roomId}`);
    return engine;
  }

  /** Stop a room's engine and forget it. `wanters` is untouched: the ports still
   *  want the room, and `rebind` puts a fresh engine in its place. */
  function stopEngine(roomId: string): void {
    const engine = engines.get(roomId);
    if (!engine) return;
    engine.stop();
    engines.delete(roomId);
  }

  /**
   * Re-dial a room whose metadata changed underneath a running engine.
   *
   * A rotation bumps `keyGen`, and the relay room is keyed by the hash of the
   * room key — so the old socket is now attached to a room nobody writes to.
   * Reusing the engine would leave the owner talking to its own old generation
   * while every peer has moved on: the failure looks exactly like "sync is
   * broken" and the diagnostic is a `4404` the client never sees because the
   * socket is fine. The engine is immutable per generation, so it is replaced.
   */
  async function rebind(room: Room): Promise<void> {
    stopEngine(room.roomId);
    attachEngine(room, await getDeviceId());
  }

  async function dispatch(request: WorkerRequest, from: PortLike | undefined): Promise<unknown> {
    switch (request.kind) {
      case "cmd":
        await ready();
        return executeCommand(db, request.cmd);

      case "move-many":
        await ready();
        return executeMoveMany(db, request.request);

      case "create-profile": {
        await ready();
        // `createRoom`, not a bare room row: §6.7's create step signs the
        // epoch-1 anchor BEFORE the room is stored, and a room without an
        // anchor cannot be shared at all (`mintJoinFragment` refuses it).
        // The relay URL is captured now so the invite carries one; a room
        // created while the relay is unset stays local-only and says so.
        const { profile } = await createRoom(
          {
            relayUrl: defaultRelayUrl,
            name: request.data.name,
            type: request.data.type,
            avatarEmoji: request.data.avatarEmoji,
          },
          { db, getDeviceId },
        );
        return profile;
      }

      case "visibility":
        hidden.set(from, request.hidden);
        applyVisibility();
        return null;

      case "room-add":
        await addRoom(request.roomId, from);
        return null;

      case "room-remove":
        removeRoom(request.roomId, from);
        return null;

      // ── Pairing (§6.7) ───────────────────────────────────────────────────
      // Every branch is a WRITE, which is why these are worker messages and
      // not tab-side operations (§5). The refusals come back as values, never
      // as throws: an invite is untrusted input, and a dialog needs the reason
      // to render the right sentence.

      case "pairing-mint": {
        await ready();
        let room = await readRoom(db, request.roomId);
        if (!room) return { ok: false, reason: "unknown-room" };
        // A pre-anchor room has no roster to hand out. Repair it HERE as well as
        // in `ready()`: a room created by an older tab after this worker booted
        // would otherwise be the one room that still cannot be shared.
        if (!room.rosterAnchor) {
          const outcome = await repairRoom(room, { db, getDeviceId });
          if (outcome === "not-this-device") return { ok: false, reason: "mint-not-owner" };
          room = (await readRoom(db, request.roomId)) ?? room;
        }
        // The minter takes the STORED room, so the fragment cannot be minted
        // from a roomId alone and cannot forget the anchor (§6.7, N4).
        return mintJoinFragment(room);
      }

      case "pairing-join": {
        await ready();
        const result = await joinRoom(request.text, {
          db,
          getDeviceId,
          ...(request.name === undefined ? {} : { profileName: request.name }),
        });
        if (!result.ok) return { ok: false, reason: result.reason };
        return { ok: true, roomId: result.room.roomId, keyGen: result.room.keyGen };
      }

      case "pairing-adopt": {
        await ready();
        const result = await rejoinRoom(request.text, { db, getDeviceId });
        if (!result.ok) return { ok: false, reason: result.reason };
        // The room was already in the engine set at its OLD generation, so the
        // meta liveQuery will not re-add it; the rebind has to happen here.
        await rebind(result.room);
        return { ok: true, roomId: result.room.roomId, keyGen: result.room.keyGen };
      }

      case "pairing-revoke": {
        await ready();
        const result = await revokeDevice(request.roomId, request.deviceId, { db, getDeviceId });
        if (!result.ok) return { ok: false, reason: result.reason };

        // §6.7 step 3: the signed notice goes into the OLD room FIRST — while
        // the engine still holds the old generation, so it is sealed with the
        // old key and reaches the sockets that are still on the old hash.
        const engine = engines.get(request.roomId);
        const notified = engine
          ? await engine.sendEnvelope("control", { type: "control-op", op: result.notice })
          : false;

        // Then the owner moves to the new generation.
        await rebind(result.room);
        const reply: PairingReply = {
          ok: true,
          roomId: result.room.roomId,
          keyGen: result.room.keyGen,
          notified,
        };
        return reply;
      }

      case "pairing-leave": {
        await ready();
        // Stop first: a purge with an engine attached leaves it reconnecting to
        // a room whose key has just been deleted.
        stopEngine(request.roomId);
        wanters.delete(request.roomId);
        await leaveRoom(request.roomId, { db, getDeviceId });
        return null;
      }

      case "pairing-rehome": {
        await ready();
        const moved = request.accept
          ? await confirmRehome(db, request.roomId)
          : await dismissRehome(db, request.roomId);
        // Only an ACCEPT changes the URL the engine dials. Declining is a
        // metadata edit; re-dialling for it would drop a healthy socket for
        // nothing.
        if (request.accept && moved) {
          const room = await readRoom(db, request.roomId);
          if (room) await rebind(room);
        }
        return null;
      }

      case "room-info": {
        const room = await readRoom(db, request.roomId);
        const engine = engines.get(request.roomId);
        const deviceId = await getDeviceId().catch(() => null);
        const info: RoomInfo = {
          roomId: request.roomId,
          deviceId,
          // Role is DATA, not authorization (§6.7): it decides which buttons the
          // share screen offers, and the signature check happens in `rooms.ts`.
          isOwner:
            room !== undefined &&
            deviceId !== null &&
            room.roster.some((m) => m.role === "owner" && m.deviceId === deviceId),
          keyGen: room?.keyGen ?? 0,
          rotationPending: room?.rotationPending ?? null,
          pendingRelayUrl: room?.pendingRelayUrl ?? null,
          status: engine?.currentStatus ?? "offline",
          peers: engine ? [...engine.members] : [],
          ops: room ? await db.ops.where("roomId").equals(request.roomId).count() : 0,
          running: engine !== undefined,
          lastClose: closes.get(request.roomId) ?? null,
        };
        return info;
      }

      case "sync-retry": {
        await ready();
        const engine = engines.get(request.roomId);
        if (!engine) {
          // No engine means nothing is dialling: the tab's `room-add` did not
          // happen (or the room was removed), and a silent success would tell
          // the user "retried" while nothing was retried.
          throw new CommandError("validation", `no live engine for ${request.roomId}`);
        }
        // `resume()` skips the remaining backoff and dials now. The engine's own
        // reconnect loop still owns recovery; this only removes the wait.
        engine.resume();
        return null;
      }

      case "blob-demand": {
        const engine = engines.get(request.roomId);
        if (!engine) return false;
        return (await engine.requestBlob(request.hash)) !== null;
      }

      case "dev-op": {
        const engine = engineFor(request.roomId);
        // The worker logs what the worker did, so the panel's log is one
        // stream rather than a local one that a refresh would clobber.
        const done = (detail: string) => log(request.roomId, request.op, undefined, detail);
        switch (request.op) {
          case "catchup": {
            const requestId = await engine.requestCatchup();
            done(requestId ? `requested ${requestId.slice(0, 8)}` : "no peers");
            return requestId;
          }
          case "audit": {
            const sent = await engine.sendAudit();
            done(sent ? "sent" : "not sent");
            return sent;
          }
          case "drain": {
            const sent = await engine.drainOutbox();
            done(`${sent} sent`);
            return sent;
          }
          case "suspend":
            engine.suspend();
            done("suspend()");
            return null;
          case "resume":
            engine.resume();
            done("resume()");
            return null;
          case "blob-request": {
            const requestId = await engine.requestBlob(request.hash ?? "");
            done(requestId ? `requested ${(request.hash ?? "").slice(0, 8)}` : "no peers");
            return requestId;
          }
          default: {
            const unreachable: never = request.op;
            throw new CommandError("validation", `unknown dev op ${String(unreachable)}`);
          }
        }
      }

      case "dev-state": {
        const engine = engines.get(request.roomId);
        const state: DevState = {
          running: engine !== undefined,
          status: engine?.currentStatus ?? "offline",
          connId: engine?.connectionId ?? null,
          members: engine ? [...engine.members] : [],
          lastClose: closes.get(request.roomId) ?? null,
          log: logs.get(request.roomId) ?? [],
          // `getDeviceId` persists on first call, so a tab cannot read it.
          deviceId: await getDeviceId().catch(() => null),
        };
        return state;
      }

      case "dev-export-room":
        return exportRoom(db, request.roomId);

      case "dev-import-room":
        await ready();
        await importRoom(db, getDeviceId, request.text);
        return null;

      case "dev-set-relay":
        await ready();
        await setRoomRelayUrl(db, request.roomId, request.url);
        return null;

      default: {
        // Exhaustiveness: a new request kind must be handled, not ignored.
        const unreachable: never = request;
        throw new CommandError("validation", `unknown request ${JSON.stringify(unreachable)}`);
      }
    }
  }

  return {
    get rooms() {
      return [...engines.keys()];
    },

    async handle(request, from) {
      try {
        const value = await dispatch(request, from);
        return { id: request.id, ok: true, value };
      } catch (error) {
        return { id: request.id, ok: false, error: toWorkerError(error) };
      }
    },

    attach(port) {
      ports.add(port);
      port.onMessage((message) => {
        const request = message as WorkerRequest;
        if (typeof request?.id !== "number") return;
        void this.handle(request, port).then((reply) => port.post(reply));
      });
      return () => {
        ports.delete(port);
        hidden.delete(port);
        for (const roomId of [...wanters.keys()]) removeRoom(roomId, port);
        applyVisibility();
      };
    },

    stop() {
      for (const engine of engines.values()) engine.stop();
      hub.stop();
      engines.clear();
      wanters.clear();
      hidden.clear();
      ports.clear();
    },
  };
}
