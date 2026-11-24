"""app.py — the FastAPI wiring (§9, §15.18/O2–O3).

The relay is ONE process. `uvicorn --workers 1` is not a tuning choice: a
process-local room dict cannot fan out across replicas, so two workers behind a
round-robin LB split rooms permanently and silently — the two-island partition
of §6.6, manufactured while every device shows "connected" (audit P0-8).

Two endpoints, two audiences:

- `/healthz` — the compose healthcheck. Counts only, no user data, no hashes.
  `/health` is an ALIAS for the same handler body (see the note at the route):
  operators and monitors guess that path first, and the plan names only
  `/healthz`.
- `/metrics` — O2's Prometheus text. §15.18 puts it on 127.0.0.1 ONLY, so it is
  guarded twice, and neither guard alone is enough:

  1. uvicorn binds `127.0.0.1`, so there is no public listener.
  2. The route refuses a request that is not loopback **and** refuses one that
     arrived through the tunnel. cloudflared shares this container's network
     namespace, so its requests have a LOOPBACK peer — a peer-only check would
     happily serve `/metrics` to the internet on any hostname whose ingress
     forwards every path. Cloudflare stamps `CF-Connecting-IP`/`CF-Ray` on what
     it proxies and a host-side scraper (node exporter) sends neither, so
     "loopback and no Cloudflare header" is the honest test.

  The primary control is still `cloudflared-config.yml.example`'s path-based
  ingress: forward `/ws` and nothing else. These checks make a misconfigured
  ingress fail closed instead of publishing the metrics.
"""

from __future__ import annotations

import asyncio
import contextlib
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import PlainTextResponse

from .constants import RelayConfig
from .endpoint import websocket_endpoint
from .registry import RoomRegistry

_LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost"})

# Cloudflare stamps these on everything it proxies. Their presence means the
# request came from the INTERNET through the tunnel, not from a scraper on the
# host — even though the tunnel's peer address looks like loopback.
_TUNNEL_HEADERS = ("cf-connecting-ip", "cf-ray")


def metrics_allowed(peer: str | None, headers: Any) -> bool:
    """O2's "on 127.0.0.1 only", in the two checks an ASGI app can actually make.

    Refusing a tunnel-proxied request is what keeps `/metrics` private even when
    a hostname forwards every path: cloudflared shares this pod's network
    namespace, so `request.client.host` is loopback for the whole internet. A
    peer check alone would be a control that looks right in review and does
    nothing in the mandated deployment.
    """
    if peer not in _LOOPBACK:
        return False
    for header in _TUNNEL_HEADERS:
        if headers.get(header):
            return False
    return True


def prometheus_text(registry: RoomRegistry) -> str:
    """O2's metric set, in text exposition format.

    Names are `owlshelf_relay_*` and every one is a gauge: the relay keeps no
    history, and a counter that resets on restart is a gauge with extra steps.
    """
    lines: list[str] = []

    def gauge(name: str, value: float, help_text: str) -> None:
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} gauge")
        lines.append(f"{name} {value}")

    gauge("owlshelf_relay_connections", registry.total, "Admitted connections.")
    gauge("owlshelf_relay_pending", registry.pending_total, "Reserved but not yet admitted.")
    gauge("owlshelf_relay_rooms", len(registry.rooms), "Known room hashes, occupied or reaping.")
    gauge(
        "owlshelf_relay_queue_depth",
        sum(conn.queue.qsize() for room in registry.rooms.values() for conn in room.conns.values()),
        "Frames waiting in writers.",
    )
    gauge(
        "owlshelf_relay_heartbeat_misses",
        sum(
            conn.missed_pongs
            for room in registry.rooms.values()
            for conn in room.conns.values()
        ),
        "Intervals since the last inbound frame, summed over connections.",
    )
    gauge("owlshelf_relay_shed_frames", registry.shed_frames, "Frames dropped by §10.1's budgets.")
    gauge("owlshelf_relay_shed_bytes", registry.shed_bytes, "Bytes dropped by §10.1's budgets.")
    gauge("owlshelf_relay_banned_ips", len(registry.banned_until), "IPs under a churn temp-ban.")

    for reason in sorted(registry.dropped):
        lines.append(f'owlshelf_relay_dropped{{reason="{reason}"}} {registry.dropped[reason]}')
    lines.append("# HELP owlshelf_relay_dropped Frames dropped, by reason.")
    lines.append("# TYPE owlshelf_relay_dropped gauge")

    return "\n".join(lines) + "\n"


def create_app(cfg: RelayConfig | None = None) -> FastAPI:
    config = cfg if cfg is not None else RelayConfig.from_env()
    registry = RoomRegistry(config)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        reaper = asyncio.create_task(registry.reaper())
        try:
            yield
        finally:
            reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await reaper

    app = FastAPI(title="OwlShelf Relay", lifespan=lifespan)
    app.state.relay_config = config
    app.state.registry = registry

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        await websocket_endpoint(websocket)

    def health_body() -> dict[str, Any]:
        """Liveness plus two counters. No user data, no room hashes."""
        return {"ok": True, "rooms": len(registry.rooms), "conns": registry.total}

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return health_body()

    # `/health` is an alias, not a second probe. Every uptime monitor,
    # load-balancer default and half-remembered `curl` guesses `/health`, and
    # the 404 it earns reads as "the relay is down" rather than "wrong path" —
    # a false outage that costs more than one extra route. Both paths call the
    # same body, so they cannot drift; `/healthz` stays the documented one
    # (§15.18/O2, `compose.yaml`, README) and is what the healthcheck uses.
    @app.get("/health")
    async def health() -> dict[str, Any]:
        return health_body()

    @app.get("/metrics", response_class=PlainTextResponse)
    async def metrics(request: Request) -> PlainTextResponse:
        """O2's scrape endpoint, restricted to a host-side caller.

        404 rather than 403 for a refused caller: the goal is to make the route
        invisible, not to advertise that a metrics endpoint exists.
        """
        peer = request.client.host if request.client else "unknown"
        if not metrics_allowed(peer, request.headers):
            return PlainTextResponse("not found", status_code=404)
        return PlainTextResponse(prometheus_text(registry))

    return app


app = create_app()
