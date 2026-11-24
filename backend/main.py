"""main.py — the relay's process entry (§9, §15.18/O1–O4).

ONE process, `--workers 1`. See `app/relay/app.py` for why that is a
correctness requirement rather than a tuning choice.

`ws_max_size` is §9's frame cap, enforced at the WebSocket protocol layer so an
oversize frame is rejected before it is ever parsed.

Config precedence (§15.18/O1): defaults < `relay.toml` < env < `RELAY_HOST`/
`PORT`, which are process arguments and not relay knobs. The one thing this file
REFUSES to do is boot silently into a topology that cannot serve more than
`conns_per_ip` users — see `topology_note`.
"""

from __future__ import annotations

import logging
import os

import uvicorn

from app.relay.constants import RelayConfig
from app.relay.logging_setup import configure_logging, log_event
from app.relay.ops import load_config, source_summary

logger = logging.getLogger("owlshelf.relay")

_LOOPBACK_BINDS = frozenset({"127.0.0.1", "::1", "localhost"})

DEFAULT_HOST = "127.0.0.1"


def topology_note(cfg: RelayConfig, bind_host: str) -> tuple[str, str]:
    """One (level, message) line about the resolved topology (G2).

    There is exactly one combination that is silently broken, and it is the one
    the plan's own deployment makes easy to reach: a loopback bind behind a
    proxy whose forwarded headers are not trusted. Every user then shares the
    proxy's address, so `conns_per_ip` caps the WHOLE RELAY at that many sockets
    — and the symptom is a bare 1013 with no diagnostic, which §9 reserves for
    rare capacity events.

    The trust-on case gets an INFO line rather than a warning: trusting headers
    is correct for the mandated tunnel topology, and crying wolf on every boot
    would train an operator to ignore the one warning that matters.
    """
    if bind_host in _LOOPBACK_BINDS and not cfg.trust_forwarded_for:
        return (
            "warning",
            f"relay is bound to {bind_host} and trust_forwarded_for is OFF: every "
            f"client behind a local proxy shares ONE ip bucket, so conns_per_ip="
            f"{cfg.conns_per_ip} caps this relay at {cfg.conns_per_ip} sockets total. "
            "Set RELAY_TOPOLOGY=tunnel (cloudflared) or RELAY_TOPOLOGY=direct only "
            "when the peer address really is the client.",
        )
    if cfg.trust_forwarded_for:
        return (
            "info",
            f"topology=tunnel: CF-Connecting-IP / X-Forwarded-For are trusted from a "
            f"loopback peer only (bind={bind_host}). A client that is NOT loopback "
            "still buckets on its own address, so it cannot choose a bucket.",
        )
    return ("info", f"topology=direct: forwarded headers are ignored (bind={bind_host}).")


def main() -> None:
    config_path = os.environ.get("RELAY_CONFIG", "")
    cfg = load_config(config_path or None)
    configure_logging(cfg)

    # `event` is a SLUG and every detail is a named field: a formatted sentence
    # would be truncated by the formatter's cap and could not be indexed.
    log_event(
        logger,
        "info",
        "origins",
        origins=", ".join(cfg.allowed_origins)
        or "(none — EVERY connection will be refused with 4401)",
    )
    log_event(logger, "info", "config", detail=source_summary(cfg, config_path or None))

    host = os.environ.get("RELAY_HOST", DEFAULT_HOST)
    level, message = topology_note(cfg, host)
    log_event(logger, level, "topology", detail=message)

    # `PORT` exists so the integration harness can run a throwaway relay beside
    # a dev one. Everything else stays as this file configures it, so the
    # harness exercises the same process the deployment does.
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(
        "app.relay.app:app",
        host=host,
        port=port,
        workers=1,
        ws="websockets-sansio",
        ws_max_size=cfg.frame_cap,
        log_level="info",
    )


if __name__ == "__main__":
    main()
