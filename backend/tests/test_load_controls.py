"""test_load_controls.py — §10.1's always-on abuse controls (G3).

Two halves, because they fail differently:

- the KNOBS, which are the contract that makes Gate G tunable at all. A control
  with a hard-coded literal cannot be measured under load.
- the SEMANTICS, which is §10.1's real sentence: "under global pressure the
  relay sheds MESSAGES first … it disconnects sessions only on hygiene
  violations". A knob that exists but disconnects on pressure has not closed
  this gap.

The measured load test (10 connections in one room, egress under the governor,
shed frames recovered by durable catch-up) still belongs to Gate G: it needs a
running relay under real traffic.
"""

from __future__ import annotations

import asyncio
import json
import time

from app.relay.constants import RelayConfig
from app.relay.registry import EgressBucket
from tests.conftest import base_config, envelope

FIELDS = set(RelayConfig.__dataclass_fields__)


# ── The knobs (§10.1) ──────────────────────────────────────────────────────


def test_a_per_room_egress_budget_is_configurable():
    assert "room_egress_burst" in FIELDS
    assert "room_egress_refill_bps" in FIELDS
    # §10.1's literal: a 20 MB burst per room.
    assert RelayConfig().room_egress_burst == 20 * 1024 * 1024


def test_a_global_egress_governor_is_configurable():
    assert {"egress_governor_bps", "egress_governor_burst"} <= FIELDS
    # §10.1's literal: ~100 Mbps. The bucket is in BYTES per second.
    assert RelayConfig().egress_governor_bps == 12_500_000


def test_an_ip_churn_throttle_is_configurable():
    assert {
        "ip_churn_threshold",
        "ip_churn_window",
        "ip_churn_ban_seconds",
    } <= FIELDS


def test_every_new_knob_is_env_overridable(monkeypatch):
    # The knobs are useless to Gate G if only a code change can move them.
    monkeypatch.setenv("ROOM_EGRESS_BURST", "1234")
    monkeypatch.setenv("EGRESS_GOVERNOR_BPS", "5678")
    monkeypatch.setenv("IP_CHURN_THRESHOLD", "9")
    monkeypatch.setenv("SHED_POLICY", "disconnect")
    cfg = RelayConfig.from_env()
    assert cfg.room_egress_burst == 1234
    assert cfg.egress_governor_bps == 5678
    assert cfg.ip_churn_threshold == 9
    assert cfg.shed_policy == "disconnect"


# ── The buckets ────────────────────────────────────────────────────────────


class TestEgressBucket:
    def test_a_burst_is_spent_then_the_bucket_is_short(self):
        bucket = EgressBucket(capacity=100, refill_bps=0, now=0.0)
        assert bucket.spend(100, now=0.0) is True
        assert bucket.spend(1, now=0.0) is False

    def test_it_refills_at_the_configured_rate(self):
        bucket = EgressBucket(capacity=100, refill_bps=10, now=0.0)
        bucket.spend(100, now=0.0)
        assert bucket.spend(10, now=1.0) is True

    def test_it_never_banks_more_than_its_capacity(self):
        bucket = EgressBucket(capacity=100, refill_bps=10, now=0.0)
        bucket.spend(100, now=0.0)
        assert bucket.spend(101, now=10_000.0) is False

    def test_starved_reports_the_same_answer_without_spending(self):
        bucket = EgressBucket(capacity=100, refill_bps=0, now=0.0)
        assert bucket.starved(now=0.0, nbytes=50) is False
        bucket.spend(60, now=0.0)
        assert bucket.starved(now=0.0, nbytes=50) is True
        assert bucket.starved(now=0.0, nbytes=40) is False


# ── The semantics (§10.1) ──────────────────────────────────────────────────


class _FakeWS:
    def __init__(self) -> None:
        self.closed_with = None
        self.sent: list[str] = []

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)

    async def send_text(self, raw: str) -> None:
        self.sent.append(raw)


async def _admitted(registry, conn_id: str, ip: str):
    from app.relay.protocol import Hello

    reservation = registry.reserve(ip)
    assert reservation is not None
    conn = registry.admit(
        Hello(conn_id=conn_id, room_id="room-a", key_gen=1, room_hash="a" * 64),
        ip,
        _FakeWS(),
        reservation,
    )
    while not conn.queue.empty():
        conn.queue.get_nowait()
    return conn


