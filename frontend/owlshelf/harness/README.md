# Execution harness (plan §13)

The plan's rule is blunt: **a spec behavior that has not EXECUTED against real
Dexie is unverified.** Reading the spec, and even reading the implementation,
is never sufficient evidence of correctness — audit-2 found defects that two
reading passes could not see, and audit-4 found that one of audit-2's own fixes
was itself defective.

So this directory runs the **shipped modules** — `src/lib/hlc.ts`,
`payload.ts`, `reduce.ts`, `cmd.ts`, `visible.ts`, and the `OwlshelfDB` class
from `db.ts` — against real Dexie 4.4.7 on `fake-indexeddb`, with injectable
clock and randomness seams so HLC and ordering tests are deterministic.

Nothing about the schema is restated here. `harness/lib/db.mjs` constructs the
shipped `OwlshelfDB` class, so the harness opens the same `stores.ts`
declaration and the same v1→v2 upgrade transaction the app does (audit-4 D5).

## Run

```sh
npm run harness
```

Exit code is 1 on any failure, so CI can gate on it. Node is pinned by
`engines` + `.nvmrc` (26.3.1 — the version the audit executed on); Dexie and
fake-indexeddb are pinned to exact versions, because a harness on drifted
dependencies tests a different library than the one the plan was verified
against.

### Filtering and repeating

```sh
npm run harness -- --suite syncRuntime          # one suite (substring, case-insensitive)
npm run harness -- --grep "resume"              # tests whose name matches
npm run harness -- --grep "resume" --repeat 30  # flakiness hunt
```

`--repeat` is for nondeterministic failures. Caching a previous run's output
cannot find one — only executing the suspect checks again can. Filter first,
then repeat: the full suite is ~20 s, one suite is well under a second, so
`--suite x --repeat 50` costs less than three full runs and actually answers
the question. With `--repeat`, PASS lines are suppressed and only failures
print, followed by a per-test tally (`failed 3/30`).

## How to read the output

```
hlc — persisted, validated, unmasked (§6.2)
  PASS  mint: a wall clock past ts takes the wall time and resets the counter
  ...
0 failed / 449 checks
```

Each line names the plan section or the audit finding it pins. A finding id in
a test name (`N5`, `R4-P0-2`, `review-2 P0-4`) means that defect is now a
permanent regression test: it was found by execution, so it can only be kept
fixed by execution.

**A leaked rejection is a failure, not noise.** `run.mjs` installs an
`unhandledRejection` handler and attributes each escape to the check that was
running, then prints `FAIL unhandled rejection — <suite> → <test>`. Node's
default is to terminate on the first one, which discards every result collected
so far (that is how one lost socket once reported nothing at all). A leak is a
real defect — an engine still dialling a deleted database, a promise nobody
awaited — so it goes in the pass/fail count; fix the code, do not silence the
handler. `src/lib/sync.ts`'s `background()` exists for exactly this: `resume()`
and the retry timer must not float a `connect()` whose `readRoom` can throw
`DatabaseClosedError`.

## What each suite checks

