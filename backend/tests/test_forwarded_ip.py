"""test_forwarded_ip.py — the per-IP cap in the mandated deployment topology (G2).

Plan §10.3/§15.18/O3 run the relay behind cloudflared in the same pod, so the
peer address is ALWAYS loopback. If forwarded headers are not trusted, every
user shares one bucket and `conns_per_ip` (12 by default) caps the whole relay
at that many sockets. Closing that gap is why the policy defaults to trusting a
*loopback* peer.

The boundary that makes the default safe is the loopback test in `client_ip`,
not the flag: a remote attacker cannot present as 127.0.0.1, so it can never
choose its own bucket no matter what the flag says. The flag exists for the
deployment where a NON-cloudflared local proxy forwards unsanitised
`X-Forwarded-For` — there the client's own value is the first element, and
trusting it would be a per-IP-cap bypass. `RELAY_TOPOLOGY=direct` is how that
deployment says so.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from types import SimpleNamespace

import pytest
import websockets

from app.relay.constants import RelayConfig, topology_label
from app.relay.endpoint import client_ip
from tests.conftest import ORIGIN, hello_frame


def fake_socket(peer: str, **headers: str):
    return SimpleNamespace(
        client=SimpleNamespace(host=peer),
        headers=headers,
    )


class TestClientIp:
    def test_a_non_loopback_peer_cannot_choose_its_own_bucket(self):
        # The one guard that must survive any policy: a direct peer's header is
        # a claim about itself, and is ignored even with trust fully on.
        cfg = RelayConfig(trust_forwarded_for=True)
        ws = fake_socket("203.0.113.9", **{"cf-connecting-ip": "1.2.3.4"})
        assert client_ip(ws, cfg) == "203.0.113.9"

    def test_a_trusted_loopback_proxys_header_is_honoured(self):
        cfg = RelayConfig(trust_forwarded_for=True)
        cf = fake_socket("127.0.0.1", **{"cf-connecting-ip": "1.2.3.4"})
        assert client_ip(cf, cfg) == "1.2.3.4"

        xff = fake_socket("::1", **{"x-forwarded-for": "5.6.7.8, 9.9.9.9"})
        assert client_ip(xff, cfg) == "5.6.7.8"

    def test_cloudflares_header_wins_over_x_forwarded_for(self):
        # CF sets `CF-Connecting-IP` itself and strips a client copy; XFF's
        # first element can be a value the client appended. Preferring CF is
        # what keeps the bucket unforgeable through the tunnel.
        cfg = RelayConfig(trust_forwarded_for=True)
        ws = fake_socket(
            "127.0.0.1",
            **{"cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "6.6.6.6"},
        )
        assert client_ip(ws, cfg) == "1.2.3.4"

    def test_a_loopback_proxy_header_is_ignored_when_trust_is_off(self):
        # The `direct` topology: a local proxy that does not sanitise XFF must
        # not hand clients a bucket of their choosing.
        cfg = RelayConfig(trust_forwarded_for=False)
        ws = fake_socket("127.0.0.1", **{"cf-connecting-ip": "1.2.3.4"})
        assert client_ip(ws, cfg) == "127.0.0.1"

    def test_an_untrusted_peer_with_no_header_still_buckets_on_its_address(self):
        assert client_ip(fake_socket("203.0.113.9"), RelayConfig()) == "203.0.113.9"


class TestTopologyResolution:
    """The policy has one resolver, so env, default and deploy cannot disagree."""

    def test_the_default_matches_the_mandated_topology(self):
        assert RelayConfig().trust_forwarded_for is True
        assert topology_label(RelayConfig()) == "tunnel"

    def test_relay_topology_direct_turns_trust_off(self, monkeypatch):
        monkeypatch.setenv("RELAY_TOPOLOGY", "direct")
        assert RelayConfig.from_env().trust_forwarded_for is False

    def test_relay_topology_tunnel_turns_trust_on(self, monkeypatch):
        monkeypatch.setenv("RELAY_TOPOLOGY", "tunnel")
        monkeypatch.delenv("TRUST_FORWARDED_FOR", raising=False)
        assert RelayConfig.from_env().trust_forwarded_for is True

    def test_the_low_level_override_works_without_a_topology(self, monkeypatch):
        monkeypatch.delenv("RELAY_TOPOLOGY", raising=False)
        monkeypatch.setenv("TRUST_FORWARDED_FOR", "0")
        assert RelayConfig.from_env().trust_forwarded_for is False

    def test_a_contradiction_raises_instead_of_picking_one(self, monkeypatch):
        monkeypatch.setenv("RELAY_TOPOLOGY", "tunnel")
        monkeypatch.setenv("TRUST_FORWARDED_FOR", "0")
        with pytest.raises(ValueError, match="TRUST_FORWARDED_FOR"):
            RelayConfig.from_env()

    def test_a_typo_in_the_topology_raises(self, monkeypatch):
        monkeypatch.setenv("RELAY_TOPOLOGY", "tunel")
        with pytest.raises(ValueError, match="RELAY_TOPOLOGY"):
            RelayConfig.from_env()


async def test_distinct_tunnel_users_get_distinct_ip_buckets_by_default(relay_factory):
    """The G2 regression, as a normal test.

    `conns_per_ip=1` is the worst case: four users with distinct
    `CF-Connecting-IP` values behind a loopback proxy must get four distinct
    buckets. Connect+hello one at a time so G1's admission path cannot mask a
    shared bucket behind a cap refusal.
    """
    relay = relay_factory(conns_per_ip=1)
    socks = []
    try:
        for i in range(4):
            ws = await websockets.connect(
                relay.url,
                origin=ORIGIN,
                additional_headers={"CF-Connecting-IP": f"198.51.100.{i + 1}"},
            )
            await ws.send(json.dumps(hello_frame(conn_id=str(uuid.uuid4()))))
            socks.append(ws)
            await asyncio.sleep(0.1)

        assert relay.registry.total == 4
        assert set(relay.registry.ip_counts) == {
            "198.51.100.1",
            "198.51.100.2",
            "198.51.100.3",
            "198.51.100.4",
        }
    finally:
        for ws in socks:
            try:
                await ws.close()
            except Exception:
                pass


async def test_direct_topology_refuses_to_bucket_four_tunnel_users_apart(relay_factory):
    """The other half: with trust off, the same four ARE one bucket.

    Kept green on purpose. It is not a bug to be fixed — it is the correct
    behaviour for a deployment whose peer address is already the real client,
    and asserting it stops a future "fix" from trusting headers unconditionally.
    """
    relay = relay_factory(conns_per_ip=4, trust_forwarded_for=False)
    socks = []
    try:
        for i in range(4):
            ws = await websockets.connect(
                relay.url,
                origin=ORIGIN,
                additional_headers={"CF-Connecting-IP": f"198.51.100.{i + 1}"},
            )
            await ws.send(json.dumps(hello_frame(conn_id=str(uuid.uuid4()))))
            socks.append(ws)
            await asyncio.sleep(0.1)

        assert set(relay.registry.ip_counts) == {"127.0.0.1"}
        assert relay.registry.ip_counts["127.0.0.1"] == 4
    finally:
        for ws in socks:
            try:
                await ws.close()
            except Exception:
                pass
