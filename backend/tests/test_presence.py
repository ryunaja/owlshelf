"""test_presence.py — the one frame the relay originates (§9, §6.6).

Presence is how a requester learns its peers' addresses, so a missing or stale
presence frame silently disables targeted catch-up: the client would have
nobody to send a catch-up-request to.
"""

from __future__ import annotations

import asyncio

from tests.conftest import HASH_A, open_socket, recv_presence


class TestJoin:
    async def test_a_newcomer_learns_the_whole_room(self, relay):
        a, a_id = await open_socket(relay)
        try:
            assert (await recv_presence(a))["members"] == [a_id]

            b, b_id = await open_socket(relay)
            try:
                # The newcomer must see BOTH ids, or it cannot address `a`.
                assert (await recv_presence(b))["members"] == sorted([a_id, b_id])
            finally:
                await b.close()
        finally:
            await a.close()

    async def test_existing_members_are_told_about_the_newcomer(self, relay):
        a, a_id = await open_socket(relay)
        try:
            await recv_presence(a)
            b, b_id = await open_socket(relay)
            try:
                assert (await recv_presence(a))["members"] == sorted([a_id, b_id])
            finally:
                await b.close()
        finally:
            await a.close()


class TestLeave:
    async def test_a_departure_is_broadcast(self, relay):
        a, a_id = await open_socket(relay)
        b, b_id = await open_socket(relay)
        try:
            await recv_presence(a)
            await recv_presence(a)
            await recv_presence(b)

            await b.close()
            assert (await recv_presence(a))["members"] == [a_id]
        finally:
            await a.close()

    async def test_the_last_departure_leaves_an_empty_room(self, relay):
        a, _ = await open_socket(relay)
        await recv_presence(a)
        await a.close()

        # Give the server a moment to run its cleanup path.
        for _ in range(50):
            if relay.registry.total == 0:
                break
            await asyncio.sleep(0.01)
        assert relay.registry.total == 0


class TestShape:
    async def test_presence_carries_no_key_gen_and_no_body(self, relay):
        # §6.6: presence is the ONE non-Envelope message. If it grew a keyGen
        # or a body, clients would start treating it as an Envelope — and the
        # relay cannot seal anything, so that body would be plaintext.
        #
        # `hash` is the one field it DOES carry: with one socket holding several
        # rooms, a member list with no room to attribute it to is unusable.
        ws, _ = await open_socket(relay)
        try:
            frame = await recv_presence(ws)
            assert set(frame) == {"type", "hash", "members"}
            assert frame["hash"] == HASH_A
        finally:
            await ws.close()

    async def test_members_are_sorted(self, relay):
        sockets = []
        try:
            for _ in range(3):
                ws, _ = await open_socket(relay)
                sockets.append(ws)
            frame = await recv_presence(sockets[0])
            assert frame["members"] == sorted(frame["members"])
        finally:
            for ws in sockets:
                await ws.close()
