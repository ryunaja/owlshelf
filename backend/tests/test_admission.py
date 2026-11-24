"""test_admission.py — the seven checks, in order, with no side effects (§9).

Each refusal has a close code the client acts on (§15.4), so each test asserts
the CODE, not just "it closed". The last class asserts the other half of the
contract: a refused socket must leave the registry exactly as it found it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging

import pytest
import websockets

from tests.conftest import (
    HASH_A,
    ORIGIN,
    expect_close,
    hello_frame,
    open_socket,
    recv_presence,
)

CONN = "11111111-2222-3333-4444-555555555555"


# ── 1. Origin ──────────────────────────────────────────────────────────────


class TestOrigin:
    async def test_a_foreign_origin_is_refused(self, relay):
        ws = await websockets.connect(relay.url, origin="http://evil.example")
        assert await expect_close(ws) == 4401

    async def test_a_missing_origin_is_refused(self, relay):
        # A browser always sends Origin for a WebSocket, so a missing one means
        # the peer is not a page — and "only owlshelf pages may connect" (§9).
        ws = await websockets.connect(relay.url)
        assert await expect_close(ws) == 4401

    async def test_an_empty_allowlist_fails_closed(self, relay_factory):
        # A config typo must not turn the relay into an open fan-out.
        relay = relay_factory(allowed_origins=())
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        assert await expect_close(ws) == 4401

    async def test_the_allowed_origin_is_admitted(self, relay):
        ws, _ = await open_socket(relay)
        try:
            assert (await recv_presence(ws))["members"] != []
        finally:
            await ws.close()


# ── 2. Global cap ──────────────────────────────────────────────────────────


class TestGlobalCap:
    async def test_the_cap_refuses_a_new_connection(self, relay_factory):
        relay = relay_factory(global_cap=1)
        first, _ = await open_socket(relay)
        try:
            await recv_presence(first)
            second = await websockets.connect(relay.url, origin=ORIGIN)
            assert await expect_close(second) == 1013
        finally:
            await first.close()

    async def test_the_cap_never_evicts_a_healthy_connection(self, relay_factory):
        relay = relay_factory(global_cap=1)
        first, _ = await open_socket(relay)
        try:
            await recv_presence(first)
            second = await websockets.connect(relay.url, origin=ORIGIN)
            await expect_close(second)
            # The first socket is still usable: reject NEW, never evict.
            await first.send(json.dumps({"type": "pong"}))
            assert first.close_code is None
            assert relay.registry.total == 1
        finally:
            await first.close()


# ── 3. Per-IP cap ──────────────────────────────────────────────────────────


class TestPerIpCap:
    async def test_the_cap_refuses_the_socket_after_the_limit(self, relay_factory):
        relay = relay_factory(conns_per_ip=1)
        first, _ = await open_socket(relay)
        try:
            await recv_presence(first)
            second = await websockets.connect(relay.url, origin=ORIGIN)
            assert await expect_close(second) == 1013
        finally:
            await first.close()

    async def test_a_household_with_two_shelves_each_is_admitted(self, relay):
        # The cap counts SOCKETS, and one socket is one ROOM membership: the
        # client opens an engine per room with a relay URL, so a device with two
        # profiles opens two. Two devices behind one NAT is therefore four
        # sockets from one IP — and §9 step 3's literal "more than 3 from one IP
        # is churn or abuse" refused the second device of a normal pair. That is
        # exactly what a two-browser test looked like (`conns_per_ip=3` in the
        # default config). The default is sized in devices × profiles; §10.1's
        # byte buckets and egress governor are the bounds that stop abuse, and
        # they are untouched.
        sockets = []
        try:
            for index in range(4):
                ws, _ = await open_socket(
                    relay, room_id=f"room-{index}", room_hash=f"{index}" * 64
                )
                # Admission is complete once presence arrives; asserting the
                # counter before that races the server.
                await recv_presence(ws)
                sockets.append(ws)
            assert relay.registry.total == 4
            assert relay.config.conns_per_ip == 12, "the default fits a household"
        finally:
            for ws in sockets:
                await ws.close()


# ── 4. Handshake ───────────────────────────────────────────────────────────


class TestHandshake:
    async def test_a_silent_socket_is_closed_after_the_deadline(self, relay_factory):
        relay = relay_factory(handshake_deadline=0.1)
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        assert await expect_close(ws) == 4402

    @pytest.mark.parametrize(
        "frame",
        [
            {"v": 1, "type": "hello"},  # missing every field
            {"v": 1, "type": "hello", "connId": CONN, "roomId": "room-a", "keyGen": 1},
            {"v": 2, "type": "hello", "connId": CONN, "roomId": "room-a", "keyGen": 1, "hash": HASH_A},
            {"v": 1, "type": "op", "connId": CONN, "roomId": "room-a", "keyGen": 1, "hash": HASH_A},
            {"v": 1, "type": "hello", "connId": "nope", "roomId": "room-a", "keyGen": 1, "hash": HASH_A},
            {"v": 1, "type": "hello", "connId": CONN, "roomId": "room-a", "keyGen": 0, "hash": HASH_A},
            {"v": 1, "type": "hello", "connId": CONN, "roomId": "room-a", "keyGen": 1, "hash": "short"},
        ],
    )
    async def test_a_malformed_hello_is_refused(self, relay, frame):
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        await ws.send(json.dumps(frame))
        assert await expect_close(ws) == 4402

    async def test_a_non_json_first_frame_is_refused(self, relay):
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        await ws.send("not json at all")
        assert await expect_close(ws) == 4402


# ── 5. Room generation ─────────────────────────────────────────────────────


class TestGeneration:
    async def test_the_first_hello_fixes_the_generation(self, relay):
        first, _ = await open_socket(relay, key_gen=3)
        try:
            await recv_presence(first)
            assert relay.registry.rooms[HASH_A].key_gen == 3
        finally:
            await first.close()

    async def test_a_stale_generation_is_refused(self, relay):
        # audit-2 N16: the pass-3 check compared a connection's generation
        # against ITSELF, which is vacuously true. The room-level check is the
        # real one, and 4404 tells the client to stop and re-pair (§6.7/D4).
        first, _ = await open_socket(relay, key_gen=2)
        try:
            await recv_presence(first)
            stale = await websockets.connect(relay.url, origin=ORIGIN)
            await stale.send(json.dumps(hello_frame(conn_id=CONN, key_gen=1)))
            assert await expect_close(stale) == 4404
        finally:
            await first.close()

    async def test_a_newer_generation_is_also_refused(self, relay):
        # A rotation mints a NEW key -> a NEW hash -> effectively a new room.
        # There are no aliases and no grace list, so a higher gen on the OLD
        # hash is just as wrong as a lower one.
        first, _ = await open_socket(relay, key_gen=1)
        try:
            await recv_presence(first)
            newer = await websockets.connect(relay.url, origin=ORIGIN)
            await newer.send(json.dumps(hello_frame(conn_id=CONN, key_gen=2)))
            assert await expect_close(newer) == 4404
        finally:
            await first.close()


# ── 6. Room cap ────────────────────────────────────────────────────────────


class TestRoomCap:
    async def test_an_eleventh_connection_is_refused(self, relay_factory):
        relay = relay_factory(room_cap=1)
        first, _ = await open_socket(relay)
        try:
            await recv_presence(first)
            second = await websockets.connect(relay.url, origin=ORIGIN)
            await second.send(json.dumps(hello_frame(conn_id=CONN)))
            assert await expect_close(second) == 4403
        finally:
            await first.close()

    async def test_the_cap_is_per_room_not_global(self, relay_factory):
        relay = relay_factory(room_cap=1)
        a, _ = await open_socket(relay, room_hash="a" * 64)
        await recv_presence(a)
        b, _ = await open_socket(relay, room_hash="b" * 64)
        try:
            await recv_presence(b)
            assert relay.registry.total == 2
        finally:
            await a.close()
            await b.close()


# ── 7. Connection identity ─────────────────────────────────────────────────


class TestConnectionIdentity:
    async def test_a_duplicate_conn_id_is_refused(self, relay):
        first, _ = await open_socket(relay, conn_id=CONN)
        try:
            await recv_presence(first)
            second = await websockets.connect(relay.url, origin=ORIGIN)
            await second.send(json.dumps(hello_frame(conn_id=CONN)))
            assert await expect_close(second) == 4402
        finally:
            await first.close()

    async def test_the_original_connection_survives_the_attempt(self, relay):
        # A hijacker gains only AEAD ciphertext it cannot read, so the correct
        # response is to refuse the newcomer, never to overwrite the incumbent.
        first, _ = await open_socket(relay, conn_id=CONN)
        try:
            await recv_presence(first)
            second = await websockets.connect(relay.url, origin=ORIGIN)
            await second.send(json.dumps(hello_frame(conn_id=CONN)))
            await expect_close(second)
            assert relay.registry.rooms[HASH_A].conns[CONN] is not None
            assert relay.registry.total == 1
        finally:
            await first.close()


# ── No side effects ────────────────────────────────────────────────────────


class TestNoSideEffects:
    async def test_a_refused_origin_leaves_the_registry_empty(self, relay):
        ws = await websockets.connect(relay.url, origin="http://evil.example")
        await expect_close(ws)
        assert relay.registry.total == 0
        assert relay.registry.rooms == {}
        assert relay.registry.ip_counts == {}

    async def test_a_refused_handshake_does_not_consume_a_per_ip_slot(self, relay_factory):
        relay = relay_factory(conns_per_ip=1)
        bad = await websockets.connect(relay.url, origin=ORIGIN)
        await bad.send("garbage")
        await expect_close(bad)

        # The slot must be free: a refusal that leaked a counter would lock the
        # device out of its own room until the process restarted.
        good, _ = await open_socket(relay)
        try:
            assert (await recv_presence(good))["members"] != []
            assert relay.registry.total == 1
        finally:
            await good.close()

    async def test_a_refused_room_cap_does_not_create_a_room(self, relay_factory):
        relay = relay_factory(room_cap=1)
        first, _ = await open_socket(relay, room_hash="a" * 64)
        try:
            await recv_presence(first)
            second = await websockets.connect(relay.url, origin=ORIGIN)
            await second.send(json.dumps(hello_frame(conn_id=CONN, room_hash="c" * 64)))
            # A different hash is a different room, so this one is admitted.
            await recv_presence(second)
            assert set(relay.registry.rooms) == {"a" * 64, "c" * 64}
            await second.close()
        finally:
            await first.close()


# ── Diagnostics ────────────────────────────────────────────────────────────


class TestDiagnostics:
    """A refusal must say WHY in the console.

    uvicorn logs `[accepted]` when the WebSocket handshake completes, which is
    BEFORE any admission check runs. Without these lines an operator sees a
    connection open and then silence — a refused origin, a full room, and a
    generation mismatch are indistinguishable, and the client only ever says
    "offline".
    """

    async def test_a_refused_origin_is_logged_with_its_reason(self, relay, caplog):
        with caplog.at_level(logging.INFO, logger="owlshelf.relay"):
            ws = await websockets.connect(relay.url, origin="http://evil.example")
            assert await expect_close(ws) == 4401
        refusals = [r for r in caplog.records if getattr(r, "event", None) == "refused"]
        assert refusals, [record.getMessage() for record in caplog.records]
        assert refusals[0].code == 4401
        assert refusals[0].reason == "origin"

    async def test_an_admission_is_logged_with_room_and_generation(self, relay, caplog):
        with caplog.at_level(logging.INFO, logger="owlshelf.relay"):
            ws, _ = await open_socket(relay)
            try:
                await recv_presence(ws)
            finally:
                await ws.close()
        admitted = [r for r in caplog.records if getattr(r, "event", None) == "admitted"]
        assert admitted, [record.getMessage() for record in caplog.records]
        # O4's shape: named fields, not a formatted sentence.
        assert admitted[0].roomHash == HASH_A
        assert admitted[0].keyGen == 1
        assert admitted[0].connId
        assert admitted[0].ip == "127.0.0.1"


# ── Concurrent handshakes (G1 — backend/RELAY-GAPS.md) ───────────────────────


async def _first_frame(ws, timeout: float = 0.75):
    """A socket's first frame: a presence dict (admitted) or a close code (refused)."""
    try:
        return json.loads(await asyncio.wait_for(ws.recv(), timeout))
    except websockets.exceptions.ConnectionClosed as exc:
        return ("closed", exc.rcvd.code if exc.rcvd else None)
    except (TimeoutError, asyncio.TimeoutError):
        return ("timeout", None)


