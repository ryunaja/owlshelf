"""test_smoke.py — the harness itself works before any contract is asserted.

If this fails, every other test in the suite is failing for the same reason and
the real failures are invisible.
"""

from __future__ import annotations

import json

from tests.conftest import HASH_A, open_socket, recv_presence


async def test_a_hello_is_admitted_and_presence_arrives(relay):
    ws, conn_id = await open_socket(relay)
    try:
        presence = await recv_presence(ws)
        assert presence["members"] == [conn_id]
        assert relay.registry.total == 1
        assert relay.registry.rooms[HASH_A].key_gen == 1
    finally:
        await ws.close()


async def test_two_sockets_in_one_room_see_each_other(relay):
    a, a_id = await open_socket(relay)
    b, b_id = await open_socket(relay)
    try:
        # `a` sees itself, then the room after `b` joins.
        first = await recv_presence(a)
        assert first["members"] == [a_id]
        second = await recv_presence(a)
        assert second["members"] == sorted([a_id, b_id])
        assert relay.registry.total == 2
    finally:
        await a.close()
        await b.close()


async def test_healthz_reports_counts(relay):
    import httpx

    ws, _ = await open_socket(relay)
    try:
        await recv_presence(ws)
        url = relay.url.replace("ws://", "http://").replace("/ws", "/healthz")
        async with httpx.AsyncClient() as client:
            response = await client.get(url)
        assert response.status_code == 200
        assert response.json() == {"ok": True, "rooms": 1, "conns": 1}
    finally:
        await ws.close()


async def test_health_is_an_alias_of_healthz(relay):
    """`/health` and `/healthz` are ONE probe served at two paths.

    `/health` used to 404, and a monitor pointed at it reports an outage while
    the relay is fine — a false alarm that costs more than the extra route. The
    alias is only safe while both paths answer the same body: the moment one
    carries a different count, an operator reading a dashboard and an operator
    holding a `curl` are looking at two different relays.
    """
    import httpx

    ws, _ = await open_socket(relay)
    try:
        await recv_presence(ws)
        base = relay.url.removesuffix("/ws").replace("ws://", "http://")
        async with httpx.AsyncClient() as client:
            long_form = await client.get(base + "/healthz")
            short_form = await client.get(base + "/health")
            typo = await client.get(base + "/health-check")
        assert long_form.status_code == 200
        assert short_form.status_code == 200
        assert short_form.json() == long_form.json() == {"ok": True, "rooms": 1, "conns": 1}
        # One alias, not a catch-all: a typo is still a 404 on purpose.
        assert typo.status_code == 404
    finally:
        await ws.close()


async def test_a_frame_round_trips_through_the_relay(relay):
    a, a_id = await open_socket(relay)
    b, b_id = await open_socket(relay)
    try:
        await recv_presence(a)
        await recv_presence(a)
        await recv_presence(b)

        await a.send(
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
        frame = json.loads(await b.recv())
        assert frame["kind"] == "op"
        assert frame["body"] == "c2VhbGVk"
        assert frame["from"] == a_id
    finally:
        await a.close()
        await b.close()
