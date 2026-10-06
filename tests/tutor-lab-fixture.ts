import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  executionFixture,
  asExecutionUser,
  learner,
  administrator,
  foreignLearner,
  type ExecutionFixture,
} from "./execution-fixture";
import { buildPackage } from "./activation-fixture";
import { validateCoursePackage } from "@/domain/course-package";

export type TutorLabFixture = ExecutionFixture & {
  cohortId: string;
  programmeVersionId: string;
  learnerEnrolmentId: string;
  lessonId: string;
  objectiveId: string;
  exercisePracticalId: string;
  labPracticalId: string;
  exercisePracticalId2: string;
  labPracticalId2: string;
  missedLessonHandoffId: string;
  objectiveReinforcementHandoffId: string;
  practicalPrerequisiteHandoffId: string;
  practicalHelpHandoffId: string;
};

async function value<T = string>(
  db: ExecutionFixture["db"],
  sql: string,
  args: unknown[] = [],
) {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}

// Builds a real activated cohort (migration 027) with an EXERCISE and a
// PRACTICAL_LAB practical under one lesson/objective, enrols `learner`
// afresh into it, then creates one handoff per reviewed reason code as that
// learner -- exactly the shape migration 028's Tutor/Lab tests need. Reuses
// executionFixture()'s existing controller-key installation for HMAC tests.
// AC-3: migration 051's own role_behaviour_version definition (Tutor and Lab
// Instructor V1), read from the migration file itself, so a fixture can be
// published exactly as a programme version published before migration 052.
function migration051RoleBehaviourVersion(): string {
  const migration = readFileSync(
    resolve("supabase/migrations/202610050051_agent_behaviour.sql"),
    "utf8",
  );
  const start = migration.indexOf(
    "create function agent_behaviour_private.role_behaviour_version",
  );
  const end = migration.indexOf("$$;", start) + 3;
  if (start < 0 || end < 3)
    throw new Error("051 role version mirror not found");
  return migration
    .slice(start, end)
    .replace("create function", "create or replace function");
}

