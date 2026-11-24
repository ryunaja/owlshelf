"""test_ops.py — config layering (O1), the topology guard (G2), the moved redirect (G5).

Every test here exists because the failure mode is silence: a relay that runs on
defaults the operator believes they overrode, or a decommissioned domain that
just stops answering, looks exactly like a healthy one from the outside.
"""

from __future__ import annotations

import asyncio
import json

import pytest
import websockets

from app.relay.constants import RelayConfig
from app.relay.ops import ConfigError, load_config, read_toml, source_summary
from main import topology_note
from tests.conftest import ORIGIN, expect_close, hello_frame, recv_presence


# ── relay.toml (O1) ────────────────────────────────────────────────────────


def write(tmp_path, text: str):
    path = tmp_path / "relay.toml"
    path.write_text(text, encoding="utf-8")
    return path


class TestToml:
    def test_a_plain_key_overrides_the_default(self, tmp_path):
        path = write(tmp_path, 'room_cap = 3\nconns_per_ip = 2\n')
        assert read_toml(path) == {"room_cap": 3, "conns_per_ip": 2}

    def test_kebab_case_is_accepted(self, tmp_path):
        # The plan's prose writes `room-cap`; a config copied from it must load.
        path = write(tmp_path, 'room-cap = 4\n')
        assert read_toml(path) == {"room_cap": 4}

    def test_an_unknown_key_fails_the_boot(self, tmp_path):
        # A silently ignored typo is the same defect class as G2: a relay that
        # behaves nothing like the file says.
        path = write(tmp_path, 'consp_per_ip = 2\n')
        with pytest.raises(ConfigError, match="unknown key"):
            read_toml(path)

    def test_a_wrong_type_fails_the_boot(self, tmp_path):
        path = write(tmp_path, 'room_cap = "ten"\n')
        with pytest.raises(ConfigError, match="room_cap"):
            read_toml(path)

    def test_origins_are_a_list(self, tmp_path):
        path = write(tmp_path, 'allowed_origins = ["https://a.example", "https://b.example"]\n')
        assert read_toml(path)["allowed_origins"] == ("https://a.example", "https://b.example")

    def test_the_moved_map_is_a_table(self, tmp_path):
        path = write(tmp_path, '[moved]\n"/ws" = "wss://new.example/ws"\n')
        assert read_toml(path)["moved"] == (("/ws", "wss://new.example/ws"),)


class TestLayering:
    def test_a_missing_default_file_is_fine(self, monkeypatch):
        monkeypatch.delenv("RELAY_CONFIG", raising=False)
        cfg = load_config(env={})
        assert cfg.room_cap == RelayConfig().room_cap

    def test_a_missing_explicit_file_raises(self, monkeypatch, tmp_path):
        monkeypatch.delenv("RELAY_CONFIG", raising=False)
        with pytest.raises(ConfigError, match="does not exist"):
            load_config(str(tmp_path / "nope.toml"), env={})

    def test_the_file_overrides_the_default_and_env_overrides_the_file(self, tmp_path):
        path = write(tmp_path, "room_cap = 3\nconns_per_ip = 2\n")
        cfg = load_config(path, env={"CONNS_PER_IP": "9"})
        assert cfg.room_cap == 3, "from the file"
        assert cfg.conns_per_ip == 9, "env wins over the file"

    def test_an_empty_env_var_means_unset_not_empty(self, tmp_path):
        path = write(tmp_path, "room_cap = 3\n")
        cfg = load_config(path, env={"ROOM_CAP": ""})
        assert cfg.room_cap == 3

    def test_the_source_summary_names_the_file_and_the_env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ROOM_CAP", "3")
        path = write(tmp_path, "conns_per_ip = 2\n")
        summary = source_summary(load_config(path, env={"ROOM_CAP": "3"}), str(path))
        assert str(path) in summary
        assert "ROOM_CAP" in summary


# ── The topology guard (G2) ────────────────────────────────────────────────


class TestTopologyNote:
    def test_a_loopback_bind_without_trust_is_a_warning(self):
        level, message = topology_note(RelayConfig(trust_forwarded_for=False), "127.0.0.1")
        assert level == "warning"
        assert "conns_per_ip" in message
        # The message must name the consequence, not the flag.
        assert "sockets total" in message

    def test_trust_on_a_loopback_bind_is_information(self):
        level, message = topology_note(RelayConfig(trust_forwarded_for=True), "127.0.0.1")
        assert level == "info"
        assert "CF-Connecting-IP" in message

    def test_a_direct_bind_is_information(self):
        level, message = topology_note(RelayConfig(trust_forwarded_for=False), "0.0.0.0")
        assert level == "info"
        assert "direct" in message

    def test_trust_on_a_public_bind_does_not_claim_a_tunnel(self):
        # A public bind with trust on is still safe (a non-loopback peer cannot
        # choose a bucket), but the note must not call it a tunnel.
        level, message = topology_note(RelayConfig(trust_forwarded_for=True), "0.0.0.0")
        assert level == "info"
        assert "loopback peer only" in message


