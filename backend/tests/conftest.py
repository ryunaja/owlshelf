"""conftest.py — a real uvicorn server per test, over real WebSocket frames.

Gate C/D are wire contracts. A mocked socket would test the mock, so every
test here drives the shipped app through `websockets.connect` against a live
server on an ephemeral port. The server runs in a thread so the test body can
stay a plain `async def`.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from typing import Any

import pytest
import uvicorn
import websockets

from app.relay.app import create_app
from app.relay.constants import RelayConfig

ORIGIN = "http://localhost:5173"
HASH_A = "a" * 64


def base_config(**overrides: Any) -> RelayConfig:
    cfg = RelayConfig(allowed_origins=(ORIGIN,))
    return cfg.with_overrides(**overrides) if overrides else cfg


class Relay:
    """A running relay plus the handles a test needs to inspect it."""

    def __init__(self, url: str, app: Any) -> None:
        self.url = url
        self.app = app
        self.registry = app.state.registry
        self.config = app.state.relay_config


@pytest.fixture
def relay_factory():
    started: list[tuple[uvicorn.Server, threading.Thread]] = []

    def start(**overrides: Any) -> Relay:
        cfg = base_config(**overrides)
        app = create_app(cfg)
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=0,
            log_level="warning",
            ws="websockets-sansio",
            ws_max_size=cfg.frame_cap,
            lifespan="on",
        )
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()

        deadline = time.time() + 10
        while not server.started:
            if time.time() > deadline:
                raise RuntimeError("relay did not start within 10s")
            time.sleep(0.005)

        port = server.servers[0].sockets[0].getsockname()[1]
        started.append((server, thread))
        return Relay(f"ws://127.0.0.1:{port}/ws", app)

    yield start

    for server, thread in started:
        server.should_exit = True
        thread.join(timeout=5)


@pytest.fixture
def relay(relay_factory) -> Relay:
    return relay_factory()


# ── Client helpers ─────────────────────────────────────────────────────────


def hello_frame(
    *,
    conn_id: str | None = None,
    room_id: str = "room-a",
    key_gen: int = 1,
    room_hash: str = HASH_A,
) -> dict[str, Any]:
    return {
        "v": 1,
        "type": "hello",
        "connId": conn_id or str(uuid.uuid4()),
        "roomId": room_id,
        "keyGen": key_gen,
        "hash": room_hash,
    }


async def open_socket(relay: Relay, *, origin: str | None = ORIGIN, **hello_kwargs: Any):
    """Connect and send a hello. Returns (socket, conn_id)."""
    ws = await websockets.connect(relay.url, origin=origin)
    frame = hello_frame(**hello_kwargs)
    await ws.send(json.dumps(frame))
    return ws, frame["connId"]


async def recv_json(ws, timeout: float = 2.0) -> dict[str, Any]:
    raw = await asyncio.wait_for(ws.recv(), timeout)
    return json.loads(raw)


async def recv_presence(ws, timeout: float = 2.0) -> dict[str, Any]:
    """Read frames until a presence frame arrives, skipping heartbeat pings."""
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError("no presence frame within timeout")
        frame = await recv_json(ws, remaining)
        if frame.get("type") == "presence":
            return frame


async def expect_close(ws, timeout: float = 2.0) -> int:
    """Wait for the server to close and return the close code."""
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError("socket was not closed within timeout")
        try:
            await asyncio.wait_for(ws.recv(), remaining)
        except websockets.exceptions.ConnectionClosed as exc:
            return exc.rcvd.code if exc.rcvd else -1


def envelope(
    *,
    room_id: str = "room-a",
    key_gen: int = 1,
    kind: str = "op",
    body: str = "bm9uY2UtY2lwaGVydGV4dA==",
    to: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    frame: dict[str, Any] = {
        "v": 1,
        "roomId": room_id,
        "keyGen": key_gen,
        "kind": kind,
        "body": body,
    }
    if to is not None:
        frame["to"] = to
    frame.update(extra)
    return frame
