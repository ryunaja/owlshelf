"""test_multiplex.py — many rooms on ONE socket (§9 amendment, §15.4 join/leave).

Why this exists: a per-room socket multiplies connections per DEVICE, and a
public IP is not a device. CGNAT puts many households behind one address, so
`conns_per_ip` could only ever be a guess. Multiplexing makes the count "one
socket per device" — the number the per-IP cap was always trying to express.

The rules pinned here are the ones that make it safe:

- A `join` is room-level: the generation, room-cap and duplicate-connId checks
  are the SAME ones a hello passes, or a second room would be a way around them.
- A refused `join` refuses ONE ROOM. A stale generation on one shelf must not
  disconnect the others — that is the difference between a frame refusal and a
  close code, and it is why `join-refused` exists.
- A frame naming a room this socket never joined is DROPPED, never broadcast:
  the room comes from the frame, resolved against the socket's memberships.
- Presence names its room, because a member list with no shelf attached is
  unusable on a socket that holds several.
"""

from __future__ import annotations

import asyncio
import json

from app.relay.constants import CloseCode
from tests.conftest import HASH_A, envelope, open_socket, recv_json, recv_presence

HASH_B = "b" * 64
HASH_C = "c" * 64


async def join(ws, *, room_id: str, room_hash: str, key_gen: int = 1) -> None:
    await ws.send(
        json.dumps(
            {"v": 1, "type": "join", "roomId": room_id, "keyGen": key_gen, "hash": room_hash}
        )
    )


async def leave(ws, room_hash: str) -> None:
    await ws.send(json.dumps({"v": 1, "type": "leave", "hash": room_hash}))


async def expect_frame(ws, wanted: str, timeout: float = 2.0) -> dict:
    """Read frames until one has `type == wanted`, skipping pings/presence."""

    async def _read() -> dict:
        while True:
            frame = await recv_json(ws, timeout)
            if frame.get("type") == wanted:
                return frame

    return await asyncio.wait_for(_read(), timeout)


async def expect_presence_for(ws, room_hash: str, timeout: float = 2.0) -> dict:
    async def _read() -> dict:
        while True:
            frame = await recv_json(ws, timeout)
            if frame.get("type") == "presence" and frame.get("hash") == room_hash:
                return frame

    return await asyncio.wait_for(_read(), timeout)


async def expect_envelope(ws, timeout: float = 2.0) -> dict:
    """Read until a routed envelope arrives, skipping presence and pings."""

    async def _read() -> dict:
        while True:
            frame = await recv_json(ws, timeout)
            if "kind" in frame:
                return frame

    return await asyncio.wait_for(_read(), timeout)


async def expect_nothing(ws, timeout: float = 0.25) -> None:
    try:
        frame = await asyncio.wait_for(ws.recv(), timeout)
    except (TimeoutError, asyncio.TimeoutError):
        return
    raise AssertionError(f"expected no frame, got {frame!r}")


async def drain(ws, timeout: float = 0.2) -> None:
    """Read and discard until nothing has arrived for `timeout`.

    Presence is per room and re-broadcast on every join, so a socket that shared
    a room with a newcomer has one frame waiting per event. Reading exactly one
    frame per socket is how a routing test ends up asserting on a stale presence.
    """
    while True:
        try:
            await asyncio.wait_for(ws.recv(), timeout)
        except (TimeoutError, asyncio.TimeoutError):
            return


# ── Join ───────────────────────────────────────────────────────────────────


