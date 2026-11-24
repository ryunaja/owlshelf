/**
 * relay.mjs — an in-memory stand-in for the real relay, for two-engine tests.
 *
 * `sync.test.mjs` drives ONE engine against a scripted socket: it proves the
 * engine's behaviour, not that two devices converge. This routes frames
 * between engines the way `backend/app/relay/` does — hello registers a
 * connection, presence goes to every member including the newcomer, a `to:`
 * frame is delivered to that connection only, and an untargeted envelope is
 * broadcast to the room.
 *
 * It is deliberately NOT a second implementation of the relay's admission
 * rules. There is no origin check, no keyGen check, no queue bound, no
 * heartbeat. Those are `backend/tests/`'s job. What this reproduces is the
 * ROUTING, because routing is what decides whether two devices converge.
 */

/**
 * @param {{ dropBroadcast?: boolean }} [options] `dropBroadcast` makes the
 *   relay silently swallow untargeted envelopes — the "push is broken" case,
 *   so a test can prove catch-up still repairs it.
 */
export function makeRelay(options = {}) {
  /** connId → { socket, roomId } */
  const conns = new Map();
  /** Every socket the factory handed out, in creation order. */
  const sockets = [];
  const log = [];

  function membersOf(roomId) {
    return [...conns.entries()]
      .filter(([, entry]) => entry.roomId === roomId)
      .map(([connId]) => connId)
      .sort();
  }

  function presence(roomId) {
    const frame = { type: "presence", members: membersOf(roomId) };
    for (const [connId, entry] of conns) {
      if (entry.roomId !== roomId) continue;
      log.push({ to: connId, kind: "presence" });
      entry.socket.deliver(frame);
    }
  }

  function deliverTo(connId, frame) {
    const target = conns.get(connId);
    if (!target) return false;
    log.push({ to: connId, kind: frame.kind ?? frame.type });
    target.socket.deliver(frame);
    return true;
  }

  function socketFactory() {
    const socket = {
      connId: null,
      sent: [],
      closed: null,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      deliver(frame) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      },
      send(data) {
        const frame = JSON.parse(data);
        this.sent.push(frame);

        if (frame.type === "hello") {
          this.connId = frame.connId;
          conns.set(frame.connId, { socket: this, roomId: frame.roomId });
          presence(frame.roomId);
          return;
        }
        if (frame.type === "pong") return;

        // The relay stamps `from`, OVERWRITING anything the client sent
        // (review-2 P0-3). Without it a targeted catch-up reply cannot name a
        // peer, and the responder election has nothing to exclude.
        frame.from = this.connId;

        // An envelope. `to` is a connectionId; a miss is a drop, never a
        // broadcast (§9).
        if (typeof frame.to === "string") {
          deliverTo(frame.to, frame);
          return;
        }
        if (options.dropBroadcast) return;
        for (const [connId, entry] of conns) {
          if (entry.roomId !== frame.roomId) continue;
          if (connId === this.connId) continue;
          log.push({ to: connId, kind: frame.kind });
          entry.socket.deliver(frame);
        }
      },
      close(code, reason) {
        this.closed = { code, reason };
        if (this.connId) {
          const entry = conns.get(this.connId);
          conns.delete(this.connId);
          if (entry) presence(entry.roomId);
        }
      },
      open() {
        this.onopen?.({});
      },
    };
    sockets.push(socket);
    return socket;
  }

  return {
    socketFactory,
    sockets,
    log,
    membersOf,
    /** Frames a given connection received, by kind. */
    received(connId, kind) {
      return log.filter((entry) => entry.to === connId && entry.kind === kind);
    },
  };
}
