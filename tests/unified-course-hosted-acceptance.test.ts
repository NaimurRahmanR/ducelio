// Explicitly opted-in, owner-authorised hosted acceptance. Never pointed at
// DUCELIO_TEST_POSTGRES_URL, never part of ordinary CI fixture writes.
// $env:DUCELIO_RUN_UNIFIED_HOSTED_ACCEPTANCE='true'
// $env:ACCEPTANCE_WRITE_ENABLED='true'
// $env:CP2F_CA_FILE='<existing verified Supabase CA>'
// npm.cmd test -- tests/unified-course-hosted-acceptance.test.ts --maxWorkers=1
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildUnifiedAcceptancePackage } from "../scripts/acceptance/unified-fixture.mjs";
import {
  withConnection,
  assertAcceptanceDatabaseWriteAuthorized,
} from "../scripts/acceptance/db.mjs";
import {
  acceptanceIdentities,
  signIn,
  anonClient,
  assertAcceptanceSupabaseWriteAuthorized,
  callProtectedRpcWithBearerToken,
  isJwtAuthRejection,
} from "../scripts/acceptance/supabase.mjs";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";
import {
  academyCatalogueSchema,
  myAcademyEnrolmentsSchema,
  academyPlanSchema,
  timetableSchema,
  type AcademyTimetable,
} from "@/domain/academy-delivery";
import { ACADEMY_FORMAT_IDS } from "@/domain/academy-scheduler";

const enabled = process.env.DUCELIO_RUN_UNIFIED_HOSTED_ACCEPTANCE === "true";
const run = randomUUID().slice(0, 18);
const reason = `TEST ONLY unified hosted acceptance ${run}`;
type Publication = { courseId: string; offerId: string; replayed: boolean };
type Buy = {
  ok: boolean;
  code?: string;
  accessGranted?: boolean;
  enrolmentId?: string;
};
type Db = {
  query: (
    sql: string,
    args?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};
const offers: { owner: SupabaseClient; id: string }[] = [];
const coupons: { owner: SupabaseClient; id: string }[] = [];
let admin: SupabaseClient,
  learner: SupabaseClient,
  foreign: SupabaseClient,
  anon: SupabaseClient;
let platform: SupabaseClient | undefined;
let course: Publication, enrolment: string, foreignEnrolment: string;
let timetable: AcademyTimetable, foreignTimetable: AcademyTimetable;
let timerAttempt: string, timerExpiresAt: number;
let before: Record<string, unknown>;
const slug = `test-unified-${run}`;
let planArgs: Record<string, unknown>;

// Observe real scheduled timestamps. No database clock override, backdating,
// direct schedule writes or admission bypass. The full journey takes ~30 min.
async function waitFor(stamp: string) {
  const target = Date.parse(stamp) + 1000;
  if (target - Date.now() > 35 * 60000)
    throw new Error("Fixture window unexpectedly far away");
  while (Date.now() < target)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, target - Date.now())),
    );
}

