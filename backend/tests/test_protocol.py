"""test_protocol.py — the wire shapes, exhaustively (§15.4, §9).

No server here. Every rule in §15.4 is a total function over a decoded frame,
so the whole shape space is enumerable — and the boundary cases (keyGen 0,
keyGen 2^31, a 65-char roomId, `keyGen: true`) are exactly the ones a
hand-written happy-path test misses.
"""

from __future__ import annotations

import json

import pytest

from app.relay.constants import CloseCode
from app.relay.protocol import (
    KINDS,
    decode,
    join_refusal_code,
    parse_hello,
    presence_frame,
    validate_envelope,
)
from tests.conftest import HASH_A, hello_frame

CONN = "11111111-2222-3333-4444-555555555555"


def raw(frame: object) -> str:
    return json.dumps(frame)


def hello(**overrides: object) -> str:
    frame = hello_frame(conn_id=CONN)
    frame.update(overrides)
    return raw(frame)


# ── decode ─────────────────────────────────────────────────────────────────


class TestDecode:
    def test_an_object_decodes(self):
        assert decode('{"a": 1}') == {"a": 1}

    @pytest.mark.parametrize("text", ["[]", '"x"', "1", "null", "true"])
    def test_a_non_object_is_not_a_frame(self, text):
        assert decode(text) is None

    @pytest.mark.parametrize("text", ["", "{", "not json", '{"a": }'])
    def test_garbage_is_not_a_frame(self, text):
        assert decode(text) is None


# ── hello ──────────────────────────────────────────────────────────────────


class TestParseHello:
    def test_accepts_a_well_formed_hello(self):
        parsed = parse_hello(hello())
        assert parsed is not None
        assert parsed.conn_id == CONN
        assert parsed.room_id == "room-a"
        assert parsed.key_gen == 1
        assert parsed.room_hash == HASH_A

    @pytest.mark.parametrize("version", [None, 0, 2, "1", 1.0, True])
    def test_rejects_an_unknown_protocol_version(self, version):
        # `1.0` and `True` both compare equal to 1 in Python, so a plain `!=`
        # would admit three JSON encodings of "version 1".
        assert parse_hello(hello(v=version)) is None

    @pytest.mark.parametrize("kind", [None, "op", "HELLO", "hello "])
    def test_rejects_a_non_hello_type(self, kind):
        assert parse_hello(hello(type=kind)) is None

    @pytest.mark.parametrize(
        "conn_id",
        [
            None,
            "",
            "not-a-uuid",
            "11111111-2222-3333-4444-55555555555",  # one short
            "11111111-2222-3333-4444-5555555555555",  # one long
            "11111111222233334444555555555555",  # no dashes
            12345,
        ],
    )
    def test_rejects_a_malformed_conn_id(self, conn_id):
        assert parse_hello(hello(connId=conn_id)) is None

    def test_accepts_an_uppercase_conn_id(self):
        # §15.4 says "uuid", not "lowercase uuid"; a client that upper-cases
        # its own id must not be locked out of its own room.
        assert parse_hello(hello(connId=CONN.upper())) is not None

    @pytest.mark.parametrize(
        "room_id",
        [None, "", "a" * 65, "room a", "room.a", "room/a", "room:a", 7],
    )
    def test_rejects_a_malformed_room_id(self, room_id):
        assert parse_hello(hello(roomId=room_id)) is None

    @pytest.mark.parametrize("room_id", ["a", "a" * 64, "Room_1-2"])
    def test_accepts_a_bounded_room_id(self, room_id):
        assert parse_hello(hello(roomId=room_id)) is not None

    @pytest.mark.parametrize("key_gen", [None, 0, -1, 2**31 + 1, 1.5, "1", True, False])
    def test_rejects_an_out_of_range_or_non_integer_key_gen(self, key_gen):
        # `True` is the interesting one: bool is an int subclass in Python, so
        # a naive isinstance check would admit `keyGen: true` as generation 1.
        assert parse_hello(hello(keyGen=key_gen)) is None

    @pytest.mark.parametrize("key_gen", [1, 2**31])
    def test_accepts_the_key_gen_boundaries(self, key_gen):
        assert parse_hello(hello(keyGen=key_gen)) is not None

    @pytest.mark.parametrize(
        "room_hash",
        [
            None,
            "",
            "a" * 63,
            "a" * 65,
            "A" * 64,  # uppercase hex is not the wire form
            "g" * 64,
            "a" * 63 + "-",
            12345,
        ],
    )
    def test_rejects_a_malformed_room_hash(self, room_hash):
        assert parse_hello(hello(hash=room_hash)) is None

    def test_rejects_a_hello_that_is_not_json(self):
        assert parse_hello("hello") is None