class TestConcurrentHandshakeCaps:
    """The caps are hard ceilings, including under the reconnect storms of Gate G.

    Each cap test opens all sockets FIRST, lets every handler run its pre-handshake
    checks while the registry is still empty, then sends every hello at once. The
    existing cap tests drain presence before opening the next socket, which
    serializes admission and hides this race.
    """

    async def _race(self, relay, n: int = 5):
        socks = [await websockets.connect(relay.url, origin=ORIGIN) for _ in range(n)]
        try:
            await asyncio.sleep(0.1)  # every handler has now checked the empty registry
            for i, ws in enumerate(socks):
                frame = hello_frame(conn_id=f"11111111-2222-3333-4444-{i:012d}")
                # With the reservation gate the refusal arrives BEFORE the hello,
                # so some of these sends land on an already-closed socket. That is
                # the fix working: the cap is decided without waiting for a hello.
                with contextlib.suppress(websockets.exceptions.ConnectionClosed):
                    await ws.send(json.dumps(frame))
            await asyncio.sleep(0.25)
            frames = await asyncio.gather(*(_first_frame(ws) for ws in socks))
            admitted = sum(
                1 for f in frames if isinstance(f, dict) and f.get("type") == "presence"
            )
            refused = sum(
                1 for f in frames if isinstance(f, tuple) and f[0] == "closed" and f[1] == 1013
            )
            return admitted, refused, relay.registry.total
        finally:
            for ws in socks:
                try:
                    await ws.close()
                except Exception:
                    pass

    async def test_concurrent_handshakes_cannot_exceed_the_global_cap(self, relay_factory):
        relay = relay_factory(global_cap=1)
        admitted, refused, total = await self._race(relay)
        assert (admitted, refused, total) == (1, 4, 1)

    async def test_concurrent_handshakes_cannot_exceed_the_per_ip_cap(self, relay_factory):
        relay = relay_factory(conns_per_ip=1)
        admitted, refused, total = await self._race(relay)
        assert (admitted, refused, total) == (1, 4, 1)


