// Owner-authorised ordinary-browser journey for the Operations Engineer and
// course-review recovery, against the local app and hosted ducelio-acceptance.
// Writes only labelled TEST ONLY fixtures: one synthetic package revision
// (immutable history, never published) and one 5% coupon (limit 1, one-hour
// expiry) that is deactivated in the same run. AWS SAA-C03 is read only.
// No service role, test route or privileged bypass.
// node --env-file=.env.local scripts/acceptance/recovery-browser.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildUnifiedAcceptancePackage } from "./unified-fixture.mjs";
import {
  withConnection,
  assertAcceptanceDatabaseWriteAuthorized,
} from "./db.mjs";
import {
  acceptanceIdentities,
  assertAcceptanceSupabaseWriteAuthorized,
} from "./supabase.mjs";
import {
  launchBrowser,
  signInThroughUi,
  byButtonText,
} from "./exam-engine-browser.mjs";

const base = process.env.RECOVERY_BROWSER_BASE ?? "http://127.0.0.1:3104";
const AWS_REVISION_3 = "3c9cd70d-60dc-4bbb-81ba-ea3081eb10b6";
const DUCELIO = "00000000-0000-4000-8000-000000000001";
const run = randomUUID().slice(0, 18);
const code = `TEST-RECOVERY-${run}`.toUpperCase().slice(0, 40);
const reason = `TEST ONLY recovery browser acceptance ${run}`;
const evidence = resolve("work/recovery-browser");
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profiles = [];
const results = [];
let admin, couponId, uploadedId, current;
let step = "TARGET_PREFLIGHT";

async function rpc(client, name, args = {}) {
  const { data, error } = await client.rpc(name, args);
  if (error)
    throw new Error(
      `${name}: ${/^[A-Z_]+$/.test(error.message) ? error.message : error.code}`,
    );
  return data;
}
function passed(surface, detail) {
  results.push({ surface, status: "PASS", ...(detail ? { detail } : {}) });
  console.log(`PASS ${surface}${detail ? ` — ${detail}` : ""}`);
}
async function ready(page, expression, label, ms = 45000) {
  if (!(await page.waitFor(expression, ms))) throw new Error(label);
}
const settled =
  "!document.body.innerText.includes('Loading the latest records')";
const text = async (page) => {
  await ready(page, settled, "Page did not finish loading");
  return page.evaluate("document.body.innerText");
};
const noOverflow = (page) =>
  page.evaluate("document.documentElement.scrollWidth<=window.innerWidth");
const chip = (title) =>
  `[...document.querySelectorAll('.oe-chip')].find(b=>b.textContent.trim()===${JSON.stringify(title)})`;
const oeField = (label) =>
  `(() => { const l=[...document.querySelectorAll('.oe-form label')].find(x=>x.textContent.trim()===${JSON.stringify(label)}); return l && document.getElementById(l.htmlFor); })()`;
async function setField(page, label, value) {
  await ready(
    page,
    `!!${oeField(label)}`,
    `Field ${label} did not appear`,
    10000,
  );
  const ok = await page.evaluate(
    `(() => { const el=${oeField(label)}; if(!el) return false; const proto = el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return el.value===${JSON.stringify(value)}; })()`,
  );
  assert.equal(ok, true, `Could not set ${label}`);
}
async function attach(page, label, filePath) {
  await ready(
    page,
    `!!${oeField(label)}`,
    `Field ${label} did not appear`,
    10000,
  );
  const id = await page.evaluate(`(${oeField(label)})?.id ?? null`);
  assert.ok(id, `No file field ${label}`);
  await page.uploadFile(`[id="${id}"]`, filePath);
}
const submit = "document.querySelector('.oe-form button[type=submit]')";
async function prepare(page) {
  await ready(
    page,
    `!!${submit} && !${submit}.disabled`,
    "Prepare button not ready",
  );
  // Wait for a NEW result (not the previous inspection or receipt) and for
  // the transition to finish, so every button shows its settled label.
  const previous = await page.evaluate(
    "document.querySelector('.oe-result')?.innerText ?? ''",
  );
  await page.click(submit);
  await ready(
    page,
    `(() => { const t = document.querySelector('.oe-result')?.innerText ?? ''; return t.length > 0 && t !== ${JSON.stringify(previous)} && !${submit}.disabled; })()`,
    "Operations Engineer gave no new result",
  );
}
const proposalText = (page) =>
  page.evaluate("document.querySelector('.oe-proposal')?.innerText ?? ''");
