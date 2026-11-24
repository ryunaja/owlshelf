"""test_backpressure.py — bounded queues, deadlines, and the byte budget (§9, §10.1).

§9's claim is that there is NO unbounded growth path: a slow consumer costs a
connection, never memory. §10.1 then narrows WHICH failure that connection is:
budgets and a full queue SHED the frame, and only hygiene violations (missed
pongs, idle, budget breach, send timeouts) disconnect. So the queue tests below
assert shedding plus a counter, and the two hygiene disconnects are asserted
where they live.

The frame-cap and byte-budget cases are unit tests on `handle_frame` because
uvicorn's `--ws-max-size` rejects an oversize frame before the app sees it —
the in-process check is a backstop for a deployment that forgot the flag, and
a socket test could not reach it.
"""

from __future__ import annotations

import json
import time


from app.relay.connection import Connection
from app.relay.constants import CloseCode
from app.relay.endpoint import handle_frame
from app.relay.protocol import Hello, encode
from app.relay.registry import RoomRegistry
from tests.conftest import HASH_A, base_config, envelope

CONN_A = "11111111-2222-3333-4444-555555555555"
CONN_B = "66666666-7777-8888-9999-aaaaaaaaaaaa"


class FakeWS:
    def __init__(self) -> None:
        self.closed_with: tuple[int, str] | None = None
        self.sent: list[dict] = []

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)

    async def send_text(self, raw: str) -> None:
        self.sent.append(json.loads(raw))


def make_conn(cfg, conn_id: str = CONN_A) -> Connection:
    return Connection(
        conn_id=conn_id,
        room_hash=HASH_A,
        room_id="room-a",
        key_gen=1,
        ip="127.0.0.1",
        ws=FakeWS(),
        cfg=cfg,
    )


def two_conn_room(cfg):
    """Two admitted connections in one room, through the real reservation path."""
    registry = RoomRegistry(cfg)
    conns = []
    for conn_id in (CONN_A, CONN_B):
        reservation = registry.reserve("127.0.0.1")
        assert reservation is not None, "the test config must admit two sockets"
        conns.append(
            registry.admit(
                Hello(conn_id=conn_id, room_id="room-a", key_gen=1, room_hash=HASH_A),
                "127.0.0.1",
                FakeWS(),
                reservation,
            )
        )
    # Presence is charged and queued as part of admitting; drain it so each
    # test starts from an empty queue.
    for conn in conns:
        while not conn.queue.empty():
            conn.queue.get_nowait()
    return registry, conns[0], conns[1]


# ── Queue ──────────────────────────────────────────────────────────────────


class TestQueue:
    def test_enqueue_accepts_until_the_queue_is_full(self):
        cfg = base_config(queue_max=2)
        conn = make_conn(cfg)
        assert conn.enqueue_frame('{"n":1}') is True
        assert conn.enqueue_frame('{"n":2}') is True
        assert conn.enqueue_frame('{"n":3}') is False
        assert conn.shed == 1, "the refusal is counted on the connection"

    def test_enqueue_refuses_after_close(self):
        cfg = base_config()
        conn = make_conn(cfg)
        conn.closed = True
        assert conn.enqueue_frame('{"n":1}') is False

    async def test_a_full_queue_sheds_the_frame_and_keeps_the_session(self):
        # §10.1: "it disconnects sessions only on hygiene violations". A full
        # queue is a slow consumer, which the writer's send deadline and the
        # keepalive already own — so routing must not add a third disconnect.
        cfg = base_config(queue_max=1)
        registry, a, b = two_conn_room(cfg)
        assert b.enqueue_frame('{"filler":true}') is True

        await registry.route(a, envelope())

        assert b.closed is False, "the session survives"
        assert registry.dropped["queue-full"] == 1, "and the shed is counted"
        assert registry.shed_frames == 1

    async def test_the_disconnect_policy_still_closes_when_asked(self):
        # Kept ONLY so Gate G can measure the difference from the pre-G3
        # behaviour; it is not a production recommendation.
        cfg = base_config(queue_max=1, shed_policy="disconnect")
        registry, a, b = two_conn_room(cfg)
        assert b.enqueue_frame('{"filler":true}') is True

        await registry.route(a, envelope())

        assert b.closed is True
        assert b.ws.closed_with == (CloseCode.POLICY_VIOLATION, "queue-full")

    async def test_route_leaves_a_target_with_room_alone(self):
        cfg = base_config(queue_max=4)
        registry, a, b = two_conn_room(cfg)

        await registry.route(a, envelope())

        assert b.closed is False
        assert b.queue.qsize() == 1

    async def test_a_full_sender_queue_does_not_block_the_fan_out(self):
        # The sender is excluded from its own broadcast, so its queue state is
        # irrelevant. If it were not, one stuck sender would stall the room.
        cfg = base_config(queue_max=1)
        registry, a, b = two_conn_room(cfg)
        assert a.enqueue_frame('{"filler":true}') is True

        await registry.route(a, envelope())

        assert b.queue.qsize() == 1
        assert b.closed is False


