import { randomUUID } from "node:crypto";
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
export async function tutorLabFixture(): Promise<TutorLabFixture> {
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
  await db.query("select public.publish_course_package($1,$2)", [
    importId,
    "Publish tutor/lab fixture",
  ]);
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
