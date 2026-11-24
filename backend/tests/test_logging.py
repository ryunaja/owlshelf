"""test_logging.py — O4's log shape, and the promise that it cannot leak (G4).

§15.18/O4: JSON lines `{ts, level, event, connId?, roomHash?, bytes?, error?}`,
100 MB × 5 rotation, and NEVER payloads or keys. The last clause is the one that
matters, so it is tested directly: a `body` on the record must not reach the
output, whatever a future call site does.
"""

from __future__ import annotations

import io
import json
import logging

import pytest

from app.relay.constants import RelayConfig
from app.relay.logging_setup import (
    ALLOWED_FIELDS,
    EVENT_MAX,
    JsonFormatter,
    TextFormatter,
    configure_logging,
    log_event,
    reset_logging,
)


@pytest.fixture(autouse=True)
def clean_logger():
    reset_logging()
    yield
    reset_logging()


def one_line(cfg=RelayConfig(), event="admitted", level="info", **fields) -> dict:
    stream = io.StringIO()
    logger = configure_logging(cfg, stream=stream)
    log_event(logger, level, event, **fields)
    out = stream.getvalue().strip().splitlines()
    assert len(out) == 1, out
    return json.loads(out[0])


class TestShape:
    def test_every_o4_field_is_emitted_when_present(self):
        record = one_line(
            connId="c-1", roomHash="a" * 64, keyGen=2, ip="1.2.3.4", code=4401, reason="origin"
        )
        assert record["level"] == "info"
        assert record["event"] == "admitted"
        assert record["connId"] == "c-1"
        assert record["roomHash"] == "a" * 64
        assert record["keyGen"] == 2
        assert record["code"] == 4401
        assert record["ts"].endswith("Z"), "UTC, in the ISO form a log shipper parses"

    def test_the_error_level_is_lowercase(self):
        assert one_line(level="error", event="frame-error")["level"] == "error"

    def test_absent_fields_are_absent_not_null(self):
        record = one_line()
        assert "connId" not in record
        assert "error" not in record


class TestNeverPayloads:
    def test_a_body_on_the_record_never_reaches_the_output(self):
        # The allowlist in the formatter is the second line of defence: the first
        # is that the relay has no plaintext body. Testing the second line means
        # a future `extra={"body": ...}` cannot leak even if someone adds one.
        record = one_line(body="SEALED-CIPHERTEXT", roomKey="SECRET-KEY-MATERIAL")
        line = json.dumps(record)
        assert "SEALED-CIPHERTEXT" not in line
        assert "SECRET-KEY-MATERIAL" not in line
        assert "body" not in record
        assert "roomKey" not in record

    def test_a_giant_event_is_capped(self):
        # A log line containing a frame is a disk-space incident.
        formatter = JsonFormatter()
        record = logging.LogRecord(
            "owlshelf.relay", logging.INFO, __file__, 1, "x" * (EVENT_MAX * 4), None, None
        )
        payload = json.loads(formatter.format(record))
        assert len(payload["event"]) == EVENT_MAX

    def test_the_allowlist_is_closed_and_named(self):
        assert "roomHash" in ALLOWED_FIELDS
        assert "connId" in ALLOWED_FIELDS
        for forbidden in ("body", "key", "roomKey", "payload", "ops"):
            assert forbidden not in ALLOWED_FIELDS


class TestHandlers:
    def test_stdout_is_always_installed(self):
        logger = configure_logging(RelayConfig(log_format="json"), stream=io.StringIO())
        assert len(logger.handlers) == 1

    def test_a_file_handler_is_added_when_a_path_is_set(self, tmp_path):
        target = tmp_path / "relay.log"
        logger = configure_logging(RelayConfig(log_file=str(target)))
        assert len(logger.handlers) == 2
        assert any(isinstance(h, logging.handlers.RotatingFileHandler) for h in logger.handlers)

    def test_rotation_is_one_hundred_megabytes_by_five(self, tmp_path):
        # O4's literal numbers, asserted on the handler rather than trusted.
        target = tmp_path / "relay.log"
        logger = configure_logging(RelayConfig(log_file=str(target)))
        handler = next(
            h for h in logger.handlers if isinstance(h, logging.handlers.RotatingFileHandler)
        )
        assert handler.maxBytes == 100 * 1024 * 1024
        assert handler.backupCount == 5

    def test_configuring_twice_does_not_double_every_line(self):
        # The integration harness imports the app more than once in one process.
        stream = io.StringIO()
        configure_logging(RelayConfig(), stream=stream)
        logger = configure_logging(RelayConfig(), stream=stream)
        log_event(logger, "info", "admitted")
        assert len(stream.getvalue().strip().splitlines()) == 1

    def test_text_format_is_opt_in_and_not_json(self):
        stream = io.StringIO()
        logger = configure_logging(RelayConfig(log_format="text"), stream=stream)
        log_event(logger, "info", "admitted", connId="c-1")
        line = stream.getvalue().strip()
        assert not line.startswith("{")
        assert "admitted" in line and "connId=c-1" in line

    def test_the_formatter_is_chosen_by_config(self):
        assert isinstance(
            configure_logging(RelayConfig()).handlers[0].formatter,
            JsonFormatter,
        )
        reset_logging()
        assert isinstance(
            configure_logging(RelayConfig(log_format="text")).handlers[0].formatter,
            TextFormatter,
        )

    def test_the_traceback_goes_to_error(self):
        formatter = JsonFormatter()
        try:
            raise ValueError("boom")
        except ValueError:
            import sys

            record = logging.LogRecord(
                "owlshelf.relay", logging.ERROR, __file__, 1, "frame-error", None, sys.exc_info()
            )
        payload = json.loads(formatter.format(record))
        assert "ValueError" in payload["error"]
