"""test_keepalive.py — heartbeat, half-open detection, idle (§9).

The heartbeat is what keeps Cloudflare's ~100s WS idle timeout from reaping a
live-but-quiet socket (§11.2), and what catches a backgrounded phone whose TCP
connection is gone but whose socket still looks open. Both failures are silent
without it.
"""

from __future__ import annotations

import asyncio
import json

from tests.conftest import expect_close, open_socket, recv_json, recv_presence


class TestPing:
    async def test_the_relay_pings_on_the_cadence(self, relay_factory):
        relay = relay_factory(heartbeat_interval=0.05)
        ws, _ = await open_socket(relay)
        try:
            await recv_presence(ws)
            frame = await recv_json(ws, timeout=1.0)
            assert frame == {"type": "ping"}
        finally:
            await ws.close()

    async def test_the_ping_is_an_app_level_frame(self, relay_factory):
        # §15.4: app-level, because the consistency audit piggybacks on the
        # cadence. A protocol-level WS ping carries no payload, so the audit
        # would have no ride.
        relay = relay_factory(heartbeat_interval=0.05)
        ws, _ = await open_socket(relay)
        try:
            await recv_presence(ws)
            frame = await recv_json(ws, timeout=1.0)
            assert frame["type"] == "ping"
            assert set(frame) == {"type"}
        finally:
            await ws.close()


class TestMissedPongs:
    async def test_two_missed_pongs_drop_the_socket(self, relay_factory):
        relay = relay_factory(heartbeat_interval=0.05, heartbeat_misses=2)
        ws, _ = await open_socket(relay)
        await recv_presence(ws)
        # ~2 intervals of total silence. 1008 is the hygiene code: this is the
        # client's fault, not a capacity refusal, so it is not 1013.
        assert await expect_close(ws, timeout=2.0) == 1008

    async def test_a_pong_resets_the_counter(self, relay_factory):
        relay = relay_factory(heartbeat_interval=0.05, heartbeat_misses=2)
        ws, _ = await open_socket(relay)
        try:
            await recv_presence(ws)
            for _ in range(8):
                await asyncio.sleep(0.03)
                await ws.send(json.dumps({"type": "pong"}))
            assert ws.close_code is None
        finally:
            await ws.close()

    async def test_a_data_frame_also_resets_the_counter(self, relay_factory):
        # §9: "Any inbound frame proves liveness." A busy client that never
        # pongs must not be dropped mid-sync.
        relay = relay_factory(heartbeat_interval=0.05, heartbeat_misses=2)
        ws, _ = await open_socket(relay)
        try:
            await recv_presence(ws)
            for _ in range(8):
                await asyncio.sleep(0.03)
                await ws.send(
                    json.dumps(
                        {
                            "v": 1,
                            "roomId": "room-a",
                            "keyGen": 1,
                            "kind": "op",
                            "body": "c2VhbGVk",
                        }
                    )
                )
            assert ws.close_code is None
        finally:
            await ws.close()


class TestIdle:
    async def test_a_silent_socket_is_idle_disconnected(self, relay_factory):
        # The idle check is a backstop: `last_seen` advances on any inbound
        # frame, so a client that keeps ponging is never idle-disconnected.
        # Here the heartbeat is effectively disabled so idle is what fires.
        relay = relay_factory(
            heartbeat_interval=0.05,
            heartbeat_misses=1000,
            idle_timeout=0.1,
        )
        ws, _ = await open_socket(relay)
        await recv_presence(ws)
        assert await expect_close(ws, timeout=2.0) == 1008

    async def test_ping_pong_alone_keeps_a_live_sync_alive(self, relay_factory):
        relay = relay_factory(
            heartbeat_interval=0.05,
            heartbeat_misses=1000,
            idle_timeout=0.1,
        )
        ws, _ = await open_socket(relay)
        try:
            await recv_presence(ws)
            for _ in range(8):
                await asyncio.sleep(0.03)
                await ws.send(json.dumps({"type": "pong"}))
            assert ws.close_code is None
        finally:
            await ws.close()
