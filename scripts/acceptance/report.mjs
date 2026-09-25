// Shared result/reporting utilities for the acceptance harness. Every
// acceptance surface returns exactly one Result; nothing here ever prints a
// secret value -- callers pass only human-readable reasons/evidence
// strings they have already scrubbed.

export const STATUSES = /** @type {const} */ ([
  "PASS",
  "FAIL",
  "BLOCKED",
  "NOT_RUN",
]);

/**
 * @typedef {"PASS"|"FAIL"|"BLOCKED"|"NOT_RUN"} Status
 * @typedef {{ surface: string, status: Status, reason: string, details?: string[] }} Result
 */

/** @param {string} surface @param {string} reason @param {string[]} [details] @returns {Result} */
export function pass(surface, reason, details) {
  return { surface, status: "PASS", reason, details };
}
/** @param {string} surface @param {string} reason @param {string[]} [details] @returns {Result} */
export function fail(surface, reason, details) {
  return { surface, status: "FAIL", reason, details };
}
/** @param {string} surface @param {string} reason @param {string[]} [details] @returns {Result} */
export function blocked(surface, reason, details) {
  return { surface, status: "BLOCKED", reason, details };
}
/** @param {string} surface @param {string} reason @param {string[]} [details] @returns {Result} */
export function notRun(surface, reason, details) {
  return { surface, status: "NOT_RUN", reason, details };
}

const ICON = {
  PASS: "[PASS]",
  FAIL: "[FAIL]",
  BLOCKED: "[BLOCKED]",
  NOT_RUN: "[NOT_RUN]",
};

/** @param {Result} r */
export function printResult(r) {
  console.log(`${ICON[r.status]} ${r.surface} -- ${r.reason}`);
  for (const d of r.details ?? []) console.log(`    ${d}`);
}

/** @param {Result[]} results @param {string} title */
export function printSummary(results, title) {
  console.log("");
  console.log(`===== ${title} =====`);
  const width = Math.max(...results.map((r) => r.surface.length), 8);
  for (const r of results) {
    console.log(`${r.surface.padEnd(width)}  ${ICON[r.status]}  ${r.reason}`);
  }
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of results) counts[r.status]++;
  console.log("");
  console.log(
    `${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.BLOCKED} BLOCKED, ${counts.NOT_RUN} NOT_RUN`,
  );
  console.log("");
  console.log(
    "This matrix is not production-readiness. PASS proves the surface it names, nothing broader.",
  );
}

// Exit-code policy: FAIL is the only status that should ever fail a CI-style
// invocation of this harness. BLOCKED/NOT_RUN are honest, expected states
// when infrastructure/credentials are absent -- never converted to FAIL.
/** @param {Result[]} results */
export function exitCodeFor(results) {
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}
