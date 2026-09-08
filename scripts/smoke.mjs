import assert from "node:assert/strict";
// Use a credential-free running server. Protected requests deliberately send no cookies.
const base = process.env.SMOKE_URL || "http://127.0.0.1:3000";
const demo = [
  "",
  "programme",
  "calendar",
  "classes",
  "assignments",
  "assessments",
  "notes",
  "results",
  "support",
  "profile",
  "study-plan",
  "announcements",
  "lecture",
  "admin",
  "counsellor",
];
const sections = [
  "programmes",
  "students",
  "cohorts",
  "counsellors",
  "sessions",
  "assignments",
  "assessments",
  "announcements",
  "registry",
  "audit",
];
let count = 0;
for (const path of [
  "/login",
  "/signup",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  ...demo.map((s) => "/demo" + (s ? "/" + s : "")),
  ...sections.map((s) => "/demo/admin?section=" + s),
]) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, path);
  const html = await response.text();
  assert.ok(html.includes('id="main"'), path + " main landmark");
  assert.ok(
    !html.includes("We couldn’t open this page"),
    path + " error boundary",
  );
  assert.equal(
    response.headers.get("x-content-type-options"),
    "nosniff",
    path + " content-type protection",
  );
  count++;
}
for (const path of [
  "/student",
  "/student/profile",
  "/student/study-plan",
  "/student/support",
  "/support",
  "/support?student=forged",
  "/admin",
  "/admin?section=audit",
]) {
  const response = await fetch(base + path, { redirect: "manual" });
  assert.equal(response.status, 307, path);
  assert.equal(
    new URL(response.headers.get("location"), base).pathname,
    "/login",
    path,
  );
  count++;
}
assert.equal((await fetch(base + "/api/admin")).status, 401);
count++;
const missing = await fetch(base + "/demo/missing-page");
assert.ok([200, 404].includes(missing.status));
const missingHtml = await missing.text();
assert.ok(missingHtml.includes("That page"));
assert.ok(missingHtml.includes("noindex"));
count++;
for (const path of [
  "/auth/callback?next=https://outside.example",
  "/auth/confirm?type=invite&token_hash=fake",
]) {
  const response = await fetch(base + path, { redirect: "manual" });
  assert.equal(response.status, 307);
  const target = new URL(response.headers.get("location"), base);
  assert.equal(target.origin, base);
  assert.equal(target.pathname, "/login");
  count++;
}
console.log(count + " HTTP smoke checks passed.");
