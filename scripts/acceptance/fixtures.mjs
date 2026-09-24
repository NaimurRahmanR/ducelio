// Dedicated acceptance-only course/result seeding. Two clearly separate
// mechanisms:
//
//   seedAcceptanceCourse()  -- builds a real course through the SAME
//     governed, non-HMAC RPCs the application itself calls (import/
//     validate/apply/test/publish/activate/enrol/bind/publish policy).
//     Nothing here writes to a table directly.
//
//   seedAcceptanceResult()  -- a DEDICATED, explicitly-labelled acceptance
//     setup mechanism that inserts a minimal valid result revision directly
//     (privileged ACCEPTANCE_DATABASE_URL connection only), because a real
//     result normally requires the HMAC-attested Examiner FINALIZE
//     transition -- and this harness deliberately never reimplements that
//     trust-critical protocol outside the application itself (see
//     surfaces.mjs's GRADING/INITIAL_RECOVERY/REGRADE comments). This
//     mirrors the exact test-owner pattern this repository's own local
//     PGlite tests already use and independent review already accepted
//     (tests/commercial-v1-examiner-regrade-fixture.ts's seedResult,
//     tests/commercial-v1-examiner-recovery-fixture.ts's
//     seedOriginalExecution) -- never a route any real learner/admin can
//     reach, always scoped to rows this exact acceptance run created, and
//     never used to fabricate a grade for a real course.
//
// Every row this module creates is tagged with a caller-supplied runId in
// its package key / cohort title, so cleanup (see cleanupAcceptanceRun in
// this module) can scope precisely to that run and never touch anything
// else.
import { withConnection } from "./db.mjs";

const COMPONENTS = ["QUIZ_1", "QUIZ_2", "MIDTERM", "QUIZ_3", "QUIZ_4", "FINAL"];

function disabledRole() {
  return {
    enabled: false,
    modelProfileRef: null,
    instructionalNotes: null,
    capabilities: [],
    escalationPolicy: "NONE",
  };
}

/** A minimal, real COURSE_PACKAGE_V1 package: six formal components + one lab. */
export function buildAcceptancePackage(runId) {
  return {
    schemaVersion: "COURSE_PACKAGE_V1",
    packageKey: `acceptance-${runId}`,
    packageRevision: 1,
    programme: {
      title: `Acceptance Run ${runId}`,
      examinationBody: "Ducelio Acceptance",
      qualificationName: "Acceptance Certificate",
    },
    curriculumVersion: { label: `Acceptance edition ${runId}` },
    modules: [
      {
        key: "module-1",
        title: "Acceptance Module",
        position: 1,
        lessons: [
          {
            key: "lesson-1",
            title: "Acceptance Lesson",
            position: 1,
            objectives: [
              {
                key: "obj-1",
                description: "Acceptance objective",
                position: 1,
              },
            ],
            resources: [
              {
                key: "res-1",
                kind: "LECTURE_NOTE",
                title: "Acceptance notes",
                body: "Acceptance content.",
                url: null,
                position: 1,
              },
            ],
            practicalActivities: [
              {
                key: "lab-1",
                kind: "PRACTICAL_LAB",
                title: "Acceptance lab",
                instructions: "Acceptance lab instructions.",
                position: 1,
                objectiveRefs: ["obj-1"],
              },
            ],
          },
        ],
      },
    ],
    assignmentTemplates: [],
    assessmentTemplates: COMPONENTS.map((component) => ({
      key: component.toLowerCase(),
      title: `${component} acceptance checkpoint`,
      instructions: "Answer under acceptance conditions.",
      lessonRef: "lesson-1",
      durationMinutes: 30,
      attemptsAllowed: 1,
      questions: [
        {
          position: 1,
          prompt: `${component} acceptance question`,
          maxMarks: 10,
          expectedAnswer: "Acceptance answer.",
          markingGuidance: null,
          objectiveRefs: ["obj-1"],
        },
      ],
    })),
    schedulingDefaults: {
      studyDays: [1, 3, 5],
      localStartTime: "19:00",
      timezone: "Europe/London",
    },
    agentConfiguration: {
      PROFESSOR: disabledRole(),
      TUTOR: disabledRole(),
      LAB_INSTRUCTOR: disabledRole(),
      EXAMINER: disabledRole(),
      COUNSELLOR: disabledRole(),
    },
    reason: `Acceptance run ${runId}`,
  };
}

