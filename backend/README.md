# OwlShelf relay

A blind, room-bound fan-out. It cannot read envelopes (AEAD), cannot authorize
anything (the signed control plane lives with clients), and remembers nothing
but transient sockets and hashes. A restart loses all of it, and that is
correct — durability lives in client outboxes, so a restarted relay only delays
delivery; it cannot diverge state.

The contract is plan §9 (behavior), §10.1 (abuse controls), §15.4 (wire shapes)
and §15.18 (ops). This directory is the transcription of those sections, and the
tests are the transcription checked.

## Run

### Locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
ALLOWED_ORIGINS="http://localhost:5173" .venv/bin/python main.py
```

`ALLOWED_ORIGINS` is **required**. An empty allowlist refuses every connection
rather than allowing every connection: a config typo must not open the relay.

Probe it with `curl http://127.0.0.1:8000/healthz` → `{"ok":true,"rooms":0,"conns":0}`.
`/health` answers the same body as an alias; every other path is a 404,
including typos, so a monitor that guesses wrong fails loudly instead of
silently scraping something else. `/ws` is the only public route — see
`cloudflared-config.yml.example`.

### The deployment unit (§15.18/O3)

```bash
cp relay.example.toml relay.toml     # then edit allowed_origins
export TUNNEL_TOKEN="…"              # from the Cloudflare dashboard
export ALLOWED_ORIGINS="https://owlshelf.example"
docker compose up -d
```

`compose.yaml` **is** the unit list: two services in one network namespace.

| Unit | Bound | Limits |
| --- | --- | --- |
| `relay` | `127.0.0.1:8000`, no published port | 512 MB, 1.5 CPU |
| `cloudflared` | outbound only, shares the relay's namespace | 128 MB |

### Why the topology is not a detail

cloudflared shares the relay's network namespace, so **every peer address is
loopback**. That is why the relay is told `RELAY_TOPOLOGY=tunnel` in
`compose.yaml`: without it, every user would share the `127.0.0.1` bucket and
`CONNS_PER_IP=3` would cap the *whole relay* at three sockets, with a bare
`1013` as the only symptom. This was gap G2 in `RELAY-GAPS.md`.

| Where the peer address comes from | `RELAY_TOPOLOGY` |
| --- | --- |
| cloudflared / another sanitising proxy on loopback | `tunnel` (trusts `CF-Connecting-IP`) |
| the socket itself is the client | `direct` (ignores forwarded headers) |
| unset | trusts a **loopback** peer only — safe either way, warned about below |

The loopback test, not the flag, is the security boundary: a remote client
cannot present as `127.0.0.1`, so it can never choose its own bucket. The flag
matters for a *local* proxy that forwards an unsanitised `X-Forwarded-For`,
where the client's own value would be the first element.

A loopback bind with trust OFF logs a **warning** at boot naming the exact
consequence. That is the one combination that silently caps the relay.

## One socket, many rooms

A socket is a **device**, not a shelf. The first room arrives as the `hello`
exactly as §15.4 says; every further room joins that socket:

| Direction | Frame | Meaning |
| --- | --- | --- |
| → | `{v:1, type:"join", roomId, keyGen, hash}` | add a room to an admitted socket |
| → | `{v:1, type:"leave", hash}` | drop a room, keep the socket |
| ← | `{type:"joined", hash, keyGen}` | adopted; frames for that room may flow |
| ← | `{type:"join-refused", hash, code, reason}` | that ROOM is refused; the socket stays |
| ← | `{type:"presence", hash, members}` | presence names its room |

Why it exists: a per-room socket makes the connection count "rooms installed",
and `conns_per_ip` then has to guess at a number an IP cannot express — CGNAT
puts many households behind one public address. One socket per device is the
only count that is stable, and it is what the client does
(`socketHub.ts` in the frontend).

The three room checks a `join` passes are the same ones a `hello` passes
(generation, `room_cap`, duplicate connId), but a refusal closes **one room**,
not the socket: a rotated shelf must not disconnect the shelf next to it. A
frame is routed by the room it *names*, so a frame for a room the socket never
joined is dropped — never broadcast. Presence, fan-out and the egress budget are
all per room; the heartbeat is per connection, and answers once for all of them.

