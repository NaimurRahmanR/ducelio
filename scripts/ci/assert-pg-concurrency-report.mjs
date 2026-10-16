import { readFileSync } from "node:fs";

// Fails the dedicated PostgreSQL CI job unless the real-PostgreSQL
// concurrency suites ACTUALLY ran: every required file executed, no test was
// skipped or pending, nothing failed, and at least the expected number of
// tests passed. A skipped suite must never look like a green concurrency run.
const [reportPath, minimumText, ...requiredFiles] = process.argv.slice(2);
const minimum = Number(minimumText);
if (!reportPath || !Number.isInteger(minimum) || requiredFiles.length === 0) {
  console.error(
    "usage: assert-pg-concurrency-report.mjs <vitest-json> <min-passed> <file>...",
  );
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const problems = [];
const executed = new Map();
for (const file of report.testResults ?? []) {
  const name = file.name.replace(/\\/g, "/");
  const counts = { passed: 0, other: 0 };
  for (const test of file.assertionResults ?? [])
    if (test.status === "passed") counts.passed += 1;
    else counts.other += 1;
  executed.set(name, counts);
  if (file.status !== "passed")
    problems.push(`${name}: file status ${file.status}`);
}
for (const required of requiredFiles) {
  const match = [...executed.entries()].find(([name]) =>
    name.endsWith(required),
  );
  if (!match) problems.push(`${required}: did not run`);
  else if (match[1].passed === 0) problems.push(`${required}: no test passed`);
  else if (match[1].other > 0)
    problems.push(`${required}: ${match[1].other} test(s) not passed`);
}
if ((report.numPendingTests ?? 0) > 0 || (report.numTodoTests ?? 0) > 0)
  problems.push(
    `${report.numPendingTests} skipped/pending, ${report.numTodoTests} todo`,
  );
if ((report.numFailedTests ?? 0) > 0)
  problems.push(`${report.numFailedTests} failed`);
if ((report.numPassedTests ?? 0) < minimum)
  problems.push(`only ${report.numPassedTests} passed (minimum ${minimum})`);

if (problems.length) {
  console.error("PostgreSQL concurrency verification FAILED:");
  for (const problem of problems) console.error(" - " + problem);
  process.exit(1);
}
console.log(
  `PostgreSQL concurrency verification passed: ${report.numPassedTests} tests across ${requiredFiles.length} required suites, none skipped.`,
);
