/**
 * run.mjs — the execution harness (plan §13).
 *
 *   npm run harness
 *   npm run harness -- --suite syncRuntime
 *   npm run harness -- --grep "resume" --repeat 20
 *
 * Every suite runs the SHIPPED modules against real Dexie on fake-indexeddb,
 * with injectable clock and randomness seams so HLC and ordering tests are
 * deterministic. Exit code 1 on any failure, so CI can gate on it.
 *
 * `--repeat` exists for flakiness hunting. Caching a previous run's output
 * cannot find a nondeterministic failure — only executing the suspect checks
 * again can. Filter first, then repeat: the full suite is ~20 s, one suite is
 * well under a second, so `--suite x --repeat 50` is cheaper than three full
 * runs and actually answers the question.
 */

import { suites } from "./suites/index.mjs";

const args = process.argv.slice(2);

/** `--name value`, or null when the flag is absent. */
function flag(name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  return args[index + 1] ?? "";
}

const suiteFilter = flag("suite")?.toLowerCase() ?? null;
const grepFilter = flag("grep")?.toLowerCase() ?? null;
const repeat = Math.max(1, Math.floor(Number(flag("repeat") ?? 1)) || 1);

const selected = suites
  .filter((suite) => suiteFilter === null || suite.name.toLowerCase().includes(suiteFilter))
  .map((suite) => ({
    ...suite,
    tests: suite.tests.filter(
      (test) => grepFilter === null || test.name.toLowerCase().includes(grepFilter),
    ),
  }))
  .filter((suite) => suite.tests.length > 0);

/**
 * Rejections that escaped the test that caused them.
 *
 * A leaked rejection is a real defect — an engine still running against a
 * deleted database, a promise nobody awaited — and Node's default is to
 * TERMINATE the process on the first one, which discards every result collected
 * so far (that is how one lost socket reported nothing at all). They are
 * recorded against the suite/test that was running and reported as failures, so
 * the run finishes and the culprit is named.
 */
const leaks = [];
let currentCheck = "(suite setup)";
process.on("unhandledRejection", (reason) => {
  leaks.push({ where: currentCheck, reason });
});

/** One pass over the selection. `verbose` prints PASS lines too. */
async function runOnce(verbose) {
  let passed = 0;
  let failed = 0;
  const failures = [];
  const leaksBefore = leaks.length;

  for (const suite of selected) {
    if (verbose) console.log(`\n${suite.name}`);

    // A suite may own a resource that is too expensive to rebuild per test —
    // the integration suite spawns the real relay. `after` runs even when a
    // test throws, so a failure cannot leak a child process.
    //
    // Setup and teardown are caught SEPARATELY, and teardown runs even when
    // setup threw. A rejection escaping here used to escape the top-level await
    // as well: Node printed ERR_UNHANDLED_REJECTION and exited, discarding
    // every result collected so far. One lost socket reported nothing at all.
    let setupError = null;
    try {
      await suite.before?.();
    } catch (error) {
      setupError = error;
    }

    if (setupError === null) {
      for (const test of suite.tests) {
        currentCheck = `${suite.name} → ${test.name}`;
        try {
          await test.run();
          passed += 1;
          if (verbose) console.log(`  PASS  ${test.name}`);
        } catch (error) {
          failed += 1;
          failures.push({ suite: suite.name, test: test.name, error });
          console.log(`  FAIL  ${test.name}`);
          console.log(`        ${error?.message ?? String(error)}`);
        } finally {
          currentCheck = suite.name;
        }
      }
    } else {
      failed += 1;
      failures.push({ suite: suite.name, test: "(suite setup)", error: setupError });
      console.log(`  FAIL  ${suite.name} — suite setup threw`);
      console.log(`        ${setupError?.message ?? String(setupError)}`);
    }

    try {
      await suite.after?.();
    } catch (error) {
      failed += 1;
      failures.push({ suite: suite.name, test: "(suite teardown)", error });
      console.log(`  FAIL  ${suite.name} — suite teardown threw`);
      console.log(`        ${error?.message ?? String(error)}`);
    }
  }

  // A leak is attributed to the check that was running when it was recorded.
  // Counting it as a failure is deliberate: an escaping rejection is a defect
  // (an engine against a deleted database, a promise nobody awaited), and
  // reporting it as noise is how it survives a refactor.
  for (const leak of leaks.slice(leaksBefore)) {
    failed += 1;
    const reason = leak.reason;
    failures.push({ suite: leak.where, test: "(unhandled rejection)", error: reason });
    console.log(`  FAIL  unhandled rejection — ${leak.where}`);
    console.log(`        ${reason?.message ?? String(reason)}`);
  }

  return { passed, failed, failures };
}

if (selected.length === 0) {
  console.error("No suite or test matched. Check --suite / --grep.");
  process.exitCode = 1;
} else if (repeat === 1) {
  const { passed, failed, failures } = await runOnce(true);
  console.log(`\n${failed} failed / ${passed + failed} checks`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const failure of failures) {
      console.log(`  ${failure.suite} → ${failure.test}`);
    }
  }
  process.exitCode = failed > 0 ? 1 : 0;
} else {
  const total = selected.reduce((sum, suite) => sum + suite.tests.length, 0);
  console.log(`${total} checks × ${repeat} runs`);

  let badRuns = 0;
  const seen = new Map();
  for (let run = 1; run <= repeat; run += 1) {
    const { passed, failed, failures } = await runOnce(false);
    if (failed > 0) {
      badRuns += 1;
      for (const failure of failures) {
        const key = `${failure.suite} → ${failure.test}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    console.log(`run ${run}/${repeat}: ${failed} failed / ${passed + failed} checks`);
  }

  console.log(`\n${badRuns} of ${repeat} runs had failures`);
  for (const [key, count] of seen) {
    console.log(`  ${key} — failed ${count}/${repeat}`);
  }
  process.exitCode = badRuns > 0 ? 1 : 0;
}
