# Relay — gaps against the plan, and the fix plan

**Status:** 2026-11-24. Steps 1–4 complete; step 5 relay code written, Gate G not passed.
**Ledger status:** all seven gaps **CLOSED** in the same 2026-11-24 pass — see "What
landed" below. `pytest` runs **zero xfails** (263 passed). Gate G itself is still
unproven: closing a gap means the defect cannot recur, not that the capacity model
has been measured.
**Scope:** `backend/` vs `owlshelf-sync-plan.md` §9–§11, §13, §15.4, §15.18. Companion to
`owlshelf-code-vs-plan.md` §5.8 / §7.6 / §7.7.
**Evidence standard:** per plan §13, a claim is proven only by execution. G1 and G2 were
reproduced against a live uvicorn server with real `websockets` frames on 2026-11-24; the
outputs are quoted below. G3–G7 are settled by reading the source: the specified component
does not exist.

## The ledger

| ID | Sev | Gap | Plan | Gate | Pinning test | Status |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | **P0** | Global + per-IP caps are TOCTOU — checked before the 8 s handshake `await`, never rechecked | §9 steps 2–3, §10.1 | C, G | `tests/test_admission.py::TestConcurrentHandshakeCaps` | **closed** + `TestReservationLedger` |
| G2 | **P0** | Default config + mandated Cloudflare tunnel put every user in one 3-socket IP bucket | §9 step 3, §10.3, §15.18/O3 | G | `tests/test_forwarded_ip.py::test_distinct_tunnel_users_get_distinct_ip_buckets_by_default` | **closed** — normal test |
| G3 | P1 | §10.1 always-on abuse controls absent: per-room aggregate budget, global egress governor, per-IP churn throttle, message shedding | §10.1 | G | `tests/test_load_controls.py` | **closed** — 17 checks, knobs + semantics |
| G4 | P1 | O1–O4 ops absent: no `relay.toml`, no metrics, no JSON/rotated logs, no `compose.yaml`, errors swallowed silently | §15.18 | G | `tests/test_ops.py`, `tests/test_logging.py` | **closed** |
| G5 | P1 | `moved` redirect absent | §15.4, §12.5 | step 7 | `tests/test_ops.py::TestMoved` | **closed** |
| G6 | P2 | Byte-budget unit contradiction: §9 says 2 MB/**s**, §10.1 says 2 MB/**min**; code follows §9, undocumented | §9, §10.1 | doc | `owlshelf-code-vs-plan.md` §7.6 | **closed** — §10.1 amended in place |
| G7 | P2 | Runtime `requirements.txt` ships pytest et al.; README claims otherwise; pydantic/yaml/dotenv/httpx unused | backend README | doc | `tests/test_dependencies.py` | **closed** — AST-checked |

## What landed (2026-11-24)

| Gap | The change |
| --- | --- |
| G1 | `RoomRegistry.reserve/settle/admit` + a `Reservation` with an idempotent settle. The endpoint gets ONE `try/finally`, and `_admit`/`_serve` split so the teardown has a single release site. `note_refusal` counts cap/timeout/shape refusals per IP; a generation mismatch is deliberately NOT counted, so a stale device keeps seeing the diagnostic 4404. |
| G2 | `RELAY_TOPOLOGY=tunnel\|direct` resolved in `constants._resolve_trust_forwarded_for`, `trust_forwarded_for` defaulting to **True** behind the loopback guard, `compose.yaml` carrying `RELAY_TOPOLOGY=tunnel`, and `main.topology_note` warning on the one combination that silently caps the relay. **Deviation from this document's own fix plan:** the flag is a config default as well as a deployment property, because carrying it only in compose leaves every non-compose deployment on the 3-socket behaviour and keeps the G2 pin a permanent xfail. The loopback peer test is the actual boundary, so the default is safe. |
| G3 | `EgressBucket` in bytes; `charge_egress` (room bucket, then governor); `_deliver` sheds and counts instead of closing; `registry.starved_at` rejects new admissions for `pressure_window`; `note_refusal` + `banned_until` at the `reserve` gate; `SHED_POLICY=drop\|disconnect` so Gate G can measure both. Frames are serialised once at the routing boundary (`protocol.encode`) and charged per recipient. Keepalive pings bypass the budgets — charging them would let the governor shed the very frames that prove a socket is alive. |
| G4 | `ops.load_config` (defaults < `relay.toml` < env, unknown key = boot failure), `logging_setup` (O4 JSON shape, an ALLOWLIST of keys so a body cannot leak, 100 MB × 5 rotation), `/metrics` (Prometheus text, loopback-guarded twice), `frame-error` replaces `except Exception: pass`, `compose.yaml` + `Dockerfile` + `relay.example.toml`. |
| G5 | `moved_target` + `_moved`, checked after the origin and before a reservation, from `[moved]` in `relay.toml` only. |
| G6 | §10.1 amended to 2 MB/s with the correction marked inline. The per-room **egress** budget §10.1 was missing is now `room_egress_burst = 20 MB` refilled at `300 KB/s`, the latter derived from §10.1's own "one zombie room ≈ 2.4 Mbps". |
| G7 | Runtime file split and pruned; `test_dependencies.py` walks the AST of `app/` and fails on an unpinned import or a test package in the runtime file. A cold `pip install` is the README's acceptance step — it needs the network, so it is not automated. |

## Still open (Gate G, not code)

1. Four distinct IP buckets through a **real** Cloudflare tunnel. The compose unit
   carries the flag; only the proof is missing.
2. The 10-connection single-room load test: egress stays under the governor, frames
   are shed without disconnects, durable catch-up recovers the shed ops.
3. A reconnect storm against the reservation ledger (the Gate G scenario G1's
   evidence was taken from).

Each is a row in `owlshelf-gate-backlog.md` (`RW-G6`, `RW-G7`, `RW-G5`) with the
procedure and pass criteria; that file is the register of every gate clause no
local run can close. Two prerequisites live there too: `/metrics` still has no
byte counters (`RW-G8` needs them as the denominator), and there is no load
generator yet (`backend/tools/loadgen.py`).

---

## G1 (P0) — admission caps are checked before the handshake and never rechecked

**Plan (§9 steps 2–3):** "At the process ceiling, refuse with try later (1013)… More than 3
sockets from one IP is churn or abuse; refuse." §10.1 requires bounding every attacker vector.

**Observed:** `endpoint.py:137-146` checks `registry.total` and `ip_count`; `endpoint.py:150`
then `await`s the hello for up to 8 s; `registry.admit()` at `endpoint.py:181` is the first
mutation, with no recheck. All handlers that arrive during the same window pass the check at
`total=0`.

**Evidence (executed, `global_cap=1`, `conns_per_ip=1`, five concurrent hellos):**

```
total after 5 connects, before hellos: 0
total after all 5 handshakes (cap=1): 5
ip_counts: {'127.0.0.1': 5}
```

The room-cap, generation, and duplicate-connId checks are *after* the await and have no gap
between check and `admit()` — they are safe. The two **pre-handshake** caps are not.

**Impact:** the hard ceiling in §9 is not a ceiling. Under a reconnect storm (Gate G's own
scenario) the cap can be exceeded by the number of concurrent handshakes; a single host can
open arbitrary sockets because the per-IP cap is bypassed too. It also makes the §10.1
anti-freeloader math meaningless.

**Fix plan:**
1. Add reservations to `RoomRegistry`: `pending_total`, `pending_by_ip`. A synchronous
   `reserve(ip)` checks `total + pending_total` against `global_cap` and
   `ip_count(ip) + pending_by_ip[ip]` against `conns_per_ip`, then increments both counters.
   Call it where steps 2–3 are today — **before** the handshake await.
2. Every exit after `reserve()` releases exactly once: handshake timeout, `hello-shape`,
   generation mismatch, room cap, duplicate connId, and disconnect-before-hello. Implement as
   a single `try/finally` with a `reserved` flag wrapping the endpoint body from `accept()` on,
   not six scattered decrements.
3. `registry.admit()` converts the reservation into a connection in the same synchronous block
   as the post-handshake room checks: no `await` between check and mutation. That is the whole
   invariant — one asyncio thread, no interleaving point.
4. Do **not** "fix" this by moving the checks after the handshake: that gives every attacker
   a free 8 s socket and breaks §10.1's cost bounding.
5. Flip `TestConcurrentHandshakeCaps` from strict xfail to a normal test in the same commit.
   Add a Gate G case with ≥5 concurrent handshakes per IP against the running relay.

---

## G2 (P0) — the mandated deployment topology makes the relay a 3-socket service

**Plan (§10.3, §15.18/O3):** the relay runs on `127.0.0.1` with a `cloudflared` container in
the same pod sharing its network namespace; one `compose.yaml` is the unit list.

**Observed:** `constants.py:79` defaults `trust_forwarded_for=False`, and `main.py` never sets
it. The peer address of every cloudflared connection is loopback, so `client_ip()`
(`endpoint.py:46-61`) returns `127.0.0.1` for **every user**; `conns_per_ip=3` then caps the
whole relay at three sockets. Neither the README run command nor any checked-in compose file
sets the flag (there is no compose file at all).

**Evidence (executed):**

```
default trust_forwarded_for: False | loopback peer, no header -> bucket: 127.0.0.1
CF header present but trust disabled -> bucket: 127.0.0.1 (every CF tunnel user shares this bucket)
trust enabled + CF header -> bucket: 1.2.3.4
```

**Impact:** if deployed exactly as documented, the fourth user cannot connect — and the
symptom is a bare 1013 with no diagnostic, which §9 says should be a rare capacity event.

**Fix plan:**
1. Check in `compose.yaml` (O3): relay (`--workers 1`, `127.0.0.1`, MemoryMax 512M,
   CPUQuota 150%, healthcheck on `/healthz`) + cloudflared (outbound-only, MemoryMax 128M),
   with `TRUST_FORWARDED_FOR=1` and `ALLOWED_ORIGINS` set explicitly. Make the flag a property
   of the deployment unit, not a thing an operator has to remember.
2. README: show the tunnel topology in the run section and state exactly when the flag must
   be on (loopback proxy) and when it must be off (direct, reachable peer).
3. Startup guard in `main.py`: log a WARNING naming this gap when the peer-facing bind is
   loopback and `trust_forwarded_for` is false. Optionally require an explicit
   `RELAY_TOPOLOGY=tunnel|direct` so a missing flag fails loudly instead of silently capping.
4. Keep the two unit guards in `test_forwarded_ip.py`: a non-loopback peer must never be able
   to choose its bucket, and a trusted loopback proxy must be honoured (CF header, then XFF).
   The fix must be topology-aware, not "trust headers unconditionally".
5. Flip `test_distinct_tunnel_users_get_distinct_ip_buckets_by_default` to a normal test when
   the compose default carries the flag; a Gate G run must show four distinct IP buckets
   through a real tunnel.

---

## G3 (P1) — §10.1's always-on abuse controls do not exist

**Plan (§10.1):** "Always-on: per-connection token bucket by BYTES (~2 MB/min sustained,
5 MB burst), per-room aggregate budget (20 MB burst), global egress governor (hard token
bucket ~100 Mbps), per-IP churn throttle with temp-bans." Under pressure the relay "sheds
MESSAGES first… rejects NEW admissions; it disconnects sessions only on hygiene violations."

**Observed:** only the per-connection **inbound** bucket exists (`connection.py:71-88`). There
is no egress accounting of any kind, no per-room budget, no governor, no churn throttle, and
no shedding path. The only response to load is `enqueue()` → `QueueFull` → disconnect with
1008 (`registry.py:122-133`), which contradicts "disconnects only on hygiene violations".

**Impact:** a single room of 10 connections can push ~20 MB/s egress with no ceiling; the
amplification math in §10.1 is untested and unenforceable; Gate G cannot measure what the
config does not expose.

**Fix plan:**
1. Add named knobs to `RelayConfig`: `room_egress_burst` (20 MB), `egress_governor_bps`
   (~100 Mbps), `ip_churn_threshold`, `ip_churn_ban_seconds`, and a shed policy selector.
   Defaults are §10.1's numbers; all overridable by env for Gate G tuning.
2. Charge egress in the writer, where the serialized frame size is known — not at `enqueue()`
   (the relay's `send_json` does the encoding). Pass the byte count to a per-room bucket and
   the global governor. Keep the inbound bucket separate; the two must not be conflated.
3. Global pressure → drop the loudest room's frames first and reject new admissions; record a
   drop counter per reason for O2 metrics. Sessions survive shedding; hygiene violations
   (missed pongs, idle, budget breach, send timeout) remain the only disconnect reasons.
4. Per-IP churn: count refused handshakes per bucket and temp-ban via config; reuse the G1
   reservation bookkeeping so bans apply at the same pre-handshake gate.
5. `tests/test_load_controls.py` pins the four knobs (strict xfail). Behavior gets a Gate G
   load test with 10 connections in one room: egress stays under the governor, frames are
   shed without disconnects, and durable client catch-up recovers the shed ops.

---

## G4 (P1) — §15.18 O1–O4 ops are unbuilt, and errors vanish

**Plan:** O1 env + one read-only mounted `relay.toml`; O2 Prometheus text on `127.0.0.1`
only; O3 one `compose.yaml`; O4 JSON lines `{ts, level, event, connId?, roomHash?, bytes?,
error}`, rotation 100 MB × 5, 14-day retention, never payloads or keys.

**Observed:** no `relay.toml` loader (Python 3.11's `tomllib` is available and unused); no
metrics — `/healthz` is an admitted placeholder (`app.py:45-52`); logs use `logging.basicConfig`
with a plain-text format (`main.py:26-29`), no rotation; and `endpoint.py:201-204` swallows
**every** exception from the message loop with `except Exception: pass` and no log line. A
bug in routing is indistinguishable from a client disconnect.

**Impact:** no operator observability, no load numbers for Gate G, and failures are invisible.
This also blocks the startup diagnostic needed by G2.

**Fix plan:**
1. `compose.yaml` per G2; `relay.toml` loaded read-only at startup with env taking precedence.
   Defer `REVOKED_TOKENS_FILE`/SIGHUP reload to step 7's mailbox as the plan says.
2. Structured JSON formatter on the `owlshelf.relay` logger with the O4 field set; a
   `RotatingFileHandler` (100 MB × 5, 14 days) in addition to stdout. Never log `body`, keys,
   or payloads — `roomHash` is already public on the wire.
3. Replace the bare `except Exception: pass` with a structured `error` event carrying the
   exception type and connection id, then the same single cleanup path.
4. `/metrics` bound to `127.0.0.1` only: connections, rooms, bytes in/out, drops by reason,
   queue depths, heartbeat misses. `/healthz` stays for the healthcheck.
5. Gate G: verify rotation by forcing rollover, verify no payload/key appears in any log,
   scrape `/metrics` from loopback and confirm it is unreachable from the public hostname.

---

## G5 (P1) — `moved` redirect absent

**Plan (§15.4, §12.5):** `{type: "moved", to: relayUrl}` served only from operator config;
"a relay domain is never decommissioned abruptly — it ends its life answering 'I've moved.'"

**Observed:** no `moved` string anywhere in `backend/app/`.

**Fix plan:** add an operator-set `moved` map to `relay.toml` (never derived from a client
message — P0-8). In `websocket_endpoint`, after the origin check, if the requested target is
in the map: `accept()`, send one `{"type": "moved", "to": ...}` frame, close 1000, and leave the
registry untouched. Gate G test with a configured redirect; assert a client cannot inject one.

---

## G6 (P2) — byte-budget units contradict each other

§9 and `constants.py:69` say ~2 MB/**s** sustained with a ~5 MB burst; §10.1 says ~2 MB/**min**.
The code follows §9 and the token-bucket docs are written in seconds, so §10.1 is almost
certainly the typo. **Fix:** amend §10.1 to 2 MB/s, record the derivation in
`owlshelf-code-vs-plan.md` §7.6, and leave the constant alone. If the intent was genuinely
per-minute, change `byte_budget_sustained` and every budget test instead — do not leave both
sentences live.

## G7 (P2) — runtime dependency bloat and a false README claim

`requirements.txt` includes `pytest`, `pytest-asyncio`, `httpx`, `pyflakes`, `Pygments`,
`iniconfig`, `pluggy` in the **runtime** install, while `backend/README.md:36-37` claims the
runtime install "deliberately does not pull them in". `pydantic`, `pydantic-settings`,
`python-dotenv`, and `PyYAML` are present and unused by `backend/app/` (G4's TOML loader needs
no new dep — `tomllib` is stdlib on Python 3.11+). **Fix:** move test-only packages to
`requirements-dev.txt`, drop the unused ones, make the README match, then reinstall from
scratch and run `pytest` to prove the dev file alone is sufficient.

---

## Fix order and acceptance

1. **G1 + G2 first** — no relay enablement before both P0s are closed. Their xfail tests go
   green in the same commit as the fix; a fix that leaves an xfail marker behind fails CI
   (`strict=True` turns the now-passing test into XPASS).
2. **G3 + its Gate G load test** — no §11 number is a promise until the governor is measured.
3. **G4, G5, G6, G7** — ops, redirect, plan correction, dependency hygiene.
4. Sign-off: `pytest` green with zero xfails for G1–G3, `npm run harness` unaffected, and
   Gates C/D/G passed. Step 5's status in `owlshelf-code-vs-plan.md` §5.-1 changes only then.

## Why the tests are strict xfails

Plan §13 treats unexecuted spec as unverified, and `owlshelf-code-vs-plan.md` §0 says a gap
must not be closed by editing only the code or only the plan. A `strict=True` xfail keeps the
suite green today while naming the exact defect; when the fix lands the test passes, XPASS
fails the run, and the marker must be deleted in that same commit. The marker cannot rot into
a permanent excuse.