class TestJoin:
    async def test_a_second_room_joins_the_same_socket(self, relay):
        ws, conn_id = await open_socket(relay)
        try:
            assert (await recv_presence(ws))["hash"] == HASH_A
            await join(ws, room_id="room-b", room_hash=HASH_B)
            assert (await expect_frame(ws, "joined"))["hash"] == HASH_B

            # Both memberships are live, and the room records agree.
            assert set(relay.registry.rooms) == {HASH_A, HASH_B}
            for room_hash in (HASH_A, HASH_B):
                assert conn_id in relay.registry.rooms[room_hash].conns
            assert relay.registry.total == 1, "one socket, not two"
        finally:
            await ws.close()

    async def test_joining_twice_is_a_named_refusal_and_not_a_second_member(self, relay):
        ws, conn_id = await open_socket(relay)
        try:
            await recv_presence(ws)
            await join(ws, room_id="room-b", room_hash=HASH_B)
            await expect_frame(ws, "joined")
            await join(ws, room_id="room-b", room_hash=HASH_B)
            frame = await expect_frame(ws, "join-refused")
            assert frame["reason"] == "already-joined"
            assert list(relay.registry.rooms[HASH_B].conns) == [conn_id]
        finally:
            await ws.close()

    async def test_a_stale_generation_refuses_only_that_room(self, relay):
        # The first socket to reach B fixes keyGen=2 for that hash.
        other, _ = await open_socket(relay, room_id="room-b", room_hash=HASH_B, key_gen=2)
        try:
            await recv_presence(other)
            ws, _ = await open_socket(relay)
            try:
                await recv_presence(ws)
                await join(ws, room_id="room-b", room_hash=HASH_B, key_gen=1)
                refused = await expect_frame(ws, "join-refused")
                assert refused["hash"] == HASH_B
                assert refused["reason"] == "generation"
                assert refused["code"] == 4404

                # The socket is still up, and its FIRST room still works.
                assert ws.close_code is None
                assert relay.registry.total == 2
                await ws.send(json.dumps(envelope(room_id="room-a", body="c3RpbGw=")))
                assert relay.registry.rooms[HASH_A].conns, "room A still holds it"
            finally:
                await ws.close()
        finally:
            await other.close()


# ── Routing ────────────────────────────────────────────────────────────────


class TestRouting:
    async def test_frames_route_by_the_room_in_the_frame(self, relay):
        # A and B are separate rooms; `hub` holds BOTH on one socket.
        a, _ = await open_socket(relay, room_id="room-a", room_hash=HASH_A)
        b, _ = await open_socket(relay, room_id="room-b", room_hash=HASH_B)
        hub, _ = await open_socket(relay, room_id="room-a", room_hash=HASH_A)
        try:
            for ws in (a, b, hub):
                await recv_presence(ws)
            await join(hub, room_id="room-b", room_hash=HASH_B)
            await expect_frame(hub, "joined")
            # Every socket drains: A saw the hub's hello, then it sees nothing
            # more; B sees the hub arrive. Reading one frame each leaves a stale
            # presence to be mistaken for a routed envelope.
            for ws in (a, b, hub):
                await drain(ws)

            await hub.send(json.dumps(envelope(room_id="room-b", body="Zm9yLWI=")))
            assert (await expect_envelope(b))["body"] == "Zm9yLWI="
            # A must NOT see B's frame: `a` is in A only.
            await expect_nothing(a, timeout=0.3)

            await hub.send(json.dumps(envelope(room_id="room-a", body="Zm9yLWE=")))
            assert (await expect_envelope(a))["body"] == "Zm9yLWE="
            await expect_nothing(b, timeout=0.3)
        finally:
            for ws in (a, b, hub):
                await ws.close()

    async def test_a_frame_for_a_room_the_socket_never_joined_is_dropped(self, relay):
        victim, _ = await open_socket(relay, room_id="room-c", room_hash=HASH_C)
        ws, _ = await open_socket(relay)
        try:
            await recv_presence(victim)
            await recv_presence(ws)
            # No `join` for C: `hash` alone must not widen the routing table.
            await ws.send(json.dumps(envelope(room_id="room-c", body="c21lYWs=")))
            await expect_nothing(victim, timeout=0.3)
        finally:
            await victim.close()
            await ws.close()

    async def test_a_wrong_generation_on_a_joined_room_is_dropped(self, relay):
        b, _ = await open_socket(relay, room_id="room-b", room_hash=HASH_B)
        ws, _ = await open_socket(relay)
        try:
            await recv_presence(b)
            await recv_presence(ws)
            await join(ws, room_id="room-b", room_hash=HASH_B)
            await expect_frame(ws, "joined")
            await expect_presence_for(b, HASH_B)
            await ws.send(json.dumps(envelope(room_id="room-b", key_gen=2, body="c3RhbGU=")))
            await expect_nothing(b, timeout=0.3)
        finally:
            await b.close()
            await ws.close()


# ── Leave, presence, teardown ──────────────────────────────────────────────