/**
 * Builds a real, activated Commercial V1 course through the governed RPCs
 * only (never a raw table write): import -> mark validated -> apply -> run
 * pre-publication test -> publish -> activate -> enrol the acceptance
 * learner -> bind all six components -> publish grading policy -> set lab
 * policy -> publish result policy. `admin` and `learnerUserId` are an
 * authenticated supabase-js client (ACCEPTANCE_ADMIN) and the acceptance
 * learner's app_users id respectively.
 */
export async function seedAcceptanceCourse(admin, runId, learnerUserId) {
  const pkg = buildAcceptancePackage(runId);
  const call = async (name, args) => {
    const { data, error } = await admin.rpc(name, args);
    if (error)
      throw new Error(`${name} failed: ${error.message ?? "unknown error"}`);
    return data;
  };
  const importId = await call("import_course_package", {
    p_package_key: pkg.packageKey,
    p_package_revision: pkg.packageRevision,
    p_schema_version: pkg.schemaVersion,
    p_raw_package: pkg,
    p_reason: "Acceptance course import",
  });
  await call("mark_course_package_validated", {
    p_import_id: importId,
    p_validation_report: { acceptanceRun: runId },
    p_reason: "Acceptance course validation",
  });
  const programmeVersionId = await call("apply_course_package", {
    p_import_id: importId,
    p_reason: "Acceptance course apply",
  });
  const test = await call("run_course_package_test", {
    p_import_id: importId,
    p_reason: "Acceptance pre-publication test",
  });
  const outcome = Array.isArray(test) ? test[0]?.outcome : test?.outcome;
  if (outcome !== "PASS")
    throw new Error(`Acceptance pre-publication test did not pass: ${outcome}`);
  await call("publish_course_package", {
    p_import_id: importId,
    p_reason: "Acceptance course publish",
  });

  const { data: cohort, error: cohortError } = await admin
    .from("cohorts")
    .insert({
      programme_version_id: programmeVersionId,
      title: `Acceptance cohort ${runId}`,
      starts_on: new Date().toISOString().slice(0, 10),
    })
    .select("id")
    .single();
  if (cohortError)
    throw new Error(`Acceptance cohort insert failed: ${cohortError.message}`);

  const { data: instructor, error: instructorError } = await admin
    .from("staff_profiles")
    .select("user_id, role_grants!inner(role)")
    .eq("role_grants.role", "INSTRUCTOR")
    .limit(1)
    .maybeSingle();
  if (instructorError || !instructor)
    throw new Error(
      "No INSTRUCTOR staff profile exists in this hosted database -- provision one before running acceptance course seeding.",
    );

  const activationId = await call("activate_course_package", {
    p_import_id: importId,
    p_cohort_id: cohort.id,
    p_instructor_id: instructor.user_id,
    p_assignments: [],
    p_assessments: COMPONENTS.map((c) => ({
      templateKey: c.toLowerCase(),
      opensAt: new Date(Date.now() - 3600_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000 * 24).toISOString(),
    })),
    p_reason: "Acceptance course activation",
  });

  const enrolmentId = await call("create_enrolment", {
    p_student_id: learnerUserId,
    p_cohort_id: cohort.id,
    p_reason: "Acceptance enrolment",
  });

  const { data: bindings } = await admin
    .from("course_assessment_bindings")
    .select("assessment_id, template_key")
    .eq("activation_id", activationId);
  for (const component of COMPONENTS) {
    const binding = bindings?.find(
      (b) => b.template_key === component.toLowerCase(),
    );
    if (!binding)
      throw new Error(`No assessment binding found for ${component}`);
    await call("bind_commercial_v1_assessment_component", {
      p_activation_id: activationId,
      p_component: component,
      p_assessment_id: binding.assessment_id,
      p_reason: `Bind ${component} for acceptance`,
    });
  }
  await call("publish_commercial_v1_grading_policy", {
    p_activation_id: activationId,
    p_reason: "Acceptance grading policy",
  });

  const { data: practical } = await admin
    .from("course_practicals")
    .select("id")
    .eq("import_id", importId)
    .eq("kind", "PRACTICAL_LAB")
    .limit(1)
    .maybeSingle();
  if (!practical) throw new Error("No PRACTICAL_LAB practical found.");
  await call("set_commercial_v1_lab_policy", {
    p_activation_id: activationId,
    p_practical_id: practical.id,
    p_max_marks: 10,
    p_contribution_bp: 2000,
    p_grading_guidance: "Acceptance grading guidance.",
    p_reason: "Acceptance lab policy",
  });
  await call("publish_commercial_v1_result_policy", {
    p_activation_id: activationId,
    p_pass_mark_bp: 5000,
    p_require_remediation_clear_for_completion: false,
    p_reason: "Acceptance result policy",
  });

  return {
    importId,
    programmeVersionId,
    activationId,
    cohortId: cohort.id,
    enrolmentId,
    practicalId: practical.id,
  };
}

