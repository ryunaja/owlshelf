"""test_reaping.py — empty rooms, and what a reaped room forgets (§9).

Reaping is the only thing that erases a room's generation binding. That makes
it security-relevant: a reaped room must NOT remember the old keyGen, or a
rotated room could never be re-created at the same hash.
"""

from __future__ import annotations

import asyncio
import json
import time

from tests.conftest import HASH_A, open_socket, recv_presence


async def wait_for(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not met within timeout")


class TestScheduling:
    async def test_the_last_leave_schedules_a_reap(self, relay):
        ws, _ = await open_socket(relay)
        await recv_presence(ws)
        assert relay.registry.rooms[HASH_A].reap_at is None

        await ws.close()
        await wait_for(lambda: relay.registry.rooms[HASH_A].reap_at is not None)

    async def test_a_room_with_a_member_is_never_scheduled(self, relay):
        a, _ = await open_socket(relay)
        b, _ = await open_socket(relay)
        try:
            await recv_presence(a)
            await recv_presence(a)
            await recv_presence(b)
            await b.close()
            await wait_for(lambda: len(relay.registry.rooms[HASH_A].conns) == 1)

            # `a` is still here, so the room must NOT be scheduled — and a
            # sweep with a far-future clock must still leave it alone.
            assert relay.registry.rooms[HASH_A].reap_at is None
            relay.registry.reap(now=time.monotonic() + 10**9)
            assert HASH_A in relay.registry.rooms
        finally:
            await a.close()


class TestSweep:
    async def test_reap_removes_an_empty_room(self, relay):
        ws, _ = await open_socket(relay)
        await recv_presence(ws)
        await ws.close()
        await wait_for(lambda: relay.registry.rooms[HASH_A].reap_at is not None)

        assert relay.registry.reap(now=time.monotonic() + 10**9) == [HASH_A]
        assert relay.registry.rooms == {}

    async def test_reap_also_drops_the_rooms_egress_bucket(self, relay):
        # A room owns an egress bucket from the moment it is admitted. Leaving
        # the bucket behind made every reaped room a permanent KB of memory —
        # unbounded growth, since any well-formed hash mints a room.
        ws, _ = await open_socket(relay)
        await recv_presence(ws)
        await ws.close()
        await wait_for(lambda: relay.registry.rooms[HASH_A].reap_at is not None)
        assert HASH_A in relay.registry.room_egress

        relay.registry.reap(now=time.monotonic() + 10**9)

        assert relay.registry.rooms == {}
        assert HASH_A not in relay.registry.room_egress

    async def test_reap_leaves_a_room_whose_deadline_has_not_passed(self, relay):
        ws, _ = await open_socket(relay)
        await recv_presence(ws)
        await ws.close()
        await wait_for(lambda: relay.registry.rooms[HASH_A].reap_at is not None)

        assert relay.registry.reap(now=time.monotonic()) == []
        assert HASH_A in relay.registry.rooms

    async def test_the_sweep_task_reaps_on_its_own(self, relay_factory):
        relay = relay_factory(room_reap_after=0.05, reap_sweep_interval=0.05)
        ws, _ = await open_socket(relay)
        await recv_presence(ws)
        await ws.close()
        await wait_for(lambda: relay.registry.rooms == {}, timeout=3.0)


class TestGenerationAfterReap:
    async def test_a_reaped_room_forgets_its_generation(self, relay):
        # A rotation mints a new key -> a new hash -> a new room. But a room
        # that was simply reaped must not pin the OLD generation forever, or a
        # device that re-pairs to the same hash could never connect again.
        first, _ = await open_socket(relay, key_gen=1)
        await recv_presence(first)
        await first.close()
        await wait_for(lambda: relay.registry.rooms[HASH_A].reap_at is not None)
        relay.registry.reap(now=time.monotonic() + 10**9)

        second, _ = await open_socket(relay, key_gen=2)
        try:
            await recv_presence(second)
            assert relay.registry.rooms[HASH_A].key_gen == 2
        finally:
            await second.close()

    async def test_an_unreaped_room_still_refuses_the_old_generation(self, relay):
        # The mirror image: while the room record survives, the binding holds.
        first, _ = await open_socket(relay, key_gen=1)
        await recv_presence(first)
        await first.close()
        await wait_for(lambda: relay.registry.rooms[HASH_A].reap_at is not None)

        import websockets

        from tests.conftest import ORIGIN, expect_close, hello_frame

        stale = await websockets.connect(relay.url, origin=ORIGIN)
        await stale.send(json.dumps(hello_frame(key_gen=2)))
        assert await expect_close(stale) == 4404
