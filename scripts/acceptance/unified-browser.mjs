// Owner-authorised ordinary-browser journey against the local app and hosted
// ducelio-acceptance. No service role, mock payment, clock override or test route.
// Run only after explicit acceptance approval, with process-local WRITE=true:
// node --env-file=.env.local scripts/acceptance/unified-browser.mjs
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

const base = "http://127.0.0.1:3104";
const run = randomUUID().slice(0, 18);
const slug = `test-browser-${run}`;
const code = `UI-${run}`.toUpperCase();
const reason = `TEST ONLY browser acceptance ${run}`;
const evidence = resolve("work/unified-browser");
const profiles = [];
const results = [];
let admin, learner, courseId, offerId, couponId;
let step = "TARGET_PREFLIGHT";
async function rpc(client, name, args = {}) {
  const { data, error } = await client.rpc(name, args);
  if (error)
    throw new Error(
      `${name}: ${/^[A-Z_]+$/.test(error.message) ? error.message : error.code}`,
    );
  return data;
}
function passed(surface) {
  results.push({ surface, status: "PASS" });
  console.log(`PASS ${surface}`);
}
async function ready(page, expression, label) {
  if (!(await page.waitFor(expression, 45000))) throw new Error(label);
}
const input = (name) => `document.querySelector('input[name="${name}"]')`;
async function dateValue(page, name, value) {
  assert.match(name, /^[A-Za-z]+$/);
  assert.equal(
    await page.evaluate(
      `(() => { const el=${input(name)}; if(!el)return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return el.value===${JSON.stringify(value)}; })()`,
    ),
    true,
  );
}
try {
  assert.equal(
    new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname,
    "blqaomssojfxaxskcyxd.supabase.co",
  );
  assert.equal(
    decodeURIComponent(new URL(process.env.ACCEPTANCE_DATABASE_URL).username),
    "postgres.blqaomssojfxaxskcyxd",
  );
  await withConnection(assertAcceptanceDatabaseWriteAuthorized);
  [admin, learner] = await Promise.all([
    acceptanceIdentities.admin(),
    acceptanceIdentities.learner(),
  ]);
  await assertAcceptanceSupabaseWriteAuthorized(admin);
  await assertAcceptanceSupabaseWriteAuthorized(learner);
  assert.equal(
    await rpc(admin, "has_role", { wanted: "ACADEMIC_ADMIN" }),
    true,
  );
  mkdirSync(evidence, { recursive: true });
  const jsonPath = resolve(evidence, `${slug}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify(buildUnifiedAcceptancePackage(`browser-${run}`)),
  );
  const a = await launchBrowser({
    chromePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  });
  profiles.push(a);
  step = "ADMIN_UI_SIGN_IN";
  assert.equal(
    await signInThroughUi(
      a.page,
      base,
      process.env.ACCEPTANCE_ADMIN_EMAIL,
      process.env.ACCEPTANCE_ADMIN_PASSWORD,
    ),
    true,
  );
  passed(step);
  step = "UPLOAD_JSON_UI";
  await a.page.goto(
    `${base}/admin/course-engineering`,
    "!!document.querySelector('#academy-package')",
  );
  await a.page.uploadFile("#academy-package", jsonPath);
  await a.page.typeInto("document.querySelector('#upload-reason')", reason);
  await a.page.click(byButtonText("Upload and validate"));
  await ready(
    a.page,
    "!!document.querySelector('form [role=status] a[href*=packageId]')",
    "Upload/validation did not produce a review",
  );
  const review = await a.page.evaluate(
    "document.querySelector('form [role=status] a[href*=packageId]').getAttribute('href')",
  );
  assert.match(review, /^\/admin\/course-engineering\?packageId=[0-9a-f-]+$/);
  await a.page.goto(
    base + review,
    "!!document.querySelector('#unified-price')",
  );
  passed(step);
  step = "PRICE_AGENTS_PUBLICATION_UI";
  await a.page.typeInto("document.querySelector('#unified-slug')", slug);
  await a.page.typeInto("document.querySelector('#unified-price')", "100.01");
  await a.page.typeInto("document.querySelector('#PROFESSOR-notes')", reason);
  await a.page.typeInto("document.querySelector('#unified-reason')", reason);
  await a.page.click(input("confirm"));
  await a.page.click(byButtonText("Publish course"));
  await ready(
    a.page,
    "[...document.querySelectorAll('[role=status]')].some(x=>x.textContent.includes('Course published.'))",
    "Publication did not pass its gates",
  );
  const packages = await rpc(admin, "list_unified_course_packages");
  const record = packages.find((p) => p.course?.slug === slug);
  assert.ok(record);
  courseId = record.course.id;
  offerId = record.course.offerId;
  assert.equal(record.packageRevision, 2);
  await a.page.screenshot(resolve(evidence, "admin-published.png"));
  passed(step);
  step = "COUPON_CREATE_UI";
  await a.page.goto(
    `${base}/admin/course-engineering/coupons`,
    "!!document.querySelector('input[name=code]')",
  );
  await a.page.typeInto(input("code"), code);
  await a.page.typeInto(input("percentOff"), "100");
  await a.page.typeInto(input("redemptionLimit"), "1");
  await dateValue(
    a.page,
    "expiresAt",
    new Date(Date.now() + 86400000).toISOString().slice(0, 16),
  );
  await a.page.select(
    "document.querySelector('input[name=code]').form.querySelector('select[name=courseId]')",
    courseId,
  );
  await a.page.typeInto(
    "document.querySelector('input[name=code]').form.querySelector('input[name=reason]')",
    reason,
  );
  await a.page.click(byButtonText("Create coupon"));
  await ready(
    a.page,
    "[...document.querySelectorAll('[role=status]')].some(x=>x.textContent.includes('Coupon created.'))",
    "Coupon creation did not finish",
  );
  couponId = (await rpc(admin, "list_course_coupons")).find(
    (c) => c.code === code,
  )?.id;
  assert.ok(couponId);
  passed(step);
  step = "LEARNER_MOBILE_PURCHASE_UI";
  const l = await launchBrowser({
    chromePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    width: 390,
    height: 844,
  });
  profiles.push(l);
  assert.equal(
    await signInThroughUi(
      l.page,
      base,
      process.env.ACCEPTANCE_LEARNER_EMAIL,
      process.env.ACCEPTANCE_LEARNER_PASSWORD,
    ),
    true,
  );
  await l.page.goto(
    `${base}/courses/${slug}`,
    "!!document.querySelector('#course-coupon')",
  );
  assert.equal(await l.page.evaluate("window.innerWidth"), 390);
  await l.page.typeInto("document.querySelector('#course-coupon')", code);
  await l.page.click(byButtonText("Continue"));
  await ready(
    l.page,
    "location.pathname==='/student/academy' && [...document.querySelectorAll('a')].some(a=>a.textContent.trim()==='Activate Course')",
    "Purchase did not expose Activate Course",
  );
  assert.equal(
    await l.page.evaluate(
      "document.documentElement.scrollWidth<=window.innerWidth",
    ),
    true,
  );
  await l.page.screenshot(resolve(evidence, "mobile-activate.png"));
  const bought = (await rpc(learner, "list_my_academy_enrolments")).find(
    (e) => e.courseId === courseId,
  );
  assert.ok(bought);
  assert.equal(bought.schedule, null);
  assert.equal(bought.formatId, null);
  passed(step);
  step = "PERSONAL_TIMETABLE_UI";
  await l.page.click(
    "[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Activate Course')",
  );
  await ready(
    l.page,
    "!!document.querySelector('input[name=startOn]')",
    "Activation planner did not open",
  );
  assert.equal(
    await l.page.evaluate(
      "document.querySelectorAll('input[name=formatId]').length",
    ),
    5,
  );
  const chosenDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await dateValue(l.page, "startOn", chosenDate);
  await dateValue(l.page, "localTime", "19:00");
  await l.page.select(
    "document.querySelector('select[name=timezone]')",
    "Europe/London",
  );
  await l.page.click(byButtonText("Preview my timetable"));
  await ready(
    l.page,
    "!!document.querySelector('#preview-title')",
    "Preview did not finish",
  );
  await l.page.screenshot(resolve(evidence, "mobile-preview.png"));
  assert.equal(
    await l.page.evaluate(
      "document.querySelector('input[name=startOn]').value",
    ),
    chosenDate,
  );
  assert.equal(
    await l.page.evaluate(
      "document.querySelector('select[name=timezone]').value",
    ),
    "Europe/London",
  );
  await dateValue(l.page, "localTime", "20:00");
  await ready(
    l.page,
    `${byButtonText("Confirm this timetable")}.disabled`,
    "Changing choices did not invalidate the preview",
  );
  await l.page.click(byButtonText("Preview my timetable"));
  await ready(
    l.page,
    `!${byButtonText("Confirm this timetable")}.disabled`,
    "Updated preview did not enable confirmation",
  );
  await l.page.click(byButtonText("Confirm this timetable"));
  await ready(
    l.page,
    "!!document.querySelector('.acad-timetable')",
    "Confirmation did not show a timetable",
  );
  const timetable = await rpc(learner, "get_my_academy_timetable", {
    p_enrolment_id: bought.enrolmentId,
  });
  assert.equal(timetable.schedule.revision, 1);
  assert.equal(timetable.schedule.localTime, "20:00");
  assert.equal(timetable.schedule.startOn, chosenDate);
  assert.equal(timetable.schedule.timezone, "Europe/London");
  for (const i of timetable.items)
    assert.equal(Date.parse(i.closesAt) - Date.parse(i.opensAt), 1439 * 60000);
  assert.equal(
    await l.page.evaluate(
      "document.documentElement.scrollWidth<=window.innerWidth",
    ),
    true,
  );
  await l.page.screenshot(resolve(evidence, "mobile-timetable.png"));
  passed(step);
  step = "BROWSER_RUNTIME_ERRORS";
  assert.equal(
    a.page.consoleErrors.length,
    0,
    "Administrator browser logged runtime errors",
  );
  assert.equal(
    l.page.consoleErrors.length,
    0,
    "Learner browser logged runtime errors",
  );
  passed(step);
} catch (error) {
  results.push({ surface: step, status: "FAIL" });
  console.error(
    `FAIL ${step}: ordinary browser journey did not satisfy its assertion; inspect private local evidence and server log.`,
  );
  console.error(
    error instanceof Error
      ? error.message.slice(0, 300)
      : "Unknown browser failure",
  );
  process.exitCode = 1;
} finally {
  if (admin) {
    try {
      // Discover only this exact run's records even if a UI assertion failed
      // immediately after publication/creation. No old course is touched.
      const record = (await rpc(admin, "list_unified_course_packages")).find(
        (p) => p.course?.slug === slug,
      );
      offerId ??= record?.course?.offerId;
      couponId ??= (await rpc(admin, "list_course_coupons")).find(
        (c) => c.code === code,
      )?.id;
      if (couponId)
        await rpc(admin, "set_course_coupon_active", {
          p_coupon_id: couponId,
          p_active: false,
          p_reason: reason,
        });
      if (offerId)
        await rpc(admin, "archive_academy_offer", {
          p_offer_id: offerId,
          p_reason: reason,
        });
      passed("AUDITED_FIXTURE_ARCHIVAL");
    } catch {
      console.error(
        "FAIL fixture archival: preserve evidence and inspect exact run before retry",
      );
      process.exitCode = 1;
    }
  }
  for (const b of profiles) await b.close();
  for (const c of [admin, learner])
    if (c) await c.auth.signOut({ scope: "local" });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    resolve(evidence, "result.json"),
    JSON.stringify({ run, results, productionReady: false }, null, 2),
  );
}