// Error logs expose only RPC names and bounded policy/SQLSTATE codes. No
// sessions, credentials, e-mails or protected response bodies are printed.
async function rpc<T = Record<string, unknown>>(
  client: SupabaseClient,
  name: string,
  args = {},
): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error)
    throw new Error(
      `${name}: ${/^[A-Z_]+$/.test(error.message) ? error.message : error.code}`,
    );
  return data as T;
}
async function snapshot(db: Db) {
  return (
    await db.query(`select
    (select count(*)::int from public.app_users) users,
    (select count(*)::int from public.cohorts) cohorts,
    (select count(*)::int from public.audit_events) audits,
    (select md5(coalesce(string_agg(to_jsonb(x)::text,'' order by id),'')) from public.academy_orders x) academy_orders,
    (select md5(coalesce(string_agg(to_jsonb(x)::text,'' order by id),'')) from public.academy_payment_events x) academy_payments,
    (select md5(coalesce(string_agg(to_jsonb(x)::text,'' order by order_id),'')) from public.academy_order_refunds x) academy_refunds,
    (select md5(coalesce(string_agg(to_jsonb(x)::text,'' order by id),'')) from public.commercial_v1_orders x) legacy_orders,
    (select md5(coalesce(string_agg(to_jsonb(x)::text,'' order by id),'')) from public.commercial_v1_payment_events x) legacy_payments,
    (select md5(coalesce(string_agg(to_jsonb(x)::text,'' order by order_id),'')) from public.commercial_v1_order_refunds x) legacy_refunds`)
  ).rows[0];
}
async function stage(owner: SupabaseClient, organisation: string, key: string) {
  const raw = buildUnifiedAcceptancePackage(key);
  const id = await rpc<string>(owner, "upload_organisation_course_package", {
    p_organisation_id: organisation,
    p_raw_package: raw,
    p_reason: reason,
  });
  const stored = await rpc(owner, "get_academy_course_package_content", {
    p_package_id: id,
  });
  const checked = validateAcademyCoursePackage(stored);
  expect(checked.valid ? [] : checked.errors).toEqual([]);
  if (!checked.valid)
    throw new Error("Synthetic package failed actual validation");
  await rpc(owner, "mark_academy_course_package_validated", {
    p_package_id: id,
    p_review: checked.review,
    p_reason: reason,
  });
  return id;
}
async function publish(owner: SupabaseClient, id: string, address: string) {
  const args = {
    p_package_id: id,
    p_offer_slug: address,
    p_currency: "GBP",
    p_amount_minor: 10001,
    p_summary: "TEST ONLY synthetic course",
    p_reason: reason,
  };
  const p = await rpc<Publication>(owner, "publish_unified_course", args);
  offers.push({ owner, id: p.offerId });
  expect(await rpc(owner, "publish_unified_course", args)).toMatchObject({
    ...p,
    replayed: true,
  });
  return p;
}
async function coupon(
  owner: SupabaseClient,
  org: string,
  id: string,
  code: string,
) {
  const c = await rpc<string>(owner, "create_organisation_course_coupon", {
    p_organisation_id: org,
    p_code: code,
    p_percent_off: 100,
    p_expires_at: new Date(Date.now() + 86400000).toISOString(),
    p_redemption_limit: 1,
    p_course_id: id,
    p_reason: reason,
  });
  coupons.push({ owner, id: c });
  return c;
}

