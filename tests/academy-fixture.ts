import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";
import { validateCoursePackage } from "@/domain/course-package";

// Shared Academy (B2C) fixture: the real Security+ SY0-701 Academy
// conversion artefact, published through the real existing curriculum
// pipeline and the migration 060 Academy RPCs. Works against PGlite and a
// real PostgreSQL client alike (both expose query(sql, params)).
export type Query = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export const ACADEMY_PACKAGE_PATH = resolve(
  "content/courses/security-plus-sy0-701/academy-b2c-rev2.json",
);
export const academyPackage = () =>
  JSON.parse(readFileSync(ACADEMY_PACKAGE_PATH, "utf8"));

// TEST-ONLY variant of the real artefact in which every pending decision is
// treated as resolved and each graded lab carries a synthetic one-criterion
// rubric. It exists solely to exercise sale, marking and completion paths;
// it is never course content and never leaves the test database.
export function approvedTestPackage(
  key = "security-plus-academy-approved-test",
) {
  const pkg = academyPackage();
  pkg.packageKey = key;
  pkg.packageRevision = 1;
  pkg.curriculum.packageKey = key;
  pkg.curriculum.packageRevision = 1;
  pkg.curriculum.curriculumVersion.label = `TEST-ONLY approved variant (${key})`;
  pkg.pendingDecisions = [];
  for (const lab of pkg.labs)
    if (lab.graded) {
      lab.rubric = [
        {
          key: "test-criterion",
          description: "TEST-ONLY synthetic criterion",
          maxMarks: 10,
        },
      ];
      lab.markingGuidance = "TEST-ONLY synthetic marking guidance.";
    }
  return pkg;
}

export const people = {
  admin: {
    id: "90000000-0000-4000-8000-000000000601",
    auth: "91000000-0000-4000-8000-000000000601",
    email: "academy-admin@example.com",
    role: "ACADEMIC_ADMIN",
  },
  learnerA: {
    id: "10000000-0000-4000-8000-000000000601",
    auth: "81000000-0000-4000-8000-000000000601",
    email: "learner-a@example.com",
    role: "STUDENT",
  },
  learnerB: {
    id: "10000000-0000-4000-8000-000000000602",
    auth: "81000000-0000-4000-8000-000000000602",
    email: "learner-b@example.com",
    role: "STUDENT",
  },
  learnerC: {
    id: "10000000-0000-4000-8000-000000000603",
    auth: "81000000-0000-4000-8000-000000000603",
    email: "learner-c@example.com",
    role: "STUDENT",
  },
  instructor: {
    id: "20000000-0000-4000-8000-000000000601",
    auth: "21000000-0000-4000-8000-000000000601",
    email: "instructor@example.com",
    role: "INSTRUCTOR",
  },
  registrar: {
    id: "20000000-0000-4000-8000-000000000602",
    auth: "21000000-0000-4000-8000-000000000602",
    email: "registrar@example.com",
    role: "REGISTRAR",
  },
} as const;
export type Person = { id: string; auth: string; email: string; role: string };

export async function seedPeople(q: Query) {
  await q("alter table auth.users disable trigger academy_identity");
  for (const p of Object.values(people)) {
    await q(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      [p.auth, p.email],
    );
    await q(
      "insert into public.app_users(id,auth_user_id,display_name) values($1,$2,$3)",
      [p.id, p.auth, p.email],
    );
    await q("insert into public.role_grants(user_id,role) values($1,$2)", [
      p.id,
      p.role,
    ]);
    if (p.role === "STUDENT")
      await q(
        "insert into public.student_profiles(user_id,student_number) values($1,$2)",
        [p.id, `ACAD-${p.id.slice(-3)}`],
      );
    else
      await q(
        "insert into public.staff_profiles(user_id,title) values($1,'Academy test staff')",
        [p.id],
      );
  }
  await q("alter table auth.users enable trigger academy_identity");
}