# ── Byte budget ────────────────────────────────────────────────────────────


class TestByteBudget:
    def test_a_burst_is_allowed_then_refused(self):
        cfg = base_config(byte_budget_burst=100, byte_budget_sustained=0)
        conn = make_conn(cfg)
        now = time.monotonic()
        assert conn.spend(100, now, cfg) is True
        assert conn.spend(1, now, cfg) is False

    def test_the_bucket_refills_at_the_sustained_rate(self):
        cfg = base_config(byte_budget_burst=100, byte_budget_sustained=10)
        conn = make_conn(cfg)
        now = time.monotonic()
        assert conn.spend(100, now, cfg) is True
        assert conn.spend(10, now, cfg) is False
        # One second later the bucket holds 10 more bytes.
        assert conn.spend(10, now + 1.0, cfg) is True

    def test_the_bucket_never_exceeds_the_burst(self):
        cfg = base_config(byte_budget_burst=100, byte_budget_sustained=10)
        conn = make_conn(cfg)
        now = time.monotonic()
        conn.spend(100, now, cfg)
        # A long idle period must not bank an unbounded allowance.
        assert conn.spend(101, now + 1000.0, cfg) is False


# ── Egress accounting (§10.1) ──────────────────────────────────────────────


class TestEgressAccounting:
    async def test_a_fan_out_charges_every_recipient(self):
        cfg = base_config()
        registry, a, b = two_conn_room(cfg)
        before = registry.governor.tokens

        await registry.route(a, envelope())

        raw_len = len(encode({"from": CONN_A, **envelope()}))
        assert registry.governor.tokens <= before - raw_len

    async def test_an_exhausted_room_budget_sheds_without_disconnecting(self):
        cfg = base_config(room_egress_burst=1, room_egress_refill_bps=0)
        registry, a, b = two_conn_room(cfg)
        registry.room_egress[HASH_A].tokens = 0

        await registry.route(a, envelope())

        assert b.closed is False, "a loud room degrades, never dies"
        assert registry.dropped["room-budget"] == 1
        assert b.queue.qsize() == 0

    async def test_governor_exhaustion_sheds_and_rejects_new_admissions(self):
        cfg = base_config(egress_governor_burst=1, egress_governor_bps=0)
        registry, a, b = two_conn_room(cfg)
        registry.governor.tokens = 0

        await registry.route(a, envelope())

        assert b.closed is False
        assert registry.dropped["governor"] == 1
        assert registry.starved_at is not None, "pressure is recorded"
        assert registry.reserve("203.0.113.9") is None, "and new admissions are refused"

    async def test_room_pressure_alone_does_not_reject_admissions(self):
        # Only the GLOBAL governor means "the pipe is saturated". A single loud
        # room must not lock everyone out.
        cfg = base_config(room_egress_burst=1, room_egress_refill_bps=0)
        registry, a, _ = two_conn_room(cfg)
        registry.room_egress[HASH_A].tokens = 0

        await registry.route(a, envelope())

        assert registry.starved_at is None
        assert registry.reserve("203.0.113.9") is not None


# ── handle_frame ───────────────────────────────────────────────────────────


class TestHandleFrame:
    async def test_an_oversize_frame_is_a_hygiene_disconnect(self):
        cfg = base_config(frame_cap=10)
        registry, a, _ = two_conn_room(cfg)
        await handle_frame(a, "x" * 100, registry, cfg)
        assert a.closed is True
        assert a.ws.closed_with == (CloseCode.POLICY_VIOLATION, "frame-cap")

    async def test_an_exhausted_budget_is_a_hygiene_disconnect(self):
        cfg = base_config(byte_budget_burst=10, byte_budget_sustained=0)
        registry, a, _ = two_conn_room(cfg)
        await handle_frame(a, "x" * 100, registry, cfg)
        assert a.closed is True
        assert a.ws.closed_with == (CloseCode.POLICY_VIOLATION, "byte-budget")

    async def test_liveness_is_recorded_before_any_rejection(self):
        # A client that sends garbage is still alive. If liveness were recorded
        # after the shape check, a buggy client would be dropped by the
        # heartbeat for a reason that has nothing to do with being alive.
        cfg = base_config()
        registry, a, _ = two_conn_room(cfg)
        a.last_seen = 0.0
        a.missed_pongs = 5

        await handle_frame(a, "not json", registry, cfg)

        assert a.last_seen > 0.0
        assert a.missed_pongs == 0
        assert a.closed is False

    async def test_a_valid_envelope_is_routed(self):
        cfg = base_config()
        registry, a, b = two_conn_room(cfg)
        await handle_frame(a, json.dumps(envelope()), registry, cfg)
        assert b.queue.qsize() == 1
        assert json.loads(b.queue.get_nowait())["from"] == CONN_A

    async def test_a_heartbeat_frame_is_consumed(self):
        cfg = base_config()
        registry, a, b = two_conn_room(cfg)
        await handle_frame(a, json.dumps({"type": "pong"}), registry, cfg)
        assert b.queue.qsize() == 0
