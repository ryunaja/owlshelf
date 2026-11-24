/**
 * socketHub.ts — ONE WebSocket for every room on a device (§9 amendment).
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 *
 * The relay used to bind a socket to exactly one room, so `SyncEngine` opened
 * one socket per room. That makes the connection count "rooms installed", and
 * the per-IP cap then had to guess: `devices × profiles`. But a public IP is
 * not a device either — CGNAT puts many households behind one address, so no
 * per-IP number can be right. The only unit that is stable is **one socket per
 * device**, which is what this module gives you: rooms share the wire, and each
 * keeps its own key, cursors, outbox and reducer.
 *
 * ── How ──────────────────────────────────────────────────────────────────
 *
 * `SyncEngine` is untouched: it still gets a `SocketLike` from its factory and
 * still sends `hello`, envelopes, and reads presence. The object it gets is a
 * `RoomAdapter`, and the hub behind it:
 *
 *  - dials when the FIRST adapter sends a `hello` (that room is the wire's
 *    primary room, so the wire hello is byte-for-byte the engine's frame),
 *  - turns every later room's `hello` into a `{type:"join"}` frame and holds
 *    that room's outbound frames until the relay answers `{type:"joined"}`,
 *  - dispatches inbound frames by the room they name (`roomId` for envelopes,
 *    `hash` for presence), so an engine only ever sees its own room,
 *  - answers the relay's heartbeat once per wire instead of once per room,
 *  - and fans a wire close out to every room, which is exactly what a socket
 *    dying used to mean for the one room that owned it.
 *
 * A relay refusal for one room (`join-refused`, e.g. a stale generation after a
 * rotation) closes THAT adapter with the refusal's code and leaves the other
 * rooms connected. That is the whole reason the relay reports it as a frame
 * instead of a close code.
 *
 * ── Per-URL wires ────────────────────────────────────────────────────────
 *
 * Rooms can name different relays (`relayUrl` is per room, §6.7 rehome), so the
 * hub keeps one wire per URL. Two rooms pointing at the same relay share it;
 * a room rehomed to another relay gets its own.
 */

import type { SocketFactory, SocketLike } from "./sync";

/** The subset of a wire frame the hub must understand to route it. */
interface Frame {
  type?: unknown;
  roomId?: unknown;
  hash?: unknown;
  keyGen?: unknown;
  code?: unknown;
  reason?: unknown;
}

function parse(raw: unknown): Frame | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Frame) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * One room's view of the shared wire. Satisfies `SocketLike`, so an engine
 * cannot tell it apart from the dedicated socket it used to get.
 */
class RoomAdapter implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  /** Set by the first `hello` this adapter sends. */
  roomId: string | null = null;
  roomHash: string | null = null;
  keyGen = 0;
  /** True once the relay has admitted this room (wire hello, or `joined`). */
  joined = false;
  /** Frames written before the room was joined, in order. */
  readonly pending: string[] = [];
  closed = false;

  /** The hello text, kept so the wire can replay it after a reconnect. */
  helloText: string | null = null;

  readonly url: string;
  private readonly hub: Hub;

  constructor(url: string, hub: Hub) {
    this.url = url;
    this.hub = hub;
  }

  send(data: string): void {
    if (this.closed) return;
    const frame = parse(data);

    // The engine's opening frame. It is the wire hello for the first room on a
    // url and a `join` for every room after that — same fields, different verb.
    if (frame?.type === "hello") {
      this.roomId = str(frame.roomId);
      this.roomHash = str(frame.hash);
      this.keyGen = typeof frame.keyGen === "number" ? frame.keyGen : 0;
      this.helloText = data;
      this.hub.attach(this);
      return;
    }

    // The hub answers the relay's heartbeat once per wire, so an engine will
    // normally never send this. Forward it if one does: the relay counts pongs
    // per connection and a missing one drops the whole socket.
    if (frame?.type === "pong") {
      this.hub.send(this, data);
      return;
    }

    if (this.joined) {
      this.hub.send(this, data);
      return;
    }
    this.pending.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.detach(this, code, reason);
  }

  /** Deliver one inbound frame. Never throws into the hub's dispatcher. */
  deliver(raw: unknown): void {
    if (this.closed) return;
    try {
      this.onmessage?.({ data: raw });
    } catch {
      /* a bad frame is dropped, never fatal — same rule as the engine's own */
    }
  }

  /** The relay refused THIS room on a healthy wire. */
  refuse(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code, reason });
  }

  /** The wire died: every room on it is closed with the same code. */
  drop(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code, reason });
  }
}

