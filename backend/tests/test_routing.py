"""test_routing.py — who receives what, and who must not (§9 "Message loop").

The three routing rules each killed a real defect in an earlier pass, so each
gets a positive AND a negative test. A routing test that only asserts "the
right peer got it" cannot see a broadcast leak.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from tests.conftest import envelope, open_socket, recv_json, recv_presence

CONN = "11111111-2222-3333-4444-555555555555"


async def expect_nothing(ws, timeout: float = 0.25) -> None:
    """Assert no frame arrives. `recv` is cancellation-safe in websockets 16."""
    try:
        frame = await asyncio.wait_for(ws.recv(), timeout)
    except (TimeoutError, asyncio.TimeoutError):
        return
    raise AssertionError(f"expected no frame, got {frame!r}")


async def three_in_a_room(relay):
    """A, B, C in one room, all presence frames drained."""
    a, a_id = await open_socket(relay)
    b, b_id = await open_socket(relay)
    c, c_id = await open_socket(relay)
    for ws in (a, b, c):
        await recv_presence(ws)
    # Drain the remaining presence frames from the later joins.
    for ws in (a, b):
        await recv_presence(ws)
    await recv_presence(a)
    return (a, a_id), (b, b_id), (c, c_id)


# ── Broadcast ──────────────────────────────────────────────────────────────


class TestBroadcast:
    async def test_a_frame_without_to_reaches_every_other_member(self, relay):
        (a, _), (b, _), (c, _) = await three_in_a_room(relay)
        try:
            await a.send(json.dumps(envelope(body="ZmFuLW91dA==")))
            for ws in (b, c):
                assert (await recv_json(ws))["body"] == "ZmFuLW91dA=="
        finally:
            for ws in (a, b, c):
                await ws.close()

    async def test_the_sender_never_receives_its_own_broadcast(self, relay):
        (a, _), (b, _), (c, _) = await three_in_a_room(relay)
        try:
            await a.send(json.dumps(envelope()))
            await recv_json(b)
            await recv_json(c)
            await expect_nothing(a)
        finally:
            for ws in (a, b, c):
                await ws.close()


# ── Targeted delivery ──────────────────────────────────────────────────────


class TestTargeted:
    async def test_a_to_naming_a_member_reaches_only_that_member(self, relay):
        (a, _), (b, b_id), (c, _) = await three_in_a_room(relay)
        try:
            await a.send(json.dumps(envelope(to=b_id, body="dGFyZ2V0ZWQ=")))
            assert (await recv_json(b))["body"] == "dGFyZ2V0ZWQ="
            await expect_nothing(c)
        finally:
            for ws in (a, b, c):
                await ws.close()

    async def test_a_to_miss_is_a_drop_never_a_broadcast(self, relay):
        # P0-5/P0-8: the broadcast fallback turned every targeted catch-up
        # reply into a room-wide leak of the whole history.
        (a, _), (b, _), (c, _) = await three_in_a_room(relay)
        try:
            await a.send(json.dumps(envelope(to=CONN)))
            await expect_nothing(b)
            await expect_nothing(c)
        finally:
            for ws in (a, b, c):
                await ws.close()

    async def test_a_to_naming_the_sender_is_delivered_to_the_sender(self, relay):
        # Not a special case: `to` is resolved against the room, and the sender
        # is in the room. Excluding it would make a self-addressed reply vanish.
        (a, a_id), (b, _), (c, _) = await three_in_a_room(relay)
        try:
            await a.send(json.dumps(envelope(to=a_id, body="c2VsZg==")))
            assert (await recv_json(a))["body"] == "c2VsZg=="
            await expect_nothing(b)
        finally:
            for ws in (a, b, c):
                await ws.close()


# ── `from` stamping ────────────────────────────────────────────────────────


class TestFromStamping:
    async def test_the_relay_stamps_from_with_the_senders_conn_id(self, relay):
        (a, a_id), (b, _), (c, _) = await three_in_a_room(relay)
        try:
            await a.send(json.dumps(envelope()))
            assert (await recv_json(b))["from"] == a_id
        finally:
            for ws in (a, b, c):
                await ws.close()

    async def test_a_client_supplied_from_is_overwritten(self, relay):
        # Without this, a peer could impersonate another device's connectionId
        # and receive its targeted catch-up replies.
        (a, a_id), (b, _), (c, _) = await three_in_a_room(relay)
        try:
            await a.send(json.dumps(envelope(**{"from": CONN})))
            assert (await recv_json(b))["from"] == a_id
        finally:
            for ws in (a, b, c):
                await ws.close()


# ── Shape rejection ────────────────────────────────────────────────────────


class TestShapeRejection:
    @pytest.mark.parametrize(
        "frame",
        [
            envelope(room_id="room-b"),  # cross-room
            envelope(key_gen=2),  # stale generation
            envelope(kind="nope"),  # outside the closed union
            envelope(kind="presence"),  # the relay's own frame kind
            envelope(body=""),  # no sealed body
            envelope(v=2),  # unknown version
            envelope(to=123),  # non-string target
        ],
    )
    async def test_a_malformed_envelope_is_dropped(self, relay, frame):
        (a, _), (b, _), (c, _) = await three_in_a_room(relay)
        try:
            await a.send(json.dumps(frame))
            await expect_nothing(b)
            await expect_nothing(c)
        finally:
            for ws in (a, b, c):
                await ws.close()

    async def test_a_non_json_frame_is_dropped(self, relay):
        (a, _), (b, _), (c, _) = await three_in_a_room(relay)
        try:
            await a.send("not json")
            await expect_nothing(b)
        finally:
            for ws in (a, b, c):
                await ws.close()

    async def test_a_json_array_is_dropped(self, relay):
        (a, _), (b, _), (c, _) = await three_in_a_room(relay)
        try:
            await a.send(json.dumps([envelope()]))
            await expect_nothing(b)
        finally:
            for ws in (a, b, c):
                await ws.close()


# ── Heartbeat frames ───────────────────────────────────────────────────────


class TestHeartbeatFrames:
    @pytest.mark.parametrize("kind", ["pong", "ping"])
    async def test_a_heartbeat_frame_is_consumed_never_routed(self, relay, kind):
        (a, _), (b, _), (c, _) = await three_in_a_room(relay)
        try:
            await a.send(json.dumps({"type": kind}))
            await expect_nothing(b)
            await expect_nothing(c)
        finally:
            for ws in (a, b, c):
                await ws.close()

    async def test_a_heartbeat_frame_still_proves_liveness(self, relay_factory):
        # A client that only pongs is alive. If a pong did not reset the
        # counter, a quiet-but-healthy device would be dropped at ~60s.
        relay = relay_factory(heartbeat_interval=0.05, heartbeat_misses=2)
        ws, _ = await open_socket(relay)
        try:
            await recv_presence(ws)
            for _ in range(6):
                await asyncio.sleep(0.03)
                await ws.send(json.dumps({"type": "pong"}))
            assert not ws.close_code
        finally:
            await ws.close()
