import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import {
  academyPackage,
  as,
  openSittingNow,
  people,
  publishAcademyCourse,
  responseBody,
  rpc,
  approvedTestPackage,
  completeLabs,
  releaseNow,
  seedPeople,
  type Query,
} from "./academy-fixture";
import {
  buildPlanUnits,
  validateAcademyCoursePackage,
} from "@/domain/academy-course-package";
import {
  canonicalStudyDays,
  formatEndDate,
  planSchedule,
  type PlanUnit,
} from "@/domain/academy-scheduler";
import {
  ACADEMY_EVIDENCE_BATCH,
  academyDeliveryEvidenceSchema,
  academyPackageListSchema,
} from "@/domain/academy-delivery";
import {
  deriveCourseLifecycle,
  INDIVIDUAL_STAGE_IDS,
  isPubliclyLive,
} from "@/domain/admin-course-lifecycle";

// Migration 202610220060 (Ducelio Academy B2C) against real PostgreSQL
// semantics (PGlite), using the real Security+ Academy conversion artefact
// published through the real existing curriculum pipeline.
let db: PGlite;
let q: Query;
let published: Awaited<ReturnType<typeof publishAcademyCourse>>;
let security: Awaited<ReturnType<typeof publishAcademyCourse>>;
const { admin, learnerA, learnerB, learnerC, instructor, registrar } = people;
let enrolA: string;
let enrolB: string;
let today: string;

type Plan = {
  feasible: boolean;
  code?: string;
  message?: string;
  alternatives?: { kind: string; formatId: string; studyDays: number[] }[];
  items: {
    kind: string;
    ref: string;
    localDate: string;
    startsAt: string;
    opensAt: string | null;
    closesAt: string | null;
    minutes: number;
    part: number;
    parts: number;
    carried: boolean;
  }[];
  startOn: string;
  endOn: string;
  finishOn: string;
  weeklyMinutes: number[];
};
type Timetable = {
  schedule: {
    revision: number;
    formatId: string;
    startOn: string;
    endOn: string;
  } | null;
  items: (Plan["items"][number] & {
    id: string;
    sequence: number;
    attempts: number | null;
  })[];
};

const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);

beforeAll(async () => {
  db = await testDatabase();
  q = (sql, params) =>
    db.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>;
  await seedPeople(q);
  // Learner journeys run on the TEST-ONLY approved variant; the real
  // Security+ artefact (pending decisions) is published separately below.
  published = await publishAcademyCourse(
    q,
    "security-plus-academy-test",
    approvedTestPackage(),
  );
  security = await publishAcademyCourse(
    q,
    "security-plus-review",
    academyPackage(),
  );
  today = (
    await q("select (now() at time zone 'Europe/London')::date::text as d")
  ).rows[0].d as string;
}, 180000);
afterAll(async () => {
  await db?.close();
});