# ── envelope ───────────────────────────────────────────────────────────────


def env(**overrides: object) -> dict:
    frame = {
        "v": 1,
        "roomId": "room-a",
        "keyGen": 1,
        "kind": "op",
        "body": "c2VhbGVk",
    }
    frame.update(overrides)
    return frame


class TestValidateEnvelope:
    def test_accepts_a_well_formed_envelope(self):
        assert validate_envelope(env(), "room-a", 1) is True

    @pytest.mark.parametrize("kind", sorted(KINDS))
    def test_accepts_every_kind_in_the_closed_union(self, kind):
        assert validate_envelope(env(kind=kind), "room-a", 1) is True

    @pytest.mark.parametrize("kind", [None, "", "ops", "OP", "audit-bisect ", "presence"])
    def test_rejects_a_kind_outside_the_union(self, kind):
        # audit-2 N7: the consistency-audit message had no legal kind at all.
        # A closed union is only closed if an unlisted kind is refused.
        assert validate_envelope(env(kind=kind), "room-a", 1) is False

    def test_rejects_a_cross_room_room_id(self):
        assert validate_envelope(env(roomId="room-b"), "room-a", 1) is False

    def test_rejects_a_stale_key_gen(self):
        assert validate_envelope(env(keyGen=2), "room-a", 1) is False

    @pytest.mark.parametrize("version", [None, 0, 2, "1"])
    def test_rejects_an_unknown_version(self, version):
        assert validate_envelope(env(v=version), "room-a", 1) is False

    @pytest.mark.parametrize("body", [None, "", 123, [], {}])
    def test_rejects_a_missing_or_non_string_body(self, body):
        assert validate_envelope(env(body=body), "room-a", 1) is False

    @pytest.mark.parametrize("to", [123, [], {}, True])
    def test_rejects_a_non_string_to(self, to):
        # A non-string `to` would make a targeted send silently broadcast.
        assert validate_envelope(env(to=to), "room-a", 1) is False

    def test_accepts_an_absent_to(self):
        assert validate_envelope(env(), "room-a", 1) is True

    def test_accepts_a_string_to(self):
        assert validate_envelope(env(to=CONN), "room-a", 1) is True


# ── presence ───────────────────────────────────────────────────────────────


class TestPresenceFrame:
    def test_members_are_sorted(self):
        assert presence_frame(["b", "a", "c"], HASH_A)["members"] == ["a", "b", "c"]

    def test_an_empty_room_has_no_members(self):
        assert presence_frame([], HASH_A) == {"type": "presence", "hash": HASH_A, "members": []}

    def test_presence_names_its_room(self):
        # One socket can be a member of several rooms, so a presence frame that
        # could not say WHICH shelf it describes would be applied to all of them
        # — the exact confusion multiplexing has to avoid.
        assert presence_frame(["a"], HASH_A)["hash"] == HASH_A

    def test_presence_carries_no_key_gen_and_no_body(self):
        # §6.6: presence is the ONE non-Envelope message. If it ever grew a
        # keyGen or a body, clients would start treating it as an Envelope.
        frame = presence_frame(["a"], HASH_A)
        assert set(frame) == {"type", "hash", "members"}


# ── Join refusal codes (§7.13) ──────────────────────────────────────────────


class TestJoinRefusalCode:
    @pytest.mark.parametrize(
        ("reason", "code"),
        [
            ("generation", CloseCode.GENERATION_MISMATCH),
            ("room-cap", CloseCode.ROOM_CAP),
            ("already-joined", CloseCode.TRY_LATER),
        ],
    )
    def test_a_refusal_carries_the_same_code_its_hello_equivalent_would(self, reason, code):
        # The client branches on this field: 4404 stops the room and asks the
        # user to re-pair; 4403/1013 back off. Every refusal was 4404 before.
        assert join_refusal_code(reason) == code

    def test_an_unknown_reason_backs_off_instead_of_asking_for_a_re_pair(self):
        # An unrecognised reason is a server bug, not a rotation. Never turn a
        # typo into "re-pair with the owner" on the user's screen.
        assert join_refusal_code("some-new-reason") == CloseCode.TRY_LATER
