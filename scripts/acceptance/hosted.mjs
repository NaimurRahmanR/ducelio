#!/usr/bin/env node
// npm run acceptance:hosted
//
// Runs every Checkpoint D acceptance surface except POSTGRES_CONCURRENCY
// (its own dedicated command, `npm run acceptance:concurrency`, since it is
// substantially heavier and needs multiple independent connections). Every
// surface classifies itself PASS/FAIL/BLOCKED/NOT_RUN; a missing credential
// is always BLOCKED, never a false PASS. Never prints a secret value.
import { printResult, printSummary, exitCodeFor, blocked } from "./report.mjs";
import { acceptanceDbConfigured } from "./db.mjs";
import * as surfaces from "./surfaces.mjs";

const liveProviderAuthorized = process.argv.includes(
  "--authorize-live-provider",
);

console.log("===== Commercial V1 hosted acceptance =====");
console.log(
  "Run `npm run acceptance:preflight` first if you have not already -- this " +
    "command does not repeat that report.",
);
console.log("");

const results = [];
async function run(fn, ...args) {
  const r = await fn(...args);
  results.push(r);
  printResult(r);
  return r;
}

await run(surfaces.checkHostedDatabase);
await run(surfaces.checkMigrations);
await run(surfaces.checkRlsAcl);
await run(surfaces.checkJwtPostgrest);
results.push(
  acceptanceDbConfigured()
    ? blocked(
        "POSTGRES_CONCURRENCY",
        "Run separately: `npm run acceptance:concurrency` (heavier, uses multiple independent connections).",
      )
    : blocked(
        "POSTGRES_CONCURRENCY",
        "ACCEPTANCE_DATABASE_URL is not configured.",
      ),
);
printResult(results[results.length - 1]);
await run(surfaces.checkGrading);
await run(surfaces.checkInitialRecovery);
await run(surfaces.checkRegrade);
await run(surfaces.checkResultProgressCompletion);
await run(surfaces.checkStripeTestMode);
await run(surfaces.checkSupabaseAuthEmail);
await run(surfaces.checkLiveProvider, {
  operatorAuthorized: liveProviderAuthorized,
});
await run(surfaces.checkMonitoring);
await run(surfaces.checkBackupRestore);
await run(surfaces.checkFullCustomerJourney, results);

printSummary(results, "Commercial V1 hosted acceptance matrix");
process.exit(exitCodeFor(results));
