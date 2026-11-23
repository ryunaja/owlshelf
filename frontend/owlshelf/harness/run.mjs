/**
 * run.mjs — the execution harness (plan §13).
 *
 *   npm run harness
 *
 * Every suite runs the SHIPPED modules against real Dexie on fake-indexeddb,
 * with injectable clock and randomness seams so HLC and ordering tests are
 * deterministic. Exit code 1 on any failure, so CI can gate on it.
 */

import { suites } from "./suites/index.mjs";

let passed = 0;
let failed = 0;
const failures = [];

for (const suite of suites) {
  console.log(`\n${suite.name}`);
  for (const test of suite.tests) {
    try {
      await test.run();
      passed += 1;
      console.log(`  PASS  ${test.name}`);
    } catch (error) {
      failed += 1;
      failures.push({ suite: suite.name, test: test.name, error });
      console.log(`  FAIL  ${test.name}`);
      console.log(`        ${error?.message ?? String(error)}`);
    }
  }
}

console.log(`\n${failed} failed / ${passed + failed} checks`);

if (failed > 0) {
  console.log("\nFailures:");
  for (const failure of failures) {
    console.log(`  ${failure.suite} → ${failure.test}`);
  }
}

process.exitCode = failed > 0 ? 1 : 0;
