"""connection.py — one socket, its bounded queue, and its two tasks (§9).

The relay's backpressure story is entirely here: a bounded queue, a writer with
a per-send deadline, and a keepalive that drops a half-open socket. Bounded
queues + deadlines + disconnects means there is NO unbounded growth path — a
slow consumer costs a connection, never memory (§9 "Writer and backpressure").

Durability never lives here. The memory queue is a transport buffer; the
client's outbox is the durable record (§6.6), so a dropped connection loses
nothing that a reconnect cannot re-send.

The queue holds **serialised frames**, not dicts. §10.1's budgets are in bytes,
so the size has to exist before the frame is queued; serialising once at the
routing boundary is also what keeps an N-recipient fan-out from doing N encodes
(`protocol.encode`).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from .constants import CloseCode, RelayConfig
from .protocol import Membership, encode, ping_frame


class Connection:
    """A socket that has passed all seven admission checks."""

    __slots__ = (
        "conn_id",
        "room_hash",
        "room_id",
        "key_gen",
        "memberships",
        "ip",
        "ws",
        "queue",
        "last_seen",
        "missed_pongs",
        "tokens",
        "last_refill",
        "closed",
        "close_reason",
        "shed",
    )

    def __init__(
        self,
        *,
        conn_id: str,
        room_hash: str,
        room_id: str,
        key_gen: int,
        ip: str,
        ws: Any,
        cfg: RelayConfig,
    ) -> None:
        self.conn_id = conn_id
        # The PRIMARY room — the one the hello named. Kept as plain fields
        # because that is what every log line and metric means by "this socket's
        # room". `memberships` is the authoritative set that routing uses.
        self.room_hash = room_hash
        self.room_id = room_id
        self.key_gen = key_gen
        self.memberships: dict[str, Membership] = {
            room_hash: Membership(room_id=room_id, key_gen=key_gen, room_hash=room_hash)
        }
        self.ip = ip
        self.ws = ws
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=cfg.queue_max)
        now = time.monotonic()
        self.last_seen = now
        self.missed_pongs = 0
        # A fresh connection starts with a full burst allowance.
        self.tokens = float(cfg.byte_budget_burst)
        self.last_refill = now
        self.closed = False
        self.close_reason: str | None = None
        # Frames this connection's queue refused. Counted per connection so the
        # metrics endpoint can show WHICH socket is being shed for (§15.18/O2).
        self.shed = 0

    # ── Budget ─────────────────────────────────────────────────────────────

    def spend(self, nbytes: int, now: float, cfg: RelayConfig) -> bool:
        """Charge `nbytes` against the token bucket. False means over budget.

        A token bucket, not a per-second counter: §9 asks for ~2 MB/s sustained
        with a ~5 MB burst, and a fixed window would let a client spend the
        whole budget twice across a window boundary.
        """
        elapsed = now - self.last_refill
        if elapsed > 0:
            self.tokens = min(
                float(cfg.byte_budget_burst),
                self.tokens + elapsed * cfg.byte_budget_sustained,
            )
            self.last_refill = now
        if self.tokens < nbytes:
            return False
        self.tokens -= nbytes
        return True

    # ── Queue ──────────────────────────────────────────────────────────────

    def enqueue_frame(self, raw: str) -> bool:
        """Offer one serialised frame to the writer. False means the queue is full.

        Synchronous on purpose: routing must never await a slow recipient, or
        one stalled socket would block the whole room's fan-out (§9).

        A full queue is NOT a disconnect any more (§10.1). The caller sheds the
        frame and counts it; a genuinely stuck socket is still caught by the
        writer's send deadline and by the keepalive's missed-pong rule, which
        are the two hygiene reasons §10.1 names.
        """
        if self.closed:
            return False
        try:
            self.queue.put_nowait(raw)
        except asyncio.QueueFull:
            self.shed += 1
            return False
        return True

    # ── Lifecycle ──────────────────────────────────────────────────────────

    async def close(self, code: int, reason: str = "") -> None:
        """Idempotent: the writer, the keepalive, and the endpoint all race here."""
        if self.closed:
            return
        self.closed = True
        self.close_reason = reason or str(code)
        try:
            await self.ws.close(code=code, reason=reason)
        except Exception:
            # The socket may already be gone; a failed close is not an error.
            pass

    async def writer(self, cfg: RelayConfig) -> None:
        """Drain the queue with a per-send deadline (§9).

        A blown deadline is a slow consumer: disconnect it. That is the whole
        point of the deadline — without it a stalled socket holds a queue slot
        forever and the room's fan-out degrades into a memory leak. It is also
        one of §10.1's named hygiene reasons, which is why shedding a frame
        never has to do this job.

        Frames arrive pre-serialised (`protocol.encode`), so this sends text and
        never re-encodes: the byte count charged against the budgets is exactly
        the byte count that goes on the wire.
        """
        while not self.closed:
            try:
                raw = await self.queue.get()
            except asyncio.CancelledError:
                return
            try:
                await asyncio.wait_for(self.ws.send_text(raw), cfg.send_deadline)
            except asyncio.CancelledError:
                return
            except (TimeoutError, asyncio.TimeoutError):
                await self.close(CloseCode.POLICY_VIOLATION, "send-deadline")
                return
            except Exception:
                await self.close(CloseCode.POLICY_VIOLATION, "send-failed")
                return

    async def keepalive(self, cfg: RelayConfig) -> None:
        """Ping on the 30s cadence; drop after 2 missed pongs (§9).

        This is what catches half-open sockets from backgrounded phones, and it
        is why Cloudflare's ~100s WS idle timeout never reaps a live-but-quiet
        socket (§11.2).

        The idle check is a backstop, not the primary mechanism: `last_seen`
        advances on ANY inbound frame including a pong, so a client that keeps
        answering pings is never idle-disconnected — "ping-pong alone keeps a
        live sync alive" (§9). Heartbeat normally wins the race at ~60s.
        """
        while not self.closed:
            try:
                await asyncio.sleep(cfg.heartbeat_interval)
            except asyncio.CancelledError:
                return
            if self.closed:
                return

            # Count the interval FIRST, then check: `missed_pongs` is the
            # number of intervals that passed with no inbound frame at all, so
            # `heartbeat_misses=2` at a 30s cadence drops at ~60s — which is
            # §9's stated number. Checking before the increment would take
            # misses+1 intervals and land at ~90s.
            self.missed_pongs += 1
            if self.missed_pongs >= cfg.heartbeat_misses:
                await self.close(CloseCode.POLICY_VIOLATION, "heartbeat")
                return

            now = time.monotonic()
            if now - self.last_seen > cfg.idle_timeout and self.queue.empty():
                await self.close(CloseCode.POLICY_VIOLATION, "idle")
                return

            # A full queue means the writer is already stuck; the send deadline
            # will close this connection, so a dropped ping needs no handling.
            #
            # Pings bypass the §10.1 egress budgets on purpose. They are relay
            # housekeeping (~16 bytes), and charging them would let the governor
            # shed the very frames that prove a socket is alive — turning a
            # budget event into a heartbeat disconnect, which is exactly the
            # "disconnects only on hygiene violations" rule §10.1 sets.
            self.enqueue_frame(encode(ping_frame()))