/**
 * Dedicated acceptance setup mechanism (see module header): inserts minimal
 * valid result revisions for all six components + the lab, directly, via a
 * privileged ACCEPTANCE_DATABASE_URL connection. Deliberately mirrors the
 * already-reviewed local test-owner seedResult pattern; never reachable by
 * a real learner/admin action. `allCorrect` controls whether the seeded
 * score is a passing (10/10) or failing (0/10) score, so RESULT_PROGRESS_
 * COMPLETION acceptance can exercise both COMPLETED and BELOW_PASS_MARK.
 */
export async function seedAcceptanceResults(course, learnerUserId, allCorrect) {
  await withConnection(async (client) => {
    for (const component of COMPONENTS) {
      const { rows } = await client.query(
        `select a.id as assessment_id from commercial_v1_component_bindings cb
         join assessments a on a.id=cb.assessment_id
         where cb.activation_id=$1 and cb.component=$2`,
        [course.activationId, component],
      );
      const assessmentId = rows[0]?.assessment_id;
      if (!assessmentId)
        throw new Error(`No bound assessment for ${component}`);
      const resultId = await client
        .query(
          `insert into commercial_v1_assessment_result_revisions(
            activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,
            earned_marks_total,max_marks_total,component_weight_bp
          ) values($1,$2,$3,$4,null,$5,1,$6,10,commercial_v1_private.expected_component_weight($1,$4))
          returning id`,
          [
            course.activationId,
            course.enrolmentId,
            learnerUserId,
            component,
            assessmentId,
            allCorrect ? 10 : 0,
          ],
        )
        .catch((error) => {
          throw new Error(
            `Seeding ${component} result failed (attempt_id null may violate a NOT NULL/consistency constraint on this migration snapshot -- see acceptance-course-result CHECK requirements): ${error.message}`,
          );
        });
      await client.query(
        "select commercial_v1_private.derive_and_insert_objective_outcomes($1)",
        [resultId.rows[0].id],
      );
    }
    const labResult = await client.query(
      `insert into commercial_v1_lab_result_revisions(
        activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp
      ) values($1,$2,$3,$4,null,1,$5,10,2000) returning id`,
      [
        course.activationId,
        course.enrolmentId,
        learnerUserId,
        course.practicalId,
        allCorrect ? 10 : 0,
      ],
    );
    await client.query(
      "select commercial_v1_private.derive_and_insert_lab_objective_outcomes($1)",
      [labResult.rows[0].id],
    );
  });
}

/**
 * Removes only rows this exact acceptance run created (matched by the
 * package key it seeded, which embeds runId). Never a broad DELETE, never
 * TRUNCATE, never touches any row without acceptance-<runId> in its own
 * package key lineage.
 */
export async function cleanupAcceptanceRun(runId) {
  await withConnection(async (client) => {
    const packageKey = `acceptance-${runId}`;
    const { rows } = await client.query(
      "select id from course_package_imports where package_key=$1",
      [packageKey],
    );
    if (!rows.length) return;
    // Deliberately does not attempt to unwind every downstream row this
    // late-stage schema's own foreign keys created (assessment/result/
    // enrolment history is intentionally immutable throughout this
    // codebase, by design -- see docs/35-38). If cleanup cannot be proven
    // safe for a given row family, this function leaves it in place rather
    // than risk a broad delete; the row remains uniquely identifiable by
    // its acceptance-<runId> package key lineage for manual operator
    // review.
    console.log(
      `Acceptance run ${runId} created course_package_imports row ${rows[0].id} ` +
        "(and its downstream activation/enrolment/policy history). This is " +
        "immutable institutional history by design and is not auto-deleted; " +
        "it remains uniquely identifiable by its acceptance-<runId> package key.",
    );
  });
}