export async function as<T>(
  q: Query,
  person: Person | null,
  sql: string,
  params: unknown[] = [],
) {
  await q("select set_config('request.jwt.claim.sub',$1,false)", [
    person?.auth ?? "",
  ]);
  await q(person ? "set role authenticated" : "set role anon");
  try {
    return (await q(sql, params)).rows as T[];
  } finally {
    await q("reset role");
    await q("select set_config('request.jwt.claim.sub','',false)");
  }
}
export async function rpc<T = unknown>(
  q: Query,
  person: Person | null,
  fn: string,
  params: unknown[] = [],
) {
  const placeholders = params.map((_, i) => `$${i + 1}`).join(",");
  const rows = await as<{ r: T }>(
    q,
    person,
    `select public.${fn}(${placeholders}) as r`,
    params,
  );
  return rows[0].r;
}

// Admin journey: upload -> validate -> existing curriculum pipeline ->
// publish with explicit prices. Mirrors src/server/academy-course-engineering.
export async function publishAcademyCourse(
  q: Query,
  slug = "security-plus-academy-test",
  pkg = academyPackage(),
  // Test-only: publish a package the TypeScript validator rejects, to prove
  // the database authority still refuses impossible learner choices.
  bypassValidator?: { review: Record<string, unknown>; formats: string[] },
) {
  const checked = validateAcademyCoursePackage(pkg);
  if (!checked.valid && !bypassValidator)
    throw new Error(JSON.stringify(checked.errors.slice(0, 5)));
  const validation = checked.valid
    ? checked
    : ({
        valid: true,
        review: {
          ...bypassValidator!.review,
          formats: bypassValidator!.formats.map((formatId) => ({ formatId })),
        },
      } as unknown as Extract<typeof checked, { valid: true }>);
  const admin = people.admin;
  const packageId = await rpc<string>(
    q,
    admin,
    "upload_academy_course_package",
    [JSON.stringify(pkg), "Upload Security+ Academy package"],
  );
  await rpc(q, admin, "mark_academy_course_package_validated", [
    packageId,
    JSON.stringify(validation.review),
    "Validated by the domain validator",
  ]);
  const curriculum = await rpc<Record<string, unknown>>(
    q,
    admin,
    "get_academy_course_package_curriculum",
    [packageId],
  );
  const curriculumReport = validateCoursePackage(curriculum);
  if (!curriculumReport.valid) throw new Error("curriculum invalid");
  const importId = await rpc<string>(q, admin, "import_course_package", [
    curriculum.packageKey,
    curriculum.packageRevision,
    curriculum.schemaVersion,
    JSON.stringify(curriculum),
    "Academy curriculum import",
  ]);
  await rpc(q, admin, "mark_course_package_validated", [
    importId,
    JSON.stringify(curriculumReport.report),
    "Academy curriculum validated",
  ]);
  const versionId = await rpc<string>(q, admin, "apply_course_package", [
    importId,
    "Academy curriculum applied",
  ]);
  for (const [role, cfg] of Object.entries(
    curriculumReport.package.agentConfiguration,
  ))
    await rpc(q, admin, "set_agent_config", [
      versionId,
      role,
      cfg.enabled,
      cfg.modelProfileRef,
      cfg.instructionalNotes,
      cfg.capabilities,
      cfg.escalationPolicy,
      "Academy agent configuration from package",
    ]);
  const test = await as<{ outcome: string; failure_code: string | null }>(
    q,
    admin,
    "select * from public.run_course_package_test($1,$2)",
    [importId, "Academy pre-publication test"],
  );
  if (test[0].outcome !== "PASS")
    throw new Error(`pre-publication test ${test[0].failure_code}`);
  await rpc(q, admin, "publish_course_package", [
    importId,
    "Academy curriculum published",
  ]);
  const prices = validation.review.formats.map((f, i) => ({
    formatId: f.formatId,
    amountMinor: 30000 + i * 5000,
  }));
  const courseId = await rpc<string>(q, admin, "publish_academy_course", [
    packageId,
    slug,
    "GBP",
    "Self-paced Security+ preparation.",
    JSON.stringify(prices),
    "Publish Security+ Academy course",
  ]);
  const offerId = (
    await q("select id from public.academy_offers where course_id=$1", [
      courseId,
    ])
  ).rows[0].id as string;
  return {
    pkg,
    validation,
    packageId,
    importId,
    versionId,
    courseId,
    offerId,
    prices,
  };
}