interface Wire {
  socket: SocketLike;
  url: string;
  open: boolean;
  /** The room whose hello opened the wire. */
  primary: RoomAdapter | null;
  rooms: Set<RoomAdapter>;
}

interface Hub {
  attach(adapter: RoomAdapter): void;
  detach(adapter: RoomAdapter, code?: number, reason?: string): void;
  send(adapter: RoomAdapter, data: string): void;
}

export interface SocketHub {
  socketFactory: SocketFactory;
  /** Wire sockets currently open or dialling — the number the relay counts. */
  socketCount(): number;
  /** Close every wire. Called when the worker is torn down. */
  stop(): void;
}

export interface SocketHubOptions {
  /** The real transport. Test seam; production passes nothing. */
  dial?: SocketFactory;
}

export function createSocketHub(options: SocketHubOptions = {}): SocketHub {
  const dial: SocketFactory =
    options.dial ?? ((url) => new WebSocket(url) as unknown as SocketLike);

  const wires = new Map<string, Wire>();
  /** adapter → the wire it is on (null until its hello is processed). */
  const homes = new Map<RoomAdapter, Wire | null>();

  const wireFor = (url: string): Wire | null => wires.get(url) ?? null;

  const forget = (wire: Wire): void => {
    if (wires.get(wire.url) === wire) wires.delete(wire.url);
  };

  function sendJoin(wire: Wire, adapter: RoomAdapter): void {
    if (!wire.open || adapter.closed || adapter.joined || adapter.helloText === null) return;
    wire.socket.send(
      JSON.stringify({
        v: 1,
        type: "join",
        roomId: adapter.roomId,
        keyGen: adapter.keyGen,
        hash: adapter.roomHash,
      }),
    );
  }

  function openWire(adapter: RoomAdapter): Wire {
    const socket = dial(adapter.url);
    const wire: Wire = { socket, url: adapter.url, open: false, primary: adapter, rooms: new Set() };
    wires.set(adapter.url, wire);
    wire.rooms.add(adapter);
    homes.set(adapter, wire);

    socket.onopen = () => {
      wire.open = true;
      // The primary room is admitted by the very frame that opened the wire, so
      // there is no `joined` to wait for: the relay's reply to a hello is
      // presence (or a close), never an ack. The HELLO goes first — a queued
      // envelope before it would be dropped by the relay's shape check.
      adapter.joined = true;
      if (adapter.helloText !== null) socket.send(adapter.helloText);
      // Rooms that arrived while the wire was still dialling were attached but
      // could not be sent yet: a `join` before the hello would be a frame on a
      // room the relay has not admitted.
      for (const room of [...wire.rooms]) {
        if (room !== adapter) sendJoin(wire, room);
      }
      flush(adapter);
    };

    socket.onmessage = (event) => dispatch(wire, event.data);

    socket.onclose = (event) => {
      wire.open = false;
      forget(wire);
      const code = typeof event?.code === "number" ? event.code : 1006;
      const reason = typeof event?.reason === "string" ? event.reason : "";
      for (const room of [...wire.rooms]) {
        homes.delete(room);
        room.drop(code, reason);
      }
      wire.rooms.clear();
    };

    socket.onerror = () => {
      /* onclose always follows */
    };

    return wire;
  }

  function flush(adapter: RoomAdapter): void {
    const wire = homes.get(adapter) ?? null;
    if (!wire || !wire.open || adapter.closed) return;
    while (adapter.pending.length > 0) {
      const next = adapter.pending.shift();
      if (next !== undefined) wire.socket.send(next);
    }
  }

  function dispatch(wire: Wire, raw: unknown): void {
    const frame = parse(raw);
    if (frame === null) return;

    // The relay's heartbeat is per CONNECTION, so one pong answers it for every
    // room on the wire. Delivering it to the rooms as well would have each
    // engine answer, which is the traffic this consolidation exists to remove.
    if (frame.type === "ping") {
      wire.socket.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (frame.type === "joined") {
      const hash = str(frame.hash);
      const room = [...wire.rooms].find((candidate) => candidate.roomHash === hash);
      if (room && !room.closed) {
        room.joined = true;
        flush(room);
      }
      return;
    }

    if (frame.type === "join-refused") {
      const hash = str(frame.hash);
      const room = [...wire.rooms].find((candidate) => candidate.roomHash === hash);
      if (!room) return;
      wire.rooms.delete(room);
      homes.delete(room);
      const code = typeof frame.code === "number" ? frame.code : 4404;
      room.refuse(code, str(frame.reason) ?? "join-refused");
      return;
    }

    // `moved` is a whole-connection redirect (§12.5): every room on the wire
    // must see it, or a decommissioned relay would only move one shelf.
    if (frame.type === "moved") {
      for (const room of [...wire.rooms]) room.deliver(raw);
      return;
    }

    if (frame.type === "presence") {
      const hash = str(frame.hash);
      const room = [...wire.rooms].find((candidate) => candidate.roomHash === hash);
      room?.deliver(raw);
      return;
    }

    const roomId = str(frame.roomId);
    const room = [...wire.rooms].find((candidate) => candidate.roomId === roomId);
    room?.deliver(raw);
  }

  const hub: Hub = {
    attach(adapter) {
      const existing = wireFor(adapter.url);
      if (existing) {
        existing.rooms.add(adapter);
        homes.set(adapter, existing);
        // Open: ask now. Still dialling: `onopen` sends the joins after the
        // hello, in that order, so the relay never sees a join for a room it
        // has not heard of.
        sendJoin(existing, adapter);
        return;
      }
      openWire(adapter);
    },

    detach(adapter, code, reason) {
      const wire = homes.get(adapter) ?? null;
      homes.delete(adapter);
      if (!wire) return;

      wire.rooms.delete(adapter);

      if (wire.rooms.size === 0) {
        forget(wire);
        wire.open = false;
        wire.socket.onopen = null;
        wire.socket.onmessage = null;
        wire.socket.onclose = null;
        wire.socket.onerror = null;
        try {
          wire.socket.close(code ?? 1000, reason ?? "");
        } catch {
          /* already closed */
        }
        return;
      }

      // Other rooms are still live: say goodbye to this one only. Without the
      // leave the room would keep this connection in its presence list and its
      // room cap until the socket dies.
      if (wire.open && adapter.roomHash !== null) {
        wire.socket.send(JSON.stringify({ v: 1, type: "leave", hash: adapter.roomHash }));
      }
    },

    send(adapter, data) {
      const wire = homes.get(adapter) ?? null;
      if (!wire || !wire.open) {
        // The adapter has been told it is open, but the wire died between the
        // two. Buffering would resurrect frames on the next wire; dropping
        // matches a socket that died mid-send, which the outbox re-sends.
        return;
      }
      wire.socket.send(data);
    },
  };

  return {
    socketFactory: (url) => {
      const adapter = new RoomAdapter(url, hub);
      // `onopen` is what starts the engine's handshake, so it fires as soon as
      // the caller has had a chance to install its handlers.
      queueMicrotask(() => {
        if (!adapter.closed) adapter.onopen?.({});
      });
      return adapter;
    },
    socketCount: () => wires.size,
    stop: () => {
      for (const wire of [...wires.values()]) {
        forget(wire);
        wire.open = false;
        try {
          wire.socket.close(1000, "worker-stop");
        } catch {
          /* already closed */
        }
        for (const room of [...wire.rooms]) {
          homes.delete(room);
          room.closed = true;
        }
        wire.rooms.clear();
      }
    },
  };
}
