import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import { buildPackage } from "./activation-fixture";
import { validateCoursePackage } from "@/domain/course-package";

export const learner = "10000000-0000-4000-8000-000000000001";
export const administrator = "10000000-0000-4000-8000-000000000002";
export const foreignLearner = "10000000-0000-4000-8000-000000000003";
export const learnerAuth = (n: number) =>
  `84000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export async function asPolicyUser(db: PGlite, n: number | null) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    n ? learnerAuth(n) : "",
  ]);
  await db.exec("set role authenticated");
}

async function value<T = string>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
) {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}

export const COMPONENTS = [
  "QUIZ_1",
  "QUIZ_2",
  "MIDTERM",
  "QUIZ_3",
  "QUIZ_4",
  "FINAL",
] as const;
export type Component = (typeof COMPONENTS)[number];

export type ComponentWindow = {
  opensAt: Date;
  closesAt: Date;
  durationMinutes: number;
};

function iso(d: Date) {
  return d.toISOString();
}

// A fresh, isolated PGlite database (its own programme/cohort/import), one
// real activated course with exactly six assessments -- one per formal
// Commercial V1 component -- bound and, unless `publish:false`, published as
// a real grading policy. Each test file/describe block that needs a
// distinct base scenario (WITH_LABS, NO_LABS, a malformed ordering, a
// tight latest-start window, ...) builds its own instance, mirroring
// tests/course-activation-workflow.test.ts's own per-scenario beforeAll
// pattern -- never sharing mutable state across scenarios.
export async function buildAssessmentPolicyFixture(opts: {
  withLabs: boolean;
  db?: PGlite;
  throughMigration?: number;
  windows?: Partial<Record<Component, ComponentWindow>>;
  attemptsAllowedOverride?: Partial<Record<Component, number>>;
  publish?: boolean;
  skipComponents?: Component[];
  multiObjectiveQuestion?: boolean;
  additionalLab?: boolean;
  additionalQuizQuestion?: boolean;
}) {
  const db =
    opts.db ??
    (await testDatabase({ throughMigration: opts.throughMigration }));
  if (!opts.db) {
    await db.exec("alter table auth.users disable trigger academy_identity");
    for (const [n, id] of [
      [1, learner],
      [2, administrator],
      [3, foreignLearner],
    ] as const) {
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [learnerAuth(n), `policy${n}@test.example`],
      );
      await db.query(
        "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
        [learnerAuth(n), id],
      );
    }
    await db.exec("alter table auth.users enable trigger academy_identity");
    await db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR')",
      [administrator],
    );
  }

  const now = new Date();
  const defaultWindows: Record<Component, ComponentWindow> = {
    QUIZ_1: {
      opensAt: new Date(now.getTime() - 24 * 3600_000),
      closesAt: new Date(now.getTime() + 3 * 3600_000),
      durationMinutes: 60,
    },
    QUIZ_2: {
      opensAt: new Date(now.getTime() + 4 * 3600_000),
      closesAt: new Date(now.getTime() + 5 * 3600_000),
      durationMinutes: 30,
    },
    MIDTERM: {
      opensAt: new Date(now.getTime() + 6 * 3600_000),
      closesAt: new Date(now.getTime() + 7.5 * 3600_000),
      durationMinutes: 90,
    },
    QUIZ_3: {
      opensAt: new Date(now.getTime() + 8 * 3600_000),
      closesAt: new Date(now.getTime() + 9 * 3600_000),
      durationMinutes: 30,
    },
    QUIZ_4: {
      opensAt: new Date(now.getTime() + 10 * 3600_000),
      closesAt: new Date(now.getTime() + 11 * 3600_000),
      durationMinutes: 30,
    },
    FINAL: {
      opensAt: new Date(now.getTime() + 12 * 3600_000),
      closesAt: new Date(now.getTime() + 14 * 3600_000),
      durationMinutes: 120,
    },
  };
  const windows: Record<Component, ComponentWindow> = {
    ...defaultWindows,
    ...opts.windows,
  };

  const pkg = buildPackage();
  if (opts.multiObjectiveQuestion) {
    pkg.modules[0].lessons[0].objectives.push({
      key: "obj-2",
      description: "Apply authentication controls",
      position: 2,
    });
  }
  pkg.packageKey = `commercial-v1-policy-${randomUUID()}`;
  pkg.assignmentTemplates = [];
  pkg.modules[0].lessons[0].practicalActivities = opts.withLabs
    ? [
        {
          key: "lab-1",
          kind: "PRACTICAL_LAB",
          title: "Hands-on lab",
          instructions: "Configure the control.",
          position: 1,
          objectiveRefs: ["obj-1"],
        },
        ...(opts.additionalLab
          ? [
              {
                key: "lab-2",
                kind: "PRACTICAL_LAB" as const,
                title: "Second hands-on lab",
                instructions: "Validate the control.",
                position: 2,
                objectiveRefs: ["obj-1"],
              },
            ]
          : []),
      ]
    : [];
  pkg.assessmentTemplates = COMPONENTS.map((component, idx) => ({
    key: component.toLowerCase(),
    title: `${component} assessment`,
    instructions: "Answer independently under controlled conditions.",
    lessonRef: "lesson-1",
    durationMinutes: windows[component].durationMinutes,
    attemptsAllowed: opts.attemptsAllowedOverride?.[component] ?? 1,
    questions: [
      {
        position: 1,
        prompt: `${component} question ${idx + 1}`,
        maxMarks: 10,
        expectedAnswer: `${component} protected answer`,
        markingGuidance: null,
        objectiveRefs:
          opts.multiObjectiveQuestion && component === "QUIZ_1"
            ? ["obj-1", "obj-2"]
            : ["obj-1"],
      },
    ],
  }));

  if (opts.additionalQuizQuestion) {
    const quiz = pkg.assessmentTemplates[0];
    quiz.questions.push({
      ...quiz.questions[0],
      position: 2,
      prompt: "Second authoritative question",
    });
  }
  await asPolicyUser(db, 2);
  const validated = validateCoursePackage(pkg);
  if (!validated.valid)
    throw new Error(
      `Invalid assessment-policy fixture package: ${JSON.stringify(validated.errors)}`,
    );
  const importId = await value(
    db,
    "select public.import_course_package($1,1,$2,$3::jsonb,$4) as v",
    [
      pkg.packageKey,
      pkg.schemaVersion,
      JSON.stringify(pkg),
      "Policy fixture import",
    ],
  );
  await db.query(
    "select public.mark_course_package_validated($1,$2::jsonb,$3)",
    [importId, JSON.stringify(validated.report), "Policy fixture validated"],
  );
  const programmeVersionId = await value(
    db,
    "select public.apply_course_package($1,$2) as v",
    [importId, "Apply policy fixture"],
  );
  // PR15 (migration 35): publish_course_package now requires a current
  // passing pre-publication test. This fixture supports running against an
  // older migration snapshot (opts.throughMigration, used by the migration
  // upgrade regression below), where migration 35 -- and therefore
  // run_course_package_test -- does not yet exist, so this step is only
  // exercised once that migration is actually loaded. This fixture does not
  // exercise agent configuration semantics, so every role is saved
  // explicitly disabled (the same default CourseAgentForm starts from)
  // purely to satisfy the governed test gate.
  if ((opts.throughMigration ?? Infinity) >= 35) {
    for (const role of [
      "PROFESSOR",
      "TUTOR",
      "LAB_INSTRUCTOR",
      "EXAMINER",
      "COUNSELLOR",
    ]) {
      await db.query(
        "select public.set_agent_config($1,$2,false,null,null,'{}',$3,$4)",
        [
          programmeVersionId,
          role,
          "NONE",
          "Policy fixture agent configuration",
        ],
      );
    }
    const testRun = await value(
      db,
      "select outcome as v from public.run_course_package_test($1,$2)",
      [importId, "Policy fixture pre-publication test"],
    );
    if (testRun !== "PASS")
      throw new Error(
        `Policy fixture pre-publication test did not pass: ${testRun}`,
      );
  }
  await db.query("select public.publish_course_package($1,$2)", [
    importId,
    "Publish policy fixture",
  ]);
  await db.exec("reset role");

  const cohortId = randomUUID();
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Policy cohort',current_date)",
    [cohortId, programmeVersionId],
  );

  await asPolicyUser(db, 2);
  const assessmentWindows = COMPONENTS.map((component) => ({
    templateKey: component.toLowerCase(),
    opensAt: iso(windows[component].opensAt),
    closesAt: iso(windows[component].closesAt),
  }));
  const activationId = await value(
    db,
    "select public.activate_course_package($1,$2,$3,$4::jsonb,$5::jsonb,$6) as v",
    [
      importId,
      cohortId,
      administrator,
      JSON.stringify([]),
      JSON.stringify(assessmentWindows),
      "Policy fixture activation",
    ],
  );
  const learnerEnrolmentId = await value(
    db,
    "select public.create_enrolment($1,$2,'Policy fixture enrolment') as v",
    [learner, cohortId],
  );
  await db.exec("reset role");

  const assessmentIds: Record<Component, string> = {} as Record<
    Component,
    string
  >;
  for (const component of COMPONENTS) {
    assessmentIds[component] = await value(
      db,
      "select assessment_id as v from public.course_assessment_bindings where activation_id=$1 and template_key=$2",
      [activationId, component.toLowerCase()],
    );
  }

  await asPolicyUser(db, 2);
  for (const component of COMPONENTS) {
    if ((opts.throughMigration ?? 29) < 29) continue;
    if (opts.skipComponents?.includes(component)) continue;
    await db.query(
      "select public.bind_commercial_v1_assessment_component($1,$2,$3,$4)",
      [
        activationId,
        component,
        assessmentIds[component],
        `Bind ${component} for policy fixture`,
      ],
    );
  }
  let policyActivationId: string | null = null;
  if (opts.publish !== false && (opts.throughMigration ?? 29) >= 29) {
    policyActivationId = await value(
      db,
      "select public.publish_commercial_v1_grading_policy($1,$2) as v",
      [activationId, "Publish fixture grading policy"],
    );
  }
  await db.exec("reset role");

  return {
    db,
    importId,
    programmeVersionId,
    cohortId,
    activationId,
    learnerEnrolmentId,
    assessmentIds,
    windows,
    published: policyActivationId !== null,
  };
}
export type AssessmentPolicyFixture = Awaited<
  ReturnType<typeof buildAssessmentPolicyFixture>
>;
