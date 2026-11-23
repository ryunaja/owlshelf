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

## How to read the output

```
hlc — persisted, validated, unmasked (§6.2)
  PASS  mint: a wall clock past ts takes the wall time and resets the counter
  ...
0 failed / 59 checks
```

Each line names the plan section or the audit finding it pins. A finding id in
a test name (`N5`, `R4-P0-2`, `review-2 P0-4`) means that defect is now a
permanent regression test: it was found by execution, so it can only be kept
fixed by execution.

## What each suite checks

| Suite | Plan | Covers |
|---|---|---|
| `hlc.test.mjs` | §6.2 | mint/receive, unmasked counter, `MAX_COUNTER` malformed on both sides, `MAX_SKEW` rejection, the exact boundary the pass-4 absorb broke |
| `payload.test.mjs` | §15.3 | per-table allowlist, absent-field defaults, reserved columns never payload-writable, 64 KB cap, resolve-without-content |
| `reduce.test.mjs` | §6.4 | total order, permutation convergence, tombstones, dedup-before-clock, quarantine slots, contiguous cursors, derived conflicts, the two index regressions |
| `cmd.test.mjs` | §6.3 | one transaction per command, `cmdId` idempotency, commit-gated ack, same-room and cross-room moves, colliding mint |

## Scope

The harness owns the logic and data layer. It **cannot** simulate real workers,
WebKit ITP, half-open sockets, leader election, or quota under browser
eviction — those stay with gates A–H in real browsers. Harness-first means
every gate test that CAN run here runs here first: fast, deterministic,
debuggable.

## Note on the seams

`CommandOptions` and `AdmitOptions` take `now` and `uuid` so a test can pin
time and identity. They are the only test seams in the shipped code, and both
default to the real `Date.now` / `crypto.randomUUID`.
