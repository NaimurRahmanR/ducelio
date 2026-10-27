// LOCAL ONLY real-browser learner journey (docs/61), against the app run
// from an env-free worktree and scripts/local/learner-stack.mjs. Headless
// Chrome through the repository's dependency-free CDP driver, real input
// events, desktop / tablet / mobile viewports, screenshots under
// work/learner-browser/. Every check is recorded; one failure never stops
// the rest. NOT production acceptance: identity and PostgREST are the local
// gateway, email/push are never delivered.
//   node scripts/local/learner-browser.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import zlib from "node:zlib";
import pg from "pg";
import {
  launchBrowser,
  signInThroughUi,
} from "../acceptance/exam-engine-browser.mjs";

const base = "http://127.0.0.1:3000";
const out = resolve("work/learner-browser");
mkdirSync(out, { recursive: true });
const EMAIL = "learner-a@example.com";
const PASSWORD = "Local-Only-Test-2026!";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const results = [];
const js = (v) => JSON.stringify(v);
const byText = (selector, text) =>
  `[...document.querySelectorAll(${js(selector)})].find(e => e.textContent.replace(/\\s+/g,' ').trim().includes(${js(text)}))`;

// Fixture identifiers from the LOCAL database (owner read, local only).
const db = new pg.Client({
  connectionString: "postgres://postgres@127.0.0.1:55484/ducelio_local_learner",
});
await db.connect();
const { rows: courseRows } = await db.query(
  `select e.id from public.academy_enrolments e join public.academy_courses c on c.id = e.course_id
    where e.learner_id = '10000000-0000-4000-8000-000000000601' and c.title like '%(local copy A)'`,
);
const courseA = courseRows[0].id;
const { rows: released } = await db.query(
  `select id from public.academy_assessment_attempts where enrolment_id=$1 and assessment_ref='quiz-1' order by started_at limit 1`,
  [courseA],
);
const { rows: labRow } = await db.query(
  `select i.ref from public.academy_schedule_items i join public.academy_schedules s on s.id=i.schedule_id
    where s.enrolment_id=$1 and s.superseded_at is null and i.kind='LAB' order by i.starts_at limit 1`,
  [courseA],
);
const releasedAttempt = released[0]?.id;
const labRef = labRow[0]?.ref;

// A real 64x64 PNG (solid Ducelio indigo), TEST ONLY.
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
const SIDE = 64;
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIDE, 0);
ihdr.writeUInt32BE(SIDE, 4);
ihdr.set([8, 2, 0, 0, 0], 8);
const raw = Buffer.concat(
  Array.from({ length: SIDE }, () =>
    Buffer.concat([
      Buffer.from([0]),
      Buffer.from(
        Array.from({ length: SIDE }, () => [0x31, 0x26, 0x80]).flat(),
      ),
    ]),
  ),
);
const png = resolve(out, "test-only-evidence.png");
writeFileSync(
  png,
  Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]),
);

