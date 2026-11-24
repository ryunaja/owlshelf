"""The OwlShelf relay: a blind, room-bound fan-out (plan §9).

It cannot read envelopes (AEAD), cannot authorize anything (the signed control
plane lives with clients), and remembers nothing but transient sockets and
hashes. Everything it knows is lost on restart, by design.
"""

from .app import create_app
from .constants import CloseCode, RelayConfig
from .registry import RoomRegistry

__all__ = ["CloseCode", "RelayConfig", "RoomRegistry", "create_app"]
