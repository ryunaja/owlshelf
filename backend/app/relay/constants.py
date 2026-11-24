"""constants.py — the relay's named knobs (plan §9, §15.18/O1).

Every number in §9's contract is a named constant here, never a literal at a
call site: Gate G tunes these, and a knob that only exists as a literal cannot
be tuned. The defaults are §9's values verbatim; `from_env` overrides them for
deployment and for tests, which is why the dataclass is frozen and passed
around explicitly rather than read from a module global.

Two knobs are deliberately NOT here:

- `FRAME_CAP` is enforced by uvicorn (`--ws-max-size`), not by this process.
  It is still carried in the config so the run command and the config cannot
  drift apart, and `endpoint.handle_frame` re-checks it defensively.
- `LICENSE_VERIFY_PUBKEY` and `REVOKED_TOKENS_FILE` belong to the paid mailbox
  (§15.18), which is step 7. Adding them now would imply the relay authorizes
  something, and it does not (§10).
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace


def _split_origins(raw: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _set(raw: str | None) -> bool:
    """An empty or whitespace env var means "unset", never "set to empty"."""
    return raw is not None and raw.strip() != ""


@dataclass(frozen=True)
class Knob:
    """One env-overridable field: the ONE place its name and its parser live.

    A table instead of fifty lines of `_env_int("X", 1)` because config has three
    layers (§15.18/O1: defaults < relay.toml < env) and every layer needs to ask
    the same two questions — "what is this field called in the env?" and "how do
    I parse it?". Two copies of those answers drift; one table cannot.
    """

    field: str
    env: str
    parse: Callable[[str], object]


# §15.18/O1's env layer. `trust_forwarded_for` is deliberately absent: it is
# resolved by `_resolve_trust_forwarded_for` from RELAY_TOPOLOGY, which has its
# own precedence rules and must be able to fail loudly.
KNOBS: tuple[Knob, ...] = (
    Knob("allowed_origins", "ALLOWED_ORIGINS", _split_origins),
    Knob("global_cap", "GLOBAL_CAP", int),
    Knob("room_cap", "ROOM_CAP", int),
    Knob("conns_per_ip", "CONNS_PER_IP", int),
    Knob("handshake_deadline", "HANDSHAKE_DEADLINE", float),
    Knob("heartbeat_interval", "HEARTBEAT_INTERVAL", float),
    Knob("heartbeat_misses", "HEARTBEAT_MISSES", int),
    Knob("idle_timeout", "IDLE_TIMEOUT", float),
    Knob("room_reap_after", "ROOM_REAP_AFTER", float),
    Knob("reap_sweep_interval", "REAP_SWEEP_INTERVAL", float),
    Knob("byte_budget_sustained", "BYTE_BUDGET_SUSTAINED", int),
    Knob("byte_budget_burst", "BYTE_BUDGET_BURST", int),
    Knob("frame_cap", "FRAME_CAP", int),
    Knob("queue_max", "QUEUE_MAX", int),
    Knob("send_deadline", "SEND_DEADLINE", float),
    Knob("room_egress_burst", "ROOM_EGRESS_BURST", int),
    Knob("room_egress_refill_bps", "ROOM_EGRESS_REFILL_BPS", int),
    Knob("egress_governor_bps", "EGRESS_GOVERNOR_BPS", int),
    Knob("egress_governor_burst", "EGRESS_GOVERNOR_BURST", int),
    Knob("pressure_window", "PRESSURE_WINDOW", float),
    Knob("ip_churn_threshold", "IP_CHURN_THRESHOLD", int),
    Knob("ip_churn_window", "IP_CHURN_WINDOW", float),
    Knob("ip_churn_ban_seconds", "IP_CHURN_BAN_SECONDS", float),
    Knob("shed_policy", "SHED_POLICY", str),
    Knob("log_format", "LOG_FORMAT", str),
    Knob("log_file", "LOG_FILE", str),
    Knob("log_max_bytes", "LOG_MAX_BYTES", int),
    Knob("log_backups", "LOG_BACKUPS", int),
)

KNOB_BY_ENV: dict[str, Knob] = {knob.env: knob for knob in KNOBS}
KNOB_BY_FIELD: dict[str, Knob] = {knob.field: knob for knob in KNOBS}


# `RELAY_TOPOLOGY` is the operator's assertion about what sits in front of the
# relay, and it maps 1:1 onto whether forwarded headers can be believed:
#   tunnel → cloudflared (or another sanitising proxy) in the same pod, so the
#            peer is loopback and `CF-Connecting-IP` is the only real address.
#   direct → the socket's own peer address IS the client, so a header would be
#            a claim the client made about itself.
_TOPOLOGY_TRUST = {"tunnel": True, "direct": False}


def _resolve_trust_forwarded_for(environ: Mapping[str, str] | None = None) -> bool | None:
    """Resolve the forwarded-header policy, and refuse to guess silently (G2).

    Three sources, resolved in one place so the compose file, the env and the
    dataclass default cannot disagree quietly:

    1. `RELAY_TOPOLOGY` — the operator's assertion. Wins.
    2. `TRUST_FORWARDED_FOR=0|1` — the low-level override, for a deployment that
       does not fit either named topology.
    3. Neither set: `None`, meaning "no opinion" — the dataclass default (or a
       relay.toml value) stands. The dataclass default is trusted, because §10.3
       mandates the tunnel topology and a relay that silently caps itself at
       `conns_per_ip` sockets is a worse failure than a spoofable bucket behind
       a non-sanitising local proxy.

    Setting both to contradictory values raises rather than picking one: the
    whole point of the guard is that a wrong answer must be loud.
    """
    env = os.environ if environ is None else environ
    topology = env.get("RELAY_TOPOLOGY", "").strip().lower()
    explicit = env.get("TRUST_FORWARDED_FOR", "").strip()

    if topology and topology not in _TOPOLOGY_TRUST:
        raise ValueError(
            f"RELAY_TOPOLOGY must be one of {sorted(_TOPOLOGY_TRUST)}, got {topology!r}"
        )
    if explicit and explicit not in {"0", "1"}:
        raise ValueError(f"TRUST_FORWARDED_FOR must be 0 or 1, got {explicit!r}")

    if topology and explicit:
        if (explicit == "1") != _TOPOLOGY_TRUST[topology]:
            raise ValueError(
                f"RELAY_TOPOLOGY={topology} means trust_forwarded_for="
                f"{_TOPOLOGY_TRUST[topology]}, but TRUST_FORWARDED_FOR={explicit}"
            )
    if topology:
        return _TOPOLOGY_TRUST[topology]
    if explicit:
        return explicit == "1"
    return None


def topology_label(cfg: "RelayConfig") -> str:
    """`tunnel` / `direct` inferred from the resolved config, for one log line."""
    return "tunnel" if cfg.trust_forwarded_for else "direct"


@dataclass(frozen=True)
class RelayConfig:
    """§9's admission-to-reap contract, as data."""

    # ── Admission ──────────────────────────────────────────────────────────
    # Only owlshelf pages may open sockets. Empty means "refuse everything",
    # never "allow everything" — a misconfigured allowlist must fail closed.
    allowed_origins: tuple[str, ...] = ()
    global_cap: int = 20_000
    room_cap: int = 10
    # §9 step 3 says "more than 3 sockets from one IP is churn or abuse". The
    # plan reads "one IP ≈ one device"; the client makes it "one IP ≈ one
    # HOUSEHOLD × its profiles", because a socket is a room membership and a
    # device opens one per room with a relay URL:
    #
    #   sockets from one public IP = devices behind that NAT × profiles each
    #
    # 3 therefore caps a household at 1.5 two-profile devices, and refuses the
    # second device of a normal pair. 12 covers 3 devices × 4 profiles and one
    # developer machine running two browsers with two profiles each (4).
    #
    # The bound that actually stops abuse is not this one: §10.1's per-connection
    # byte bucket, per-room egress burst, the global egress governor and the
    # per-IP churn ban all still apply, and they are what a single IP cannot
    # scale past. Raising this moves the ceiling from "one laptop" to "one
    # household" without moving the throughput ceiling at all.
    conns_per_ip: int = 12
    handshake_deadline: float = 8.0

    # ── Keepalive ──────────────────────────────────────────────────────────
    heartbeat_interval: float = 30.0
    heartbeat_misses: int = 2
    idle_timeout: float = 300.0

    # ── Reaping ────────────────────────────────────────────────────────────
    room_reap_after: float = 86_400.0
    reap_sweep_interval: float = 60.0

    # ── Transport budget ───────────────────────────────────────────────────
    # Inbound, per connection. §9 says ~2 MB/s sustained with a ~5 MB burst;
    # §10.1 said "2 MB/min". The token bucket is written in seconds and §9 is
    # the transport contract, so §10.1 is the typo — amended there, and the
    # derivation is recorded in owlshelf-code-vs-plan.md §7.6.
    byte_budget_sustained: int = 2 * 1024 * 1024
    byte_budget_burst: int = 5 * 1024 * 1024
    frame_cap: int = 512 * 1024
    queue_max: int = 64
    send_deadline: float = 5.0

    # ── §10.1 always-on abuse controls ─────────────────────────────────────
    # Per-room aggregate EGRESS budget. Capacity is §10.1's literal "20 MB
    # burst"; the refill is derived from §10.1's own amplification math ("one
    # zombie room ≈ 2.4 Mbps egress"), because the plan gives a burst but no
    # per-room rate. 2.4 Mbps = 300 KB/s.
    room_egress_burst: int = 20 * 1024 * 1024
    room_egress_refill_bps: int = 300_000

    # Global egress governor: §10.1's "hard token bucket ~100 Mbps". 100 Mbps =
    # 12.5 MB/s, and a "hard" bucket with one second of capacity is the least
    # generous reading that still absorbs a burst.
    egress_governor_bps: int = 12_500_000
    egress_governor_burst: int = 12_500_000

    # How long a shed frame keeps NEW admissions refused (§10.1: "sheds
    # MESSAGES first … and rejects NEW admissions"). Short: admitting a socket is
    # cheap and the governor refills continuously.
    pressure_window: float = 1.0

    # Per-IP churn throttle with temp-bans (§10.1). The plan names the control
    # and no numbers, so these are Gate-G-tunable defaults: a browser that
    # reconnects a handful of times in a minute is nowhere near 20.
    ip_churn_threshold: int = 20
    ip_churn_window: float = 60.0
    ip_churn_ban_seconds: float = 60.0

    # What to do with a frame the budget or the governor refuses:
    #   "drop"       — shed it, count it, keep the session (§10.1's rule)
    #   "disconnect" — the pre-G3 behaviour (queue-full → 1008), kept ONLY so
    #                  Gate G can measure the difference. Not a recommendation.
    shed_policy: str = "drop"

    # ── Topology (G2) ──────────────────────────────────────────────────────
    # Trust `CF-Connecting-IP` / `X-Forwarded-For` from a LOOPBACK proxy only.
    # The loopback test is the real boundary — a remote attacker cannot present
    # as 127.0.0.1 — so this is on by default, matching §10.3's mandated
    # topology (cloudflared in the pod). Off is the right answer for a DIRECT
    # deployment behind a proxy that does not sanitise XFF, where a client
    # could otherwise pick its own bucket; `RELAY_TOPOLOGY=direct` sets it.
    trust_forwarded_for: bool = True

    # ── Ops (§15.18/O4) ────────────────────────────────────────────────────
    # `json` is O4's shape; `text` exists for a developer's console and is never
    # the deployed default. `log_file` empty means stdout only.
    log_format: str = "json"
    log_file: str = ""
    log_max_bytes: int = 100 * 1024 * 1024
    log_backups: int = 5

    # §15.4/§12.5: `path -> relayUrl`, with "*" as a catch-all. Set from
    # relay.toml only (O1) — an operator decision, never a client's.
    moved: tuple[tuple[str, str], ...] = ()

    extra: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(
        cls,
        base: "RelayConfig | None" = None,
        environ: Mapping[str, str] | None = None,
    ) -> "RelayConfig":
        """Defaults (or `base`) plus the env layer (§15.18/O1).

        `base` is how `ops.load_config` applies the toml UNDER the env: it passes
        the toml-derived config in, and every env var that is actually set wins.

        `environ` exists so the layer is testable without mutating the process.
        A reader that reaches for `os.environ` directly cannot be stacked on top
        of a file without a monkeypatch, which is exactly the bug this signature
        removes.
        """
        env = os.environ if environ is None else environ
        values: dict[str, object] = {
            knob.field: knob.parse(env[knob.env])
            for knob in KNOBS
            if _set(env.get(knob.env))
        }
        # `None` means "no opinion", so a relay.toml value survives when neither
        # RELAY_TOPOLOGY nor TRUST_FORWARDED_FOR is set.
        trust = _resolve_trust_forwarded_for(env)
        if trust is not None:
            values["trust_forwarded_for"] = trust
        if base is None:
            return cls(**values)
        return replace(base, **values)

    def with_overrides(self, **kwargs: object) -> "RelayConfig":
        """A copy with knobs replaced — how tests shrink a 30s heartbeat to 30ms."""
        return replace(self, **kwargs)


# §15.4's close-code table. Named here so the endpoint never writes a bare int.
class CloseCode:
    NORMAL = 1000
    GOING_AWAY = 1001
    # Hygiene: the client broke the transport contract (byte budget, slow
    # consumer). §15.4 assigns 1013 to capacity refusals only, and §6.6 reads
    # 1013 as "not your fault, back off" — so a client-caused disconnect is
    # 1008 instead.
    POLICY_VIOLATION = 1008
    TRY_LATER = 1013
    ORIGIN_REFUSED = 4401
    HANDSHAKE_TIMEOUT = 4402
    ROOM_CAP = 4403
    GENERATION_MISMATCH = 4404
