"""registry.py — rooms, connections, caps, and reaping (§9).

This module is the relay's entire memory. It holds transient sockets and
hashes and nothing else: no ops, no cursors, no user data, no database. A
restart loses all of it and that is correct — durability lives in client
outboxes (§6.6), so a restarted relay only delays delivery, it cannot diverge
state (§9.1).

The registry is deliberately free of I/O beyond `Connection.enqueue_frame` and
`Connection.close`, so caps, budgets, and reaping are testable without a socket.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from .connection import Connection
from .constants import CloseCode, RelayConfig
from .protocol import Hello, Membership, encode, presence_frame


@dataclass
class Room:
    """One room hash. `key_gen` is fixed by the FIRST hello (§9 step 5)."""

    room_hash: str
    key_gen: int
    conns: dict[str, Connection] = field(default_factory=dict)
    # Set when the last connection leaves; None while occupied.
    reap_at: float | None = None


@dataclass
class Reservation:
    """One admission slot claimed BEFORE the handshake await (§9 steps 2-3).

    The defect this exists to close: the caps used to be checked, then the
    handler awaited the hello for up to `handshake_deadline`, then it mutated
    the registry with no recheck. Every handler arriving inside that window saw
    `total=0` and passed, so the ceiling was exceeded by the number of
    concurrent handshakes. `RELAY-GAPS.md` G1 reproduced it at `global_cap=1`:
    five hellos, `total=5`.

    `settled` makes release idempotent, so the endpoint can call
    `registry.settle(...)` from ONE `finally` no matter how far admission got.
    """

    ip: str
    settled: bool = False


class EgressBucket:
    """A token bucket in BYTES, used for both the room budget and the governor.

    Bytes and not messages: §10.1 is explicit that message-count limits miss the
    512 KB frames that actually matter.
    """

    __slots__ = ("capacity", "tokens", "refill_bps", "last_refill")

    def __init__(self, capacity: float, refill_bps: float, now: float | None = None) -> None:
        self.capacity = float(capacity)
        self.refill_bps = float(refill_bps)
        self.tokens = float(capacity)
        self.last_refill = time.monotonic() if now is None else now

    def spend(self, nbytes: int, now: float) -> bool:
        """Charge `nbytes`. False means the bucket is short — the caller SHEDS.

        Never raises and never blocks: a budget check that can block would make
        egress accounting the new head-of-line bottleneck.
        """
        elapsed = now - self.last_refill
        if elapsed > 0:
            self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_bps)
            self.last_refill = now
        if self.tokens < nbytes:
            return False
        self.tokens -= nbytes
        return True

    def starved(self, now: float, nbytes: int) -> bool:
        """True when a frame of `nbytes` would not fit — for admission pressure."""
        elapsed = max(0.0, now - self.last_refill)
        return self.tokens + elapsed * self.refill_bps < nbytes


class RoomRegistry:
    def __init__(self, cfg: RelayConfig) -> None:
        self.cfg = cfg
        self.rooms: dict[str, Room] = {}
        self.ip_counts: dict[str, int] = {}
        self.total = 0

        # ── §10.1 controls ─────────────────────────────────────────────────
        # Slots that passed the pre-handshake caps but have not been admitted.
        # `total + pending_total` is what `global_cap` bounds, and that is the
        # whole point: an 8 s handshake window must not be a free pass.
        self.pending_total = 0
        self.pending_by_ip: dict[str, int] = {}
        # Refusals per IP inside the churn window; the ban map is checked at
        # `reserve`, which is the cheapest gate there is.
        self.refusals: dict[str, list[float]] = {}
        self.banned_until: dict[str, float] = {}
        # The global egress governor. `starved_at` is when it last had to shed,
        # and §10.1 says pressure also rejects NEW admissions.
        self.governor = EgressBucket(cfg.egress_governor_burst, cfg.egress_governor_bps)
        self.starved_at: float | None = None
        # Per-room egress budgets, created with the room (§10.1). Keyed by hash
        # rather than hung off `Room`, so the room record stays a pure record
        # and the budget can be reset independently of reaping.
        self.room_egress: dict[str, EgressBucket] = {}
        # Counters for O2 metrics (G4). No room hashes, no IPs.
        self.dropped: dict[str, int] = {}
        self.shed_frames = 0
        self.shed_bytes = 0

    # ── Admission bookkeeping ──────────────────────────────────────────────

    def room_for(self, room_hash: str) -> Room | None:
        return self.rooms.get(room_hash)

    def ip_count(self, ip: str) -> int:
        return self.ip_counts.get(ip, 0)

    def reserve(self, ip: str) -> Reservation | None:
        """Claim one admission slot, or refuse — synchronously, before the await.

        THIS is the G1 fix. Both caps are read and both counters are written in
        one synchronous block, so no handler can interleave between the check
        and the claim. One asyncio thread is the entire synchronisation story:
        there is no lock because there is no await between the read and the
        write.

        The cost of the claim is bounded by `handshake_deadline`, so a flood of
        sockets that never say hello saturates `pending_total` and is refused
        rather than admitted — which is the cost bounding §10.1 asks for.
        """
        now = time.monotonic()
        if self._is_banned(ip, now):
            return None
        # §10.1: under egress pressure, reject NEW admissions and keep serving
        # the ones already here.
        if self.starved_at is not None and now - self.starved_at < self.cfg.pressure_window:
            return None
        if self.total + self.pending_total >= self.cfg.global_cap:
            return None
        if self.ip_count(ip) + self.pending_by_ip.get(ip, 0) >= self.cfg.conns_per_ip:
            return None

        self.pending_total += 1
        self.pending_by_ip[ip] = self.pending_by_ip.get(ip, 0) + 1
        return Reservation(ip=ip)

    def settle(self, reservation: Reservation) -> None:
        """Release a slot that was never fulfilled. Idempotent by contract."""
        if reservation.settled:
            return
        reservation.settled = True
        self._drop_pending(reservation.ip)

    def _drop_pending(self, ip: str) -> None:
        remaining = self.pending_by_ip.get(ip, 0) - 1
        if remaining > 0:
            self.pending_by_ip[ip] = remaining
        else:
            self.pending_by_ip.pop(ip, None)
        self.pending_total = max(0, self.pending_total - 1)

    def note_refusal(self, ip: str) -> None:
        """Count a refusal per IP and temp-ban a churner (§10.1).

        Refusals are counted, not admissions: a legitimate device that reconnects
        a few times is far below the threshold, while a reconnect storm is
        exactly what the counter measures.
        """
        now = time.monotonic()
        window = self.cfg.ip_churn_window
        stamps = [t for t in self.refusals.get(ip, ()) if now - t <= window]
        stamps.append(now)
        if len(stamps) >= self.cfg.ip_churn_threshold:
            self.banned_until[ip] = now + self.cfg.ip_churn_ban_seconds
            self.refusals.pop(ip, None)
            self.dropped["ip-banned"] = self.dropped.get("ip-banned", 0) + 1
            return
        self.refusals[ip] = stamps

    def _is_banned(self, ip: str, now: float) -> bool:
        until = self.banned_until.get(ip)
        if until is None:
            return False
        if now < until:
            return True
        del self.banned_until[ip]
        return False

    def admit(self, hello: Hello, ip: str, ws: Any, reservation: Reservation) -> Connection:
        """Register a connection that has already passed every admission check.

        Two things happen here that must not be separated by an `await`:

        1. The reservation becomes an admitted connection — one slot leaves
           `pending_*`, one enters `ip_counts`/`total`. Both caps therefore keep
           counting the socket at every instant of its life.
        2. Creating the room fixes its `keyGen`: the first hello to a hash wins,
           and every later hello must match or be refused with 4404 (§9 step 5,
           audit-2 N16 — the pass-3 check compared a connection's generation
           against itself, which is vacuously true).

        The caller has already run the post-handshake checks (generation, room
        cap, duplicate connId) with no `await` between them and this call, so
        those three remain atomic too.
        """
        if not reservation.settled:
            reservation.settled = True
            self._drop_pending(ip)

        room = self._ensure_room(hello.room_hash, hello.key_gen)

        conn = Connection(
            conn_id=hello.conn_id,
            room_hash=hello.room_hash,
            room_id=hello.room_id,
            key_gen=hello.key_gen,
            ip=ip,
            ws=ws,
            cfg=self.cfg,
        )
        room.conns[conn.conn_id] = conn
        room.reap_at = None
        self.ip_counts[ip] = self.ip_counts.get(ip, 0) + 1
        self.total += 1
        return conn

    def release(self, conn: Connection) -> None:
        """The single cleanup path. Every exit route funnels through here.

        Every membership is detached, not just the primary one: with
        multiplexing a socket can be a member of several rooms, and leaving the
        others populated would keep a ghost in their presence lists and their
        room caps forever. Room reaping is scheduled per room, exactly as before.
        """
        for room_hash in list(conn.memberships):
            conn.memberships.pop(room_hash, None)
            room = self.rooms.get(room_hash)
            if room is None:
                continue
            room.conns.pop(conn.conn_id, None)
            if not room.conns:
                # §9: the last connection leaving schedules the room for
                # reaping ~24h later. The room record survives so a late hello
                # still meets the generation check.
                room.reap_at = time.monotonic() + self.cfg.room_reap_after

        remaining = self.ip_counts.get(conn.ip, 0) - 1
        if remaining > 0:
            self.ip_counts[conn.ip] = remaining
        else:
            self.ip_counts.pop(conn.ip, None)
        self.total = max(0, self.total - 1)

    # ── Egress accounting (§10.1) ──────────────────────────────────────────

    def charge_egress(self, room_hash: str, nbytes: int, now: float | None = None) -> str | None:
        """Charge one outbound frame. None means send it; a string is the shed reason.

        Two buckets, charged in order and deliberately NOT merged:

        - the ROOM budget, because fan-out is what multiplies. One 512 KB inbound
          op becomes `len(conns)-1` outbound frames, so a per-connection budget
          cannot see the amplification that §10.1's math is about.
        - the GLOBAL governor, because the room budget is per-room and ten
          abusive rooms would each be politely within their own.

        A room that is merely loud sheds against its own budget and never sets
        `starved_at`; only the governor — real saturation — rejects admissions.
        """
        now = time.monotonic() if now is None else now

        room_bucket = self.room_egress.get(room_hash)
        if room_bucket is not None and not room_bucket.spend(nbytes, now):
            self._note_shed("room-budget", nbytes)
            return "room-budget"

        if not self.governor.spend(nbytes, now):
            self._note_shed("governor", nbytes)
            self.starved_at = now
            return "governor"
        return None

    def _note_shed(self, reason: str, nbytes: int) -> None:
        self.shed_frames += 1
        self.shed_bytes += nbytes
        self.dropped[reason] = self.dropped.get(reason, 0) + 1

    async def _deliver(self, conn: Connection, raw: str, now: float, room_hash: str) -> None:
        """Charge, then queue. A refusal SHEDS unless the policy says otherwise.

        §10.1: "under global pressure the relay sheds MESSAGES first … it
        disconnects sessions only on hygiene violations". Shedding is safe
        because the client's outbox is the durable record and catch-up re-sends
        (§6.6) — a shed frame delays sync, it cannot lose data.

        `room_hash` is the room the FRAME belongs to, not the socket's primary
        room: with multiplexing the two differ, and charging the wrong room would
        let one loud shelf spend another shelf's egress budget.

        The `disconnect` policy exists only so Gate G can measure the difference
        against the pre-G3 behaviour; it is not a production recommendation.
        """
        nbytes = len(raw)
        reason = self.charge_egress(room_hash, nbytes, now)
        if reason is not None:
            if self.cfg.shed_policy == "disconnect":
                await conn.close(CloseCode.POLICY_VIOLATION, reason)
            return

        if conn.enqueue_frame(raw):
            return
        self._note_shed("queue-full", nbytes)
        if self.cfg.shed_policy == "disconnect":
            await conn.close(CloseCode.POLICY_VIOLATION, "queue-full")

    # ── Multiplexing: many rooms on one socket ─────────────────────────────

    def _ensure_room(self, room_hash: str, key_gen: int) -> Room:
        """Get or create the room record, including its egress bucket.

        Called by `admit` and by `join_room`, so a room that arrives as a `join`
        gets the same budget a room that arrived as a hello would have.
        """
        room = self.rooms.get(room_hash)
        if room is None:
            room = Room(room_hash=room_hash, key_gen=key_gen)
            self.rooms[room_hash] = room
            self.room_egress[room_hash] = EgressBucket(
                self.cfg.room_egress_burst, self.cfg.room_egress_refill_bps
            )
        return room

    async def join_room(self, conn: Connection, member: Membership) -> str | None:
        """Add one room to an admitted socket. None means joined.

        The three room-level rules are the SAME ones `_admit` applies to a hello
        (generation, cap, duplicate connId) — a second room must not be a way to
        bypass what a first room has to satisfy. The difference is the failure
        mode: a refused `join` reports one room and leaves the socket and its
        other rooms untouched, because a stale generation on one shelf is not a
        reason to disconnect the others.
        """
        room = self.rooms.get(member.room_hash)
        if room is not None and room.key_gen != member.key_gen:
            return "generation"
        if room is not None and len(room.conns) >= self.cfg.room_cap:
            return "room-cap"
        if room is not None and conn.conn_id in room.conns:
            return "already-joined"

        room = self._ensure_room(member.room_hash, member.key_gen)
        room.conns[conn.conn_id] = conn
        room.reap_at = None
        conn.memberships[member.room_hash] = member
        await self.broadcast_presence(room)
        return None

    async def leave_room(self, conn: Connection, room_hash: str) -> bool:
        """Drop one room from a socket that stays open. False means no-op."""
        if conn.memberships.pop(room_hash, None) is None:
            return False
        room = self.rooms.get(room_hash)
        if room is None or room.conns.pop(conn.conn_id, None) is None:
            return True
        if not room.conns:
            room.reap_at = time.monotonic() + self.cfg.room_reap_after
        await self.broadcast_presence(room)
        return True

    def membership_for(self, conn: Connection, room_id: str) -> Membership | None:
        """The membership a frame's `roomId` names on this connection.

        Linear over a handful of rooms on purpose: the alternative is a second
        dict keyed by roomId, which would then have to be kept in sync with
        `memberships` in `join_room`, `leave_room` and `release`.
        """
        for member in conn.memberships.values():
            if member.room_id == room_id:
                return member
        return None


    async def send_room_frame(
        self,
        conn: Connection,
        msg: dict[str, Any],
        room_hash: str,
        now: float | None = None,
    ) -> None:
        """Deliver one relay-originated frame to ONE connection, egress charged.

        Relay-originated frames are not free: `joined` and `join-refused` go out
        on the same socket that carries envelopes, and §10.1's budgets are in
        bytes on the wire. Routing them through `_deliver` keeps the accounting
        identical to a fan-out frame and means the shed policy applies here too.
        """
        await self._deliver(
            conn, encode(msg), time.monotonic() if now is None else now, room_hash
        )

    # ── Routing ────────────────────────────────────────────────────────────

    async def route(self, sender: Connection, msg: dict[str, Any]) -> None:
        """Stamp `from`, serialise ONCE, then deliver (§9 "Message loop").

        Three rules, each of which was a defect in an earlier pass:

        - `from` is stamped by the RELAY, overwriting anything the client sent.
          Without it, targeted catch-up cannot name a peer (review-2 P0-3).
        - A `to:` naming a known connection is delivered ONLY to it. A `to:`
          MISS is a DROP, never a broadcast fallback (P0-5/P0-8) — the fallback
          turned every targeted reply into a room-wide leak.
        - A missing `to` fans out to every OTHER connection of the room.

        The room comes from the FRAME, resolved against this connection's
        memberships — not from the socket, which may hold several. A frame
        naming a room this connection never joined is dropped, and so is one
        whose keyGen no longer matches: both are the cross-room gate, and the
        AEAD tag remains the cryptographic one behind it.

        Serialising here rather than in each writer is what makes §10.1's byte
        accounting exact: the number charged against the budgets IS the number
        of bytes the writer hands the socket.
        """
        member = self.membership_for(sender, str(msg.get("roomId")))
        if member is None:
            return
        msg["from"] = sender.conn_id

        room = self.rooms.get(member.room_hash)
        if room is None:
            return

        raw = encode(msg)
        now = time.monotonic()

        to = msg.get("to")
        if to is not None:
            target = room.conns.get(to)
            if target is None:
                return
            await self._deliver(target, raw, now, member.room_hash)
            return

        for other in list(room.conns.values()):
            if other.conn_id == sender.conn_id:
                continue
            await self._deliver(other, raw, now, member.room_hash)

    async def broadcast_presence(self, room: Room) -> None:
        """Tell the room who is here (§9 "Presence").

        Presence goes to EVERY member including the newcomer, because the
        newcomer needs the roster to address its catch-up requests. It is the
        one frame the relay originates, and it carries no keyGen and no body.

        The frame names its room hash: on a multiplexed socket the client has
        several member lists to keep apart, and a presence frame that could not
        say which shelf it described would be applied to all of them.
        """
        if not room.conns:
            return
        raw = encode(presence_frame(room.conns.keys(), room.room_hash))
        now = time.monotonic()
        for conn in list(room.conns.values()):
            await self._deliver(conn, raw, now, room.room_hash)

    # ── Reaping ────────────────────────────────────────────────────────────

    def reap(self, now: float | None = None) -> list[str]:
        """Drop rooms whose reap deadline has passed. Returns the hashes."""
        now = time.monotonic() if now is None else now
        reaped: list[str] = []
        for room_hash, room in list(self.rooms.items()):
            if room.conns:
                continue
            if room.reap_at is not None and now >= room.reap_at:
                del self.rooms[room_hash]
                # The egress bucket belongs to the room, not to the socket that
                # created it. Dropping only `rooms` left one bucket per reaped
                # room forever — a slow unbounded-memory path, since any
                # well-formed hash mints a room (review-2 P2-5).
                self.room_egress.pop(room_hash, None)
                reaped.append(room_hash)
        return reaped

    async def reaper(self) -> None:
        """The sweep task. Cancelled on shutdown."""
        while True:
            try:
                await asyncio.sleep(self.cfg.reap_sweep_interval)
            except asyncio.CancelledError:
                return
            self.reap()