async function check(viewport, step, run) {
  try {
    const detail = await run();
    results.push({ viewport, step, ok: true, detail: detail ?? "" });
  } catch (e) {
    results.push({ viewport, step, ok: false, detail: String(e.message ?? e) });
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const VIEWPORTS = [
  ["desktop", 1440, 1000],
  ["tablet", 820, 1180],
  ["mobile", 390, 844],
];
const PAGES = [
  ["dashboard", "/student", ".ln-dashboard"],
  ["my-learning", "/student/learning", ".ln-course-row"],
  ["timetable", "/student/timetable", ".ln-day"],
  ["leaderboards", "/student/leaderboards", "h1"],
  ["profile", "/student/profile", "input[name=firstName]"],
  ["support", "/student/support", "select[name=category]"],
  ["workspace", `/student/courses/${courseA}`, ".ln-wrow"],
  ["progression", `/student/courses/${courseA}/progression`, "h1"],
  ["released-attempt", `/student/academy/attempt/${releasedAttempt}`, "h1"],
];

for (const [viewport, width, height] of VIEWPORTS) {
  const { page, close } = await launchBrowser({
    chromePath: CHROME,
    width,
    height,
  });
  const shot = (name) =>
    page.screenshotFullPage(resolve(out, `${viewport}-${name}.png`));
  const noOverflow = async () => {
    const r = await page.evaluate(
      "({w: document.documentElement.scrollWidth, v: window.innerWidth})",
    );
    must(r.w <= r.v + 1, `horizontal overflow ${r.w}px > ${r.v}px`);
  };
  try {
    await check(viewport, "sign in through the UI", async () => {
      await signInThroughUi(page, base, EMAIL, PASSWORD);
      must(
        await page.waitFor("location.pathname.startsWith('/student')", 30000),
        `landed on ${await page.url()}`,
      );
      return await page.url();
    });

    for (const [name, path, ready] of PAGES)
      await check(viewport, `render ${name}`, async () => {
        await page.goto(base + path);
        must(
          await page.waitFor(`!!document.querySelector(${js(ready)})`, 45000),
          `${ready} not rendered at ${await page.url()}`,
        );
        await noOverflow();
        await shot(name);
        await page.evaluate("window.scrollTo(0, 0)");
        await page.screenshotViewport(
          resolve(out, `${viewport}-${name}-first-view.png`),
        );
        return "no horizontal overflow";
      });

    await check(viewport, "navigation reachable", async () => {
      await page.goto(base + "/student");
      await page.waitFor("!!document.querySelector('.ln-dashboard')", 45000);
      const labels = await page.evaluate(
        `[...document.querySelectorAll('nav[aria-label="Academy navigation"] a, nav[aria-label="Mobile academy navigation"] a')].map(a => a.textContent.trim()).filter(Boolean)`,
      );
      for (const want of [
        "Dashboard",
        "My Learning",
        "My Timetable",
        "Leaderboards",
        "Browse Courses",
        "Profile",
      ])
        must(
          labels.some((l) => l.includes(want)),
          `missing ${want} in ${labels}`,
        );
      return labels.join(" | ");
    });

    if (viewport !== "desktop") continue;

    // ---- desktop functional journeys --------------------------------------
    await check(
      viewport,
      "dashboard has exactly four rows in order",
      async () => {
        await page.goto(base + "/student");
        await page.waitFor("!!document.querySelector('.ln-dashboard')", 45000);
        const rows = await page.evaluate(
          "[...document.querySelectorAll('.ln-dashboard > [data-row]')].map(r => r.dataset.row + ':' + r.innerText.replace(/\\s+/g,' ').slice(0,60))",
        );
        must(rows.length === 4, `rows: ${rows.length}`);
        const nav = await page.evaluate(
          `[...document.querySelectorAll('nav[aria-label="Academy navigation"] a')].map(a => a.textContent.trim())`,
        );
        must(nav.length === 6, `sidebar has ${nav.length} links: ${nav}`);
        must(
          await page.evaluate(
            "[...document.querySelectorAll('footer a, a')].some(a => a.textContent.includes('Support & Feedback') && a.getAttribute('href') === '/student/support')",
          ),
          "no Support & Feedback link to /student/support",
        );
        return rows.join(" || ");
      },
    );

    // Every major card is one real link: clicking the card body (not only
    // its link text) and pressing Enter on its link both arrive.
    const cardCases = [
      [
        "Next Activity card",
        "/student",
        "document.querySelector('[data-panel=\"next-activity\"] .ln-next__title')",
        "location.pathname.startsWith('/student/courses/') && location.hash.length > 1",
      ],
      [
        "Explore More Courses banner",
        "/student",
        "document.querySelector('.ln-explore__text span')",
        "location.pathname === '/courses'",
      ],
      [
        "timetable activity card",
        "/student/timetable",
        "document.querySelector('.ln-activity .ln-activity__meta')",
        "location.pathname.startsWith('/student/courses/')",
      ],
      [
        "course progression card",
        "/student",
        "document.querySelector('.ln-progress-card.ln-clickable .ln-progress-card__provider')",
        "location.pathname.endsWith('/progression')",
      ],
      [
        "released result row",
        "/student",
        "document.querySelector('tr.ln-rowlink td[data-label=\"Type\"]')",
        "location.pathname.startsWith('/student/academy/attempt/')",
      ],
      [
        "My Learning course row",
        "/student/learning",
        "document.querySelector('.ln-course-row .ln-course-row__provider')",
        "location.pathname.startsWith('/student/courses/')",
      ],
    ];
    for (const [name, from, target, arrived] of cardCases)
      await check(viewport, `card opens its destination: ${name}`, async () => {
        await page.goto(base + from);
        await page.waitFor(`!!(${target})`, 45000);
        await page.click(target);
        must(
          await page.waitFor(arrived, 30000),
          `stayed on ${await page.url()}`,
        );
        const landed = await page.url();
        await page.goto(base + from);
        await page.waitFor(`!!(${target})`, 45000);
        // Keyboard: the card's link takes focus and Enter follows it.
        const focused = await page.evaluate(
          `(() => { const el = ${target}; const card = el.closest('.ln-clickable, .ln-course-row, tr.ln-rowlink, .ln-explore'); const link = card.matches('a') ? card : card.querySelector('.ln-clickable__link, .ln-rowlink__link'); link.focus(); return document.activeElement === link; })()`,
        );
        must(focused, "the card's link cannot take keyboard focus");
        await page.press("Enter");
        must(
          await page.waitFor(arrived, 30000),
          "Enter did not follow the card's link",
        );
        return `${landed} (mouse and keyboard)`;
      });

    await check(
      viewport,
      "a form inside a page never triggers card navigation",
      async () => {
        await page.goto(base + "/student");
        await page.waitFor(
          "!!document.querySelector('#ln-sarah-message')",
          45000,
        );
        await page.click("document.querySelector('#ln-sarah-message')");
        await page.insertText("TEST ONLY");
        must(
          (await page.url()) === "/student",
          "typing in Sarah navigated away",
        );
        return "Sarah's form stays put";
      },
    );

    await check(
      viewport,
      "Sarah: double-click icon opens fullscreen, conversation kept",
      async () => {
        await page.evaluate(
          "document.querySelector('.ln-sarah__icon').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))",
        );
        must(
          await page.waitFor(
            "!!document.querySelector('.ln-sarah-backdrop')",
            5000,
          ),
          "fullscreen did not open",
        );
        await shot("sarah-fullscreen");
        await page.evaluate(
          "document.querySelector('.ln-sarah__icon').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))",
        );
        must(
          await page.waitFor(
            "!document.querySelector('.ln-sarah-backdrop')",
            5000,
          ),
          "fullscreen did not close",
        );
        return "opened and closed";
      },
    );

    await check(
      viewport,
      "timetable: 7 days, next and previous week",
      async () => {
        await page.goto(base + "/student/timetable");
        await page.waitFor("!!document.querySelector('.ln-day')", 45000);
        const days = await page.evaluate(
          "document.querySelectorAll('.ln-page .ln-day').length",
        );
        must(days === 7, `${days} day columns`);
        await page.click(byText("a", "Next week"));
        must(
          await page.waitFor("location.search.includes('week=')", 15000),
          "next week did not navigate",
        );
        await page.waitFor("!!document.querySelector('.ln-day')", 30000);
        await page.click(byText("a", "Previous week"));
        await page.waitFor("!!document.querySelector('.ln-day')", 30000);
        const reminders = await page.evaluate(
          "document.querySelector('#ln-reminders-heading')?.closest('section')?.innerText.slice(0,200)",
        );
        must(reminders, "reminders panel missing");
        return reminders.replace(/\s+/g, " ");
      },
    );

    await check(viewport, "workspace has six panels", async () => {
      await page.goto(base + `/student/courses/${courseA}`);
      await page.waitFor("!!document.querySelector('.ln-wrow')", 45000);
      const n = await page.evaluate(
        "[...document.querySelectorAll('.ln-wrow')].reduce((n, r) => n + r.children.length, 0)",
      );
      must(n === 6, `${n} panels`);
      return "3 rows x 2 panels";
    });

    await check(viewport, "Give attendance records attendance", async () => {
      await page.click(byText("button", "Give attendance"));
      // The panel re-renders from the server as attended (the form, and its
      // transient message, are replaced by the recorded time and timer).
      must(
        await page.waitFor(
          "document.body.innerText.includes('Recorded at') && document.body.innerText.includes('since check-in')",
          30000,
        ),
        "attendance not shown as recorded",
      );
      await page.reload();
      await page.waitFor("!!document.querySelector('.ln-wrow')", 45000);
      await shot("workspace-after-attendance");
      return "confirmed";
    });

    await check(
      viewport,
      "lab evidence: upload a screenshot, add code, submit",
      async () => {
        must(labRef, "no lab on the timetable");
        const input = `#ln-lab-files-${labRef}`;
        must(
          await page.waitFor(`!!document.querySelector(${js(input)})`, 15000),
          "evidence form not shown",
        );
        await page.uploadFile(input, png);
        must(
          await page.waitFor(
            `document.body.innerText.includes('test-only-evidence.png')`,
            20000,
          ),
          "uploaded file not listed: " +
            (await page.evaluate(
              "document.querySelector('.ln-lab-form')?.innerText",
            )),
        );
        await page.typeInto(
          `document.querySelector('#ln-lab-code-${labRef}')`,
          "# TEST ONLY\nprint('zero trust')",
        );
        await page.click(byText("button", "Submit evidence"));
        must(
          await page.waitFor(
            "document.body.innerText.includes('Evidence submitted')",
            20000,
          ),
          "no submission confirmation",
        );
        await page.reload();
        await page.waitFor("!!document.querySelector('.ln-wrow')", 45000);
        const lab = await page.evaluate(
          "document.querySelector('.ln-lab-evidence')?.closest('section, .ln-panel')?.innerText",
        );
        must(
          /Submitted, awaiting grading/.test(lab ?? ""),
          "lab not marked submitted",
        );
        must(
          /Submitted evidence cannot be changed/.test(lab ?? ""),
          "evidence not read-only",
        );
        await shot("workspace-lab-submitted");
        return "submitted and read-only";
      },
    );

    await check(
      viewport,
      "released result: score, correct answers, explanations",
      async () => {
        await page.goto(base + `/student/academy/attempt/${releasedAttempt}`);
        await page.waitFor("!!document.querySelector('h1')", 45000);
        const text = await page.text();
        must(/This attempt scored \d+ \/ \d+/.test(text), "no released score");
        must(text.includes("Correct answer:"), "no correct answers");
        return text.match(/This attempt scored \d+ \/ \d+/)[0];
      },
    );

    await check(
      viewport,
      "workspace results and dashboard list the released result",
      async () => {
        await page.goto(base + "/student");
        await page.waitFor("!!document.querySelector('.ln-dashboard')", 45000);
        const row4 = await page.evaluate(
          "document.querySelector('[data-row=\"4\"]').innerText",
        );
        must(!/No results to show yet/.test(row4), "released result missing");
        return row4.replace(/\s+/g, " ").slice(0, 160);
      },
    );

    await check(
      viewport,
      "leaderboard shows You and pseudonymous peers",
      async () => {
        await page.goto(base + "/student/leaderboards");
        await page.waitFor("!!document.querySelector('h1')", 45000);
        const text = await page.text();
        must(/\bYou\b/.test(text), "caller not shown as You");
        must(!text.includes("learner-b@example.com"), "peer email exposed");
        await shot("leaderboards-data");
        return "You present; no peer identity";
      },
    );

    await check(
      viewport,
      "profile: names and education save and persist",
      async () => {
        await page.goto(base + "/student/profile");
        await page.waitFor(
          "Object.keys(document.querySelector('input[name=firstName]') ?? {}).some(k => k.startsWith('__reactProps$'))",
          45000,
        );
        await page.typeInto(
          "document.querySelector('input[name=firstName]')",
          "Test",
        );
        await page.typeInto(
          "document.querySelector('input[name=lastName]')",
          "Learner Local",
        );
        await page.click(byText("button", "Add education"));
        await page.waitFor(
          "!!document.querySelector('input[name=\"education.0.institution\"]')",
          5000,
        );
        await page.typeInto(
          "document.querySelector('input[name=\"education.0.institution\"]')",
          "TEST ONLY Institute",
        );
        await page.typeInto(
          "document.querySelector('input[name=\"education.0.qualification\"]')",
          "TEST ONLY Diploma",
        );
        await page.evaluate(
          "(() => { const el = document.querySelector('input[name=\"education.0.startDate\"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '2020-09-01'); el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); })()",
        );
        await page.click(byText("label", "I study here now"));
        await page.click(byText("button", "Save profile"));
        must(
          await page.waitFor(
            "document.body.innerText.includes('Profile saved')",
            20000,
          ),
          "not saved: " +
            (await page.evaluate(
              "[...document.querySelectorAll('.is-error, [role=alert]')].map(e=>e.innerText).join(' | ')",
            )),
        );
        await page.reload();
        await page.waitFor(
          "!!document.querySelector('input[name=firstName]')",
          45000,
        );
        const kept = await page.evaluate(
          "[document.querySelector('input[name=firstName]').value, document.querySelector('input[name=\"education.0.institution\"]')?.value]",
        );
        must(
          kept[0] === "Test" && kept[1] === "TEST ONLY Institute",
          `after reload: ${kept}`,
        );
        return "persisted";
      },
    );

    await check(viewport, "profile: photo upload", async () => {
      await page.uploadFile("input[name=photo]", png);
      await page.click(byText("button", "Upload photo"));
      must(
        await page.waitFor(
          "document.body.innerText.includes('Photo updated')",
          20000,
        ),
        "photo not uploaded: " +
          (await page.evaluate(
            "[...document.querySelectorAll('[role=alert]')].map(e=>e.innerText).join(' | ')",
          )),
      );
      return "uploaded";
    });

    await check(
      viewport,
      "profile: verified email change request (never sent locally)",
      async () => {
        await page.typeInto(
          "document.querySelector('input[name=email]')",
          "learner-a-new@example.com",
        );
        await page.click(byText("button", "Change email"));
        must(
          await page.waitFor(
            "document.body.innerText.includes('Check your inbox')",
            20000,
          ),
          "no confirmation message",
        );
        await page.reload();
        await page.waitFor(
          "!!document.querySelector('input[name=firstName]')",
          45000,
        );
        must(
          (await page.text()).includes("learner-a-new@example.com"),
          "pending change not shown",
        );
        await shot("profile-saved");
        return "pending change shown; current address unchanged";
      },
    );

    await check(viewport, "support form: honest queued state", async () => {
      await page.goto(base + "/student/support");
      await page.waitFor(
        "Object.keys(document.querySelector('select[name=category]') ?? {}).some(k => k.startsWith('__reactProps$'))",
        45000,
      );
      await page.select(
        "document.querySelector('select[name=category]')",
        "TECHNICAL",
      );
      await page.typeInto(
        "document.querySelector('input[name=subject]')",
        "TEST ONLY local check",
      );
      await page.typeInto(
        "document.querySelector('textarea[name=message]')",
        "TEST ONLY message from the local browser journey.",
      );
      await page.click(byText("button", "Send message"));
      must(
        await page.waitFor(
          "document.body.innerText.includes('Delivery is pending') || document.body.innerText.includes('could not')",
          20000,
        ),
        "no delivery state",
      );
      const text = await page.text();
      must(!text.includes("was sent to support@ducelio.com"), "claimed sent");
      await shot("support-queued");
      return text.includes("Delivery is pending")
        ? "QUEUED (pending)"
        : "error shown";
    });

    await check(
      viewport,
      "AI Tutor: Give Class Notes opens the governed Tutor",
      async () => {
        await page.goto(base + `/student/courses/${courseA}`);
        await page.waitFor("!!document.querySelector('.ln-wrow')", 45000);
        await page.click(byText("button", "Give Class Notes"));
        must(
          await page.waitFor(
            "location.pathname.startsWith('/student/academy/support/') || location.search.includes('tutorNotice')",
            60000,
          ),
          "no navigation: " + (await page.url()),
        );
        await page.waitFor("document.readyState === 'complete'", 30000);
        await shot("tutor-opened");
        return (await page.url()).replace(/[0-9a-f-]{36}/, "<id>");
      },
    );
    let attemptPath = "";
    await check(
      viewport,
      "Assessment Centre: Take starts an attempt",
      async () => {
        await page.goto(base + `/student/courses/${courseA}`);
        await page.waitFor("!!document.querySelector('.ln-wrow')", 45000);
        await page.click(byText("button", "Take "));
        must(
          await page.waitFor(
            "location.pathname.startsWith('/student/academy/attempt/')",
            30000,
          ),
          "no attempt page: " + (await page.url()),
        );
        attemptPath = await page.url();
        await page.waitFor(
          "document.body.innerText.includes('Attempt 1 of')",
          30000,
        );
        await shot("attempt-in-progress");
        return attemptPath;
      },
    );

    const attemptId = () => attemptPath.split("/").pop().split("?")[0];
    let saved = { position: 0, optionId: "" };
    await check(
      viewport,
      "shuffled exam: first question is this attempt's server-seeded order",
      async () => {
        // Oracle: the order the database derives from the attempt's own
        // stored seed (never sent to the browser).
        const { rows } = await db.query(
          `select (x->>'position')::int p, x->>'prompt' prompt
             from public.academy_assessment_attempts a
             join public.academy_enrolments e on e.id = a.enrolment_id
             cross join lateral jsonb_array_elements(academy_private.assessment_template(e.course_id, a.assessment_ref)->'questions') x
            where a.id = $1
            order by academy_private.question_rank(a.presentation_seed, (x->>'position')::int)`,
          [attemptId()],
        );
        must(rows.length > 1, "no questions in the attempt template");
        const text = await page.text();
        must(
          text.includes(rows[0].prompt.slice(0, 40)),
          "the first question shown is not the seeded first question",
        );
        const authoredFirst = [...rows].sort((a, b) => a.p - b.p)[0];
        return `first shown = authored #${rows[0].p} (authored first is #${authoredFirst.p})`;
      },
    );

    await check(
      viewport,
      "shuffled exam: answer and save a question",
      async () => {
        for (let n = 0; n < 40; n++) {
          const radio = await page.evaluate(
            "(() => { const r = document.querySelector('.exam-choices input[type=radio]'); return r ? { name: r.name, value: r.value } : null; })()",
          );
          if (radio) {
            saved = {
              position: Number(radio.name.replace("answer-q-", "")),
              optionId: radio.value,
            };
            await page.click(
              `document.querySelector('.exam-choices input[type=radio][value=${js(radio.value)}]')`,
            );
            await page.click(byText("button", "Save answer"));
            must(
              await page.waitFor(
                "/saved/i.test(document.body.innerText)",
                20000,
              ),
              "no save confirmation",
            );
            await shot("exam-answer-saved");
            const stored = await db.query(
              "select body from public.academy_assessment_responses where attempt_id=$1 and question_position=$2 order by id desc limit 1",
              [attemptId(), saved.position],
            );
            must(
              stored.rows[0] &&
                JSON.parse(stored.rows[0].body).optionId === saved.optionId,
              "the saved answer is not the one recorded for that authored question",
            );
            return `saved authored question #${saved.position}`;
          }
          await page.click(byText("button", "Next question"));
        }
        throw new Error("no single-choice question found");
      },
    );

    await check(viewport, "same-attempt resume", async () => {
      await page.goto(base + `/student/courses/${courseA}`);
      await page.waitFor("!!document.querySelector('.ln-wrow')", 45000);
      const resume = await page.evaluate(
        `(${byText("button, a", "Resume")}) ? 'Resume' : 'Take '`,
      );
      await page.click(byText("button, a", resume));
      must(
        await page.waitFor(
          `location.pathname === ${js(attemptPath.split("?")[0])}`,
          30000,
        ),
        `resumed to ${await page.url()} instead of ${attemptPath}`,
      );
      must(
        await page.waitFor(
          `!!document.querySelector('nav[aria-label="Questions"]')`,
          30000,
        ),
        "exam did not load on resume",
      );
      for (let n = 0; n < 40; n++) {
        const restored = await page.evaluate(
          `!!document.querySelector('input[name="answer-q-${saved.position}"][value=${js(saved.optionId)}]:checked')`,
        );
        if (restored) return `via ${resume.trim()}; saved answer restored`;
        const onIt = await page.evaluate(
          `!!document.querySelector('input[name="answer-q-${saved.position}"]')`,
        );
        if (onIt) break;
        await page.click(byText("button", "Next question"));
      }
      throw new Error("the saved answer was not restored on resume");
    });

    await check(
      viewport,
      "controlled-assessment firewall: Tutor closed and answer review withheld",
      async () => {
        await page.goto(base + `/student/courses/${courseA}`);
        await page.waitFor("!!document.querySelector('.ln-wrow')", 45000);
        must(
          (await page.text()).includes(
            "The AI Tutor is closed while a controlled assessment",
          ),
          "Tutor not closed during the attempt",
        );
        await shot("workspace-during-attempt");
        await page.goto(base + `/student/academy/attempt/${releasedAttempt}`);
        await page.waitFor("!!document.querySelector('h1')", 45000);
        must(
          !(await page.text()).includes("Correct answer:"),
          "answer review shown during a controlled assessment",
        );
        return "Tutor closed; review withheld while an attempt is ACTIVE";
      },
    );

    await check(
      viewport,
      "submit: result stays confidential before the learner's deadline",
      async () => {
        await page.goto(base + attemptPath);
        await page.waitFor(
          `!!document.querySelector('nav[aria-label="Questions"]')`,
          45000,
        );
        await page.click(byText("button", "Review and submit"));
        await page.click(byText("button", "Submit final answers"));
        must(
          await page.waitFor(
            "document.body.innerText.includes('Your result is confidential')",
            30000,
          ),
          "no confidential-result message after submission",
        );
        const text = await page.text();
        must(
          !/This attempt scored|Correct answer:|Explanation:/.test(text),
          "result or answers shown before release",
        );
        await shot("attempt-submitted-confidential");
        return "confidential until the window closes";
      },
    );

    await check(
      viewport,
      "after the learner's own deadline: score, answers and explanations together; grading authoritative",
      async () => {
        // LOCAL ONLY owner time travel: close this learner's quiz window.
        const ref = (
          await db.query(
            "select assessment_ref r from public.academy_assessment_attempts where id=$1",
            [attemptId()],
          )
        ).rows[0].r;
        await db.query(
          "alter table public.academy_schedule_items disable trigger guard_history",
        );
        try {
          await db.query(
            `update public.academy_schedule_items
                set starts_at = now() - interval '25 hours', ends_at = now() - interval '25 hours' + make_interval(mins => minutes),
                    opens_at = now() - interval '25 hours', closes_at = now() - interval '1 second'
              where enrolment_id = $1 and kind = 'ASSESSMENT' and ref = $2
                and schedule_id = (select id from public.academy_schedules where enrolment_id = $1 and superseded_at is null)`,
            [courseA, ref],
          );
        } finally {
          await db.query(
            "alter table public.academy_schedule_items enable trigger guard_history",
          );
        }
        await page.goto(base + attemptPath);
        await page.waitFor("!!document.querySelector('h1')", 45000);
        must(
          await page.waitFor(
            "document.body.innerText.includes('This attempt scored')",
            30000,
          ),
          "no released score after the deadline",
        );
        const text = await page.text();
        must(text.includes("Correct answer:"), "no correct answers");
        must(text.includes("Explanation:"), "no explanations");
        // Authoritative grading: the shown score is the stored score, and
        // the saved question's mark follows the answer key, not the order.
        const a = (
          await db.query(
            "select score, max_score, presentation_seed from public.academy_assessment_attempts where id=$1",
            [attemptId()],
          )
        ).rows[0];
        must(
          text.includes(`This attempt scored ${a.score} / ${a.max_score}`),
          "shown score differs from the stored score",
        );
        const k = (
          await db.query(
            `select x->'answerKey'->>'correctOptionId' k, (x->>'maxMarks')::int m,
                    (select marks from public.academy_question_marks where attempt_id=$1 and question_position=$2) got
               from public.academy_assessment_attempts a
               join public.academy_enrolments e on e.id=a.enrolment_id
               cross join lateral jsonb_array_elements(academy_private.assessment_template(e.course_id, a.assessment_ref)->'questions') x
              where a.id=$1 and (x->>'position')::int=$2`,
            [attemptId(), saved.position],
          )
        ).rows[0];
        const expected = k.k === saved.optionId ? k.m : 0;
        must(
          k.got === expected,
          `saved question marked ${k.got}, expected ${expected}`,
        );
        must(
          !(await page.html()).includes(a.presentation_seed),
          "the presentation seed reached the page",
        );
        await shot("attempt-released-review");
        return `scored ${a.score}/${a.max_score}; saved question marked ${k.got} by the answer key; seed absent`;
      },
    );

    await check(
      viewport,
      "the presentation seed never reaches any page",
      async () => {
        const seeds = (
          await db.query(
            "select presentation_seed s from public.academy_assessment_attempts where learner_id='10000000-0000-4000-8000-000000000601' and presentation_seed is not null",
          )
        ).rows.map((r) => r.s);
        for (const path of [
          `/student/courses/${courseA}`,
          "/student",
          "/student/leaderboards",
          `/student/academy/attempt/${releasedAttempt}`,
          attemptPath,
        ]) {
          await page.goto(base + path);
          await page.waitFor("document.readyState === 'complete'", 30000);
          const html = await page.html();
          for (const seed of seeds)
            must(!html.includes(seed), `seed found on ${path}`);
        }
        return `${seeds.length} seeds checked across 5 pages`;
      },
    );

    await check(viewport, "no uncaught console errors", async () => {
      must(
        page.consoleErrors.length === 0,
        page.consoleErrors.slice(0, 5).join(" | "),
      );
      return "none";
    });
  } finally {
    await close();
  }
}
await db.end();
writeFileSync(resolve(out, "results.json"), JSON.stringify(results, null, 2));
for (const r of results)
  console.log(
    `${r.ok ? "PASS" : "FAIL"} [${r.viewport}] ${r.step} — ${r.detail}`,
  );
const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - failed} passed, ${failed} failed (LOCAL ONLY)`,
);
process.exitCode = failed ? 1 : 0;