// Canonical correct (or deliberately wrong) response bodies for an
// objective question, built from its own protected key.
export function responseBody(
  question: {
    questionType: string;
    interaction: Record<string, unknown>;
    answerKey: Record<string, unknown>;
  },
  correct = true,
) {
  const key = question.answerKey;
  const i = question.interaction;
  switch (question.questionType) {
    case "SINGLE_SELECT": {
      const options = (i.options as { id: string }[]).map((o) => o.id);
      return JSON.stringify({
        optionId: correct
          ? key.correctOptionId
          : options.find((o) => o !== key.correctOptionId),
      });
    }
    case "MULTIPLE_SELECT": {
      const options = (i.options as { id: string }[]).map((o) => o.id);
      const right = key.correctOptionIds as string[];
      return JSON.stringify({
        optionIds: correct ? right : [options.find((o) => !right.includes(o))],
      });
    }
    case "PBQ_MATCHING":
      return JSON.stringify({ matches: correct ? key.mapping : {} });
    case "PBQ_ORDERING":
      return JSON.stringify({
        order: correct
          ? key.correctOrder
          : (i.steps as { id: string }[]).map((s) => s.id),
      });
    case "PBQ_CONFIGURATION":
      return JSON.stringify({ values: correct ? key.values : {} });
  }
  throw new Error("unsupported");
}

// Move one assessment's sitting window so it is open now (superuser only;
// the history guard is bypassed explicitly, which no RPC can do).
export async function openSittingNow(
  q: Query,
  enrolmentId: string,
  ref: string,
) {
  await q(
    "alter table public.academy_schedule_items disable trigger guard_history",
  );
  await q(
    `update public.academy_schedule_items set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour',
       opens_at = now() - interval '1 hour', closes_at = now() + interval '2 days'
     where enrolment_id = $1 and kind = 'ASSESSMENT' and ref = $2
       and schedule_id = (select id from public.academy_schedules where enrolment_id = $1 and superseded_at is null)`,
    [enrolmentId, ref],
  );
  await q(
    "alter table public.academy_schedule_items enable trigger guard_history",
  );
}

// Bring scheduled items of one kind (optionally one ref) into the past so
// time-released content and practicals open (superuser only).
export async function releaseNow(
  q: Query,
  enrolmentId: string,
  kind: "LESSON" | "LAB",
  ref?: string,
) {
  await q(
    "alter table public.academy_schedule_items disable trigger guard_history",
  );
  await q(
    `update public.academy_schedule_items set starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours'
     where enrolment_id = $1 and kind = $2 and ($3::text is null or ref = $3)
       and schedule_id = (select id from public.academy_schedules where enrolment_id = $1 and superseded_at is null)`,
    [enrolmentId, kind, ref ?? null],
  );
  await q(
    "alter table public.academy_schedule_items enable trigger guard_history",
  );
}

// Submit every graded practical and record its (test-only) rubric mark.
export async function completeLabs(
  q: Query,
  learner: Person,
  enrolmentId: string,
  marks: number,
) {
  await releaseNow(q, enrolmentId, "LAB");
  for (const lab of approvedTestPackage().labs.filter(
    (l: { graded: boolean }) => l.graded,
  )) {
    const submitted = await rpc<{ ok: boolean; submissionId: string }>(
      q,
      learner,
      "submit_my_academy_lab",
      [
        enrolmentId,
        lab.activityRef,
        `Learner findings for ${lab.activityRef}`,
        randomUUID(),
      ],
    );
    if (!submitted.ok) throw new Error(JSON.stringify(submitted));
    await rpc(q, people.admin, "mark_academy_lab_submission", [
      submitted.submissionId,
      JSON.stringify({ "test-criterion": marks }),
      "Evaluated against the test rubric",
    ]);
  }
}