## Test

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```

`requirements.txt` is the **runtime** install and contains nothing test-only;
`requirements-dev.txt` builds on it and adds pytest, pytest-asyncio, httpx and
`watchfiles` (for `--reload`). `tests/test_dependencies.py` reads both files and
the AST of `app/`, and fails if a test package creeps back into the runtime file
or an import loses its pin. A cold `pip install -r requirements-dev.txt` in a
fresh venv is the acceptance step for the split, and it needs the network — so it
is not automated here.

Every test drives the shipped app through a real uvicorn server over real
WebSocket frames on an ephemeral port. A mocked socket would test the mock, and
the relay's contract is a wire contract.

| File | Covers |
| --- | --- |
| `test_protocol.py` | §15.4 shapes, exhaustively — no server |
| `test_admission.py` | The seven checks in order, each with its close code; the reservation ledger; concurrent handshakes; the churn ban |
| `test_routing.py` | Broadcast, targeted delivery, `to:` miss, `from` stamping |
| `test_presence.py` | The one frame the relay originates, and that it names its room |
| `test_multiplex.py` | Many rooms on one socket: `join`/`leave`, per-room refusal, routing by the frame's room, presence per room, teardown |
| `test_keepalive.py` | Heartbeat, half-open detection, idle |
| `test_reaping.py` | Empty rooms, and what a reaped room forgets |
| `test_backpressure.py` | Bounded queues, send deadlines, byte budget, per-recipient egress charging, shed-vs-disconnect |
| `test_load_controls.py` | §10.1's four controls: the knobs, the buckets, shedding, the governor's admission pressure, churn bans, the metrics text |
| `test_forwarded_ip.py` | The per-IP bucket in the tunnel topology, and the loopback boundary |
| `test_ops.py` | Config layering (O1), the topology guard, `moved` (G5), the shipped example, the compose unit |
| `test_logging.py` | O4's JSON shape, rotation numbers, and the promise that a payload cannot reach a log line |
| `test_dependencies.py` | The runtime/dev split (§7.7) |

## Diagnostics

The relay logs one JSON object per line on the `owlshelf.relay` logger
(`{ts, level, event, connId?, roomHash?, bytes?, error?}`), with `event` as a
slug and every detail a named field:

```json
{"ts":"2026-11-24T14:33:07.412Z","level":"info","event":"admitted","connId":"3f1c…","roomHash":"f58aca09…","keyGen":1,"ip":"127.0.0.1"}
{"ts":"2026-11-24T14:33:07.418Z","level":"info","event":"refused","code":4401,"reason":"origin"}
{"ts":"2026-11-24T14:33:09.002Z","level":"info","event":"closed","connId":"3f1c…","roomHash":"f58aca09…"}
```

`LOG_FORMAT=text` gives the same fields for a human. `LOG_FILE` adds a rotating
handler (100 MB × 5); the 14-day retention in O4 is a property of the log
*volume* (logrotate/journald), not something a size-rotating handler can express.

**No payload and no key can appear**, in two layers: the relay has no plaintext
body to log, and the formatter emits an allowlist of keys — a future
`extra={"body": …}` is not printed. `test_logging.py` asserts both.

Startup logs the allowlist it will enforce (or `(none — EVERY connection will be
refused with 4401)`), the resolved config sources, and the topology note.

**uvicorn's `WebSocket /ws [accepted]` line is not evidence of success.** It
fires when the HTTP upgrade completes, which is *before* any admission check
runs — a connection refused a millisecond later still prints `[accepted]`. Read
`admitted` / `refused` instead. A client that shows `offline` while the console
shows `[accepted]` was refused, and the `refused` line names the code.

## Metrics (§15.18/O2)

`GET /metrics` on the relay's own port, Prometheus text format:
`owlshelf_relay_connections`, `_pending`, `_rooms`, `_queue_depth`,
`_heartbeat_misses`, `_shed_frames`, `_shed_bytes`, `_banned_ips`, and
`owlshelf_relay_dropped{reason="…"}`.

Loopback only, three times over — and the middle one is the one that matters,
because `cloudflared` shares the relay's network namespace, so a request from
the **internet** arrives with a loopback peer:

1. uvicorn binds `127.0.0.1`: no public listener.
2. The route refuses any request carrying `CF-Connecting-IP` / `CF-Ray` — those
   are stamped by Cloudflare on what it proxies, and a host-side scraper sends
   neither. Without this, a hostname whose ingress forwarded *every* path would
   serve `/metrics` to the public.
3. `cloudflared-config.yml.example` forwards only `path: /ws`; everything else
   404s inside cloudflared.

Nothing in it carries a room hash, an IP, or a connId.

## Knobs

All in `app/relay/constants.py`, all overridable by env var (one `KNOBS` table
binds each field to its env name and parser), all named because Gate G tunes
them. Defaults are §9/§10.1's values; `relay.example.toml` is the annotated list
and a test asserts it matches the defaults, so the file cannot drift.

Config layers: **defaults < `relay.toml` (read-only mount) < env**. An unknown key
in the file fails the boot — a silently ignored typo is a relay that behaves
nothing like the file says.

## What this deliberately does not do

- **No crypto.** There is no `cryptography` dependency and there must not be.
  The relay never decrypts, never verifies a signature, never authorizes.
- **No database.** `DATABASE_URL` is gone. Nothing persists.
- **No `SECRET_KEY`.** There is no server-side auth to key.
- **No `/items`, no `/users`.** The relay holds no user data; a CRUD endpoint
  here would be the store-and-forward path the architecture rejects.

## Not yet built

- The paid mailbox, license tokens, `REVOKED_TOKENS_FILE` + SIGHUP reload
  (§15.18) — step 7, deliberately absent so the relay does not imply it
  authorizes anything.
- **Measured** capacity numbers. §11's model is still a model; Gate G replaces it
  with `/metrics` scraped under load (10 connections in one room, egress under
  the governor, shed frames recovered by durable catch-up).

## Gate G status

`RELAY-GAPS.md` is the original ledger and fix plan. All seven gaps (G1–G7) are
closed and every pinning test is a normal test — the suite has **zero xfails**.
What remains is measurement, not code:

- four distinct IP buckets through a **real** Cloudflare tunnel (asserted against
  a loopback proxy in tests);
- the 10-connection single-room load test;
- a reconnect storm against the reservation ledger.

Until those run, §11's capacity numbers and Gate G itself are unproven, and
`owlshelf-code-vs-plan.md` §5.-1 keeps step 5 at "Gate G not passed".

`owlshelf-gate-backlog.md` is the full register: every gate clause that no local
run can close, with the environment it needs, the procedure, and the pass
criteria. The three items above are `RW-G5`–`RW-G7` there, `RW-G8` is the
capacity measurement they feed, and the browser half of Gate G is `RW-G1`–`RW-G4`.