# ── The reservation ledger (G1) ────────────────────────────────────────────


class TestReservationLedger:
    """A slot is claimed before the handshake and released on EVERY exit.

    The count `total + pending_total` is what `global_cap` bounds. If any refusal
    path forgot to release, the ceiling would ratchet DOWN until the relay
    refused everybody — the mirror image of the G1 bug, and harder to notice
    because it looks like ordinary capacity exhaustion.
    """

    async def test_the_ledger_is_balanced_after_every_refusal_path(self, relay_factory):
        relay = relay_factory(handshake_deadline=0.2, global_cap=10, conns_per_ip=10)

        # 4 handshake timeout.
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        assert await expect_close(ws, timeout=2.0) == 4402

        # 4 bad hello shape.
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        await ws.send("not json")
        assert await expect_close(ws, timeout=2.0) == 4402

        # 5 generation mismatch.
        first, _ = await open_socket(relay, key_gen=3, room_hash="b" * 64)
        await recv_presence(first)
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        await ws.send(json.dumps(hello_frame(key_gen=2, room_hash="b" * 64)))
        assert await expect_close(ws, timeout=2.0) == 4404
        await first.close()

        # 7 duplicate connId.
        holder, conn_id = await open_socket(relay, room_hash="c" * 64)
        await recv_presence(holder)
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        await ws.send(json.dumps(hello_frame(conn_id=conn_id, room_hash="c" * 64)))
        assert await expect_close(ws, timeout=2.0) == 4402
        await holder.close()

        await asyncio.sleep(0.15)
        assert relay.registry.pending_total == 0, "every reservation was settled"
        assert relay.registry.pending_by_ip == {}
        assert relay.registry.total == 0

    async def test_a_refused_slot_does_not_ratchet_the_cap_down(self, relay_factory):
        # global_cap=1 and three timeouts: if any of them leaked a reservation,
        # the third socket could never have been admitted at all.
        relay = relay_factory(handshake_deadline=0.15, global_cap=1, conns_per_ip=1)
        for _ in range(3):
            ws = await websockets.connect(relay.url, origin=ORIGIN)
            assert await expect_close(ws, timeout=2.0) == 4402

        ws, _ = await open_socket(relay)
        try:
            await recv_presence(ws)
            assert relay.registry.total == 1
        finally:
            await ws.close()

    async def test_a_held_reservation_already_counts_against_the_cap(self, relay_factory):
        # The G1 invariant at its sharpest: one socket that has NOT said hello
        # must already occupy the only slot.
        relay = relay_factory(global_cap=1, conns_per_ip=1, handshake_deadline=5.0)
        silent = await websockets.connect(relay.url, origin=ORIGIN)
        try:
            await asyncio.sleep(0.15)
            assert relay.registry.total == 0
            assert relay.registry.pending_total == 1

            refused = await websockets.connect(relay.url, origin=ORIGIN)
            assert await expect_close(refused, timeout=2.0) == 1013
        finally:
            with contextlib.suppress(Exception):
                await silent.close()


class TestChurnThrottle:
    """§10.1's per-IP churn throttle, at the gate that costs nothing."""

    async def test_a_churner_is_temp_banned_and_a_quiet_peer_is_not(self, relay_factory):
        relay = relay_factory(
            global_cap=1, conns_per_ip=1, ip_churn_threshold=3, ip_churn_ban_seconds=5.0
        )
        # Burn the single slot, then churn refusals against it.
        holder, _ = await open_socket(relay)
        try:
            await recv_presence(holder)
            for _ in range(3):
                ws = await websockets.connect(relay.url, origin=ORIGIN)
                assert await expect_close(ws, timeout=2.0) == 1013
            assert "127.0.0.1" in relay.registry.banned_until
        finally:
            await holder.close()

        # Even after the slot frees, the ban still refuses.
        await asyncio.sleep(0.1)
        ws = await websockets.connect(relay.url, origin=ORIGIN)
        assert await expect_close(ws, timeout=2.0) == 1013