| Suite | Plan | Covers |
|---|---|---|
| `hlc.test.mjs` | §6.2 | mint/receive, unmasked counter, `MAX_COUNTER` malformed on both sides, `MAX_SKEW` rejection, the exact boundary the pass-4 absorb broke |
| `payload.test.mjs` | §15.3 | per-table allowlist, absent-field defaults, reserved columns never payload-writable, 64 KB cap, resolve-without-content |
| `media.test.mjs` | §8.1 | the `imageUrl` render allowlist — `idb:`, `data:`, `https:` and nothing else |
| `capture.test.mjs` | §8.1 | 4 MB raw / 1 MB compressed / 1024 px, and the downscale that enforces them |
| `mediaUrl.test.mjs` | §8.1 | the `idb://` resolver: room-scoped, ref-counted, revoked on release, and a cached `missing` re-resolved after `invalidateMedia` |
| `blobDemand.test.mjs` | §6.6, §8.1 | the pull side of media sync: a demand reaches the fetcher, the cooldown is per `(roomId, hash)`, an arrival clears it, and a stale unsubscribe cannot disarm a newer fetcher |
| `canonical.test.mjs` | §15.1 | `u8`/`u32be`/`u64be`/`lp`/`concat`, `canonicalJson` key order, `associatedData`, `endDigest`, `auditDigest` |
| `envelope.test.mjs` | §6.6 | AES-256-GCM seal/open, the three gates (socket room, `matchesRoom`, AEAD tag), nonce freshness, AD binding |
| `reduce.test.mjs` | §6.4 | total order, permutation convergence, tombstones, dedup-before-clock, quarantine slots, contiguous cursors, derived conflicts, the two index regressions |
| `cmd.test.mjs` | §6.3 | one transaction per command, `cmdId` idempotency, commit-gated ack, same-room and cross-room moves, partial moves splitting the row, the blob copied room-scoped, a bulk move reporting per item, colliding mint |
| `live.test.mjs` | §6.5 | a remote op repaints a live query with no command and no refetch |
| `outbox.test.mjs` | §6.6 | derived acks over the REACHABLE set, `ACK_GRACE`, monotonic peer cursors, `drainPlan` ordering, the not-yet-sent gate (an entry with `attempts === 0` is never acked — without it the first drain tick acked every fresh mint and the owner never announced anything), and that contact records cursors WITHOUT extending the roster (§6.7 deleted the stopgap that used to) |
| `gc.test.mjs` | §15.5, §6.6 | the cheap half of storage GC: a command records its `createdAt`, a fresh receipt survives while an expired one is collected, a pre-TTL receipt with no `createdAt` is collected rather than kept forever, no non-`cmd:` meta row is ever touched, a retry inside the TTL still returns the ORIGINAL ack, acked outbox entries age out while `pending` and `dead` never do, another room's entries are untouched, the `cmd:` scan is floored and the floor row is written only after a successful scan, `start()` prunes AFTER the dial, and a throwing prune does not stop the engine connecting |
| `catchup.test.mjs` | §6.6 | request fan-out, responder election and the suppression ladder, byte-bounded chunks, end-marker digest and cursors, `SETTLE` |
| `audit.test.mjs` | §6.6 | digest inputs (tombstones, log shape, room scoping), the three-rung repair ladder |
| `blob.test.mjs` | §6.6, §15.4 | the derived chunk budget (sealed frame measured against the relay cap), serve/negative, continuity, size and count caps, hash-before-write |
| `sync.test.mjs` | §6.6, §7.1, §9 | close-code table, jittered capped backoff, hello shape, presence fan-out, ping/pong, frame gates, all three adoption proofs, suppression timers, session lifecycle, replay, blob fan-out and verification, the `defaultRelayUrl` fallback, and single-flight dialling (a resume during a pending retry opens one socket, a stop during an in-flight dial opens none) |
| `syncErrors.test.mjs` | §6.6 | **every close has a sentence**: the codes the relay sends (1006/1008/1011/1013/4401/4402/4403/4404) each map to a kind, a title and a real detail that keeps the number; retry is offered only where it can help (never for 4401/4403/4404); the relay's own reason (byte-budget, join-refused, …) wins over the generic sentence; an unknown code still reports its number; and `healthOf` for a synced shelf with peers, a failure with its code visible, a live session outranking a remembered failure, a shelf with no engine saying "Not connected yet", `attention`, and a rotation reported as a prompt rather than an outage |
| `syncHealth.test.mjs` | §6.6 | **the badge store**: an unknown room reports "Not connected yet" with a STABLE reference (or React re-renders forever); `refresh` seeds a cold tab from `room-info`; a `sync-status` event updates the snapshot and notifies once, carrying the close code; a `synced` session clears the remembered failure; an event for another room does not touch this one; `retry` calls `syncRetry` then re-reads; a failing `refresh` keeps the last known state instead of inventing an error |
| `socketHub.test.mjs` | §9 amendment | **one socket per device, not one per room**: two rooms on one relay share ONE wire and the second joins it; a room whose hello arrives while the wire is dialling joins after the hello (never before); a non-primary room holds its frames until the relay says `joined`; inbound frames reach only the room they name; the relay heartbeat is answered once per wire; a refused join closes THAT room and leaves the others; a wire death fans out to every room; closing one room sends `leave` and keeps the wire, the last room closes it; different relay URLs get different wires; a rotation reconnects one room without a second wire; `stop` closes everything |
| `syncRuntime.test.mjs` | §7.1, §5.5 | the app's boot path, driven through a REAL `createWorkerHost` over `localTransport`: one engine per room, a room with no `relayUrl` still reaching the relay, a room's own URL winning, a profile created after boot connecting without a reload, `start` being idempotent, StrictMode's start → stop → start leaving one engine, `stop` closing every socket and removing every listener, the visibility/online/pageshow resume events, **two tabs sharing ONE socket per room**, a tab that stops not stopping an engine another tab still wants, every port hidden suspending while any visible resumes, and the media demand path end to end (demand → `blob-request` → verified `file-chunk` → `blob-arrived` → media invalidation) |
| `syncStore.test.mjs` | §13 | the dev panel as a VIEW over the worker: relay URL persisted before the engine dials (it reads the URL from the DB), `connect` asking the worker for the room, selecting another room opening no second socket, `disconnect` suspending rather than tearing down (the engine is shared), an operation on a room with no engine surfacing an error, outbox bucketing, a `getSnapshot` that is referentially stable across idle polls, and a live emission not overwriting the relay URL being typed |
| `roomShare.test.mjs` | §13 | the dev-only room hand-off, now a lib module because `importRoom` writes: export carries the key, generation, relay and roster; every malformed payload is refused without writing; import writes a fresh `authorSeq` and empty cursors; the joiner lands on the roster as a member; a populated room is refused; and the refusal is ROOM-scoped rather than device-scoped (audit-2 N10). **Superseded by the real pairing UI** (`pairing.test.mjs`, `ShareRoomDialog`), kept because the harness's two-device setups and the `?sync=1` panel still use it. It is no longer the pairing story (§5.6) |
| `rooms.test.mjs` | §6.7, Gate D | **pairing, the signed roster, and revocation**: the device keypair is minted once and reused per database, a signing round-trip verifies and nothing malformed throws, the control signature input ignores member order but covers epoch/room/signer/content, an owner-signed epoch verifies against the pinned key while a forged one changes nothing, an epoch that renames the owner, lists two owners, or replays/rolls back is refused, an epoch is adopted across a gap, `assertConsistent` catches a roster that is not the chain head, the QR fragment round-trips and carries the CURRENT `keyGen`, the minter refuses an unpaired room and the parser names all 10 refusal reasons, `readControlOp` admits exactly three kinds, a forged control op leaves no materialized change, a cross-room op is refused, minting requires the owner AND the pinned key, `rotate-key` records the generation but never the key and blocks minting, `rehome` stages until confirmed, `createRoom` persists a complete pairable room in one transaction, `joinRoom` does NOT roster itself and refuses a data-carrying re-join ROOM-scoped, the owner admits a peer by signature, revocation rotates the key and notifies the old room, and leaving purges the exact §15.17 set while keeping its signed statement |
| `liveQuery.test.mjs` | §6.5 | the invariant that broke the profile page: a querier that opens a read-write transaction is rejected by Dexie, a pure-read querier emits, and opening before subscribing keeps the querier pure |
| `twoDevice.test.mjs` | §6.6, Gate C | **two real engines over an in-memory relay** (`lib/relay.mjs`): a fresh device converges with no manual catch-up, a live op reaches the peer, catch-up repairs a dropped broadcast, both directions converge, a device advertises its CURRENT cursors rather than the ones it had at connect, and the OWNER announces ops even when its roster never learned about the joiner |
| `worker.test.mjs` | §5, §6.6 | the single-writer split: a `cmd` round-trips through a fake port, a `CommandError` keeps its code across the wire, an unknown request kind is rejected rather than ignored, `move-many` reports per item, `create-profile` writes the room and the profile together, `visibility` is accepted while `blob-demand` needs a live engine, `room-add`/`room-remove` open and close an engine (and a room that is not in the database is refused), `dev-state` reports the engine's live state and the deviceId, two concurrent commands correlate by `id`, and all three ladder rungs — SharedWorker, Web Locks leader/follower over a real `BroadcastChannel`, and tab mode with the single-tab warning. Also the handoff: a follower is promoted when the leader tab goes away, a command stranded on the dead leader's channel still commits exactly once, and a promoted tab re-announces its rooms while events reach followers |
| `pairing.test.mjs` | §6.7, step 6 UI | **the six pairing commands the screens post**, through `createWorkerHost`: an invite carries the stored room's `keyGen`, key, owner and anchor; minting refuses an unknown room; joining writes room + profile and does NOT roster the joiner; a data-carrying join is refused `room-exists`; a malformed invite is refused with one of the closed-set reasons; re-pair refuses a stale code, a different owner, a forged anchor and an unknown room; a rotation code clears `rotationPending` and adopts the owner's NEW key; removal is owner-only, never the owner, and leaves the 30-day notice row; a rotation re-dials the owner's engine (asserted by counting sockets); leaving purges the room and keeps the signed statement; the owner cannot leave; `room-info` reports role/generation/rotation/op count; and a staged relay move is accepted or dismissed |
| `integration.test.mjs` | §5.3, Gate G | **the real client against the real relay**: `backend/main.py` runs as a child process on a free port, and the shipped `SyncEngine` dials it over `ws` with a real `Origin` header. An allowed Origin is admitted, a disallowed one is refused 4401, two real engines converge, a late device pulls history with no manual catch-up, the relay stamps `from`, and the outbox waits for a reachable peer then clears when it adopts |

## Scope

The harness owns the logic and data layer. It **cannot** simulate real workers,
WebKit ITP, half-open sockets, leader election, or quota under browser
eviction — those stay with gates A–H in real browsers. Harness-first means
every gate test that CAN run here runs here first: fast, deterministic,
debuggable.

The deferred half has its own register: `owlshelf-gate-backlog.md` at the repo
root lists every clause no local run can decide (`RW-*`), with the environment,
the procedure, and pass criteria. If a row there is open, the gate is not passed
— a green run here is not evidence about it.

## Note on the seams

`CommandOptions` and `AdmitOptions` take `now` and `uuid` so a test can pin
time and identity. They are the only test seams in the shipped code, and both
default to the real `Date.now` / `crypto.randomUUID`.