export async function tutorLabFixture(
  options: { publishBeforeMigration052?: boolean } = {},
): Promise<TutorLabFixture> {
  const base = await executionFixture();
  const { db } = base;
  const pkg = buildPackage();
  pkg.packageKey = "tutor-lab-fixture-package";
  // No assignment/assessment templates needed for Tutor/Lab tests -- keeps
  // activate_course_package's schedule-matching trivial (empty arrays match
  // empty templates). The controlled-assessment firewall is instead
  // exercised via executionFixture()'s own pre-existing assessment/attempt.
  pkg.assignmentTemplates = [];
  pkg.assessmentTemplates = [];
  // Two practicals of EACH kind, same lesson, deliberately: PRACTICAL_LAB
  // and EXERCISE practicals within one lesson both legitimately route to
  // the same destination/reason (PRACTICAL_HELP / PRACTICAL_PREREQUISITE
  // respectively), so request_delivery_handoff's own idempotency identity
  // (requested_by + request_id, migration 023) cannot by itself distinguish
  // "practical A" from "practical B" on a replay -- exactly the ambiguity
  // Blocker 1's regression test exercises.
  pkg.modules[0].lessons[0].practicalActivities = [
    {
      key: "exercise",
      kind: "EXERCISE",
      title: "Practice access control",
      instructions: "Exercise instructions sentinel",
      position: 1,
      objectiveRefs: ["obj-1"],
    },
    {
      key: "lab",
      kind: "PRACTICAL_LAB",
      title: "Configure access control",
      instructions: "Lab instructions sentinel",
      position: 2,
      objectiveRefs: ["obj-1"],
    },
    {
      key: "exercise-2",
      kind: "EXERCISE",
      title: "Practice access control (second)",
      instructions: "Second exercise instructions sentinel",
      position: 3,
      objectiveRefs: ["obj-1"],
    },
    {
      key: "lab-2",
      kind: "PRACTICAL_LAB",
      title: "Configure access control (second)",
      instructions: "Second lab instructions sentinel",
      position: 4,
      objectiveRefs: ["obj-1"],
    },
  ];
  await asExecutionUser(db, 2);
  const validated = validateCoursePackage(pkg);
  if (!validated.valid) throw new Error("Invalid tutor/lab fixture package");
  const importId = await value(
    db,
    "select public.import_course_package($1,1,$2,$3::jsonb,$4) as v",
    [
      pkg.packageKey,
      pkg.schemaVersion,
      JSON.stringify(pkg),
      "Tutor/Lab fixture import",
    ],
  );
  await db.query(
    "select public.mark_course_package_validated($1,$2::jsonb,$3)",
    [importId, JSON.stringify(validated.report), "Tutor/Lab fixture validated"],
  );
  const programmeVersionId = await value(
    db,
    "select public.apply_course_package($1,$2) as v",
    [importId, "Apply tutor/lab fixture"],
  );
  // PR15: publish_course_package now requires a current passing
  // pre-publication test. This fixture does not exercise agent
  // configuration semantics, so every role is saved explicitly disabled
  // (the same default CourseAgentForm starts from) purely to satisfy the
  // governed test gate.
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
        "Tutor/Lab fixture agent configuration",
      ],
    );
  }
  const testRun = await value(
    db,
    "select outcome as v from public.run_course_package_test($1,$2)",
    [importId, "Tutor/Lab fixture pre-publication test"],
  );
  if (testRun !== "PASS")
    throw new Error(
      `Tutor/Lab fixture pre-publication test did not pass: ${testRun}`,
    );
  let restore: string | null = null;
  if (options.publishBeforeMigration052) {
    await db.exec("reset role");
    restore = (
      await db.query<{ v: string }>(
        "select pg_get_functiondef('agent_behaviour_private.role_behaviour_version(text)'::regprocedure) as v",
      )
    ).rows[0].v;
    await db.exec(migration051RoleBehaviourVersion());
    await asExecutionUser(db, 2);
  }
  await db.query("select public.publish_course_package($1,$2)", [
    importId,
    "Publish tutor/lab fixture",
  ]);
  if (restore) {
    await db.exec("reset role");
    await db.exec(restore);
  }
  await db.exec("reset role");
  const cohortId = randomUUID();
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Tutor/Lab cohort',current_date)",
    [cohortId, programmeVersionId],
  );
  await asExecutionUser(db, 2);
  const activationId = await value(
    db,
    "select public.activate_course_package($1,$2,$3,$4::jsonb,$5::jsonb,$6) as v",
    [
      importId,
      cohortId,
      administrator,
      JSON.stringify([]),
      JSON.stringify([]),
      "Tutor/Lab fixture activation",
    ],
  );
  void activationId;
  const learnerEnrolmentId = await value(
    db,
    "select public.create_enrolment($1,$2,'Tutor/Lab fixture enrolment') as v",
    [learner, cohortId],
  );
  await db.exec("reset role");
  const lessonId = await value(
    db,
    "select id as v from public.lessons where programme_version_id=$1 order by position limit 1",
    [programmeVersionId],
  );
  const objectiveId = await value(
    db,
    "select id as v from public.lesson_objectives where lesson_id=$1 limit 1",
    [lessonId],
  );
  const exercisePracticalId = await value(
    db,
    "select id as v from public.course_practicals where lesson_id=$1 and kind='EXERCISE' order by position limit 1",
    [lessonId],
  );
  const labPracticalId = await value(
    db,
    "select id as v from public.course_practicals where lesson_id=$1 and kind='PRACTICAL_LAB' order by position limit 1",
    [lessonId],
  );
  const exercisePracticalId2 = await value(
    db,
    "select id as v from public.course_practicals where lesson_id=$1 and kind='EXERCISE' order by position desc limit 1",
    [lessonId],
  );
  const labPracticalId2 = await value(
    db,
    "select id as v from public.course_practicals where lesson_id=$1 and kind='PRACTICAL_LAB' order by position desc limit 1",
    [lessonId],
  );

  await asExecutionUser(db, 1);
  const missedLessonHandoffId = await value(
    db,
    "select public.request_delivery_handoff($1,$2,null,'MISSED_LESSON_PRACTICE',$3) as v",
    [learnerEnrolmentId, lessonId, randomUUID()],
  );
  const objectiveReinforcementHandoffId = await value(
    db,
    "select public.request_delivery_handoff($1,$2,$3,'OBJECTIVE_REINFORCEMENT',$4) as v",
    [learnerEnrolmentId, lessonId, objectiveId, randomUUID()],
  );
  const practicalPrerequisiteHandoffId = await value(
    db,
    "select public.request_practical_support($1,$2,$3) as v",
    [learnerEnrolmentId, exercisePracticalId, randomUUID()],
  );
  const practicalHelpHandoffId = await value(
    db,
    "select public.request_practical_support($1,$2,$3) as v",
    [learnerEnrolmentId, labPracticalId, randomUUID()],
  );
  await db.exec("reset role");

  return {
    ...base,
    cohortId,
    programmeVersionId,
    learnerEnrolmentId,
    lessonId,
    objectiveId,
    exercisePracticalId,
    labPracticalId,
    exercisePracticalId2,
    labPracticalId2,
    missedLessonHandoffId,
    objectiveReinforcementHandoffId,
    practicalPrerequisiteHandoffId,
    practicalHelpHandoffId,
  };
}
export { learner, administrator, foreignLearner, asExecutionUser };