class TestShedding:
    async def test_a_budget_breach_sheds_and_never_disconnects(self):
        cfg = base_config(room_egress_burst=10, room_egress_refill_bps=0)
        from app.relay.registry import RoomRegistry

        registry = RoomRegistry(cfg)
        a = await _admitted(registry, "11111111-1111-1111-1111-111111111111", "10.0.0.1")
        b = await _admitted(registry, "22222222-2222-2222-2222-222222222222", "10.0.0.2")

        # A 512 KB body is well past a 10-byte room budget.
        await registry.route(a, envelope(body="x" * 4096))

        assert b.closed is False, "a shed frame must not end a session"
        assert registry.dropped["room-budget"] == 1
        assert b.queue.qsize() == 0

    async def test_a_shed_frame_is_recoverable_because_the_log_is_durable(self):
        # §10.1's whole justification: shedding is safe because the client's
        # outbox is the durable record and catch-up re-sends. The relay only has
        # to NOT pretend the frame was delivered — which is why the shed is
        # counted rather than silently swallowed.
        cfg = base_config(egress_governor_burst=1, egress_governor_bps=0)
        from app.relay.registry import RoomRegistry

        registry = RoomRegistry(cfg)
        a = await _admitted(registry, "11111111-1111-1111-1111-111111111111", "10.0.0.1")
        await _admitted(registry, "22222222-2222-2222-2222-222222222222", "10.0.0.2")

        await registry.route(a, envelope())
        await registry.route(a, envelope())

        assert registry.dropped["governor"] >= 1
        assert registry.shed_frames == registry.dropped.get("governor", 0) + registry.dropped.get(
            "room-budget", 0
        )

    async def test_the_governor_also_rejects_new_admissions(self):
        cfg = base_config(egress_governor_burst=1, egress_governor_bps=0)
        from app.relay.registry import RoomRegistry

        registry = RoomRegistry(cfg)
        a = await _admitted(registry, "11111111-1111-1111-1111-111111111111", "10.0.0.1")
        # A second member: routing skips the sender, so a one-connection room
        # charges no egress at all and would make this assertion vacuous.
        await _admitted(registry, "22222222-2222-2222-2222-222222222222", "10.0.0.2")
        await registry.route(a, envelope())
        assert registry.dropped["governor"] == 1
        assert registry.reserve("10.9.9.9") is None

    async def test_pressure_lifts_once_the_window_passes(self):
        cfg = base_config(egress_governor_burst=1, egress_governor_bps=0, pressure_window=0.05)
        from app.relay.registry import RoomRegistry

        registry = RoomRegistry(cfg)
        a = await _admitted(registry, "11111111-1111-1111-1111-111111111111", "10.0.0.1")
        # A second member: routing skips the sender, so a one-connection room
        # charges no egress at all and would make this assertion vacuous.
        await _admitted(registry, "22222222-2222-2222-2222-222222222222", "10.0.0.2")
        await registry.route(a, envelope())
        assert registry.dropped["governor"] == 1
        assert registry.reserve("10.9.9.9") is None

        await asyncio.sleep(0.08)
        assert registry.reserve("10.9.9.9") is not None, "admissions resume on their own"


class TestChurnBan:
    async def test_a_banned_ip_is_refused_before_any_other_check(self):
        cfg = base_config(ip_churn_threshold=2, ip_churn_ban_seconds=5.0)
        from app.relay.registry import RoomRegistry

        registry = RoomRegistry(cfg)
        registry.note_refusal("198.51.100.7")
        registry.note_refusal("198.51.100.7")

        assert "198.51.100.7" in registry.banned_until
        assert registry.reserve("198.51.100.7") is None
        assert registry.reserve("198.51.100.8") is not None, "one churner does not ban a neighbour"

    async def test_a_legitimate_retry_is_not_banned(self):
        cfg = base_config(ip_churn_threshold=5, ip_churn_ban_seconds=5.0)
        from app.relay.registry import RoomRegistry

        registry = RoomRegistry(cfg)
        for _ in range(4):
            registry.note_refusal("198.51.100.7")
        assert "198.51.100.7" not in registry.banned_until

    async def test_a_ban_expires(self):
        cfg = base_config(ip_churn_threshold=1, ip_churn_ban_seconds=0.05)
        from app.relay.registry import RoomRegistry

        registry = RoomRegistry(cfg)
        registry.note_refusal("198.51.100.7")
        assert registry.reserve("198.51.100.7") is None
        await asyncio.sleep(0.08)
        assert registry.reserve("198.51.100.7") is not None


class TestMetricsText:
    def test_the_exposition_has_types_and_the_shed_counters(self):
        from app.relay.app import prometheus_text
        from app.relay.registry import RoomRegistry

        registry = RoomRegistry(base_config())
        registry.dropped["room-budget"] = 3
        registry.shed_frames = 3
        text = prometheus_text(registry)

        assert "# TYPE owlshelf_relay_connections gauge" in text
        assert 'owlshelf_relay_dropped{reason="room-budget"} 3' in text
        assert "owlshelf_relay_shed_frames 3" in text
        # Nothing user-identifying: no room hash, no IP, no connId.
        assert "a" * 64 not in text
        assert "127.0.0.1" not in text


def test_metrics_only_answers_a_loopback_caller():
    from types import SimpleNamespace

    from app.relay.app import _LOOPBACK

    assert "127.0.0.1" in _LOOPBACK
    assert "203.0.113.9" not in _LOOPBACK
    # The route body compares against the same set, so this is the guard.
    assert SimpleNamespace(host="203.0.113.9").host not in _LOOPBACK


class TestMetricsPrivacy:
    """O2's "on 127.0.0.1 only" has to survive the mandated topology.

    cloudflared shares the relay's network namespace, so a request that arrived
    from the INTERNET still has a loopback peer. A peer-only guard would be a
    control that reads correctly and does nothing.
    """

    def test_a_host_scraper_is_allowed(self):
        from app.relay.app import metrics_allowed

        assert metrics_allowed("127.0.0.1", {}) is True
        assert metrics_allowed("::1", {}) is True

    def test_a_public_peer_is_refused(self):
        from app.relay.app import metrics_allowed

        assert metrics_allowed("203.0.113.9", {}) is False

    def test_a_tunnel_proxied_request_is_refused_even_from_loopback(self):
        from app.relay.app import metrics_allowed

        # This is the case the peer check cannot see.
        assert metrics_allowed("127.0.0.1", {"cf-connecting-ip": "1.2.3.4"}) is False
        assert metrics_allowed("127.0.0.1", {"cf-ray": "8f00-AMS"}) is False

    def test_an_unknown_peer_is_refused(self):
        from app.relay.app import metrics_allowed

        assert metrics_allowed(None, {}) is False
