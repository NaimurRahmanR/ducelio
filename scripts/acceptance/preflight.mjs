#!/usr/bin/env node
// npm run acceptance:preflight
//
// Reports, for every acceptance-relevant environment variable, exactly one
// of configured / missing / malformed -- never a value. This is read-only:
// it makes no network call and touches no database. Run this first, always,
// before `npm run acceptance:hosted` or `npm run acceptance:concurrency`.
import { preflightReport, stripeLooksLive } from "./env.mjs";

const report = preflightReport();
const width = Math.max(...report.map((r) => r.name.length), 8);

console.log("===== Commercial V1 acceptance preflight =====");
console.log("(configured/missing/malformed only -- no value is ever printed)");
console.log("");

for (const scope of ["app", "acceptance"]) {
  console.log(
    scope === "app"
      ? "-- Application-runtime variables --"
      : "-- Acceptance-tooling-only variables (never used by src/**) --",
  );
  for (const r of report.filter((x) => x.scope === scope)) {
    console.log(`${r.name.padEnd(width)}  ${r.status.toUpperCase()}`);
  }
  console.log("");
}

if (stripeLooksLive()) {
  console.log(
    "WARNING: STRIPE_SECRET_KEY is shaped like a LIVE-mode key (sk_live_...). " +
      "Stripe acceptance will refuse to run against it (see docs/38 and " +
      "scripts/acceptance/surfaces.mjs) unless a separate, explicit later " +
      "production acceptance phase authorizes it.",
  );
  console.log("");
}

const malformed = report.filter((r) => r.status === "malformed");
const configuredCount = report.filter((r) => r.status === "configured").length;
const missingCount = report.filter((r) => r.status === "missing").length;

console.log(
  `${configuredCount} configured, ${missingCount} missing, ${malformed.length} malformed.`,
);
if (malformed.length) {
  console.log("");
  console.log(
    "MALFORMED variables must be fixed before hosted acceptance can trust them:",
  );
  for (const r of malformed) console.log(`  - ${r.name}`);
}
console.log("");
console.log(
  missingCount === report.length
    ? "No hosted/acceptance credentials are configured in this environment. " +
        "Run `npm run acceptance:hosted` anyway -- every surface will report " +
        "BLOCKED with its exact missing prerequisite, never a false PASS."
    : "Some acceptance surfaces may now be runnable. Run `npm run acceptance:hosted`.",
);

// Preflight itself only ever fails (non-zero exit) on a MALFORMED value --
// a value that is present but cannot be trusted is worth failing a CI step
// on; a merely-absent value is an expected, honest BLOCKED state for every
// surface that needs it, not a preflight failure.
process.exit(malformed.length ? 1 : 0);