describe.skipIf(!enabled)("owner-authorised ducelio-acceptance journey", () => {
  beforeAll(async () => {
    process.loadEnvFile(".env.local");
    expect(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname).toBe(
      "blqaomssojfxaxskcyxd.supabase.co",
    );
    const dbUrl = new URL(process.env.ACCEPTANCE_DATABASE_URL!);
    expect(decodeURIComponent(dbUrl.username)).toBe(
      "postgres.blqaomssojfxaxskcyxd",
    );
    expect(dbUrl.hostname.endsWith(".pooler.supabase.com")).toBe(true);
    // Independent TLS-verified DB marker BEFORE even authenticating fixtures.
    before = await withConnection(async (db: Db) => {
      await assertAcceptanceDatabaseWriteAuthorized(db);
      return snapshot(db);
    });
    [admin, learner, foreign] = await Promise.all([
      acceptanceIdentities.admin(),
      acceptanceIdentities.learner(),
      acceptanceIdentities.foreignLearner(),
    ]);
    anon = anonClient();
    for (const c of [admin, learner, foreign])
      await assertAcceptanceSupabaseWriteAuthorized(c);
    expect(
      await rpc<boolean>(admin, "has_role", { wanted: "ACADEMIC_ADMIN" }),
    ).toBe(true);
    if (
      process.env.ACCEPTANCE_PLATFORM_ADMIN_EMAIL &&
      process.env.ACCEPTANCE_PLATFORM_ADMIN_PASSWORD
    ) {
      platform = await signIn(
        "ACCEPTANCE_PLATFORM_ADMIN_EMAIL",
        "ACCEPTANCE_PLATFORM_ADMIN_PASSWORD",
      );
      await assertAcceptanceSupabaseWriteAuthorized(platform);
      expect(
        await rpc<boolean>(platform!, "has_role", { wanted: "PLATFORM_ADMIN" }),
      ).toBe(true);
    } else if (
      await rpc<boolean>(admin, "has_role", { wanted: "PLATFORM_ADMIN" })
    )
      platform = admin;
    for (const c of [learner, foreign]) {
      expect(await rpc<boolean>(c, "has_role", { wanted: "STUDENT" })).toBe(
        true,
      );
      expect(
        await rpc<boolean>(c, "has_role", { wanted: "ACADEMIC_ADMIN" }),
      ).toBe(false);
      expect(
        await rpc<boolean>(c, "has_role", { wanted: "PLATFORM_ADMIN" }),
      ).toBe(false);
    }
  }, 60000);

  afterAll(async () => {
    const errors: string[] = [];
    // Audited archival/deactivation only. No deletes or cleanup of evidence.
    for (const c of coupons) {
      try {
        await rpc(c.owner, "set_course_coupon_active", {
          p_coupon_id: c.id,
          p_active: false,
          p_reason: reason,
        });
      } catch {
        errors.push("COUPON_DEACTIVATION_FAILED");
      }
    }
    for (const o of offers) {
      try {
        await rpc(o.owner, "archive_academy_offer", {
          p_offer_id: o.id,
          p_reason: reason,
        });
      } catch {
        errors.push("OFFER_ARCHIVE_FAILED");
      }
    }
    if (anon) {
      const catalogue = academyCatalogueSchema.parse(
        await rpc(anon, "list_unified_course_catalogue"),
      );
      expect(
        catalogue.some((c) => offers.some((o) => o.id === c.offerId)),
      ).toBe(false);
    }
    if (before)
      await withConnection(async (db: Db) => {
        const after = await snapshot(db);
        expect(after.audits as number).toBeGreaterThanOrEqual(
          before.audits as number,
        );
        delete after.audits;
        const { audits: _audits, ...protectedBefore } = before;
        void _audits;
        expect(after).toEqual(protectedBefore);
      });
    for (const c of new Set([admin, learner, foreign, platform]))
      if (c) await c.auth.signOut({ scope: "local" });
    expect(errors).toEqual([]);
  }, 60000);

  it("starts with an empty new public catalogue and rejects forged JWTs", async () => {
    expect(
      academyCatalogueSchema.parse(
        await rpc(anon, "list_unified_course_catalogue"),
      ),
    ).toEqual([]);
    expect(
      isJwtAuthRejection(
        await callProtectedRpcWithBearerToken(
          "list_my_academy_enrolments",
          "invalid.invalid.invalid",
        ),
      ),
    ).toBe(true);
    for (const client of [anon, learner, foreign])
      for (const table of [
        "academy_course_packages",
        "academy_assessment_attempts",
        "academy_orders",
        "course_engine_coupons",
        "course_engine_coupon_redemptions",
      ]) {
        const denied = await client.from(table).select("*").limit(1);
        expect(denied.error?.code).toBe("42501");
      }
  });

  it("publishes a completely new course through the reused academic authorities", async () => {
    const id = await stage(admin, "00000000-0000-4000-8000-000000000001", run);
    course = await publish(admin, id, slug);
    const offer = academyCatalogueSchema
      .parse(await rpc(anon, "list_unified_course_catalogue"))
      .find((c) => c.offerId === course.offerId)!;
    expect(offer.demoContent).toBe(true);
    expect(offer.formats).toHaveLength(5);
    expect(offer.formats.every((f) => f.amountMinor === 10001)).toBe(true);
  });

  it("redeems 100% once across concurrent replay, without payment or activation", async () => {
    const code = `FULL-${run}`.toUpperCase();
    await coupon(
      admin,
      "00000000-0000-4000-8000-000000000001",
      course.courseId,
      code,
    );
    const args = { p_offer_slug: slug, p_coupon_code: code };
    const purchases = await Promise.all([
      rpc<Buy>(learner, "create_unified_course_order", args),
      rpc<Buy>(learner, "create_unified_course_order", args),
    ]);
    expect(purchases.every((p) => p.ok && p.accessGranted)).toBe(true);
    expect(purchases[0].enrolmentId).toBe(purchases[1].enrolmentId);
    enrolment = purchases[0].enrolmentId!;
    expect(
      await rpc<Buy>(foreign, "create_unified_course_order", args),
    ).toMatchObject({ ok: false, code: "COUPON_UNAVAILABLE" });
    const item = myAcademyEnrolmentsSchema
      .parse(await rpc(learner, "list_my_academy_enrolments"))
      .find((e) => e.enrolmentId === enrolment)!;
    expect(item.formatId).toBeNull();
    expect(item.schedule).toBeNull();
    const codeB = `OTHER-${run}`.toUpperCase();
    await coupon(
      admin,
      "00000000-0000-4000-8000-000000000001",
      course.courseId,
      codeB,
    );
    foreignEnrolment = (
      await rpc<Buy>(foreign, "create_unified_course_order", {
        p_offer_slug: slug,
        p_coupon_code: codeB,
      })
    ).enrolmentId!;
  });

  it("offers all durations and confirms exactly one individual 1439-minute timetable", async () => {
    const first = new Date(Date.now() + 120000).toISOString();
    planArgs = {
      p_enrolment_id: enrolment,
      p_start_on: first.slice(0, 10),
      p_study_days: [1, 2, 3, 4, 5, 6, 7],
      p_local_time: first.slice(11, 16),
      p_timezone: "UTC",
    };
    for (const format of ACADEMY_FORMAT_IDS) {
      expect(
        academyPlanSchema.parse(
          await rpc(learner, "preview_my_academy_schedule", {
            ...planArgs,
            p_format_id: format,
          }),
        ).feasible,
      ).toBe(true);
    }
    const args = {
      ...planArgs,
      p_format_id: "ACCELERATED_2W",
      p_request_key: randomUUID(),
    };
    const confirmed = await Promise.all([
      rpc(learner, "confirm_my_academy_schedule", args),
      rpc(learner, "confirm_my_academy_schedule", args),
    ]);
    expect(confirmed.every((c) => c.ok)).toBe(true);
    expect(confirmed[0].scheduleId).toBe(confirmed[1].scheduleId);
    expect(
      await rpc(learner, "confirm_my_academy_schedule", {
        ...args,
        p_local_time: "01:00",
      }),
    ).toMatchObject({ ok: false, code: "REQUEST_CONFLICT" });
    timetable = timetableSchema.parse(
      await rpc(learner, "get_my_academy_timetable", {
        p_enrolment_id: enrolment,
      }),
    );
    expect(new Set(timetable.items.map((i) => i.kind))).toEqual(
      new Set(["LESSON", "LAB", "REVISION", "ASSESSMENT"]),
    );
    for (const i of timetable.items) {
      expect(Date.parse(i.opensAt!)).toBe(Date.parse(i.startsAt));
      expect(Date.parse(i.closesAt!) - Date.parse(i.opensAt!)).toBe(
        1439 * 60000,
      );
    }
    expect(
      timetable.items.filter((i) => i.kind === "ASSESSMENT").map((i) => i.ref),
    ).toEqual(["quiz_1", "quiz_2", "midterm", "quiz_3", "quiz_4", "final"]);
    expect(
      await rpc(foreign, "confirm_my_academy_schedule", {
        ...args,
        p_enrolment_id: foreignEnrolment,
        p_request_key: randomUUID(),
      }),
    ).toMatchObject({ ok: true });
    foreignTimetable = timetableSchema.parse(
      await rpc(foreign, "get_my_academy_timetable", {
        p_enrolment_id: foreignEnrolment,
      }),
    );
  });

  it(
    "opens owned classroom/lab/revision and enforces examination firewall and independent timer",
    async () => {
      const lesson = timetable.items.find((i) => i.kind === "LESSON")!;
      const lab = timetable.items.find((i) => i.kind === "LAB")!;
      const revision = timetable.items.find((i) => i.kind === "REVISION")!;
      expect(
        await rpc(learner, "open_my_academy_professor_classroom", {
          p_enrolment_id: enrolment,
          p_schedule_item_id: lesson.id,
        }),
      ).toMatchObject({ ok: false, code: "WINDOW_CLOSED" });
      expect(
        await rpc(learner, "start_my_academy_assessment", {
          p_enrolment_id: enrolment,
          p_assessment_ref: "quiz_1",
        }),
      ).toMatchObject({ ok: false, code: "SITTING_NOT_OPEN" });
      await waitFor(lesson.opensAt!);
      expect(
        await rpc(learner, "open_my_academy_professor_classroom", {
          p_enrolment_id: enrolment,
          p_schedule_item_id: lesson.id,
        }),
      ).toMatchObject({ ok: true });
      await waitFor(lab.opensAt!);
      expect(
        await rpc(learner, "open_my_academy_lab_support", {
          p_enrolment_id: enrolment,
          p_schedule_item_id: lab.id,
        }),
      ).toMatchObject({ ok: true });
      await expect(
        rpc(foreign, "get_my_academy_timetable", { p_enrolment_id: enrolment }),
      ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
      await waitFor(
        timetable.items.find((i) => i.kind === "ASSESSMENT")!.opensAt!,
      );
      const started = await rpc(foreign, "start_my_academy_assessment", {
        p_enrolment_id: foreignEnrolment,
        p_assessment_ref: "quiz_1",
      });
      expect(started.ok).toBe(true);
      timerAttempt = started.attemptId as string;
      const attempt = await rpc(foreign, "get_my_academy_attempt", {
        p_attempt_id: timerAttempt,
      });
      timerExpiresAt = Date.parse(attempt.expiresAt as string);
      expect(timerExpiresAt - Date.parse(attempt.startedAt as string)).toBe(
        60000,
      );
      expect(timerExpiresAt).toBeLessThan(
        Date.parse(
          foreignTimetable.items.find((i) => i.kind === "ASSESSMENT")!
            .closesAt!,
        ),
      );
      expect(JSON.stringify(attempt)).not.toMatch(
        /correctOptionId|expectedAnswer|markingGuidance/,
      );
      const foreignLesson = foreignTimetable.items.find(
        (i) => i.kind === "LESSON",
      )!;
      expect(
        await rpc(foreign, "open_my_academy_professor_classroom", {
          p_enrolment_id: foreignEnrolment,
          p_schedule_item_id: foreignLesson.id,
        }),
      ).toMatchObject({ ok: false, code: "ACTIVITY_BLOCKED" });
      expect(
        await rpc(foreign, "start_my_academy_assessment", {
          p_enrolment_id: foreignEnrolment,
          p_assessment_ref: "midterm",
        }),
      ).toMatchObject({ ok: false, code: "ANOTHER_ASSESSMENT_ACTIVE" });
      for (const ref of [
        "quiz_1",
        "quiz_2",
        "midterm",
        "quiz_3",
        "quiz_4",
        "final",
      ]) {
        await waitFor(
          timetable.items.find((i) => i.kind === "ASSESSMENT" && i.ref === ref)!
            .opensAt!,
        );
        if (ref === "midterm")
          expect(
            await rpc(learner, "get_my_unified_revision", {
              p_enrolment_id: enrolment,
              p_item_id: revision.id,
            }),
          ).toHaveProperty("objectives");
        const a = await rpc(learner, "start_my_academy_assessment", {
          p_enrolment_id: enrolment,
          p_assessment_ref: ref,
        });
        expect(a.ok).toBe(true);
        expect(
          await rpc(learner, "record_my_academy_response", {
            p_attempt_id: a.attemptId,
            p_question_position: 1,
            p_body: JSON.stringify({ optionId: "a" }),
            p_idempotency_key: randomUUID(),
          }),
        ).toMatchObject({ ok: true });
        expect(
          await rpc(learner, "submit_my_academy_attempt", {
            p_attempt_id: a.attemptId,
          }),
        ).toMatchObject({
          ok: true,
          state: "SUBMITTED",
          score: 10,
          maxScore: 10,
        });
      }
      expect(
        await rpc(learner, "get_my_academy_results", {
          p_enrolment_id: enrolment,
        }),
      ).toMatchObject({
        outcome: "PASSED",
        courseScoreBp: 10000,
        status: "COMPLETED",
      });
    },
    35 * 60000,
  );

  it("isolates external organisation ownership and raw protected tables with real JWTs", async (context) => {
    if (!platform) {
      console.warn(
        "BLOCKED hosted organisation provisioning: configure separate ACCEPTANCE_PLATFORM_ADMIN_EMAIL/PASSWORD with actual PLATFORM_ADMIN. No global role grant or privileged fixture bypass was made.",
      );
      context.skip();
    }
    const orgA = await rpc<string>(
      platform!,
      "create_course_organisation_by_email",
      {
        p_slug: `test-a-${run}`,
        p_name: `TEST ONLY A ${run}`,
        p_owner_email: process.env.ACCEPTANCE_LEARNER_EMAIL,
        p_reason: reason,
      },
    );
    const orgB = await rpc<string>(
      platform!,
      "create_course_organisation_by_email",
      {
        p_slug: `test-b-${run}`,
        p_name: `TEST ONLY B ${run}`,
        p_owner_email: process.env.ACCEPTANCE_FOREIGN_LEARNER_EMAIL,
        p_reason: reason,
      },
    );
    const idA = await stage(learner, orgA, `external-${run}`);
    const idB = await stage(foreign, orgB, `external-${run}`);
    const a = await publish(learner, idA, `test-a-${run}`);
    await publish(foreign, idB, `test-b-${run}`);
    await expect(
      rpc(foreign, "get_academy_course_package_content", {
        p_package_id: idA,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      rpc(foreign, "archive_academy_offer", {
        p_offer_id: a.offerId,
        p_reason: reason,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      rpc(foreign, "create_organisation_course_coupon", {
        p_organisation_id: orgB,
        p_code: `BAD-${run}`.toUpperCase(),
        p_percent_off: 100,
        p_expires_at: new Date(Date.now() + 86400000).toISOString(),
        p_redemption_limit: 1,
        p_course_id: a.courseId,
        p_reason: reason,
      }),
    ).rejects.toThrow("FORBIDDEN");
    const mine = await learner
      .from("course_engine_organisations")
      .select("id")
      .in("id", [orgA, orgB]);
    expect(mine.error).toBeNull();
    expect(mine.data?.map((o) => o.id)).toEqual([orgA]);
    const packages = await rpc<{ id: string }[]>(
      learner,
      "list_unified_course_packages",
    );
    expect(packages.some((p) => p.id === idA)).toBe(true);
    expect(packages.some((p) => p.id === idB)).toBe(false);
    for (const client of [anon, learner, foreign])
      for (const table of [
        "academy_course_packages",
        "academy_assessment_attempts",
        "academy_orders",
        "course_engine_coupons",
        "course_engine_coupon_redemptions",
      ]) {
        const denied = await client.from(table).select("*").limit(1);
        expect(denied.error?.code).toBe("42501");
      }
    for (const c of [learner, foreign])
      expect(
        await rpc<boolean>(c, "has_role", { wanted: "PLATFORM_ADMIN" }),
      ).toBe(false);
  }, 60000);

  it("expires a real one-minute attempt while its 23h59m activity is still open", async () => {
    expect(timerAttempt).toBeTruthy();
    const wait = Math.max(0, timerExpiresAt - Date.now() + 1000);
    expect(wait).toBeLessThan(62000);
    await new Promise((resolve) => setTimeout(resolve, wait));
    expect(
      await rpc(foreign, "record_my_academy_response", {
        p_attempt_id: timerAttempt,
        p_question_position: 1,
        p_body: JSON.stringify({ optionId: "a" }),
        p_idempotency_key: randomUUID(),
      }),
    ).toMatchObject({ ok: false, code: "EXPIRED" });
    const ended = await rpc(foreign, "get_my_academy_attempt", {
      p_attempt_id: timerAttempt,
    });
    expect(ended.state).toBe("SUBMITTED");
    expect(ended.score).toBe(0);
  }, 70000);
});