class TestLifecycle:
    async def test_leave_stops_delivery_and_keeps_the_socket(self, relay):
        b, _ = await open_socket(relay, room_id="room-b", room_hash=HASH_B)
        a, a_id = await open_socket(relay)
        try:
            await recv_presence(b)
            await recv_presence(a)
            await join(a, room_id="room-b", room_hash=HASH_B)
            await expect_frame(a, "joined")
            await expect_presence_for(b, HASH_B)

            await leave(a, HASH_B)
            # B sees the departure, and only B remains in the room.
            departed = await expect_presence_for(b, HASH_B)
            assert a_id not in departed["members"]
            assert a_id not in relay.registry.rooms[HASH_B].conns

            await a.send(json.dumps(envelope(room_id="room-b", body="Z29uZQ==")))
            await expect_nothing(b, timeout=0.3)
            # ... and A's first room is untouched.
            assert a.close_code is None
            assert a_id in relay.registry.rooms[HASH_A].conns
        finally:
            await b.close()
            await a.close()

    async def test_presence_names_its_room_on_a_multiplexed_socket(self, relay):
        ws, conn_id = await open_socket(relay)
        try:
            first = await recv_presence(ws)
            assert first["hash"] == HASH_A
            await join(ws, room_id="room-b", room_hash=HASH_B)
            presence_b = await expect_presence_for(ws, HASH_B)
            assert presence_b["members"] == [conn_id]
        finally:
            await ws.close()

    async def test_disconnect_removes_every_membership(self, relay):
        a, a_id = await open_socket(relay)
        b, _ = await open_socket(relay, room_id="room-b", room_hash=HASH_B)
        try:
            await recv_presence(a)
            await recv_presence(b)
            await join(a, room_id="room-b", room_hash=HASH_B)
            await expect_frame(a, "joined")
            await expect_presence_for(b, HASH_B)

            await a.close()
            # B's room loses it, and the emptied room is scheduled for reaping
            # rather than left populated by a ghost.
            for _ in range(20):
                if a_id not in relay.registry.rooms[HASH_B].conns:
                    break
                await asyncio.sleep(0.05)
            assert a_id not in relay.registry.rooms[HASH_B].conns
            assert relay.registry.total == 1
        finally:
            await b.close()


# ── Refusal codes (§7.13) ───────────────────────────────────────────────────


class TestRefusalCodes:
    """A join passes the hello's three checks, so it must report the hello's codes.

    The client branches on `join-refused.code`: 4404 stops the room and asks the
    user to re-pair, while 4403/1013 back off. Hardcoding 4404 told a user whose
    room was merely FULL to re-pair with the owner.
    """

    async def test_a_full_room_refuses_with_4403_not_4404(self, relay_factory):
        relay = relay_factory(room_cap=2)
        a, _ = await open_socket(relay, room_hash=HASH_A)
        b, _ = await open_socket(relay, room_id="room-b", room_hash=HASH_B)
        b2, _ = await open_socket(relay, room_id="room-b", room_hash=HASH_B)
        c, c_id = await open_socket(relay, room_hash=HASH_A)
        try:
            for ws in (a, b, b2, c):
                await recv_presence(ws)

            # B is at its cap of two; C is admitted to A and joins B.
            await join(c, room_id="room-b", room_hash=HASH_B)
            refused = await expect_frame(c, "join-refused")
            assert refused["reason"] == "room-cap"
            assert refused["code"] == CloseCode.ROOM_CAP

            # The refusal is room-scoped: A still works on the same socket.
            assert c.close_code is None
            assert relay.registry.total == 4
            assert c_id in relay.registry.rooms[HASH_A].conns
            assert c_id not in relay.registry.rooms[HASH_B].conns
        finally:
            for ws in (a, b, b2, c):
                await ws.close()

    async def test_a_duplicate_join_refuses_with_a_backoff_code(self, relay):
        ws, _ = await open_socket(relay)
        try:
            await recv_presence(ws)
            await join(ws, room_id="room-b", room_hash=HASH_B)
            await expect_frame(ws, "joined")
            await join(ws, room_id="room-b", room_hash=HASH_B)
            refused = await expect_frame(ws, "join-refused")
            assert refused["reason"] == "already-joined"
            assert refused["code"] == CloseCode.TRY_LATER
        finally:
            await ws.close()