async function confirmProposal(page) {
  const confirmButton = byButtonText("Confirm and execute");
  // Execution is impossible until the exact proposal is confirmed.
  assert.equal(await page.evaluate(`${confirmButton}.disabled`), true);
  await page.click(
    "document.querySelector('.oe-confirm input[type=checkbox]')",
  );
  assert.equal(await page.evaluate(`${confirmButton}.disabled`), false);
  await page.click(confirmButton);
  await ready(
    page,
    "!!document.querySelector('.oe-receipt')",
    "No receipt after confirmation",
  );
  return page.evaluate("document.querySelector('.oe-receipt').innerText");
}
async function openOperations(page) {
  await page.goto(
    `${base}/admin/operations-engineer`,
    `!!document.querySelector('.oe-form') && ${settled}`,
  );
}

try {
  assert.equal(
    new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname,
    "blqaomssojfxaxskcyxd.supabase.co",
  );
  await withConnection(assertAcceptanceDatabaseWriteAuthorized);
  admin = await acceptanceIdentities.admin();
  const learner = await acceptanceIdentities.learner();
  await assertAcceptanceSupabaseWriteAuthorized(admin);
  assert.equal(
    await rpc(admin, "has_role", { wanted: "ACADEMIC_ADMIN" }),
    true,
  );
  const before = await rpc(admin, "list_unified_course_packages");
  const aws = before.find((p) => p.id === AWS_REVISION_3);
  assert.ok(aws, "AWS revision 3 not visible");
  const awsSnapshot = JSON.stringify(aws);
  mkdirSync(evidence, { recursive: true });
  const pkg = buildUnifiedAcceptancePackage(`recovery-${run}`);
  const validPath = resolve(evidence, `valid-${run}.json`);
  const invalidPath = resolve(evidence, `invalid-${run}.json`);
  const conflictPath = resolve(evidence, `conflict-${run}.json`);
  writeFileSync(validPath, JSON.stringify(pkg));
  writeFileSync(
    invalidPath,
    JSON.stringify({ ...pkg, packageRevision: 0, reason: "TEST ONLY invalid" }),
  );
  writeFileSync(
    conflictPath,
    JSON.stringify({
      ...pkg,
      reason: "TEST ONLY different content, same revision",
    }),
  );

  const a = await launchBrowser({ chromePath, width: 1366, height: 900 });
  profiles.push(a);
  current = a.page;
  step = "ADMIN_SIGN_IN";
  await signInThroughUi(
    a.page,
    base,
    process.env.ACCEPTANCE_ADMIN_EMAIL,
    process.env.ACCEPTANCE_ADMIN_PASSWORD,
  );
  passed(step);

  step = "NAVIGATION_DESTINATIONS";
  await a.page.goto(
    `${base}/admin/course-engineering`,
    "!!document.querySelector('.ac-nav')",
  );
  const nav = await a.page.evaluate(
    "[...document.querySelectorAll('.ac-nav a')].map(a=>a.textContent.trim()+'='+a.getAttribute('href'))",
  );
  assert.ok(nav.includes("Operations Engineer=/admin/operations-engineer"));
  assert.ok(
    nav.includes("Course academic review=/admin/course-engineering/review"),
  );
  passed(step, nav.join(", "));

  step = "OPERATIONS_ENGINEER_OPENS";
  await openOperations(a.page);
  assert.equal(
    await a.page.evaluate("location.pathname"),
    "/admin/operations-engineer",
  );
  const oeText = await text(a.page);
  assert.match(oeText, /Operations Engineer/);
  const aiConfigured = /AI interpretation configured/.test(oeText);
  if (!aiConfigured) {
    assert.match(oeText, /AI interpretation not configured/);
    assert.equal(
      await a.page.evaluate("document.querySelector('#oe-request').disabled"),
      true,
    );
  }
  passed(
    step,
    aiConfigured
      ? "AI configured"
      : "AI not configured: plain-language input disabled, typed operations offered",
  );

  step = "OE_READ_COURSES";
  await prepare(a.page);
  const courses = await text(a.page);
  assert.match(courses, /Courses and publication states/);
  assert.match(courses, /awaiting academic review/);
  assert.doesNotMatch(courses, /not started/);
  passed(step);

  step = "OE_INSPECT_AWS";
  await a.page.click(chip("Inspect a course revision"));
  await setField(a.page, "Course revision", AWS_REVISION_3);
  await prepare(a.page);
  const inspect = await text(a.page);
  const pending = inspect.match(/Pending: [A-Z_]+/g) ?? [];
  assert.equal(
    pending.length,
    8,
    `Expected 8 pending decisions, saw ${pending.length}`,
  );
  assert.match(inspect, /imported and tested at publication/);
  passed(step, `${pending.length} pending decisions shown`);

  step = "OE_PUBLISH_AWS_BLOCKED";
  await a.page.click(chip("Publish a course"));
  await setField(a.page, "Approved course revision", AWS_REVISION_3);
  await setField(
    a.page,
    "Course address (/courses/…)",
    `test-blocked-${run}`.slice(0, 60),
  );
  await setField(a.page, "Currency", "GBP");
  await setField(a.page, "Price", "1.00");
  await setField(a.page, "Reason (recorded in the audit trail)", reason);
  await prepare(a.page);
  const blocked = await proposalText(a.page);
  assert.match(blocked, /8 academic decision\(s\) are pending/);
  assert.equal(
    await a.page.evaluate(`${byButtonText("Confirm and execute")}.disabled`),
    true,
  );
  assert.equal(
    await a.page.evaluate("!!document.querySelector('.oe-confirm')"),
    false,
  );
  await a.page.click(byButtonText("Discard proposal"));
  passed(step);

  step = "OE_SALES_REPORT";
  await a.page.click(chip("Orders and sales statistics"));
  await prepare(a.page);
  const sales = await text(a.page);
  assert.match(sales, /Recognised revenue/);
  assert.match(sales, /Not reported/);
  passed(step);

  step = "OE_UPLOAD_INVALID_REFUSED";
  const count0 = (await rpc(admin, "list_unified_course_packages")).length;
  await a.page.click(chip("Upload a course package"));
  await setField(a.page, "Owning organisation", DUCELIO);
  await setField(a.page, "Reason (recorded in the audit trail)", reason);
  await attach(a.page, "Course package file (.json)", invalidPath);
  await prepare(a.page);
  assert.match(await proposalText(a.page), /failed validation/);
  assert.equal(
    await a.page.evaluate(`${byButtonText("Confirm and execute")}.disabled`),
    true,
  );
  assert.equal(
    (await rpc(admin, "list_unified_course_packages")).length,
    count0,
  );
  passed(step, "blocked before any record");

  step = "OE_UPLOAD_CONFIRMED";
  await attach(a.page, "Course package file (.json)", validPath);
  await prepare(a.page);
  const uploadProposal = await proposalText(a.page);
  assert.match(uploadProposal, /structurally valid/);
  assert.equal(
    (await rpc(admin, "list_unified_course_packages")).length,
    count0,
  );
  const uploadReceipt = await confirmProposal(a.page);
  assert.match(uploadReceipt, /Operation completed/);
  assert.match(uploadReceipt, /Confirmed by re-reading/);
  const after = await rpc(admin, "list_unified_course_packages");
  const uploaded = after.find((p) => p.packageKey === pkg.packageKey);
  uploadedId = uploaded?.id;
  assert.equal(uploaded?.status, "VALIDATED");
  assert.equal(after.length, count0 + 1);
  passed(step, `revision ${uploaded.packageRevision} stored and validated`);

  step = "OE_UPLOAD_REPLAY_CREATES_NOTHING";
  await prepare(a.page);
  assert.match(await proposalText(a.page), /already stored as revision 1/);
  assert.equal(
    (await rpc(admin, "list_unified_course_packages")).length,
    count0 + 1,
  );
  passed(step);

  step = "COURSE_ACADEMIC_REVIEW_WORKSPACE";
  await a.page.goto(
    `${base}/admin/course-engineering/review?packageId=${AWS_REVISION_3}`,
    "!!document.querySelector('#review')",
  );
  assert.equal(
    await a.page.evaluate("location.pathname"),
    "/admin/course-engineering/review",
  );
  const review = await text(a.page);
  assert.match(review, /Course academic review/);
  assert.doesNotMatch(review, /cohort/i);
  for (const key of [
    "OFFICIAL_SOURCE_RECONCILIATION",
    "EXAM_ITEM_INDEPENDENT_REVIEW",
    "ACADEMIC_PASS_POLICY_APPROVAL",
    "DELIVERY_FORMAT_FEASIBILITY",
    "COURSE_PRICE_APPROVAL",
    "HOSTED_ACCEPTANCE",
    "LAB_ASSESSMENT_MODEL",
    "ASSESSMENT_FORM_VARIATION",
  ])
    assert.match(review, new RegExp(key));
  assert.equal(
    await a.page.evaluate(
      "[...document.querySelectorAll('#resolve input[type=checkbox]')].some(c=>c.checked)",
    ),
    false,
  );
  assert.equal(
    await a.page.evaluate(
      "document.querySelectorAll('#resolve input[name=decision]').length",
    ),
    8,
  );
  await a.page.screenshot(resolve(evidence, "course-academic-review.png"));
  passed(step, "8 decisions pending, none pre-selected, not submitted");

  step = "LEARNER_RESULT_REVIEW_SEPARATE";
  await a.page.goto(
    `${base}/admin/academic-review`,
    "document.readyState==='complete'",
  );
  assert.equal(
    await a.page.evaluate("location.pathname"),
    "/admin/academic-review",
  );
  const results2 = await text(a.page);
  assert.match(results2, /LEARNER RESULT REVIEW|Learner result review/);
  assert.match(results2, /Open Course academic review/);
  passed(step);

  step = "COURSE_ENGINEERING_STAGES_AND_REFUSALS";
  await a.page.goto(
    `${base}/admin/course-engineering?packageId=${AWS_REVISION_3}`,
    "!!document.querySelector('#academy-package')",
  );
  const ce = await text(a.page);
  assert.match(ce, /Structurally validated · awaiting academic review/);
  assert.doesNotMatch(ce, /Curriculum pipeline: not started/);
  for (const [file, expected] of [
    [invalidPath, /Nothing was stored/],
    [conflictPath, /already exists .* set "packageRevision" to 2/],
  ]) {
    const n = (await rpc(admin, "list_unified_course_packages")).length;
    await a.page.uploadFile("#academy-package", file);
    await a.page.typeInto("document.querySelector('#upload-reason')", reason);
    await a.page.click(byButtonText("Upload and validate"));
    await ready(
      a.page,
      "!!document.querySelector('#upload [role=alert]')",
      "Upload refusal not shown",
    );
    assert.match(
      await a.page.evaluate(
        "document.querySelector('#upload [role=alert]').innerText",
      ),
      expected,
    );
    assert.equal((await rpc(admin, "list_unified_course_packages")).length, n);
    await a.page.goto(
      `${base}/admin/course-engineering?packageId=${AWS_REVISION_3}`,
      "!!document.querySelector('#academy-package')",
    );
  }
  passed(step, "invalid and conflicting uploads refused, no record");

  step = "OE_COUPON_CREATE";
  await openOperations(a.page);
  await a.page.click(chip("Create a discount code"));
  await setField(a.page, "Organisation", DUCELIO);
  await setField(a.page, "Code", code);
  await setField(a.page, "Discount type", "PERCENT");
  await setField(a.page, "Percent off", "5");
  const expiry = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
  await setField(a.page, "Expires (UTC)", expiry);
  await setField(a.page, "Total redemption limit", "1");
  await setField(a.page, "Reason (recorded in the audit trail)", reason);
  await prepare(a.page);
  assert.match(await proposalText(a.page), /5% off/);
  const couponReceipt = await confirmProposal(a.page);
  assert.match(couponReceipt, /Operation completed/);
  const created = (await rpc(admin, "list_course_coupons")).find(
    (c) => c.code === code,
  );
  couponId = created?.id;
  assert.equal(created?.active, true);
  assert.equal(created?.percentOff, 5);
  passed(step);

  step = "OE_COUPON_DEACTIVATE";
  await openOperations(a.page);
  await a.page.click(chip("Activate or deactivate a discount code"));
  await setField(a.page, "Coupon", couponId);
  await setField(a.page, "Availability", "false");
  await setField(a.page, "Reason (recorded in the audit trail)", reason);
  await prepare(a.page);
  assert.match(await proposalText(a.page), /Active → Inactive/);
  const deactivated = await confirmProposal(a.page);
  assert.match(deactivated, /Confirmed by re-reading/);
  assert.equal(
    (await rpc(admin, "list_course_coupons")).find((c) => c.id === couponId)
      ?.active,
    false,
  );
  passed(step);

  step = "AWS_UNCHANGED";
  const awsAfter = (await rpc(admin, "list_unified_course_packages")).find(
    (p) => p.id === AWS_REVISION_3,
  );
  assert.equal(JSON.stringify(awsAfter), awsSnapshot);
  passed(step);

  step = "MOBILE_LAYOUT";
  const mob = await launchBrowser({ chromePath, width: 390, height: 844 });
  profiles.push(mob);
  await signInThroughUi(
    mob.page,
    base,
    process.env.ACCEPTANCE_ADMIN_EMAIL,
    process.env.ACCEPTANCE_ADMIN_PASSWORD,
  );
  for (const path of [
    "/admin/operations-engineer",
    `/admin/course-engineering/review?packageId=${AWS_REVISION_3}`,
  ]) {
    await mob.page.goto(base + path, "document.readyState==='complete'");
    assert.equal(await mob.page.evaluate("window.innerWidth"), 390);
    assert.equal(
      await noOverflow(mob.page),
      true,
      `${path} overflows at 390px`,
    );
  }
  await mob.page.screenshot(resolve(evidence, "mobile-review.png"));
  passed(step);

  step = "LEARNER_FUNCTIONS_AND_REFUSALS";
  const l = await launchBrowser({ chromePath, width: 390, height: 844 });
  profiles.push(l);
  await signInThroughUi(
    l.page,
    base,
    process.env.ACCEPTANCE_LEARNER_EMAIL,
    process.env.ACCEPTANCE_LEARNER_PASSWORD,
  );
  await l.page.goto(
    `${base}/student/academy`,
    "document.readyState==='complete'",
  );
  const mine = await text(l.page);
  assert.doesNotMatch(mine, /Application error|could not be loaded/i);
  const enrolments = await rpc(learner, "list_my_academy_enrolments");
  assert.equal(await noOverflow(l.page), true);
  await l.page.goto(`${base}/courses`, "document.readyState==='complete'");
  assert.doesNotMatch(await text(l.page), /Application error/i);
  for (const path of [
    "/admin/operations-engineer",
    "/admin/course-engineering/review",
  ]) {
    await l.page.goto(base + path, "document.readyState==='complete'");
    const t = await text(l.page);
    assert.doesNotMatch(
      t,
      /Prepare proposal|Record reviewed decisions|OFFICIAL_SOURCE_RECONCILIATION/,
    );
  }
  passed(
    step,
    `${enrolments.length} enrolments listed; admin workspaces refused`,
  );

  step = "BROWSER_RUNTIME_ERRORS";
  for (const p of profiles)
    assert.deepEqual(
      p.page.consoleErrors,
      [],
      "A browser logged runtime errors",
    );
  passed(step);
} catch (error) {
  results.push({ surface: step, status: "FAIL" });
  console.error(`FAIL ${step}`);
  if (current) {
    // Bounded diagnostics: the operations result panel only, never page data.
    const shown = await current
      .evaluate(
        "(document.querySelector('.oe-result')?.innerText ?? document.querySelector('[role=alert]')?.innerText ?? '').slice(0, 600)",
      )
      .catch(() => "");
    console.error(`Result panel: ${shown}`);
    await current
      .screenshot(resolve(evidence, `failure-${step}.png`))
      .catch(() => {});
  }
  console.error(
    error instanceof Error ? error.message.slice(0, 400) : "Unknown failure",
  );
  process.exitCode = 1;
} finally {
  if (admin) {
    try {
      couponId ??= (await rpc(admin, "list_course_coupons")).find(
        (c) => c.code === code,
      )?.id;
      const c = couponId
        ? (await rpc(admin, "list_course_coupons")).find(
            (x) => x.id === couponId,
          )
        : null;
      if (c?.active)
        await rpc(admin, "set_course_coupon_active", {
          p_coupon_id: couponId,
          p_active: false,
          p_reason: reason,
        });
      results.push({
        surface: "FIXTURE_CLEANUP",
        status: "PASS",
        detail: `coupon ${couponId ? "deactivated" : "not created"}; TEST package ${uploadedId ?? "not created"} retained as immutable history, never published`,
      });
    } catch {
      results.push({ surface: "FIXTURE_CLEANUP", status: "FAIL" });
      process.exitCode = 1;
    }
  }
  for (const p of profiles) await p.close().catch(() => {});
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    resolve(evidence, "result.json"),
    JSON.stringify({ run, results }, null, 1),
  );
}
