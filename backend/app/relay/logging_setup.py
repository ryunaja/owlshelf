"""logging_setup.py — O4's structured log lines, and nothing else (§15.18/O4).

The shape is fixed by the plan: `{ts, level, event, connId?, roomHash?, bytes?,
error?}`. Two decisions follow from "never payloads or keys (§10)":

1. **`event` is a SLUG, not a sentence.** A call site logs `"admitted"` with
   named fields, never `f"admitted {conn_id}"`. Formatted prose cannot be
   parsed, re-indexed, or alerted on, and it is how a payload ends up in a log
   line the first time someone is debugging.
2. **The formatter emits an ALLOWLIST of keys.** A future `extra={"body": ...}`
   cannot leak the ciphertext, because `body` is not in the list. That is
   defence in depth rather than the primary rule — the primary rule is that the
   relay never has a plaintext body to log in the first place.

`roomHash` is the room's PUBLIC hash, already on the wire, never the key.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from typing import Any

from .constants import RelayConfig

LOGGER_NAME = "owlshelf.relay"

# O4's optional fields, and the only ones that reach the output. `code`/`reason`
# are the close code and its short reason, which every refusal already knows.
ALLOWED_FIELDS = (
    "connId",
    "roomHash",
    "bytes",
    "error",
    "errorType",
    "ip",
    "keyGen",
    "code",
    "reason",
    "count",
    "room",
    "conns",
    "detail",
    "to",
    "origins",
)

# A runaway `event` is a bug about to become a disk-space incident. The cap is
# generous enough for a slug and small enough that a stray blob cannot fit.
EVENT_MAX = 120


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )


class JsonFormatter(logging.Formatter):
    """One JSON object per line, O4's field set, UTC timestamps."""

    def format(self, record: logging.LogRecord) -> str:
        event = getattr(record, "event", None) or record.getMessage()
        payload: dict[str, Any] = {
            "ts": _utc_now(),
            "level": record.levelname.lower(),
            "event": event[:EVENT_MAX],
        }
        for key in ALLOWED_FIELDS:
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        if record.exc_info:
            # A traceback is operator-facing diagnostics, not client data.
            payload["error"] = self.formatException(record.exc_info)
        return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


class TextFormatter(logging.Formatter):
    """The dev console. Same fields, human eyes. Never the deployed default."""

    def format(self, record: logging.LogRecord) -> str:
        head = f"{_utc_now()} {record.levelname:<7} {record.name} "
        event = (getattr(record, "event", None) or record.getMessage())[:EVENT_MAX]
        extras = " ".join(
            f"{key}={getattr(record, key)}"
            for key in ALLOWED_FIELDS
            if getattr(record, key, None) is not None
        )
        return f"{head}{event}{(' ' + extras) if extras else ''}"


def configure_logging(cfg: RelayConfig, *, stream=None) -> logging.Logger:
    """Install the handlers once, idempotently.

    Idempotent because the integration harness imports the app more than once in
    one process; a second `addHandler` would double every line.
    """
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()

    formatter: logging.Formatter = (
        JsonFormatter() if cfg.log_format != "text" else TextFormatter()
    )

    # stdout first: in a pod, journald/the container runtime is the primary sink
    # and the file handler is the one with a retention policy.
    console = logging.StreamHandler(stream or sys.stdout)
    console.setFormatter(formatter)
    logger.addHandler(console)

    if cfg.log_file:
        # Size rotation bounds disk no matter what else goes wrong. O4's 14-day
        # retention is a property of the log VOLUME (logrotate / journald), not
        # something a size-rotating handler can express — documented rather than
        # pretended.
        file_handler = RotatingFileHandler(
            cfg.log_file,
            maxBytes=cfg.log_max_bytes,
            backupCount=cfg.log_backups,
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

    return logger


def log_event(
    logger: logging.Logger,
    level: str,
    event: str,
    **fields: Any,
) -> None:
    """Log one O4 record: a slug plus named fields."""
    getattr(logger, level)(event, extra={"event": event, **fields})


def reset_logging() -> None:
    """Test seam: drop every handler so the next `configure_logging` starts clean."""
    logger = logging.getLogger(LOGGER_NAME)
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()