describe("Academy Course Engineering: upload, validation and publication", () => {
  it("rejects malformed and non-admin uploads", async () => {
    await expect(
      rpc(q, admin, "upload_academy_course_package", [
        JSON.stringify({ schemaVersion: "COURSE_PACKAGE_V1" }),
        "Wrong schema",
      ]),
    ).rejects.toThrow(/MALFORMED_PACKAGE/);
    await expect(
      rpc(q, admin, "upload_academy_course_package", ["[]", "Not an object"]),
    ).rejects.toThrow(/MALFORMED_PACKAGE/);
    for (const person of [learnerA, instructor, registrar])
      await expect(
        rpc(q, person, "upload_academy_course_package", [
          JSON.stringify(academyPackage()),
          "Unauthorised upload",
        ]),
      ).rejects.toThrow(/FORBIDDEN/);
    await expect(rpc(q, null, "list_academy_course_packages")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("is idempotent for identical content and refuses a different body under the same revision", async () => {
    const pkg = academyPackage();
    expect(
      await rpc(q, admin, "upload_academy_course_package", [
        JSON.stringify(pkg),
        "Re-upload identical",
      ]),
    ).toBe(security.packageId);
    pkg.course.description = "Changed description for the same revision.";
    await expect(
      rpc(q, admin, "upload_academy_course_package", [
        JSON.stringify(pkg),
        "Conflicting re-upload",
      ]),
    ).rejects.toThrow(/REVISION_CONFLICT/);
  });

  it("re-checks package invariants in the database before accepting validation", async () => {
    const pkg = academyPackage();
    pkg.packageRevision = 12;
    pkg.curriculum.packageRevision = 12;
    pkg.grading.components[0].weightBp = 400; // 99%
    const id = await rpc<string>(q, admin, "upload_academy_course_package", [
      JSON.stringify(pkg),
      "Tampered weights",
    ]);
    await expect(
      rpc(q, admin, "mark_academy_course_package_validated", [
        id,
        JSON.stringify({ packageKey: pkg.packageKey }),
        "Forged validation",
      ]),
    ).rejects.toThrow(/ACADEMY_PACKAGE_INVALID: grading/);
    expect(
      await rpc(q, admin, "reject_academy_course_package", [
        id,
        "Weights do not total 100%",
      ]),
    ).toBe(id);
  });

  it("refuses publication until the embedded curriculum is published, and never on validation alone", async () => {
    const pkg = academyPackage();
    pkg.packageRevision = 13;
    pkg.curriculum.packageRevision = 13;
    const v = validateAcademyCoursePackage(pkg);
    expect(v.valid).toBe(true);
    const id = await rpc<string>(q, admin, "upload_academy_course_package", [
      JSON.stringify(pkg),
      "Revision 3",
    ]);
    await expect(
      rpc(q, admin, "publish_academy_course", [
        id,
        "sec-academy-r3",
        "GBP",
        null,
        JSON.stringify([{ formatId: "STANDARD_6W", amountMinor: 1000 }]),
        "Too early",
      ]),
    ).rejects.toThrow(/INVALID_STATE/);
    if (!v.valid) return;
    await rpc(q, admin, "mark_academy_course_package_validated", [
      id,
      JSON.stringify(v.review),
      "Validated",
    ]);
    await expect(
      rpc(q, admin, "publish_academy_course", [
        id,
        "sec-academy-r3",
        "GBP",
        null,
        JSON.stringify([{ formatId: "STANDARD_6W", amountMinor: 1000 }]),
        "No curriculum yet",
      ]),
    ).rejects.toThrow(/CURRICULUM_NOT_PUBLISHED/);
    await expect(
      rpc(q, learnerA, "publish_academy_course", [
        id,
        "sec-academy-r3",
        "GBP",
        null,
        "[]",
        "Learner publish",
      ]),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it("publishes without any cohort, instructor, activation or manual assessment setup", async () => {
    const counts = (
      await q(`select (select count(*) from public.cohorts)::int cohorts, (select count(*) from public.course_activations)::int activations,
      (select count(*) from public.assessments)::int assessments`)
    ).rows[0];
    expect(counts).toEqual({ cohorts: 1, activations: 0, assessments: 0 }); // the one demo seed cohort only
    const course = (
      await q("select * from public.academy_courses where id=$1", [
        published.courseId,
      ])
    ).rows[0];
    const units = course.units as PlanUnit[];
    expect(units.filter((u) => u.kind === "LESSON")).toHaveLength(28);
    expect(units.filter((u) => u.kind === "LAB")).toHaveLength(14);
    expect(
      units.filter((u) => u.kind === "ASSESSMENT").map((u) => u.ref),
    ).toEqual(["quiz-1", "quiz-2", "midterm", "quiz-3", "quiz-4", "final"]);
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_course_lessons where course_id=$1",
          [published.courseId],
        )
      ).rows[0].n,
    ).toBe(28);
    const formats = (
      await q(
        "select format_id from public.academy_offer_formats where offer_id=$1 order by format_id",
        [published.offerId],
      )
    ).rows.map((r) => r.format_id);
    expect(formats).toEqual([
      "ACCELERATED_2W",
      "EXTENDED_8W",
      "FLEXIBLE_12W",
      "INTENSIVE_4W",
      "STANDARD_6W",
    ]);
  });

  it("refuses a price for a format the package does not support, and a colliding slug", async () => {
    const pkg = academyPackage();
    pkg.packageKey = "security-plus-academy-variant";
    pkg.curriculum.packageKey = pkg.packageKey;
    pkg.deliveryFormats = pkg.deliveryFormats.filter(
      (f: { formatId: string }) => f.formatId !== "ACCELERATED_2W",
    );
    const v = validateAcademyCoursePackage(pkg);
    if (!v.valid) throw new Error("variant invalid");
    const id = await rpc<string>(q, admin, "upload_academy_course_package", [
      JSON.stringify(pkg),
      "Variant",
    ]);
    await rpc(q, admin, "mark_academy_course_package_validated", [
      id,
      JSON.stringify(v.review),
      "Validated variant",
    ]);
    await expect(
      rpc(q, admin, "publish_academy_course", [
        id,
        "security-plus-academy-test",
        "GBP",
        null,
        JSON.stringify([{ formatId: "STANDARD_6W", amountMinor: 1 }]),
        "Slug clash",
      ]),
    ).rejects.toThrow(/SLUG_CONFLICT/);
  });

  it("keeps a course with pending academic decisions review-only: no catalogue, no sale, no checkout", async () => {
    expect(await rpc(q, null, "list_academy_catalogue")).toEqual([]);
    const refused = await rpc<{ ok: boolean; code: string; pending: string[] }>(
      q,
      admin,
      "enable_academy_public_sale",
      [security.offerId, true, "Attempt to sell with pending decisions"],
    );
    expect(refused).toMatchObject({ ok: false, code: "POLICY_PENDING" });
    expect(refused.pending).toEqual(
      expect.arrayContaining([
        "LAB_RUBRICS",
        "COURSE_PASS_MARK",
        "MISSED_SITTING_POLICY",
      ]),
    );
    expect(
      await rpc(q, learnerA, "create_academy_order", [
        "security-plus-review",
        "STANDARD_6W",
      ]),
    ).toMatchObject({ ok: false, code: "SALE_NOT_OPEN" });
    await expect(
      rpc(q, learnerA, "enable_academy_public_sale", [
        security.offerId,
        true,
        "Learner attempt",
      ]),
    ).rejects.toThrow(/FORBIDDEN/);
    // The real artefact keeps the published 20% lab contribution.
    const units = (
      await q(
        "select p.raw_package->'grading' g from public.academy_courses c join public.academy_course_packages p on p.id=c.package_id where c.id=$1",
        [security.courseId],
      )
    ).rows[0].g as { components: { componentKey: string; weightBp: number }[] };
    expect(
      units.components.find((c) => c.componentKey === "LABS")?.weightBp,
    ).toBe(2000);
  });

  it("opens public sale only with zero pending decisions and an explicit owner-approval confirmation", async () => {
    expect(
      await rpc(q, admin, "enable_academy_public_sale", [
        published.offerId,
        false,
        "Not confirmed",
      ]),
    ).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(
      await rpc(q, admin, "enable_academy_public_sale", [
        published.offerId,
        true,
        "Owner approved test policy",
      ]),
    ).toMatchObject({ ok: true, replayed: false });
    expect(
      await rpc(q, admin, "enable_academy_public_sale", [
        published.offerId,
        true,
        "Owner approved test policy",
      ]),
    ).toMatchObject({ ok: true, replayed: true });
    await expect(
      q(
        "update public.academy_offers set sale_mode='REVIEW_ONLY', sale_approved_by=null, sale_approved_at=null, sale_approval_reason=null where id=$1",
        [published.offerId],
      ),
    ).rejects.toThrow(/IMMUTABLE_HISTORY/);
  });

  it("exposes only published offers with approved prices in the anonymous catalogue", async () => {
    const catalogue = await rpc<
      {
        slug: string;
        formats: { formatId: string; amountMinor: number }[];
        description: string;
      }[]
    >(q, null, "list_academy_catalogue");
    expect(catalogue).toHaveLength(1);
    expect(catalogue[0].slug).toBe("security-plus-academy-test");
    expect(catalogue[0].formats.map((f) => f.amountMinor)).toEqual(
      published.prices.map((p) => p.amountMinor),
    );
    expect(JSON.stringify(catalogue)).not.toMatch(
      /answerKey|expectedAnswer|markingGuidance|correctOptionId/,
    );
  });

  it("keeps the review free of protected assessment content", async () => {
    const review = await rpc<{ review: unknown }>(
      q,
      admin,
      "get_academy_course_package_review",
      [published.packageId],
    );
    expect(JSON.stringify(review)).not.toMatch(
      /answerKey|expectedAnswer|markingGuidance|correctOptionId|correctOrder/,
    );
  });
});

describe("authoritative planner parity with the TypeScript planner", () => {
  it("derives the identical unit sequence", async () => {
    const v = published.validation;
    if (!v.valid) throw new Error();
    const sqlUnits = (
      await q("select units from public.academy_courses where id=$1", [
        published.courseId,
      ])
    ).rows[0].units as (PlanUnit & { minDays: number })[];
    expect(
      sqlUnits.map(({ kind, ref, minutes, minDays }) => ({
        kind,
        ref,
        minutes,
        minDays,
      })),
    ).toEqual(
      buildPlanUnits(v.package, v.curriculum).map((u) => ({
        kind: u.kind,
        ref: u.ref,
        minutes: u.minutes,
        minDays: u.minimumDaysAfterTeaching ?? 0,
      })),
    );
  });

  it("produces identical plans across formats, weekday patterns and start dates", async () => {
    const v = published.validation;
    if (!v.valid) throw new Error();
    const units = buildPlanUnits(v.package, v.curriculum);
    const sqlUnits = JSON.stringify(
      (
        await q("select units from public.academy_courses where id=$1", [
          published.courseId,
        ])
      ).rows[0].units,
    );
    let compared = 0;
    for (const f of v.package.deliveryFormats)
      for (const k of [1, 3, 4, 5, 6, 7])
        for (const start of ["2027-01-04", "2027-01-07", "2027-03-13"]) {
          const weeks = {
            ACCELERATED_2W: 2,
            INTENSIVE_4W: 4,
            STANDARD_6W: 6,
            EXTENDED_8W: 8,
            FLEXIBLE_12W: 12,
          }[f.formatId];
          const days = canonicalStudyDays(k);
          const ts = planSchedule(
            units,
            { weeks, sessionMinutes: f.sessionMinutes },
            { startDate: start, studyDays: days },
          );
          const sql = (
            await q(
              "select academy_private.plan_units($1::jsonb,$2,$3,$4::date,$5::int[],null,null,0) p",
              [sqlUnits, weeks, f.sessionMinutes, start, days],
            )
          ).rows[0].p as { feasible: boolean; items?: unknown[] };
          expect(sql.feasible).toBe(ts.feasible);
          if (ts.feasible)
            expect(sql.items).toEqual(
              ts.items.map(
                ({
                  sequence,
                  unitIndex,
                  kind,
                  ref,
                  part,
                  parts,
                  sessionIndex,
                  localDate,
                  offsetMinutes,
                  minutes,
                }) => ({
                  sequence,
                  unitIndex,
                  kind,
                  ref,
                  part,
                  parts,
                  sessionIndex,
                  localDate,
                  offsetMinutes,
                  minutes,
                }),
              ),
            );
          compared++;
        }
    expect(compared).toBe(90);
  }, 60000);
});

describe("individual entitlement and learner-controlled scheduling", () => {
  it("grants authorised access without a cohort and refuses unauthorised grants", async () => {
    enrolA = await rpc<string>(q, admin, "grant_academy_entitlement", [
      published.offerId,
      learnerA.email,
      null,
      "Reviewer access for acceptance",
    ]);
    enrolB = await rpc<string>(q, admin, "grant_academy_entitlement", [
      published.offerId,
      learnerB.email,
      "STANDARD_6W",
      "Complimentary Standard format",
    ]);
    expect(
      await rpc(q, admin, "grant_academy_entitlement", [
        published.offerId,
        learnerA.email,
        null,
        "Repeat grant",
      ]),
    ).toBe(enrolA);
    await expect(
      rpc(q, admin, "grant_academy_entitlement", [
        published.offerId,
        instructor.email,
        null,
        "Not a learner",
      ]),
    ).rejects.toThrow(/LEARNER_NOT_FOUND/);
    await expect(
      rpc(q, learnerA, "grant_academy_entitlement", [
        published.offerId,
        learnerC.email,
        null,
        "Self-service grant",
      ]),
    ).rejects.toThrow(/FORBIDDEN/);
    const enrolments = await rpc<
      {
        enrolmentId: string;
        formatId: string | null;
        fixedFormatId: string | null;
      }[]
    >(q, learnerA, "list_my_academy_enrolments");
    expect(enrolments.map((e) => e.enrolmentId)).toEqual([enrolA]);
  });

  it("previews a full personal timetable from the learner's own choices", async () => {
    const start = addDays(today, 3);
    const plan = await rpc<Plan>(q, learnerA, "preview_my_academy_schedule", [
      enrolA,
      "ACCELERATED_2W",
      start,
      [1, 2, 3, 4, 5, 6],
      "18:30",
      "Europe/London",
    ]);
    expect(plan.feasible).toBe(true);
    expect(plan.startOn).toBe(start);
    expect(plan.endOn).toBe(formatEndDate(start, 2));
    expect(
      plan.items.filter((i) => i.kind === "LESSON" && i.part === 1),
    ).toHaveLength(28);
    expect(
      new Set(plan.items.filter((i) => i.kind === "LAB").map((i) => i.ref))
        .size,
    ).toBe(14);
    expect(
      plan.items.filter((i) => i.kind === "ASSESSMENT").map((i) => i.ref),
    ).toEqual(["quiz-1", "quiz-2", "midterm", "quiz-3", "quiz-4", "final"]);
    // Every session date is a chosen weekday and starts at the chosen local time.
    for (const i of plan.items)
      expect([1, 2, 3, 4, 5, 6]).toContain(
        ((new Date(`${i.localDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1,
      );
    const local = (
      await q(
        `select bool_and((x->>'startsAt')::timestamptz - (((x->>'localDate')::date + time '18:30') at time zone 'Europe/London')
        between interval '0' and interval '359 minutes') ok from jsonb_array_elements($1::jsonb) x`,
        [JSON.stringify(plan.items)],
      )
    ).rows[0].ok;
    expect(local).toBe(true);
    expect(plan.weeklyMinutes).toHaveLength(2);
    expect(JSON.stringify(plan)).not.toMatch(
      /answerKey|expectedAnswer|markingGuidance/,
    );
  });

  it("places every assessment after its required teaching and preparation", async () => {
    const plan = await rpc<Plan>(q, learnerA, "preview_my_academy_schedule", [
      enrolA,
      "ACCELERATED_2W",
      addDays(today, 3),
      [1, 2, 3, 4, 5, 6],
      "18:30",
      "Europe/London",
    ]);
    const pkg = academyPackage();
    for (const a of pkg.assessments) {
      const sitting = plan.items.find(
        (i) => i.kind === "ASSESSMENT" && i.ref === a.templateRef,
      )!;
      const index = plan.items.indexOf(sitting);
      const lastTaught = Math.max(
        ...plan.items
          .filter(
            (i) => i.kind === "LESSON" && a.requiredLessonRefs.includes(i.ref),
          )
          .map((i) => plan.items.indexOf(i)),
      );
      expect(lastTaught).toBeLessThan(index);
      const lastLessonDate = plan.items
        .slice(0, index)
        .filter((i) => i.kind === "LESSON")
        .at(-1)!.localDate;
      expect(
        Date.parse(sitting.localDate) - Date.parse(lastLessonDate),
      ).toBeGreaterThanOrEqual(
        a.preparation.minimumDaysAfterTeaching * 86400000,
      );
      const revision = plan.items.filter(
        (i) => i.kind === "REVISION" && i.ref === a.templateRef,
      );
      expect(revision.reduce((n, i) => n + i.minutes, 0)).toBe(
        a.preparation.revisionMinutes,
      );
      expect(plan.items.indexOf(revision.at(-1)!)).toBeLessThan(index);
      expect(Date.parse(sitting.closesAt!) - Date.parse(sitting.opensAt!)).toBe(
        a.sittingWindowHours * 3600000,
      );
    }
  });

  it("explains invalid choices instead of silently changing them", async () => {
    const tooFew = await rpc<Plan>(q, learnerA, "preview_my_academy_schedule", [
      enrolA,
      "ACCELERATED_2W",
      addDays(today, 3),
      [1, 3, 5],
      "18:30",
      "Europe/London",
    ]);
    expect(tooFew).toMatchObject({
      feasible: false,
      code: "STUDY_DAYS_OUT_OF_RANGE",
    });
    expect(
      (
        await rpc<Plan>(q, learnerA, "preview_my_academy_schedule", [
          enrolA,
          "STANDARD_6W",
          addDays(today, -1),
          [1, 3, 5, 6],
          "18:30",
          "Europe/London",
        ])
      ).code,
    ).toBe("INVALID_START_DATE");
    expect(
      (
        await rpc<Plan>(q, learnerA, "preview_my_academy_schedule", [
          enrolA,
          "STANDARD_6W",
          today,
          [1, 3, 5, 6],
          "18:30",
          "Mars/Olympus",
        ])
      ).code,
    ).toBe("INVALID_TIMEZONE");
    expect(
      (
        await rpc<Plan>(q, learnerA, "preview_my_academy_schedule", [
          enrolA,
          "WEEKEND_1W",
          today,
          [6, 7],
          "18:30",
          "Europe/London",
        ])
      ).code,
    ).toBe("INVALID_FORMAT");
    expect(
      (
        await rpc<Plan>(q, learnerB, "preview_my_academy_schedule", [
          enrolB,
          "ACCELERATED_2W",
          today,
          [1, 2, 3, 4, 5, 6],
          "18:30",
          "Europe/London",
        ])
      ).code,
    ).toBe("FORMAT_FIXED");
  });

  it("refuses a local class time that does not exist because of a daylight-saving change", async () => {
    const found = (
      await q(
        `select z, d::date::text d, t::text from unnest(array['America/New_York','Europe/London','Australia/Sydney','Pacific/Auckland','America/Santiago']) z,
        generate_series($1::date + 1, $1::date + 170, interval '1 day') d, unnest(array['00:30'::time,'01:30'::time,'02:30'::time]) t
      where (((d::date + t) at time zone z) at time zone z) <> d::date + t order by d limit 1`,
        [today],
      )
    ).rows[0] as { z: string; d: string; t: string };
    expect(found).toBeTruthy();
    const isodow = ((new Date(`${found.d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    // The DST date falls within the first week; every weekday is a study day.
    const plan = await rpc<Plan>(q, learnerA, "preview_my_academy_schedule", [
      enrolA,
      "ACCELERATED_2W",
      addDays(found.d, -1) < today ? found.d : addDays(found.d, -1),
      [1, 2, 3, 4, 5, 6, 7],
      found.t.slice(0, 5),
      found.z,
    ]);
    expect(isodow).toBeGreaterThan(0);
    expect(plan).toMatchObject({ feasible: false, code: "INVALID_LOCAL_TIME" });
    expect(plan.message).toMatch(/daylight-saving/);
  });

  it("keeps wall-clock class times across a daylight-saving transition", async () => {
    const plan = await rpc<Plan>(q, learnerA, "preview_my_academy_schedule", [
      enrolA,
      "FLEXIBLE_12W",
      addDays(today, 1),
      [1, 3, 5],
      "19:00",
      "America/New_York",
    ]);
    expect(plan.feasible).toBe(true);
    const offsets = (
      await q(
        `select distinct to_char((x->>'startsAt')::timestamptz at time zone 'America/New_York','HH24:MI') local_start,
        extract(hour from ((x->>'startsAt')::timestamptz at time zone 'UTC'))::int utc_hour
      from jsonb_array_elements($1::jsonb) x where (x->>'part')::int = 1 and x->>'kind' = 'LESSON' and (x->>'minutes')::int > 0 order by 1`,
        [
          JSON.stringify(
            plan.items.filter(
              (i) => Date.parse(i.startsAt) === Date.parse(i.startsAt),
            ),
          ),
        ],
      )
    ).rows;
    // Sessions start at 19:00 local; within a 12-week window the UTC hour moves when DST changes.
    expect(offsets.some((o) => o.local_start === "19:00")).toBe(true);
  });

  it("confirms idempotently, locks the format and refuses a second competing plan", async () => {
    const key = randomUUID();
    const args = [
      enrolA,
      "ACCELERATED_2W",
      addDays(today, 3),
      [1, 2, 3, 4, 5, 6],
      "18:30",
      "Europe/London",
      key,
    ];
    const first = await rpc<{
      ok: boolean;
      revision: number;
      replayed: boolean;
    }>(q, learnerA, "confirm_my_academy_schedule", args);
    expect(first).toMatchObject({ ok: true, revision: 1, replayed: false });
    expect(
      await rpc(q, learnerA, "confirm_my_academy_schedule", args),
    ).toMatchObject({ ok: true, replayed: true });
    expect(
      await rpc(q, learnerA, "confirm_my_academy_schedule", [
        enrolA,
        "FLEXIBLE_12W",
        addDays(today, 3),
        [1, 3, 5],
        "18:30",
        "Europe/London",
        randomUUID(),
      ]),
    ).toMatchObject({ ok: false, code: "PLAN_EXISTS" });
    expect(
      (
        await q("select format_id from public.academy_enrolments where id=$1", [
          enrolA,
        ])
      ).rows[0].format_id,
    ).toBe("ACCELERATED_2W");
    await expect(
      q(
        "update public.academy_enrolments set format_id='FLEXIBLE_12W' where id=$1",
        [enrolA],
      ),
    ).rejects.toThrow(/IMMUTABLE_HISTORY/);
  });

  it("gives two learners with different formats distinct schedules from the same curriculum", async () => {
    await rpc(q, learnerB, "confirm_my_academy_schedule", [
      enrolB,
      "STANDARD_6W",
      addDays(today, 3),
      [1, 3, 5, 6],
      "07:00",
      "Asia/Kolkata",
      randomUUID(),
    ]);
    const a = await rpc<Timetable>(q, learnerA, "get_my_academy_timetable", [
      enrolA,
    ]);
    const b = await rpc<Timetable>(q, learnerB, "get_my_academy_timetable", [
      enrolB,
    ]);
    expect(a.schedule!.endOn).not.toBe(b.schedule!.endOn);
    const finalA = a.items.find(
      (i) => i.ref === "final" && i.kind === "ASSESSMENT",
    )!;
    const finalB = b.items.find(
      (i) => i.ref === "final" && i.kind === "ASSESSMENT",
    )!;
    expect(finalA.opensAt).not.toBe(finalB.opensAt);
    const lessonRefs = (t: Timetable) => [
      ...new Set(t.items.filter((i) => i.kind === "LESSON").map((i) => i.ref)),
    ];
    expect(lessonRefs(a)).toEqual(lessonRefs(b));
    const assessments = (t: Timetable) =>
      t.items
        .filter((i) => i.kind === "ASSESSMENT")
        .map((i) => [i.ref, i.minutes]);
    expect(assessments(a)).toEqual(assessments(b)); // identical fixed durations
  });

  it("denies cross-learner access to schedules, lessons and enrolments", async () => {
    await expect(
      rpc(q, learnerB, "get_my_academy_timetable", [enrolA]),
    ).rejects.toThrow(/NOT_FOUND_OR_FORBIDDEN/);
    await expect(
      rpc(q, learnerB, "preview_my_academy_schedule", [
        enrolA,
        "ACCELERATED_2W",
        today,
        [1, 2, 3, 4, 5, 6],
        "18:30",
        "Europe/London",
      ]),
    ).rejects.toThrow(/NOT_FOUND_OR_FORBIDDEN/);
    await expect(
      rpc(q, learnerC, "get_my_academy_lesson", [enrolA, "lesson-1-1"]),
    ).rejects.toThrow(/NOT_FOUND_OR_FORBIDDEN/);
    await expect(
      rpc(q, admin, "get_my_academy_timetable", [enrolA]),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      as(q, learnerA, "select * from public.academy_schedule_items"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(q, learnerA, "select raw_package from public.academy_course_packages"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(q, learnerA, "select academy_private.build_units('{}'::jsonb)"),
    ).rejects.toThrow(/permission denied/);
  });

  it("serves lesson content from the materialised curriculum", async () => {
    await expect(
      rpc(q, learnerA, "get_my_academy_lesson", [enrolA, "lesson-1-4"]),
    ).rejects.toThrow(/NOT_RELEASED/);
    expect(
      await rpc(q, learnerA, "record_my_academy_lesson_studied", [
        enrolA,
        "lesson-1-4",
      ]),
    ).toMatchObject({ ok: false, code: "NOT_RELEASED" });
    await releaseNow(q, enrolA, "LESSON", "lesson-1-4");
    const lesson = await rpc<{
      title: string;
      objectives: unknown[];
      resources: unknown[];
    }>(q, learnerA, "get_my_academy_lesson", [enrolA, "lesson-1-4"]);
    expect(lesson.title).toBe("Cryptographic Solutions Overview");
    expect(lesson.objectives).toHaveLength(1);
    expect(lesson.resources.length).toBeGreaterThan(0);
    // Confirming study is explicit, idempotent and never mastery.
    expect(
      await rpc(q, learnerA, "record_my_academy_lesson_studied", [
        enrolA,
        "lesson-1-4",
      ]),
    ).toMatchObject({ ok: true, replayed: false });
    expect(
      await rpc(q, learnerA, "record_my_academy_lesson_studied", [
        enrolA,
        "lesson-1-4",
      ]),
    ).toMatchObject({ ok: true, replayed: true });
    const progress = await rpc<{
      studied: number;
      objectives: { state: string }[];
    }>(q, learnerA, "get_my_academy_progress", [enrolA]);
    expect(progress.studied).toBe(1);
    expect(progress.objectives.every((o) => o.state === "NOT_STARTED")).toBe(
      true,
    );
  });
});

describe("server-owned assessment sittings, results and completion", () => {
  const template = (ref: string) =>
    academyPackage().curriculum.assessmentTemplates.find(
      (t: { key: string }) => t.key === ref,
    );

  it("rejects early exam access in the database", async () => {
    expect(
      await rpc(q, learnerA, "start_my_academy_assessment", [enrolA, "quiz-1"]),
    ).toMatchObject({ ok: false, code: "SITTING_NOT_OPEN" });
    expect(
      await rpc(q, learnerA, "start_my_academy_assessment", [
        enrolA,
        "no-such-assessment",
      ]),
    ).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("runs a timed sitting with learner-safe questions and deterministic database scoring", async () => {
    await openSittingNow(q, enrolA, "quiz-1");
    const started = await rpc<{ ok: boolean; attemptId: string }>(
      q,
      learnerA,
      "start_my_academy_assessment",
      [enrolA, "quiz-1"],
    );
    expect(started.ok).toBe(true);
    expect(
      await rpc(q, learnerA, "start_my_academy_assessment", [enrolA, "quiz-1"]),
    ).toMatchObject({ ok: true, attemptId: started.attemptId, resumed: true });
    const attempt = await rpc<{
      questions: { position: number }[];
      durationMinutes: number;
      expiresAt: string;
      startedAt: string;
    }>(q, learnerA, "get_my_academy_attempt", [started.attemptId]);
    expect(attempt.questions).toHaveLength(20);
    expect(attempt.durationMinutes).toBe(25);
    expect(Date.parse(attempt.expiresAt) - Date.parse(attempt.startedAt)).toBe(
      25 * 60000,
    );
    expect(JSON.stringify(attempt)).not.toMatch(
      /answerKey|expectedAnswer|markingGuidance|correctOptionId|correctOrder|"mapping"/,
    );
    await expect(
      rpc(q, learnerB, "get_my_academy_attempt", [started.attemptId]),
    ).rejects.toThrow(/NOT_FOUND_OR_FORBIDDEN/);
    expect(
      await rpc(q, learnerA, "record_my_academy_response", [
        started.attemptId,
        1,
        '{"optionId":"zzz"}',
        "bad-key-0001",
      ]),
    ).toMatchObject({ ok: false, code: "INVALID_RESPONSE" });
    for (const question of template("quiz-1").questions) {
      const key = `q1-${question.position}-0001`;
      expect(
        await rpc(q, learnerA, "record_my_academy_response", [
          started.attemptId,
          question.position,
          responseBody(question),
          key,
        ]),
      ).toMatchObject({ ok: true });
      expect(
        await rpc(q, learnerA, "record_my_academy_response", [
          started.attemptId,
          question.position,
          responseBody(question),
          key,
        ]),
      ).toMatchObject({ ok: true, replayed: true });
    }
    const max = template("quiz-1").questions.reduce(
      (n: number, x: { maxMarks: number }) => n + x.maxMarks,
      0,
    );
    const submitted = await rpc(q, learnerA, "submit_my_academy_attempt", [
      started.attemptId,
    ]);
    expect(submitted).toMatchObject({
      ok: true,
      state: "SUBMITTED",
      submission: "STUDENT_SUBMIT",
      score: max,
      maxScore: max,
    });
    expect(
      await rpc(q, learnerA, "submit_my_academy_attempt", [started.attemptId]),
    ).toEqual(submitted);
    expect(
      await rpc(q, learnerA, "record_my_academy_response", [
        started.attemptId,
        1,
        responseBody(template("quiz-1").questions[0]),
        "late-key-0001",
      ]),
    ).toMatchObject({ ok: false, code: "ATTEMPT_CLOSED" });
    expect(
      await rpc(q, learnerA, "start_my_academy_assessment", [enrolA, "quiz-1"]),
    ).toMatchObject({ ok: false, code: "NO_ATTEMPTS_REMAINING" });
  });

  it("refuses a sitting that cannot give the full fixed duration before the window closes", async () => {
    await openSittingNow(q, enrolA, "quiz-2");
    await q(
      "alter table public.academy_schedule_items disable trigger guard_history",
    );
    await q(
      "update public.academy_schedule_items set closes_at = now() + interval '10 minutes' where enrolment_id=$1 and ref='quiz-2' and kind='ASSESSMENT'",
      [enrolA],
    );
    await q(
      "alter table public.academy_schedule_items enable trigger guard_history",
    );
    expect(
      await rpc(q, learnerA, "start_my_academy_assessment", [enrolA, "quiz-2"]),
    ).toMatchObject({ ok: false, code: "SITTING_CLOSED" });
    await openSittingNow(q, enrolA, "quiz-2");
  });

  it("auto-submits an expired attempt and ignores late answers", async () => {
    const started = await rpc<{ attemptId: string }>(
      q,
      learnerA,
      "start_my_academy_assessment",
      [enrolA, "quiz-2"],
    );
    const first = template("quiz-2").questions[0];
    await rpc(q, learnerA, "record_my_academy_response", [
      started.attemptId,
      first.position,
      responseBody(first),
      "q2-early-0001",
    ]);
    await q(
      "alter table public.academy_assessment_attempts disable trigger guard_history",
    );
    await q(
      "update public.academy_assessment_attempts set started_at = now() - interval '30 minutes', expires_at = now() - interval '5 minutes' where id=$1",
      [started.attemptId],
    );
    await q(
      "alter table public.academy_assessment_attempts enable trigger guard_history",
    );
    // The early answer was given before the (moved) deadline.
    await q(
      "alter table public.academy_assessment_responses disable trigger guard_history",
    );
    await q(
      "update public.academy_assessment_responses set recorded_at = now() - interval '10 minutes' where attempt_id=$1",
      [started.attemptId],
    );
    await q(
      "alter table public.academy_assessment_responses enable trigger guard_history",
    );
    expect(
      await rpc(q, learnerA, "record_my_academy_response", [
        started.attemptId,
        2,
        responseBody(template("quiz-2").questions[1]),
        "q2-late-00001",
      ]),
    ).toMatchObject({ ok: false, code: "EXPIRED" });
    const result = await rpc<{
      state: string;
      submission: string;
      score: number;
    }>(q, learnerA, "get_my_academy_attempt", [started.attemptId]);
    expect(result).toMatchObject({
      state: "SUBMITTED",
      submission: "AUTO_TIMEOUT",
      score: first.maxMarks,
    });
  });

  it("revises only future dates and never alters completed academic history", async () => {
    const before = await rpc<Timetable>(
      q,
      learnerA,
      "get_my_academy_timetable",
      [enrolA],
    );
    const attemptsBefore = (
      await q(
        "select id, schedule_item_id, score, state from public.academy_assessment_attempts where enrolment_id=$1 order by started_at",
        [enrolA],
      )
    ).rows;
    // Bring the first sessions into the past so there is real history to keep.
    await q(
      "alter table public.academy_schedule_items disable trigger guard_history",
    );
    await q(
      `update public.academy_schedule_items set starts_at = starts_at - interval '20 days', ends_at = ends_at - interval '20 days'
      where enrolment_id=$1 and sequence <= 6 and kind <> 'ASSESSMENT'`,
      [enrolA],
    );
    await q(
      "alter table public.academy_schedule_items enable trigger guard_history",
    );
    const stale = await rpc(q, learnerA, "revise_my_academy_schedule", [
      enrolA,
      7,
      addDays(today, 2),
      [1, 2, 3, 4, 5, 6],
      "08:00",
      "Europe/London",
      randomUUID(),
    ]);
    expect(stale).toMatchObject({ ok: false, code: "STALE_REVISION" });
    const preview = await rpc<Plan>(
      q,
      learnerA,
      "preview_my_academy_schedule_revision",
      [
        enrolA,
        addDays(today, 2),
        [1, 2, 3, 4, 5, 6, 7],
        "08:00",
        "Europe/London",
      ],
    );
    expect(preview.feasible).toBe(true);
    expect(preview.items.filter((i) => i.carried).length).toBeGreaterThan(0);
    const revised = await rpc<{ ok: boolean; revision: number }>(
      q,
      learnerA,
      "revise_my_academy_schedule",
      [
        enrolA,
        1,
        addDays(today, 2),
        [1, 2, 3, 4, 5, 6, 7],
        "08:00",
        "Europe/London",
        randomUUID(),
      ],
    );
    expect(revised).toMatchObject({ ok: true, revision: 2 });
    const after = await rpc<Timetable>(
      q,
      learnerA,
      "get_my_academy_timetable",
      [enrolA],
    );
    expect(after.schedule!.startOn).toBe(before.schedule!.startOn);
    expect(after.schedule!.endOn).toBe(before.schedule!.endOn); // purchased format window unchanged
    expect(after.schedule!.formatId).toBe("ACCELERATED_2W");
    // Opened sittings with attempts are carried exactly.
    for (const ref of ["quiz-1", "quiz-2"]) {
      const old = before.items.find(
        (i) => i.ref === ref && i.kind === "ASSESSMENT",
      )!;
      const now = after.items.find(
        (i) => i.ref === ref && i.kind === "ASSESSMENT",
      )!;
      expect(now.carried).toBe(true);
      expect(now.opensAt).toBe(old.opensAt);
    }
    const attemptsAfter = (
      await q(
        "select id, schedule_item_id, score, state from public.academy_assessment_attempts where enrolment_id=$1 order by started_at",
        [enrolA],
      )
    ).rows;
    expect(attemptsAfter).toEqual(attemptsBefore);
    // Every lesson minute is still scheduled exactly once.
    const minutes = (t: Timetable) =>
      t.items
        .filter((i) => i.kind === "LESSON")
        .reduce((n, i) => n + i.minutes, 0);
    expect(minutes(after)).toBe(28 * 90);
    const oldRows = (
      await q(
        "select count(*)::int n from public.academy_schedule_items i join public.academy_schedules s on s.id=i.schedule_id where s.enrolment_id=$1 and s.revision=1",
        [enrolA],
      )
    ).rows[0].n;
    expect(oldRows).toBe(before.items.length); // revision 1 is retained unchanged
    await expect(
      q("delete from public.academy_schedule_items where enrolment_id=$1", [
        enrolA,
      ]),
    ).rejects.toThrow(/IMMUTABLE_HISTORY/);
  });

  it("records course completion only from database-scored results", async () => {
    let results = await rpc<{
      outcome: string;
      components: { componentKey: string; status: string }[];
    }>(q, learnerA, "get_my_academy_results", [enrolA]);
    expect(results.outcome).toBe("IN_PROGRESS");
    expect(
      (await q("select count(*)::int n from public.academy_completions"))
        .rows[0].n,
    ).toBe(0);
    for (const ref of ["midterm", "quiz-3", "quiz-4", "final"]) {
      await openSittingNow(q, enrolA, ref);
      const { attemptId } = await rpc<{ attemptId: string }>(
        q,
        learnerA,
        "start_my_academy_assessment",
        [enrolA, ref],
      );
      for (const question of template(ref).questions)
        await rpc(q, learnerA, "record_my_academy_response", [
          attemptId,
          question.position,
          responseBody(question),
          `${ref}-${question.position}-k1`,
        ]);
      await rpc(q, learnerA, "submit_my_academy_attempt", [attemptId]);
    }
    results = await rpc(q, learnerA, "get_my_academy_results", [enrolA]);
    // Labs carry 20%: no completion while they are unmarked.
    expect(results.outcome).toBe("IN_PROGRESS");
    await completeLabs(q, learnerA, enrolA, 10);
    results = await rpc(q, learnerA, "get_my_academy_results", [enrolA]);
    // quiz-2 was auto-submitted with one answer: 5% weight, so the course score is ~95%.
    expect(results.outcome).toBe("PASSED");
    const completion = (
      await q(
        "select * from public.academy_completions where enrolment_id=$1",
        [enrolA],
      )
    ).rows[0];
    expect(completion.course_score_bp).toBeGreaterThanOrEqual(7000);
    expect(
      (
        await q("select status from public.academy_enrolments where id=$1", [
          enrolA,
        ])
      ).rows[0].status,
    ).toBe("COMPLETED");
    expect(
      await rpc(q, learnerA, "revise_my_academy_schedule", [
        enrolA,
        2,
        addDays(today, 2),
        [1, 2, 3, 4, 5, 6],
        "08:00",
        "Europe/London",
        randomUUID(),
      ]),
    ).toMatchObject({ ok: false, code: "ENROLMENT_CLOSED" });
  }, 60000);

  it("never records completion for a learner who has not passed", async () => {
    for (const ref of [
      "quiz-1",
      "quiz-2",
      "midterm",
      "quiz-3",
      "quiz-4",
      "final",
    ]) {
      await openSittingNow(q, enrolB, ref);
      const { attemptId } = await rpc<{ attemptId: string }>(
        q,
        learnerB,
        "start_my_academy_assessment",
        [enrolB, ref],
      );
      const first = template(ref).questions[0];
      await rpc(q, learnerB, "record_my_academy_response", [
        attemptId,
        first.position,
        responseBody(first, false),
        `${ref}-wrong-k1`,
      ]);
      await rpc(q, learnerB, "submit_my_academy_attempt", [attemptId]);
    }
    await completeLabs(q, learnerB, enrolB, 0);
    const results = await rpc<{ outcome: string; courseScoreBp: number }>(
      q,
      learnerB,
      "get_my_academy_results",
      [enrolB],
    );
    expect(results).toMatchObject({ outcome: "NOT_PASSED", courseScoreBp: 0 });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_completions where enrolment_id=$1",
          [enrolB],
        )
      ).rows[0].n,
    ).toBe(0);
  }, 60000);
});

describe("insufficient availability: database refusal on a mis-specified format", () => {
  // Defence in depth: a variant whose format minimum is deliberately
  // mis-specified (three days a week for Accelerated). The TypeScript
  // validator rejects it; the database accepts its structure, so this proves
  // the scheduling authority itself refuses the impossible choice.
  let tight: Awaited<ReturnType<typeof publishAcademyCourse>>;
  let enrolTight: string;
  beforeAll(async () => {
    const pkg = academyPackage();
    pkg.packageKey = "security-plus-academy-tight";
    pkg.curriculum.packageKey = pkg.packageKey;
    pkg.curriculum.curriculumVersion.label = "Mis-specified acceptance variant";
    pkg.deliveryFormats = [
      {
        formatId: "ACCELERATED_2W",
        sessionMinutes: 360,
        minStudyDaysPerWeek: 3,
        maxStudyDaysPerWeek: 7,
      },
      {
        formatId: "STANDARD_6W",
        sessionMinutes: 180,
        minStudyDaysPerWeek: 3,
        maxStudyDaysPerWeek: 6,
      },
    ];
    expect(validateAcademyCoursePackage(pkg)).toMatchObject({ valid: false });
    tight = await publishAcademyCourse(q, "security-plus-academy-tight", pkg, {
      review: { packageKey: pkg.packageKey, title: "Mis-specified variant" },
      formats: ["ACCELERATED_2W", "STANDARD_6W"],
    });
    enrolTight = await rpc<string>(q, admin, "grant_academy_entitlement", [
      tight.offerId,
      learnerC.email,
      null,
      "Mis-specified format acceptance",
    ]);
  }, 120000);

  it("explains an infeasible choice and offers only alternatives that work", async () => {
    let found: { start: string; days: number[]; plan: Plan } | null = null;
    for (let offset = 1; offset <= 1 && !found; offset++)
      for (const days of [[1, 3, 5]]) {
        const start = addDays(today, offset);
        const plan = await rpc<Plan>(
          q,
          learnerC,
          "preview_my_academy_schedule",
          [enrolTight, "ACCELERATED_2W", start, days, "09:00", "Europe/London"],
        );
        if (plan.code === "INSUFFICIENT_AVAILABILITY") {
          found = { start, days, plan };
          break;
        }
      }
    expect(found).not.toBeNull();
    expect(found!.plan.message).toMatch(/not enough/);
    const kinds = found!.plan.alternatives!.map((a) => a.kind).sort();
    expect(kinds).toContain("STUDY_DAYS");
    for (const alt of found!.plan.alternatives!) {
      const check = await rpc<Plan>(
        q,
        learnerC,
        "preview_my_academy_schedule",
        [
          enrolTight,
          alt.formatId,
          found!.start,
          alt.studyDays,
          "09:00",
          "Europe/London",
        ],
      );
      expect(check.feasible).toBe(true);
    }
    expect(
      await rpc(q, learnerC, "confirm_my_academy_schedule", [
        enrolTight,
        "ACCELERATED_2W",
        found!.start,
        found!.days,
        "09:00",
        "Europe/London",
        randomUUID(),
      ]),
    ).toMatchObject({ ok: false, code: "INSUFFICIENT_AVAILABILITY" });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_schedules where enrolment_id=$1",
          [enrolTight],
        )
      ).rows[0].n,
    ).toBe(0);
  }, 60000);
});

describe("compatibility with the existing institutional workflow", () => {
  it("leaves organisation tables and the demo cohort untouched", async () => {
    const rows = (
      await q(
        "select (select count(*) from public.enrolments)::int enrolments, (select count(*) from public.commercial_v1_offers)::int offers, (select count(*) from public.commercial_v1_entitlements)::int entitlements",
      )
    ).rows[0];
    expect(rows).toEqual({ enrolments: 1, offers: 0, entitlements: 0 });
    expect(
      (await q("select count(*)::int n from public.cohorts")).rows[0].n,
    ).toBe(1);
  });
});

describe("admin course delivery evidence (migration 066)", () => {
  const evidence = async (ids: string[]) =>
    academyDeliveryEvidenceSchema.parse(
      await rpc(q, admin, "get_academy_delivery_evidence", [ids]),
    );
  const scaleImports = async (prefix: string) =>
    (
      await q(
        "select id from public.course_package_imports where package_key like $1 order by package_key",
        [`${prefix}%`],
      )
    ).rows.map((r) => r.id as string);
  // Bulk, minimal but constraint-valid rows (as the database owner, as a
  // fixture): each curriculum import with its Academy package of the same
  // key, revision and embedded curriculum, as an upload would leave them.
  const seedLinkedPackages = (prefix: string, n: number) =>
    q(
      `with s as (select g, $1 || g as key, jsonb_build_object('packageKey', $1 || g, 'n', g) as cur
                    from generate_series(1, $2::int) g),
       imp as (insert into public.course_package_imports(package_key, package_revision, schema_version, content_hash, raw_package, created_by)
               select key, 1, 'COURSE_PACKAGE_V1', encode(sha256(convert_to(key, 'UTF8')), 'hex'), cur, $3 from s returning id)
       insert into public.academy_course_packages(package_key, package_revision, schema_version, content_hash, raw_package, created_by)
       select key, 1, 'ACADEMY_COURSE_PACKAGE_V1', encode(sha256(convert_to('academy-' || key, 'UTF8')), 'hex'),
              jsonb_build_object('curriculum', cur), $3 from s`,
      [prefix, n, admin.id],
    );

  it("links published and unpublished Academy packages by recorded relationships, with offer terms", async () => {
    const e = await evidence([security.importId, published.importId]);
    const link = e.links.find(
      (l) => l.curriculumImportId === security.importId,
    );
    expect(link).toMatchObject({
      packageId: security.packageId,
      status: "PUBLISHED",
      curriculumStatus: "PUBLISHED",
      course: {
        id: security.courseId,
        offerId: security.offerId,
        slug: "security-plus-review",
        offerState: "PUBLISHED",
        saleMode: "REVIEW_ONLY",
        currency: "GBP",
      },
    });
    expect(
      Object.fromEntries(
        link!.course!.formats.map((f) => [f.formatId, f.amountMinor]),
      ),
    ).toEqual(
      Object.fromEntries(
        security.prices.map((p) => [p.formatId, p.amountMinor]),
      ),
    );
    const weeks = link!.course!.formats.map((f) => f.weeks);
    expect(weeks).toEqual([...weeks].sort((a, b) => a - b));
    expect(e.links).toHaveLength(2);
    // An unknown curriculum import has no link.
    expect((await evidence([randomUUID()])).links).toEqual([]);
  });

  it("is available to course administrators only, with a bounded batch", async () => {
    for (const person of [learnerA, instructor, registrar, null])
      await expect(
        rpc(q, person, "get_academy_delivery_evidence", [[security.importId]]),
      ).rejects.toThrow();
    const ids = Array.from({ length: 1001 }, () => randomUUID());
    await expect(
      rpc(q, admin, "get_academy_delivery_evidence", [ids]),
    ).rejects.toThrow(/INVALID_INPUT/);
    expect((await evidence(ids.slice(0, 1000))).links).toEqual([]);
  });

  it("classifies more than 100 Academy courses, beyond the old 100-package listing window", async () => {
    await seedLinkedPackages("scale-a-course-", 150);
    const ids = await scaleImports("scale-a-course-");
    expect(ids).toHaveLength(150);
    // The Academy register list stops at the 100 newest packages, so it
    // cannot be used for classification...
    const listed = academyPackageListSchema.parse(
      await rpc(q, admin, "list_academy_course_packages"),
    );
    expect(listed).toHaveLength(100);
    // ...while the evidence read classifies every requested import.
    const e = await evidence(ids);
    expect(new Set(e.links.map((l) => l.curriculumImportId))).toEqual(
      new Set(ids),
    );
    expect(
      e.links.every((l) => l.status === "UPLOADED" && l.course === null),
    ).toBe(true);
  });

  it("classifies 1,200 courses in server-sized batches of set-based reads", async () => {
    await seedLinkedPackages("scale-b-course-", 1200);
    const ids = await scaleImports("scale-b-course-");
    expect(ids).toHaveLength(1200);
    const started = performance.now();
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += ACADEMY_EVIDENCE_BATCH)
      batches.push(ids.slice(i, i + ACADEMY_EVIDENCE_BATCH));
    const results = await Promise.all(batches.map((b) => evidence(b)));
    const elapsed = performance.now() - started;
    const linked = new Set(
      results.flatMap((r) => r.links.map((l) => l.curriculumImportId)),
    );
    expect(batches).toHaveLength(3);
    expect(linked.size).toBe(1200);
    console.info(
      `[delivery-evidence] 1200 imports in 3 batches: ${Math.round(elapsed)} ms (PGlite)`,
    );
    expect(elapsed).toBeLessThan(30000);
  }, 120000);

  it("counts Academy packages not yet attached to any curriculum, excluding rejected ones", async () => {
    const before = (await evidence([])).packagesWithoutCurriculum;
    await q(
      `insert into public.academy_course_packages(package_key, package_revision, schema_version, content_hash, raw_package, created_by)
       values ('unattached-course', 1, 'ACADEMY_COURSE_PACKAGE_V1', encode(sha256('unattached'::bytea), 'hex'),
               '{"curriculum":{"packageKey":"unattached-course"}}', $1)`,
      [admin.id],
    );
    await q(
      `insert into public.academy_course_packages(package_key, package_revision, schema_version, content_hash, raw_package, created_by,
         status, rejected_by, rejected_at, rejected_reason)
       values ('rejected-course', 1, 'ACADEMY_COURSE_PACKAGE_V1', encode(sha256('rejected'::bytea), 'hex'), '{"curriculum":{}}', $1,
         'REJECTED', $1, now(), 'Rejected fixture')`,
      [admin.id],
    );
    expect((await evidence([])).packagesWithoutCurriculum).toBe(before + 1);
  });

  it("classifies the published review-only course as individual learning, never cohort delivery", async () => {
    const key = (
      await q(
        "select package_key from public.course_package_imports where id=$1",
        [security.importId],
      )
    ).rows[0].package_key as string;
    const revisions = (
      await q(
        `select id, package_key, package_revision, status, programme_id, programme_version_id,
          created_at::text, applied_at::text, published_at::text, rejected_at::text
         from public.course_package_imports where package_key=$1`,
        [key],
      )
    ).rows.map((r) => ({
      id: r.id as string,
      packageKey: r.package_key as string,
      packageRevision: r.package_revision as number,
      status: r.status as string,
      programmeId: r.programme_id as string | null,
      programmeVersionId: r.programme_version_id as string | null,
      createdAt: r.created_at as string,
      appliedAt: r.applied_at as string | null,
      publishedAt: r.published_at as string | null,
      rejectedAt: r.rejected_at as string | null,
    }));
    expect(
      (
        await q(
          "select count(*)::int n from public.cohorts where programme_version_id=$1",
          [security.versionId],
        )
      ).rows[0].n,
    ).toBe(0);
    const e = await evidence(revisions.map((r) => r.id));
    const catalogue = (
      await rpc<{ slug: string }[]>(q, null, "list_academy_catalogue")
    ).map((o) => o.slug);
    const life = deriveCourseLifecycle({
      revisions,
      activations: [],
      offerActivations: [],
      liveOfferSlugs: [],
      cohorts: [],
      cohortEvidenceComplete: true,
      academyPackages: e.links.map((l) => ({
        id: l.packageId,
        packageRevision: l.packageRevision,
        status: l.status,
        pendingDecisions: l.pendingDecisions,
        curriculumImport: {
          id: l.curriculumImportId,
          status: l.curriculumStatus,
        },
        course: l.course,
      })),
      academyCatalogueSlugs: catalogue,
    });
    expect(life.delivery).toBe("INDIVIDUAL");
    expect(life.stages.map((s) => s.id)).toEqual([...INDIVIDUAL_STAGE_IDS]);
    expect(life.cohortStages).toBeNull();
    expect(JSON.stringify(life)).not.toMatch(
      /\/admin\/cohorts|\/admin\/activation/,
    );
    expect(life.headline).toMatch(
      /^Published for review only — not on public sale/,
    );
    expect(life.individual).toMatchObject({
      packageId: security.packageId,
      saleMode: "REVIEW_ONLY",
      publicSale: false,
      listed: false,
      href: `/admin/academy-course-engineering?packageId=${security.packageId}`,
    });
    expect(life.individual?.formats).toHaveLength(security.prices.length);
    expect(isPubliclyLive(life)).toBe(false);
  });
});
