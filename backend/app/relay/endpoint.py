"""endpoint.py — admission, the message loop, and the single cleanup path (§9).

The order of the seven admission checks is part of the contract, not an
implementation detail: each one is cheaper than the next, and each failure must
leave the registry untouched. A reordering that registers a connection before
the room-cap check would let an 11th socket evict nothing but still consume a
per-IP slot.

**The caps are reservations, not observations** (RELAY-GAPS.md G1). Steps 2 and
3 used to read `registry.total` and `ip_count`, then `await` the hello for up to
`handshake_deadline`, then mutate with no recheck — so every handler that
arrived inside the same window saw `total=0` and passed. At `global_cap=1`, five
concurrent hellos produced `total=5`. `registry.reserve()` now claims a slot
synchronously, before the await, and `registry.admit()` converts that claim into
a connection in the same synchronous block as the post-handshake checks. One
asyncio thread plus no `await` between read and write is the entire
synchronisation argument.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from .constants import CloseCode, RelayConfig
from .logging_setup import log_event
from .protocol import (
    HEARTBEAT_TYPES,
    decode,
    encode,
    join_refusal_code,
    join_refused_frame,
    joined_frame,
    parse_hello,
    parse_join,
    parse_leave,
    validate_envelope,
)
from .connection import Connection
from .registry import Reservation, RoomRegistry

logger = logging.getLogger("owlshelf.relay")

_LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost"})


def origin_allowed(origin: str | None, cfg: RelayConfig) -> bool:
    """§9 admission step 1.

    Fails CLOSED on an empty allowlist and on a missing Origin. A browser
    always sends Origin for a WebSocket, so a missing one means the peer is not
    a page — and "only owlshelf pages may connect" is the stated rule. An empty
    allowlist meaning "allow everything" would turn a config typo into an open
    relay.
    """
    if not cfg.allowed_origins:
        return False
    if origin is None:
        return False
    return origin in cfg.allowed_origins


def client_ip(websocket: WebSocket, cfg: RelayConfig) -> str:
    """The address the per-IP cap counts.

    Forwarded headers are trusted ONLY when the peer is a loopback proxy
    (cloudflared, §15.18/O3). That loopback test — not the config flag — is the
    real boundary: a remote attacker cannot present as 127.0.0.1, so it can
    never choose its own bucket.

    `CF-Connecting-IP` is preferred over `X-Forwarded-For` because Cloudflare
    sets it itself and strips any client-supplied copy, while an XFF header is
    appended to by intermediate proxies and its FIRST element can be a value the
    client sent (RELAY-GAPS.md G2).
    """
    peer = websocket.client.host if websocket.client else "unknown"
    if cfg.trust_forwarded_for and peer in _LOOPBACK:
        cf = websocket.headers.get("cf-connecting-ip")
        if cf:
            return cf.strip()
        xff = websocket.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    return peer


def moved_target(cfg: RelayConfig, path: str) -> str | None:
    """§15.4/§12.5's `moved` redirect, from OPERATOR CONFIG only.

    A decommissioned relay domain ends its life answering "I've moved" instead of
    going dark. The map is `path -> relayUrl` with `"*"` as a catch-all, so the
    common whole-relay move is one line and a per-room move is still expressible.

    Never derived from a client message: a redirect a client could inject is a
    redirect to a host the client controls (audit-2 P0-8).
    """
    if not cfg.moved:
        return None
    exact = dict(cfg.moved).get(path)
    if exact is not None:
        return exact
    return dict(cfg.moved).get("*")


async def _refuse(websocket: WebSocket, code: int, reason: str) -> None:
    """Close with a code AND say why in the console.

    Without this line the relay is silent about every refusal: uvicorn logs
    `[accepted]` when the handshake completes, so an operator sees a connection
    open and then nothing, with no way to tell a refused origin from a full
    room from a generation mismatch.
    """
    log_event(logger, "info", "refused", code=code, reason=reason)
    with contextlib.suppress(Exception):
        await websocket.close(code=code, reason=reason)


async def _moved(websocket: WebSocket, to: str) -> None:
    """One frame, then a normal close. The registry is never touched."""
    log_event(logger, "info", "moved", to=to)
    with contextlib.suppress(Exception):
        await websocket.send_text(encode({"type": "moved", "to": to}))
        await websocket.close(code=CloseCode.NORMAL, reason="moved")


async def handle_frame(
    conn: Any,
    raw: str,
    registry: RoomRegistry,
    cfg: RelayConfig,
) -> None:
    """One inbound frame: liveness, budget, shape, then route (§9).

    Order matters. Liveness is recorded before any rejection, because a client
    that sends garbage is still alive and must not be dropped by the heartbeat
    for it. The budget is charged before parsing, so a flood of unparseable
    frames still costs the sender.
    """
    now = time.monotonic()
    conn.last_seen = now
    conn.missed_pongs = 0

    nbytes = len(raw.encode("utf-8"))
    if nbytes > cfg.frame_cap:
        # uvicorn's --ws-max-size is the primary enforcement; this is the
        # in-process backstop for a deployment that forgot the flag.
        await conn.close(CloseCode.POLICY_VIOLATION, "frame-cap")
        return

    if not conn.spend(nbytes, now, cfg):
        await conn.close(CloseCode.POLICY_VIOLATION, "byte-budget")
        return

    msg = decode(raw)
    if msg is None:
        return

    # Heartbeat frames are consumed, never routed (§9). `ping` from a client is
    # tolerated as liveness only: it is not routable either way, and dropping
    # it would be a silent no-op with no benefit.
    if msg.get("type") in HEARTBEAT_TYPES:
        return

    # Multiplexing (§9 amendment): a socket may carry several rooms. `join` and
    # `leave` are room-level operations on an ALREADY admitted socket, so they
    # sit between the heartbeat frames and the envelope gate — they are not
    # envelopes, and a refused join must not close the socket.
    kind = msg.get("type")
    if kind == "join":
        await _handle_join(conn, raw, registry)
        return
    if kind == "leave":
        room_hash = parse_leave(raw)
        if room_hash is not None:
            await registry.leave_room(conn, room_hash)
        return

    member = registry.membership_for(conn, str(msg.get("roomId")))
    if member is None:
        return
    if not validate_envelope(msg, member.room_id, member.key_gen):
        return

    await registry.route(conn, msg)


async def _handle_join(conn: Any, raw: str, registry: RoomRegistry) -> None:
    """One `join` request: adopt the room or refuse ONLY it.

    Refusals are per-room by design. A rotation on one shelf (4404) used to mean
    disconnecting the socket, which with multiplexing would drop every other
    shelf with it — so the failure is reported as a frame and the connection
    stays up. The client turns it into a local close for that room only, which
    is the same path it already takes for a dedicated socket.
    """
    member = parse_join(raw)
    if member is None:
        return
    reason = await registry.join_room(conn, member)
    if reason is None:
        await registry.send_room_frame(
            conn, joined_frame(member.room_hash, member.key_gen), member.room_hash
        )
        return
    log_event(
        logger,
        "info",
        "join-refused",
        connId=conn.conn_id,
        roomHash=member.room_hash,
        reason=reason,
    )
    await registry.send_room_frame(
        conn,
        join_refused_frame(member.room_hash, join_refusal_code(reason), reason),
        member.room_hash,
    )


async def _admit(
    websocket: WebSocket,
    registry: RoomRegistry,
    cfg: RelayConfig,
    ip: str,
    reservation: Reservation,
) -> Connection | None:
    """Steps 4-7. Returns the connection, or None after refusing.

    Steps 5-7 and `registry.admit()` contain no `await`: the room's generation,
    its cap, and its connId set are read and decided in one uninterrupted block,
    which is why those three were never part of the G1 race.
    """
    # 4. Handshake deadline.
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), cfg.handshake_deadline)
    except (TimeoutError, asyncio.TimeoutError):
        registry.note_refusal(ip)
        await _refuse(websocket, CloseCode.HANDSHAKE_TIMEOUT, "handshake-timeout")
        return None
    except WebSocketDisconnect:
        return None

    hello = parse_hello(raw)
    if hello is None:
        registry.note_refusal(ip)
        await _refuse(websocket, CloseCode.HANDSHAKE_TIMEOUT, "hello-shape")
        return None

    room = registry.room_for(hello.room_hash)

    # 5. Room generation. The FIRST hello to a hash fixes keyGen; a mismatch
    #    means the room was rotated and this device must re-pair (§6.7/D4).
    #    Deliberately NOT counted as churn: this refusal is diagnostic, and a
    #    device that keeps retrying with a stale key must keep seeing 4404
    #    rather than being downgraded to a bare 1013.
    if room is not None and room.key_gen != hello.key_gen:
        await _refuse(websocket, CloseCode.GENERATION_MISMATCH, "generation")
        return None

    # 6. Room cap.
    if room is not None and len(room.conns) >= cfg.room_cap:
        await _refuse(websocket, CloseCode.ROOM_CAP, "room-cap")
        return None

    # 7. Connection identity. A duplicate connId is refused, never overwritten:
    #    a hijacker would gain only AEAD ciphertext it cannot read.
    if room is not None and hello.conn_id in room.conns:
        await _refuse(websocket, CloseCode.HANDSHAKE_TIMEOUT, "duplicate-conn")
        return None

    conn = registry.admit(hello, ip, websocket, reservation)
    log_event(
        logger,
        "info",
        "admitted",
        connId=hello.conn_id,
        roomHash=hello.room_hash,
        keyGen=hello.key_gen,
        ip=ip,
    )
    return conn


async def _serve(
    websocket: WebSocket,
    conn: Connection,
    registry: RoomRegistry,
    cfg: RelayConfig,
) -> None:
    """The message loop, and the ONLY place a connection is torn down.

    `registry.release()` lives in this `finally`, after the tasks are cancelled
    and before the presence broadcast, because the broadcast must not list the
    departing connection. A single release site is what makes "every exit route
    funnels through here" true rather than aspirational.

    With multiplexing the socket can hold several rooms, so presence is
    broadcast per room and the rooms are captured BEFORE `release` detaches
    them — after the detach there is nothing left to name.
    """
    writer: asyncio.Task[None] | None = None
    keepalive: asyncio.Task[None] | None = None
    rooms = list(conn.memberships)

    try:
        writer = asyncio.create_task(conn.writer(cfg))
        keepalive = asyncio.create_task(conn.keepalive(cfg))
        for room_hash in rooms:
            room = registry.rooms.get(room_hash)
            if room is not None:
                await registry.broadcast_presence(room)

        while not conn.closed:
            raw = await websocket.receive_text()
            await handle_frame(conn, raw, registry, cfg)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        # G4: a bare `except Exception: pass` made a routing bug
        # indistinguishable from a client disconnect. The cleanup path is still
        # this one function; the difference is that the failure is now a log
        # line with a connection id rather than silence.
        log_event(
            logger,
            "error",
            "frame-error",
            connId=conn.conn_id,
            errorType=type(exc).__name__,
            error=str(exc),
        )
    finally:
        conn.closed = True
        log_event(logger, "info", "closed", connId=conn.conn_id, roomHash=conn.room_hash)
        for task in (writer, keepalive):
            if task is None:
                continue
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        registry.release(conn)
        for room_hash in rooms:
            room = registry.rooms.get(room_hash)
            if room is None:
                continue
            with contextlib.suppress(Exception):
                await registry.broadcast_presence(room)


async def websocket_endpoint(websocket: WebSocket) -> None:
    cfg: RelayConfig = websocket.app.state.relay_config
    registry: RoomRegistry = websocket.app.state.registry

    # Every admission failure ACCEPTS first, then closes. A close code cannot
    # be sent before the handshake completes, and §15.4 gives the client a code
    # to read for each refusal. "No side effects" still holds: the registry is
    # untouched until every check passes.
    await websocket.accept()

    # 1. Origin.
    if not origin_allowed(websocket.headers.get("origin"), cfg):
        await _refuse(websocket, CloseCode.ORIGIN_REFUSED, "origin")
        return

    # 0 (operator). A decommissioned relay answers "I've moved" and touches
    #    nothing else — before a reservation, so a redirect costs no slot.
    target = moved_target(cfg, websocket.url.path)
    if target is not None:
        await _moved(websocket, target)
        return

    ip = client_ip(websocket, cfg)

    # 2+3. Global and per-IP caps, as ONE reservation taken before the await.
    #      The refusal reason stays a single "cap": the client's response is the
    #      same (back off and retry, §§6.6/15.4), and distinguishing them in the
    #      close reason would tell a scanner how it was caught.
    reservation = registry.reserve(ip)
    if reservation is None:
        registry.note_refusal(ip)
        await _refuse(websocket, CloseCode.TRY_LATER, "cap")
        return

    conn: Connection | None = None
    try:
        conn = await _admit(websocket, registry, cfg, ip, reservation)
        if conn is None:
            return
        await _serve(websocket, conn, registry, cfg)
    finally:
        # `settle` is idempotent and `admit` already settled it on the success
        # path, so this single call releases the slot on EVERY other exit:
        # handshake timeout, bad hello, generation, room cap, duplicate connId,
        # and a disconnect that happened before the hello.
        registry.settle(reservation)
