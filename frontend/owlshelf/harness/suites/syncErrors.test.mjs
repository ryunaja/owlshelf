/**
 * syncErrors.test.mjs — the sentences a user sees when sync stops (§6.6).
 *
 * The defect this suite exists for: sync failed SILENTLY. The engine retried
 * with backoff, the only place a close code appeared was the dev panel behind
 * `?sync=1`, and everyone else saw a shelf that stopped updating with no code
 * and no next step. These tests pin that every close path has words, that the
 * code survives into the text, and that "Try again" is offered only where it can
 * possibly help.
 */

import { CLOSE } from "../../src/lib/sync.ts";
import { CLOSE_REASON, describeClose, healthOf } from "../../src/lib/syncErrors.ts";
import { assert, assertEqual } from "../lib/assert.mjs";

export default {
  name: "syncErrors — every close has a sentence, and the code survives (§6.6)",
  tests: [
    {
      name: "the codes the relay actually sends are all named",
      async run() {
        const cases = [
          [1006, "network", "Can't reach the relay"],
          [1008, "policy", "Disconnected by the relay"],
          [1011, "network", "Relay error"],
          [CLOSE.TRY_LATER, "capacity", "Relay is full"],
          [CLOSE.ORIGIN_REFUSED, "config", "This address isn't allowed"],
          [CLOSE.HANDSHAKE_TIMEOUT, "config", "Relay didn't answer properly"],
          [CLOSE.ROOM_CAP, "capacity", "Shelf is full"],
          [CLOSE.GENERATION_MISMATCH, "rotation", "Shelf moved to a new key"],
        ];
        for (const [code, kind, title] of cases) {
          const trouble = describeClose(code);
          assertEqual(trouble.code, code, `code ${code} is kept`);
          assertEqual(trouble.kind, kind, `kind for ${code}`);
          assertEqual(trouble.title, title, `title for ${code}`);
          assert(trouble.detail.length > 20, `a real sentence for ${code}`);
        }
      },
    },
    {
      name: "retrying is offered only where it can help",
      async run() {
        // 4401 is a deployment mismatch and 4404 needs a new invite: a button
        // that cannot work teaches the user the app is broken.
        assertEqual(describeClose(CLOSE.ORIGIN_REFUSED).retryable, false, "4401");
        assertEqual(describeClose(CLOSE.GENERATION_MISMATCH).retryable, false, "4404");
        assertEqual(describeClose(CLOSE.ROOM_CAP).retryable, false, "4403");
        assertEqual(describeClose(1006).retryable, true, "1006");
        assertEqual(describeClose(CLOSE.TRY_LATER).retryable, true, "1013");
      },
    },
    {
      name: "the relay's own reason wins over the generic sentence",
      async run() {
        const budget = describeClose(1008, CLOSE_REASON.BYTE_BUDGET);
        assert(
          budget.detail.includes("budget"),
          `a byte-budget close explains the budget: ${budget.detail}`,
        );
        const policy = describeClose(1008);
        assert(
          !policy.detail.includes("budget"),
          "and the generic 1008 does not claim one",
        );

        const join = describeClose(1008, CLOSE_REASON.JOIN_REFUSED);
        assert(join.detail.includes("add this shelf"), "a refused join says so");
      },
    },
    {
      name: "an unknown code still reports the code rather than a shrug",
      async run() {
        const trouble = describeClose(4999);
        assertEqual(trouble.code, 4999, "the number is kept");
        assertEqual(trouble.kind, "network", "unknown closes as a network problem");
        assert(trouble.detail.length > 10, "with a sentence");
      },
    },
    {
      name: "health: a running, synced shelf with peers is ok",
      async run() {
        const health = healthOf("synced", null, ["c1", "c2"], true);
        assertEqual(health.tone, "ok", "tone");
        assert(health.label.includes("2 online"), `peers named: ${health.label}`);
        assertEqual(health.trouble, null, "no trouble");
      },
    },
    {
      name: "health: a failure keeps its code visible and names the trouble",
      async run() {
        const health = healthOf("offline", { code: 1006, reason: "" }, [], true);
        assertEqual(health.tone, "error", "tone");
        assertEqual(health.trouble?.code, 1006, "trouble carried");
        assert(health.label.includes("Can't reach"), `label: ${health.label}`);
        assert(health.detail.includes("1006"), `the code is in the detail: ${health.detail}`);
      },
    },
    {
      name: "health: a live session outranks a remembered failure",
      async run() {
        // The engine retries automatically. While it is connecting or syncing,
        // the badge must not keep shouting the previous error.
        const connecting = healthOf("connecting", { code: 1006, reason: "" }, [], true);
        assertEqual(connecting.tone, "busy", "connecting");
        assertEqual(connecting.label, "Connecting…", "label");
        const syncing = healthOf("syncing", { code: 1006, reason: "" }, [], true);
        assertEqual(syncing.tone, "busy", "syncing");
      },
    },
    {
      name: "health: a shelf with no engine says so instead of claiming offline-by-fault",
      async run() {
        const health = healthOf("offline", null, [], false);
        assertEqual(health.tone, "busy", "not an error yet");
        assertEqual(health.label, "Not connected yet", "label");
      },
    },
    {
      name: "health: attention is a warning, not a failure",
      async run() {
        const health = healthOf("attention", null, [], true);
        assertEqual(health.tone, "warn", "tone");
        assertEqual(health.trouble, null, "no code");
      },
    },
    {
      name: "health: a rotation is reported as such, never as a network problem",
      async run() {
        const health = healthOf("attention", { code: 4404, reason: "generation" }, [], true);
        assertEqual(health.tone, "warn", "a rotation is a prompt, not an outage");
        assertEqual(health.trouble?.kind, "rotation", "kind");
        assertEqual(health.trouble?.retryable, false, "retrying cannot fix it");
      },
    },
  ],
};