# ── moved (G5) ─────────────────────────────────────────────────────────────


class TestMoved:
    async def test_a_configured_redirect_sends_one_frame_and_closes_1000(self, relay_factory):
        relay = relay_factory(moved=(("*", "wss://new.example/ws"),))
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        frame = json.loads(await asyncio.wait_for(ws.recv(), 2.0))
        assert frame == {"type": "moved", "to": "wss://new.example/ws"}
        assert await expect_close(ws) == 1000
        assert relay.registry.total == 0, "a redirect touches nothing"
        assert relay.registry.pending_total == 0, "and costs no slot"

    async def test_a_path_specific_redirect_beats_the_catch_all(self, relay_factory):
        relay = relay_factory(
            moved=(("/ws", "wss://exact.example/ws"), ("*", "wss://catch.example/ws"))
        )
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        frame = json.loads(await asyncio.wait_for(ws.recv(), 2.0))
        assert frame["to"] == "wss://exact.example/ws"
        assert await expect_close(ws) == 1000

    async def test_no_config_means_no_redirect(self, relay):
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        try:
            await ws.send(json.dumps(hello_frame()))
            assert (await recv_presence(ws))["type"] == "presence"
        finally:
            await ws.close()

    async def test_a_client_cannot_inject_a_redirect(self, relay):
        # The map is operator config. A hello naming a `to` or a `moved` field
        # must not turn the relay into a redirector for it.
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        try:
            payload = hello_frame()
            payload["moved"] = "wss://evil.example/ws"
            payload["to"] = "wss://evil.example/ws"
            await ws.send(json.dumps(payload))
            first = json.loads(await asyncio.wait_for(ws.recv(), 2.0))
            assert first.get("type") == "presence", "an unknown hello field changes nothing"
        finally:
            await ws.close()


# ── The shipped example config ─────────────────────────────────────────────


class TestShippedExample:
    def test_relay_example_toml_loads_cleanly(self):
        # The example is documentation that an operator copies. If it does not
        # pass the real loader, the documentation is wrong about the format —
        # and the loader's unknown-key rule means it fails on the FIRST boot,
        # not silently.
        from pathlib import Path

        example = Path(__file__).resolve().parent.parent / "relay.example.toml"
        assert example.is_file(), "the example config must ship with the code"
        overrides = read_toml(example)
        assert overrides["allowed_origins"] == ("https://owlshelf.example",)
        assert overrides["room_egress_burst"] == 20 * 1024 * 1024
        assert overrides["egress_governor_bps"] == 12_500_000
        assert overrides["log_format"] == "json"

    def test_the_example_matches_the_defaults_it_claims(self):
        # Every value in the example except the origin placeholder must BE the
        # default, or the file is a second, drifting source of truth.
        from pathlib import Path

        example = Path(__file__).resolve().parent.parent / "relay.example.toml"
        overrides = read_toml(example)
        # Two values are deployment CHOICES, not defaults, and both have a
        # reason to differ:
        #  - allowed_origins: empty refuses everything, so an example cannot
        #    ship the default without being useless.
        #  - log_file: empty is "stdout only", which is right for a library and
        #    wrong for the compose unit (it mounts this path).
        assert overrides.pop("allowed_origins") == ("https://owlshelf.example",)
        assert overrides.pop("log_file") == "/var/log/owlshelf/relay.log"
        defaults = RelayConfig()
        for field, value in overrides.items():
            assert value == getattr(defaults, field), (
                f"relay.example.toml sets {field}={value!r}, but the default is "
                f"{getattr(defaults, field)!r} — the example claims to be the defaults"
            )


class TestComposeIsTheUnitList:
    def test_compose_declares_both_containers_and_the_tunnel_topology(self):
        from pathlib import Path

        text = (Path(__file__).resolve().parent.parent / "compose.yaml").read_text()
        # cloudflared runs on the HOST in this deployment: the compose unit list
        # must contain exactly the two containerised services.
        assert "cloudflared:" not in text
        assert "relay:" in text and "frontend:" in text
        assert "network_mode: host" in text, (
            "host networking is what makes the peer loopback for host cloudflared"
        )
        assert "RELAY_TOPOLOGY" in text, "the compose default must carry the flag (G2)"
        assert "TRUST_FORWARDED_FOR" not in text or "RELAY_TOPOLOGY" in text

    def test_compose_does_not_publish_the_relay_port(self):
        # The tunnel is the only ingress. A published 8000 would expose an
        # origin-less relay to the internet.
        from pathlib import Path

        text = (Path(__file__).resolve().parent.parent / "compose.yaml").read_text()
        body = text.split("services:", 1)[1]
        # Comments mention `ports:` to explain why it is absent; strip them.
        code = "\n".join(line.split("#", 1)[0] for line in body.splitlines())
        assert "ports:" not in code
