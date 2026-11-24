"""protocol.py — the relay's wire contract, as pure functions (plan §9, §15.4).

Nothing here touches a socket, a clock, or the registry. That is deliberate:
the relay's job is to check SHAPE and route, never to parse a payload (§9), so
every shape rule is a total function over a decoded frame and can be tested
exhaustively without a server.

The relay is blind. It cannot read `body` (AEAD under the room key), cannot
verify a signature, and cannot authorize anything — the signed control plane
lives with clients (§10). Everything below is therefore a *routing* check. The
real binding is the AEAD tag, which only clients can evaluate.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable

from .constants import CloseCode

# §6.6's CLOSED union, plus `audit-bisect` (§15.4, and §6.6's repair ladder).
# An unlisted kind is dropped at the relay's shape check AND at the client —
# audit-2 N7 was the consistency-audit message having no legal kind at all.
KINDS = frozenset(
    {
        "op",
        "control",
        "catchup-request",
        "catchup-reply",
        "blob-request",
        "file-chunk",
        "audit",
        "audit-bisect",
    }
)

PROTOCOL_VERSION = 1

# §15.4: roomId is ≤64 chars of [A-Za-z0-9_-]; hash is 64 hex chars.
ROOM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ROOM_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
CONN_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

KEY_GEN_MIN = 1
KEY_GEN_MAX = 2**31

# Heartbeat frames are app-level (§15.4) because the consistency audit
# piggybacks on the 30s cadence; a protocol-level WS ping carries no payload.
HEARTBEAT_TYPES = frozenset({"ping", "pong"})


@dataclass(frozen=True)
class Hello:
    """A validated first frame. Every field has already passed its shape rule."""

    conn_id: str
    room_id: str
    key_gen: int
    room_hash: str


@dataclass(frozen=True)
class Membership:
    """One room on a connection (§9 amendment: multiplexing).

    A socket is no longer bound to exactly one room. The FIRST room still comes
    from `hello` (so an old client works unchanged); every extra room arrives as
    a `join` frame on the same socket. The relay is still blind — a membership is
    a routing tuple, never a credential: the room key, and therefore the AEAD
    tag, is the only thing that decides whether a frame is readable.
    """

    room_id: str
    key_gen: int
    room_hash: str


def _is_version(value: object) -> bool:
    """`v` must be the INTEGER 1, not `1.0` and not `true`.

    `1.0 == 1` and `True == 1` are both true in Python, so a plain `!=` check
    admits three distinct JSON encodings of "version 1". §15.4 says `v: 1`, and
    a version tag that accepts a float is a version tag that cannot be extended
    to `1.5` later without ambiguity.
    """
    return isinstance(value, int) and not isinstance(value, bool) and value == PROTOCOL_VERSION


def decode(raw: str) -> dict[str, Any] | None:
    """Parse one text frame into a JSON object, or None if it is not one."""
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def encode(msg: dict[str, Any]) -> str:
    """Serialise one outbound frame.

    The relay pre-serialises for two reasons that are both about accounting:

    - §10.1's budgets are in BYTES, so the relay has to know how many it is
      about to put on the wire. Measuring a dict means serialising it anyway.
    - A fan-out of N recipients serialises ONCE here instead of N times in the
      writer. With 512 KB frames that is the difference between 0.5 MB and
      5 MB of JSON work per op in a 10-socket room.

    Compact separators, not the default: the wire is a machine boundary, and
    the default `", "`/`": "` padding is pure egress on every frame.
    """
    return json.dumps(msg, separators=(",", ":"))


def parse_hello(raw: str) -> Hello | None:
    """Validate the first client frame (§15.4).

    Shape only, and every field is required: a hello missing `keyGen` must not
    be defaulted to 1, because the room-level generation check (§9 step 5)
    would then admit a stale device into a rotated room.
    """
    msg = decode(raw)
    if msg is None:
        return None

    if not _is_version(msg.get("v")):
        return None
    if msg.get("type") != "hello":
        return None

    conn_id = msg.get("connId")
    room_id = msg.get("roomId")
    key_gen = msg.get("keyGen")
    room_hash = msg.get("hash")

    if not isinstance(conn_id, str) or not CONN_ID_RE.match(conn_id):
        return None
    if not isinstance(room_id, str) or not ROOM_ID_RE.match(room_id):
        return None
    # `bool` is an `int` subclass in Python; `keyGen: true` must not pass.
    if isinstance(key_gen, bool) or not isinstance(key_gen, int):
        return None
    if not (KEY_GEN_MIN <= key_gen <= KEY_GEN_MAX):
        return None
    if not isinstance(room_hash, str) or not ROOM_HASH_RE.match(room_hash):
        return None

    return Hello(
        conn_id=conn_id,
        room_id=room_id,
        key_gen=key_gen,
        room_hash=room_hash,
    )


def parse_membership(msg: dict[str, Any], expected_type: str) -> Membership | None:
    """Validate one `join`/`leave` tuple. Shape only, same rules as `hello`.

    `join` is the multiplexing amendment to §15.4: a second room joins the
    socket that is already admitted. It is a SEPARATE frame and not a hello
    field so that (a) a v1 client keeps working byte-for-byte, and (b) a refused
    join can be reported without dropping the rooms that already work — a
    rotation on one shelf must not disconnect the others.
    """
    if not _is_version(msg.get("v")):
        return None
    if msg.get("type") != expected_type:
        return None

    room_id = msg.get("roomId")
    key_gen = msg.get("keyGen")
    room_hash = msg.get("hash")

    if not isinstance(room_id, str) or not ROOM_ID_RE.match(room_id):
        return None
    if isinstance(key_gen, bool) or not isinstance(key_gen, int):
        return None
    if not (KEY_GEN_MIN <= key_gen <= KEY_GEN_MAX):
        return None
    if not isinstance(room_hash, str) or not ROOM_HASH_RE.match(room_hash):
        return None

    return Membership(room_id=room_id, key_gen=key_gen, room_hash=room_hash)


def parse_join(raw: str) -> Membership | None:
    """A `join` frame: add one room to an already-admitted socket."""
    msg = decode(raw)
    return None if msg is None else parse_membership(msg, "join")


def parse_leave(raw: str) -> str | None:
    """A `leave` frame: drop one room from an already-admitted socket.

    Only the hash is needed — the connection is the credential, and it is
    already admitted for that hash or this is a no-op.
    """
    msg = decode(raw)
    if msg is None:
        return None
    if not _is_version(msg.get("v")) or msg.get("type") != "leave":
        return None
    room_hash = msg.get("hash")
    if not isinstance(room_hash, str) or not ROOM_HASH_RE.match(room_hash):
        return None
    return room_hash


def validate_envelope(msg: dict[str, Any], room_id: str, key_gen: int) -> bool:
    """Check one forwarded frame against the socket's bound room (§9, §6.6).

    The roomId/keyGen comparison is defense in depth, not the binding: a
    cross-room message dies at three independent gates — this string check, the
    client's socket-room check, and the AEAD tag keyed to the socket's room key.
    Only the third is cryptographic, which is why this one is cheap and total.
    """
    if not _is_version(msg.get("v")):
        return False
    if msg.get("roomId") != room_id:
        return False
    if msg.get("keyGen") != key_gen:
        return False
    if msg.get("kind") not in KINDS:
        return False

    body = msg.get("body")
    if not isinstance(body, str) or body == "":
        return False

    # `to` is optional; when present it must be a string, or a targeted send
    # would silently become a broadcast (P0-5/P0-8).
    to = msg.get("to")
    if to is not None and not isinstance(to, str):
        return False

    return True


def presence_frame(members: Iterable[str], room_hash: str) -> dict[str, Any]:
    """The ONE non-Envelope wire message (§6.6, audit-2 N19).

    It carries no keyGen and no body because the relay cannot seal anything.
    It is routing metadata the relay already owns, and clients consume it as
    presence only — never as an Envelope.

    `hash` names WHICH room this presence is about. It is required now that one
    socket can be in several rooms: without it a multiplexed client cannot tell
    a shelf's member list from another's.
    """
    return {"type": "presence", "hash": room_hash, "members": sorted(members)}


def joined_frame(room_hash: str, key_gen: int) -> dict[str, Any]:
    """A `join` (or the hello-time admission) was accepted for this room.

    The client holds frames until it sees this: an envelope for a room the relay
    has not adopted would be dropped by routing, and "dropped" is
    indistinguishable from "lost in transit" without an ack.
    """
    return {"type": "joined", "hash": room_hash, "keyGen": key_gen}


def join_refused_frame(room_hash: str, code: int, reason: str) -> dict[str, Any]:
    """One room was refused on an otherwise healthy socket.

    Deliberately NOT a close: a stale generation on one shelf must not take the
    other shelves down with it. The client fails that room locally (the same
    path as a 4404 on a dedicated socket) and keeps the rest connected.
    """
    return {"type": "join-refused", "hash": room_hash, "code": code, "reason": reason}


# A join passes the same THREE room checks as a hello (§7.13), so its refusals
# must carry the SAME close codes a hello's refusal would. The client branches on
# this field: 4404 stops the room and asks the user to re-pair, 4403 backs off.
# Hardcoding 4404 for every reason made a full room look like a rotation.
JOIN_REFUSAL_CODES: dict[str, int] = {
    "generation": CloseCode.GENERATION_MISMATCH,  # 4404: rotated, re-pair
    "room-cap": CloseCode.ROOM_CAP,  # 4403: capacity, back off and retry
    "already-joined": CloseCode.TRY_LATER,  # 1013: retry race, not permanent
}


def join_refusal_code(reason: str) -> int:
    """The wire close code for one `join_room` refusal reason.

    An unknown reason is a server bug, not a rotation: default to a backoff code
    rather than telling a user to re-pair because of a typo.
    """
    return JOIN_REFUSAL_CODES.get(reason, CloseCode.TRY_LATER)


def ping_frame() -> dict[str, Any]:
    return {"type": "ping"}
