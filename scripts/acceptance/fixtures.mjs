// Dedicated acceptance-only course/result seeding. Two clearly separate
// mechanisms:
//
//   seedAcceptanceCourse()  -- builds a real course through the SAME
//     governed, non-HMAC RPCs the application itself calls (import/
//     validate/apply/test/publish/activate/enrol/bind/publish policy),
//     including the cohort itself: migration 202610010044's governed
//     admin_create_cohort RPC (ACADEMIC_ADMIN/PLATFORM_ADMIN) replaced the
//     earlier privileged direct-SQL cohort insert that existed only
//     because no product cohort-creation authority did.
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
//
// Independent-review finding 2 (prior pass): "never production" is not a
// safety mechanism on its own. Every mutating function below calls
// db.mjs's assertAcceptanceDatabaseWriteAuthorized -- which fails closed
// unless BOTH the local ACCEPTANCE_WRITE_ENABLED opt-in AND a matching
// in-database acceptance-environment marker row are present -- as its
// first action, before any write.
//
// Independent-review finding 1 (this pass): seedAcceptanceCourse's actual
// writes travel through the authenticated Supabase client
// (NEXT_PUBLIC_SUPABASE_URL), a completely different path from the direct
// database gate above (ACCEPTANCE_DATABASE_URL). A direct-database marker
// match alone never proves the Supabase side targets the same
// environment. seedAcceptanceCourse therefore also calls supabase.mjs's
// assertAcceptanceSupabaseWriteAuthorized, and only proceeds once BOTH
// independently confirm the SAME ACCEPTANCE_ENVIRONMENT_ID.
import { randomUUID } from "node:crypto";
import {
  withConnection,
  withAcceptanceWriteConnection,
  resolveAppUserId,
  appUserHasRole,
  appUserHasStaffProfile,
} from "./db.mjs";
import { assertAcceptanceSupabaseWriteAuthorized } from "./supabase.mjs";

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

// Examiner app acceptance (scripts/acceptance/examiner-app.mjs) only: the
// SAME reviewed EXAMINER configuration a real course author could publish --
// the role's single allowed profile ref, the controlled-assessment grading
// capability from migration 036's allowlist, and no ACADEMIC_REVIEW
// escalation (which would terminate every claim ESCALATED before any
// provider call). Recovery reuses this same config check; regrade does not
// consult it. Every other caller keeps the default all-disabled package.
const EXAMINER_ACCEPTANCE_ROLE = Object.freeze({
  enabled: true,
  modelProfileRef: "EXAMINER_COMMERCIAL_V1",
  instructionalNotes: null,
  capabilities: ["grade_controlled_assessment"],
  escalationPolicy: "NONE",
});

// Customer-journey acceptance (scripts/acceptance/customer-journey.mjs)
// only: the reviewed role configurations a real course author could publish
// for a course whose learner journey reaches the Professor classroom, Tutor
// and Lab Instructor support and Examiner assessment + lab grading. Each
// role names ONLY its own single allowed runtime profile
// (ROLE_RUNTIME_PROFILE_POLICY) and only capabilities from its code-owned
// catalogue (roleCapabilityCatalogue / SQL role_capability_allowlist), with
// no ACADEMIC_REVIEW escalation. COUNSELLOR stays disabled.
export const JOURNEY_ACCEPTANCE_ROLES = Object.freeze({
  PROFESSOR: Object.freeze({
    enabled: true,
    modelProfileRef: "PROFESSOR_COMMERCIAL_V1",
    instructionalNotes: null,
    capabilities: Object.freeze([
      "get_current_learner_context",
      "get_lesson_context",
      "get_lesson_objectives",
    ]),
    escalationPolicy: "NONE",
  }),
  TUTOR: Object.freeze({
    enabled: true,
    modelProfileRef: "TUTOR_COMMERCIAL_V1",
    instructionalNotes: null,
    capabilities: Object.freeze([
      "get_lesson_context",
      "get_lesson_objectives",
      "get_learning_resources",
    ]),
    escalationPolicy: "NONE",
  }),
  LAB_INSTRUCTOR: Object.freeze({
    enabled: true,
    modelProfileRef: "LAB_INSTRUCTOR_COMMERCIAL_V1",
    instructionalNotes: null,
    capabilities: Object.freeze([
      "get_lesson_context",
      "get_lesson_objectives",
    ]),
    escalationPolicy: "NONE",
  }),
  EXAMINER: Object.freeze({
    enabled: true,
    modelProfileRef: "EXAMINER_COMMERCIAL_V1",
    instructionalNotes: null,
    capabilities: Object.freeze([
      "grade_controlled_assessment",
      "grade_practical_lab",
    ]),
    escalationPolicy: "NONE",
  }),
});

function roleConfig(options, role) {
  if (options.journeyAgents && JOURNEY_ACCEPTANCE_ROLES[role]) {
    const reviewed = JOURNEY_ACCEPTANCE_ROLES[role];
    return { ...reviewed, capabilities: [...reviewed.capabilities] };
  }
  if (role === "EXAMINER" && options.examinerEnabled)
    return {
      ...EXAMINER_ACCEPTANCE_ROLE,
      capabilities: [...EXAMINER_ACCEPTANCE_ROLE.capabilities],
    };
  return disabledRole();
}

// Customer-journey acceptance only: { firstOpensAt (epoch ms),
// windowMinutes } -> six strictly sequential, non-overlapping windows, each
// opening exactly at the previous one's close.
export function journeyAssessmentWindows({ firstOpensAt, windowMinutes }) {
  if (
    !Number.isFinite(firstOpensAt) ||
    !Number.isInteger(windowMinutes) ||
    windowMinutes < 1 ||
    windowMinutes > 120
  )
    throw new Error("assessmentSchedule is malformed.");
  return COMPONENTS.map((c, index) => ({
    templateKey: c.toLowerCase(),
    opensAt: new Date(
      firstOpensAt + index * windowMinutes * 60_000,
    ).toISOString(),
    closesAt: new Date(
      firstOpensAt + (index + 1) * windowMinutes * 60_000,
    ).toISOString(),
  }));
}

/**
 * A minimal, real COURSE_PACKAGE_V1 package: six formal components + one lab.
 * `options.examinerEnabled` enables only the EXAMINER role (see
 * EXAMINER_ACCEPTANCE_ROLE); it is false for every existing caller.
 * `options.journeyAgents` (customer-journey.mjs only) enables exactly the
 * JOURNEY_ACCEPTANCE_ROLES configurations; `options.assessmentDurationMinutes`
 * (customer-journey.mjs only; 1..30, default 30) shortens every component's
 * duration so six strictly sequential windows fit one attended run.
 */
export function buildAcceptancePackage(runId, options = {}) {
  const durationMinutes = options.assessmentDurationMinutes ?? 30;
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 1 ||
    durationMinutes > 30
  )
    throw new Error("assessmentDurationMinutes must be an integer 1..30.");
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
      durationMinutes,
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
      PROFESSOR: roleConfig(options, "PROFESSOR"),
      TUTOR: roleConfig(options, "TUTOR"),
      LAB_INSTRUCTOR: roleConfig(options, "LAB_INSTRUCTOR"),
      EXAMINER: roleConfig(options, "EXAMINER"),
      COUNSELLOR: disabledRole(),
    },
    reason: `Acceptance run ${runId}`,
  };
}

/**
 * Builds a real, activated Commercial V1 course through the governed RPCs
 * only for anything a real learner/admin action would normally reach:
 * import -> mark validated -> apply -> run pre-publication test -> publish
 * -> activate -> enrol the acceptance learner -> bind all six components ->
 * publish grading policy -> set lab policy -> publish result policy.
 * `admin` is an authenticated supabase-js client (ACCEPTANCE_ADMIN) that is
 * ALSO the provisioned acceptance instructor AND the verified
 * ACADEMIC_ADMIN/PLATFORM_ADMIN recovery actor concurrency.mjs's
 * RECOVERY_VS_RECOVERY race needs (see the instructor-discovery comment
 * below, and the returned recoveryActorId field). `learnerAuthUserId` is
 * the acceptance learner's Supabase
 * AUTH user id (auth.users.id -- e.g. from
 * `(await learner.auth.getUser()).data.user.id`), NEVER their app_users.id
 * -- those are two separately-generated uuids (see db.mjs's
 * resolveAppUserId). This function resolves the real application
 * app_users.id itself before calling any RPC that takes a student id, so
 * every caller passes the SAME kind of identifier it already has on hand
 * (the Auth session's own user id) and can never accidentally pass the
 * wrong id space.
 *
 * Independent-review finding (schema-consistency audit, this pass): a
 * prior version of this function accepted an already-resolved
 * "learnerUserId" and forwarded it directly to create_enrolment's
 * p_student_id -- but every call site actually had only the Auth user id
 * on hand (auth.users.id), not app_users.id. create_enrolment's
 * p_student_id is matched directly against student_profiles.user_id,
 * which references app_users.id (migration 2609080001/002) -- passing the
 * Auth id there would not enrol the real acceptance learner. Fixed by
 * resolving the correct id internally, once, from the one identifier every
 * caller actually already has.
 *
 * Cohort creation: public.cohorts grants `authenticated` SELECT only, so a
 * direct `.from("cohorts").insert(...)` is (correctly) rejected. Migration
 * 202610010044 added the governed admin_create_cohort RPC -- the same
 * authority the /admin/cohorts product surface uses -- so the cohort is now
 * created through it as the acceptance admin, with no privileged SQL.
 *
 * Independent-review finding (this pass, blocker): the
 * course_practicals/course_assessment_bindings tables read further below
 * cannot be reached through PostgREST by a real hosted ACCEPTANCE_ADMIN
 * using the publishable-key authenticated client:
 *   - public.course_practicals / public.course_assessment_bindings:
 *     migration 2609140027 is stricter still -- its own self-verifying DO
 *     block explicitly revokes EVERY privilege (including column-level)
 *     from anon/authenticated/service_role and RAISES if any is ever
 *     found, for exactly this table set. Not even SELECT is reachable via
 *     PostgREST.
 * None of that may be worked around with a production grant or a weaker
 * RLS policy (this harness never weakens production constraints to make
 * acceptance pass). course_practicals/course_assessment_bindings are
 * therefore read back through the acceptance-only direct PostgreSQL
 * connection -- a plain read needs no gate, only ACCEPTANCE_DATABASE_URL.
 *
 * Independent-review finding (this pass): instructor discovery previously
 * used `.from("staff_profiles").select("user_id, role_grants!inner(role)")`
 * -- but there is no foreign key between staff_profiles and role_grants at
 * all (both independently reference app_users only), so PostgREST cannot
 * resolve that embed; and, separately, an arbitrary INSTRUCTOR picked from
 * the whole hosted database is not necessarily the one acceptance
 * identity actually provisioned for this purpose. Fixed by resolving the
 * ACCEPTANCE_ADMIN's own app_users.id (the same identity this function
 * already authenticates as) and verifying, directly against the database,
 * that it genuinely carries the INSTRUCTOR role and a staff_profiles row
 * -- never picking a different, arbitrary row. Fails closed with an
 * explicit error naming exactly which prerequisite is missing.
 *
 * Independent-review finding 2 (prior pass): writes here go through
 * supabase-js/PostgREST, not the direct pg connection -- so this function
 * opens its OWN short-lived privileged connection purely to run the
 * direct-database gate, and closes it again immediately.
 *
 * Independent-review finding 1 (this pass): the Supabase-side gate is
 * checked FIRST (it needs only the already-injected `admin` client, no
 * database connection, and so fails fast and is fully testable without
 * hosted infrastructure) and the direct-database gate SECOND. Both must
 * pass -- in either order -- before a single product write RPC is called;
 * the ordering here is a testability/fail-fast convenience, not a
 * security dependency between the two.
 */
export async function seedAcceptanceCourse(
  admin,
  runId,
  learnerAuthUserId,
  options = {},
) {
  await assertAcceptanceSupabaseWriteAuthorized(admin);
  const { data: adminUser, error: adminUserError } = await admin.auth.getUser();
  if (adminUserError || !adminUser?.user?.id)
    throw new Error(
      "Could not resolve the acceptance admin's own hosted Supabase Auth user id.",
    );
  // One privileged connection resolves BOTH real app_users ids this
  // function needs (the learner's and the admin/instructor's) and
  // verifies the admin genuinely carries INSTRUCTOR + a staff_profiles
  // row -- all read-only, but run on the SAME gated connection as a
  // matter of course, never a bespoke ungated variant.
  //
  // Independent-review finding (v5, this pass): concurrency.mjs's
  // RECOVERY_VS_RECOVERY race needs a real, verified ACADEMIC_ADMIN/
  // PLATFORM_ADMIN app_users.id to use as commercial_v1_examiner_recovery_
  // executions.actor_id -- migration 2609240040 defines actor_id as "the
  // initiating ACADEMIC_ADMIN/PLATFORM_ADMIN" and its own governed
  // recovery function rejects any other actor. INSTRUCTOR is a DIFFERENT
  // role and never implies admin recovery authority on its own, so this
  // is checked independently and explicitly, never inferred from the
  // INSTRUCTOR check above. Exposed as `recoveryActorId` -- a distinctly
  // named field, even though it happens to resolve to the same acceptance
  // admin identity as `instructorId` here, so no caller can confuse "is
  // an instructor" with "is authorized to act as the recovery actor".
  const { studentId, instructorId, recoveryActorId } =
    await withAcceptanceWriteConnection(async (client) => {
      const resolvedStudentId = await resolveAppUserId(
        client,
        learnerAuthUserId,
      );
      if (!resolvedStudentId)
        throw new Error(
          "No public.app_users row is linked to the acceptance learner's Auth user id -- ACCEPTANCE_LEARNER_EMAIL must be a real Supabase Auth user that has actually signed up against this hosted project (migration 002's provision_academy_user() trigger creates this link on signup).",
        );
      const resolvedInstructorId = await resolveAppUserId(
        client,
        adminUser.user.id,
      );
      if (!resolvedInstructorId)
        throw new Error(
          "No public.app_users row is linked to the acceptance admin's Auth user id -- ACCEPTANCE_ADMIN_EMAIL must be a real Supabase Auth user that has actually signed up against this hosted project.",
        );
      if (!(await appUserHasRole(client, resolvedInstructorId, "INSTRUCTOR")))
        throw new Error(
          "The acceptance admin's app_users row does not carry the INSTRUCTOR role -- grant it INSTRUCTOR (see docs/38) before running acceptance course seeding.",
        );
      if (!(await appUserHasStaffProfile(client, resolvedInstructorId)))
        throw new Error(
          "The acceptance admin's app_users row has no public.staff_profiles row -- provision one before running acceptance course seeding.",
        );
      const hasAdminRecoveryAuthority =
        (await appUserHasRole(
          client,
          resolvedInstructorId,
          "ACADEMIC_ADMIN",
        )) ||
        (await appUserHasRole(client, resolvedInstructorId, "PLATFORM_ADMIN"));
      if (!hasAdminRecoveryAuthority)
        throw new Error(
          "The acceptance admin's app_users row carries neither ACADEMIC_ADMIN nor PLATFORM_ADMIN -- migration 2609240040 requires the recovery actor to hold one of those roles (INSTRUCTOR alone is never sufficient); grant one before running acceptance course seeding.",
        );
      return {
        studentId: resolvedStudentId,
        instructorId: resolvedInstructorId,
        recoveryActorId: resolvedInstructorId,
      };
    });
  // options.transformPackage (CP2 exam-engine acceptance only) replaces the
  // synthetic question set and Examiner escalation before import; the
  // hosted package validator and activation still validate everything.
  const built = buildAcceptancePackage(runId, options);
  const pkg = options.transformPackage
    ? options.transformPackage(built)
    : built;
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

  // `options.lessonSegment` (commerce-revocation.mjs only): COURSE_PACKAGE_V1
  // materialises no lesson segments, and the governed create_lesson_segment
  // (migration 2609090011) accepts only a DRAFT, unenrolled version -- so the
  // one segment lesson progress needs is added here, before the
  // pre-publication test (which compares modules/lessons/objectives only)
  // and publication. A plain read locates the fixture's single lesson.
  let lessonSegment = null;
  if (options.lessonSegment) {
    const lessonId = await withConnection((client) =>
      client
        .query(
          "select id from lessons where programme_version_id=$1 order by id limit 1",
          [programmeVersionId],
        )
        .then((r) => r.rows[0]?.id ?? null),
    );
    if (!lessonId) throw new Error("The acceptance programme has no lesson.");
    const segmentId = await call("create_lesson_segment", {
      p_lesson_id: lessonId,
      p_title: `Acceptance segment ${runId}`,
      p_position: 1,
      p_reason: "Acceptance lesson segment",
    });
    lessonSegment = { lessonId, segmentId };
  }

  // Independent-review finding (v6, this pass, BLOCKER -- confirmed by a
  // real hosted acceptance:concurrency run, acceptance run
  // 1790361944555-1nzbhw, whose persisted course_package_test_runs row
  // recorded outcome=FAIL, failure_code=CONFIGURATION_INCOMPLETE,
  // failed_roles=PROFESSOR,TUTOR,LAB_INSTRUCTOR,EXAMINER,COUNSELLOR):
  // migration 2609120024's apply_course_package() does NOT materialise
  // pkg.agentConfiguration into public.academic_agent_configs at all --
  // that table is configured SEPARATELY, through the governed
  // public.set_agent_config() RPC (migration 2609170036). Migration
  // 2609170035's run_course_package_test() calls
  // evaluate_config_readiness(), which requires the STORED
  // academic_agent_configs rows to exactly match the package's own
  // proposed agentConfiguration -- with none configured at all, every
  // one of the five reviewed roles was reported missing. Fixed by
  // calling set_agent_config once per role, copying the EXACT values
  // buildAcceptancePackage() already proposed for that role -- never
  // inventing different settings, never merely enabling a role to force
  // the test to pass. This MUST run here, strictly AFTER
  // apply_course_package and BEFORE run_course_package_test: migration
  // 2609170035's publication authority binds a PASSing test to the
  // exact configuration/fingerprint in place AT THAT TEST, so
  // academic_agent_configs must never be touched again between the test
  // and publish_course_package below.
  const AGENT_ROLES = [
    "PROFESSOR",
    "TUTOR",
    "LAB_INSTRUCTOR",
    "EXAMINER",
    "COUNSELLOR",
  ];
  for (const role of AGENT_ROLES) {
    const roleConfig = pkg.agentConfiguration[role];
    await call("set_agent_config", {
      p_programme_version_id: programmeVersionId,
      p_role: role,
      p_enabled: roleConfig.enabled,
      p_model_profile_ref: roleConfig.modelProfileRef,
      p_instructional_notes: roleConfig.instructionalNotes,
      p_capabilities: roleConfig.capabilities,
      p_escalation_policy: roleConfig.escalationPolicy,
      p_reason: `Acceptance ${role} agent configuration`,
    });
  }

  const test = await call("run_course_package_test", {
    p_import_id: importId,
    p_reason: "Acceptance pre-publication test",
  });
  // run_course_package_test's own `returns table(...)` shape means
  // PostgREST/supabase-js normalizes it to an array of one row -- the
  // SAME normalization the outcome check already used before this pass,
  // never assuming a bare object shape.
  const testResult = Array.isArray(test) ? test[0] : test;
  const outcome = testResult?.outcome;
  if (outcome !== "PASS") {
    // Independent-review finding (v6, this pass): the previous error
    // only said "did not pass: FAIL", discarding
    // run_course_package_test's own bounded, non-sensitive diagnostic
    // columns (failure_code/failed_roles) -- exactly the fields that
    // would have identified CONFIGURATION_INCOMPLETE immediately instead
    // of requiring an independent read of the persisted
    // course_package_test_runs row. Never includes the fingerprint, raw
    // package content, or any SQL error text -- only these three
    // already-governed, already-safe-to-surface columns.
    const failureCode = testResult?.failure_code ?? "UNKNOWN";
    const failedRoles = Array.isArray(testResult?.failed_roles)
      ? testResult.failed_roles.join(",")
      : (testResult?.failed_roles ?? "");
    throw new Error(
      `Acceptance pre-publication test did not pass: outcome=${outcome} failure_code=${failureCode} failed_roles=${failedRoles}`,
    );
  }
  await call("publish_course_package", {
    p_import_id: importId,
    p_reason: "Acceptance course publish",
  });

  // The governed product authority (migration 202610010044), exactly as
  // /admin/cohorts calls it: one OPEN cohort for this run, starting today
  // (UTC), under the governed programme version apply_course_package just
  // returned. No privileged SQL.
  const cohortId = await call("admin_create_cohort", {
    p_programme_version_id: programmeVersionId,
    p_title: `Acceptance cohort ${runId}`,
    p_starts_on: new Date().toISOString().slice(0, 10),
    p_ends_on: null,
    p_capacity: null,
    p_reason: "Acceptance cohort creation",
  });

  // Independent-review finding (v4, this pass): every one of the six
  // components previously shared the EXACT SAME opens_at/closes_at
  // window. publish_commercial_v1_grading_policy (migration 2609140029)
  // walks the six components in the fixed institutional order QUIZ_1 ->
  // QUIZ_2 -> MIDTERM -> QUIZ_3 -> QUIZ_4 -> FINAL and raises
  // ASSESSMENT_SEQUENCE_INVALID the moment a later component's opens_at
  // is earlier than the previous component's closes_at -- which an
  // identical shared window always is. seedAcceptanceCourse could
  // therefore never actually reach a published grading policy. Fixed by
  // deriving six deterministic, strictly sequential, non-overlapping
  // windows from ONE captured base timestamp -- windowMinutes (2 hours)
  // comfortably exceeds durationMinutes=30 (buildAcceptancePackage's own
  // template value, which activate_course_package uses verbatim as each
  // assessment's duration_minutes -- migration 2609140029's
  // ASSESSMENT_WINDOW_TOO_SHORT guard requires closes_at-opens_at >=
  // duration_minutes), and each window's opens_at is set to exactly the
  // previous window's closes_at (never earlier), satisfying the sequence
  // check with no gap and no overlap. QUIZ_1 still opens in the past
  // (baseTime, one hour before this call), matching the previous
  // fixture's own intent that the first component is already open.
  const baseTime = Date.now() - 3600_000;
  const windowMinutes = 120;
  const p_assessments = COMPONENTS.map((c, index) => ({
    templateKey: c.toLowerCase(),
    opensAt: new Date(baseTime + index * windowMinutes * 60_000).toISOString(),
    closesAt: new Date(
      baseTime + (index + 1) * windowMinutes * 60_000,
    ).toISOString(),
  }));

  // `options.assessmentSchedule` (customer-journey.mjs only) replaces the
  // default windows above with journeyAssessmentWindows' -- the SAME
  // strictly sequential arithmetic from one captured base -- so the journey
  // can sit every component through the real learner path in one run. The
  // governed RPCs enforce the same sequence/duration rules either way.
  const assessments = options.assessmentSchedule
    ? journeyAssessmentWindows(options.assessmentSchedule)
    : p_assessments;

  const activationId = await call("activate_course_package", {
    p_import_id: importId,
    p_cohort_id: cohortId,
    p_instructor_id: instructorId,
    p_assignments: [],
    p_assessments: assessments,
    p_reason: "Acceptance course activation",
  });

  const enrolmentId = await call("create_enrolment", {
    p_student_id: studentId,
    p_cohort_id: cohortId,
    p_reason: "Acceptance enrolment",
  });

  // Read-only -- see the function header for why course_assessment_bindings
  // cannot be read via PostgREST here (migration 2609140027 revokes every
  // privilege, including SELECT, for this table set, and self-verifies
  // that nothing has re-granted one).
  const bindings = await withConnection((client) =>
    client
      .query(
        "select assessment_id, template_key from course_assessment_bindings where activation_id=$1",
        [activationId],
      )
      .then((r) => r.rows),
  );
  for (const component of COMPONENTS) {
    const binding = bindings.find(
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

  // Read-only -- same PostgREST-unreachable table set as bindings above.
  const practicalId = await withConnection((client) =>
    client
      .query(
        "select id from course_practicals where import_id=$1 and kind='PRACTICAL_LAB' limit 1",
        [importId],
      )
      .then((r) => r.rows[0]?.id ?? null),
  );
  if (!practicalId) throw new Error("No PRACTICAL_LAB practical found.");
  await call("set_commercial_v1_lab_policy", {
    p_activation_id: activationId,
    p_practical_id: practicalId,
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
    cohortId,
    enrolmentId,
    practicalId,
    studentId,
    instructorId,
    recoveryActorId,
    // { lessonId, segmentId } only when options.lessonSegment was set.
    lessonSegment,
    // Independent-review finding (JWT_POSTGREST completion, this pass):
    // surfaces.mjs's checkJwtPostgrest needs a real, bound assessment id
    // to prove the protected-content boundary (get_active_assessment_
    // questions) -- reusing the `bindings` read this function's own
    // component-binding loop above already performed, rather than a
    // second, separate direct-DB read for the same data.
    quiz1AssessmentId: bindings.find((b) => b.template_key === "quiz_1")
      ?.assessment_id,
    // Every bound component's assessment id, from the same read (the
    // customer-journey driver sits all six).
    assessmentIdsByComponent: Object.fromEntries(
      COMPONENTS.map((component) => [
        component,
        bindings.find((b) => b.template_key === component.toLowerCase())
          ?.assessment_id ?? null,
      ]),
    ),
  };
}

/**
 * Enrols a SECOND, already-signed-up acceptance identity into an EXISTING
 * cohort a prior seedAcceptanceCourse() call already created -- used only
 * to give a foreign/unrelated learner their OWN real, known enrolment
 * (never a synthetic id) for cross-learner ownership-override acceptance
 * (docs/38 section 3: "learner cannot override actor/student IDs").
 * Reuses the exact same resolveAppUserId + create_enrolment pattern
 * seedAcceptanceCourse's own primary-learner enrolment already uses --
 * never a raw table insert, never a second copy of create_enrolment's own
 * authority logic.
 *
 * Independent-review finding (V2): this function's write travels through
 * the SAME two independent network paths seedAcceptanceCourse's own do --
 * the authenticated Supabase client (`admin.rpc("create_enrolment", ...)`,
 * authenticated by NEXT_PUBLIC_SUPABASE_URL/PUBLISHABLE_KEY) and the
 * direct database connection (ACCEPTANCE_DATABASE_URL, via
 * withAcceptanceWriteConnection, used here only to resolve `studentId`).
 * A prior version asserted only the direct-database gate before ever
 * reaching create_enrolment -- proving ACCEPTANCE_DATABASE_URL points at
 * a genuine acceptance environment, but never independently proving
 * NEXT_PUBLIC_SUPABASE_URL (a completely different path) points at the
 * SAME one. Both gates -- assertAcceptanceSupabaseWriteAuthorized (this
 * call) and the direct-database gate withAcceptanceWriteConnection
 * enforces internally -- must independently agree on the SAME
 * ACCEPTANCE_ENVIRONMENT_ID, exactly matching seedAcceptanceCourse's own
 * safety model, before create_enrolment is ever called.
 */
export async function enrolAcceptanceLearner(
  admin,
  cohortId,
  learnerAuthUserId,
) {
  await assertAcceptanceSupabaseWriteAuthorized(admin);
  const studentId = await withAcceptanceWriteConnection((client) =>
    resolveAppUserId(client, learnerAuthUserId),
  );
  if (!studentId)
    throw new Error(
      "No public.app_users row is linked to this learner's Auth user id -- it must be a real Supabase Auth user that has actually signed up against this hosted project (migration 002's provision_academy_user() trigger creates this link on signup).",
    );
  const { data, error } = await admin.rpc("create_enrolment", {
    p_student_id: studentId,
    p_cohort_id: cohortId,
    p_reason: "Acceptance additional-learner enrolment",
  });
  if (error)
    throw new Error(
      `create_enrolment failed: ${error.message ?? "unknown error"}`,
    );
  return { enrolmentId: data, studentId };
}

/**
 * Dedicated acceptance-only test-owner insert of ONE assessment_attempts
 * row on the caller's already-gated connection. A real attempt is
 * normally created only by the learner's own start_assessment_attempt RPC
 * (an ordinary write, no HMAC involved) -- this exists because both
 * seedAcceptanceResults (below) and the true-concurrency owning-chain
 * fixture (concurrency.mjs) need a real, FK-satisfying attempt row without
 * exercising session/attempt-window timing that neither is actually
 * testing. Inserted directly as SUBMITTED (never ACTIVE), so it never
 * touches the one-active-attempt-per-student partial unique index.
 * assessment_attempts is guarded, immutable institutional history once
 * inserted (migration 2609090016's guard_assessment_attempt_history
 * rejects every UPDATE/DELETE unconditionally) -- like every other row
 * this harness seeds through the governed graph, this is permanent,
 * run-scoped history, never cleaned up.
 */
export async function seedAcceptanceAttempt(client, params) {
  const {
    assessmentId,
    enrolmentId,
    studentId,
    cohortId,
    programmeVersionId,
    attemptNumber = 1,
  } = params;
  const attemptId = randomUUID();
  await client.query(
    `insert into assessment_attempts(
      id,assessment_id,enrolment_id,student_id,cohort_id,programme_version_id,attempt_number,
      state,started_at,expires_at,submitted_at,submission_provenance
    ) values($1,$2,$3,$4,$5,$6,$7,'SUBMITTED',
      now()-interval '10 minutes',now()+interval '20 minutes',now()-interval '5 minutes','STUDENT_SUBMIT')`,
    [
      attemptId,
      assessmentId,
      enrolmentId,
      studentId,
      cohortId,
      programmeVersionId,
      attemptNumber,
    ],
  );
  return attemptId;
}

/**
 * Dedicated acceptance-only test-owner insert of ONE
 * commercial_v1_lab_submissions row -- the same rationale as
 * seedAcceptanceAttempt, for the lab-result revision's required, non-null
 * submission_id. Append-only once inserted (migration
 * 2609150030's lab_submission_append_only).
 */
export async function seedAcceptanceLabSubmission(client, params) {
  const { activationId, practicalId, enrolmentId, studentId, idempotencySeed } =
    params;
  const submissionId = randomUUID();
  await client.query(
    `insert into commercial_v1_lab_submissions(
      id,activation_id,practical_id,enrolment_id,student_id,body,idempotency_key
    ) values($1,$2,$3,$4,$5,'Acceptance lab submission body.',$6)`,
    [
      submissionId,
      activationId,
      practicalId,
      enrolmentId,
      studentId,
      `acceptance-lab-${idempotencySeed}`,
    ],
  );
  return submissionId;
}

/**
 * Dedicated acceptance setup mechanism (see module header): inserts minimal
 * valid result revisions for all six components + the lab, directly, via a
 * privileged ACCEPTANCE_DATABASE_URL connection. Deliberately mirrors the
 * already-reviewed local test-owner seedResult pattern; never reachable by
 * a real learner/admin action. `allCorrect` controls whether the seeded
 * score is a passing (10/10-per-question) or failing (0) score, so
 * RESULT_PROGRESS_COMPLETION acceptance can exercise both COMPLETED and
 * BELOW_PASS_MARK.
 *
 * Independent-review finding (schema-consistency audit, this pass):
 * migration 2609150030's derive_and_insert_objective_outcomes() calls
 * assert_complete_question_marks() FIRST, which requires exactly one
 * public.commercial_v1_assessment_question_marks row per
 * public.assessment_questions row bound to the assessment, with
 * max_marks_snapshot matching the real question and the revision's own
 * earned_marks_total/max_marks_total matching the sum of those marks
 * exactly (assessment_result_is_valid() checks the identical totals). A
 * prior version of this function never inserted any question_marks row at
 * all and hard-coded max_marks_total=10 regardless of how many questions
 * (or what max_marks) the seeded package actually defined -- every call
 * would throw INCOMPLETE_QUESTION_MARKS. Fixed by reading the REAL
 * assessment_questions rows for each bound assessment, deriving
 * max_marks_total as their sum, inserting one question_marks row per
 * question (marks_awarded = the question's own max_marks when
 * allCorrect, else 0 -- never a value the question's own max_marks
 * couldn't support), and only THEN calling
 * derive_and_insert_objective_outcomes(). assessment_result_is_valid() is
 * asserted true immediately afterward -- this function throws, rather
 * than returning a silently-invalid revision, if it is not.
 *
 * Independent-review finding (this pass): every table this function
 * writes to is append-only/guarded (immutable the instant a row commits
 * -- see seedAcceptanceAttempt/seedAcceptanceLabSubmission above and
 * commercial_v1_assessment_result_revisions' own append-only trigger).
 * Without a transaction, a defect partway through (a later component, or
 * the lab) would leave an earlier component's revision permanently
 * committed and unrepairable by DELETE. The entire operation -- every
 * component's attempt/result/question-marks insert, plus the lab
 * submission/result -- now runs inside one BEGIN/COMMIT, ROLLBACK on any
 * error, so a defect leaves nothing committed at all.
 *
 * Independent-review finding (schema-consistency audit, prior pass): both
 * result-revision inserts below previously supplied `null` for a NOT NULL
 * column -- attempt_id on commercial_v1_assessment_result_revisions and
 * submission_id on commercial_v1_lab_result_revisions (migration
 * 2609150030) -- which can never have succeeded against the current
 * schema. Fixed by seeding one real attempt/submission row per component
 * (seedAcceptanceAttempt/seedAcceptanceLabSubmission above) and using
 * their real ids. Also drops the separate `learnerUserId` parameter
 * entirely -- `course.studentId` (resolved once, correctly, by
 * seedAcceptanceCourse) is now the single source of truth, so no call
 * site can pass a mismatched id.
 *
 * `options.excludeComponents` (concurrency-app-races.mjs's
 * REGRADE_VS_COMPLETION only) skips components whose result the caller has
 * ALREADY produced through the real application (answered responses plus
 * the real Examiner FINALIZE), so a regrade target is never one of this
 * function's response-less seeded attempts. Only known component names are
 * accepted; the lab is always seeded.
 */
export async function seedAcceptanceResults(
  course,
  allCorrect,
  { excludeComponents = [] } = {},
) {
  if (excludeComponents.some((c) => !COMPONENTS.includes(c)))
    throw new Error("excludeComponents names an unknown component.");
  await withAcceptanceWriteConnection(async (client) => {
    await client.query("begin");
    try {
      for (const component of COMPONENTS) {
        if (excludeComponents.includes(component)) continue;
        const { rows: bindingRows } = await client.query(
          `select a.id as assessment_id from commercial_v1_component_bindings cb
           join assessments a on a.id=cb.assessment_id
           where cb.activation_id=$1 and cb.component=$2`,
          [course.activationId, component],
        );
        const assessmentId = bindingRows[0]?.assessment_id;
        if (!assessmentId)
          throw new Error(`No bound assessment for ${component}`);

        const { rows: questions } = await client.query(
          "select id, max_marks from assessment_questions where assessment_id=$1 order by position",
          [assessmentId],
        );
        if (!questions.length)
          throw new Error(
            `No assessment_questions found for ${component} (assessment ${assessmentId}) -- cannot derive a valid result revision without at least one real question.`,
          );
        const maxMarksTotal = questions.reduce(
          (sum, q) => sum + q.max_marks,
          0,
        );
        const earnedMarksTotal = allCorrect ? maxMarksTotal : 0;

        const attemptId = await seedAcceptanceAttempt(client, {
          assessmentId,
          enrolmentId: course.enrolmentId,
          studentId: course.studentId,
          cohortId: course.cohortId,
          programmeVersionId: course.programmeVersionId,
        });
        const resultId = await client.query(
          `insert into commercial_v1_assessment_result_revisions(
            activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,
            earned_marks_total,max_marks_total,component_weight_bp
          ) values($1,$2,$3,$4,$5,$6,1,$7,$8,commercial_v1_private.expected_component_weight($1,$4))
          returning id`,
          [
            course.activationId,
            course.enrolmentId,
            course.studentId,
            component,
            attemptId,
            assessmentId,
            earnedMarksTotal,
            maxMarksTotal,
          ],
        );
        const resultRevisionId = resultId.rows[0].id;

        // One commercial_v1_assessment_question_marks row per REAL question
        // -- assert_complete_question_marks() (called by
        // derive_and_insert_objective_outcomes below) requires an exact
        // 1:1 match against assessment_questions, never a subset/superset.
        for (const question of questions) {
          const marksAwarded = allCorrect ? question.max_marks : 0;
          await client.query(
            `insert into commercial_v1_assessment_question_marks(
              result_revision_id, question_id, marks_awarded, max_marks_snapshot
            ) values($1,$2,$3,$4)`,
            [resultRevisionId, question.id, marksAwarded, question.max_marks],
          );
        }

        await client.query(
          "select commercial_v1_private.derive_and_insert_objective_outcomes($1)",
          [resultRevisionId],
        );
        const { rows: validRows } = await client.query(
          "select commercial_v1_private.assessment_result_is_valid($1) as valid",
          [resultRevisionId],
        );
        if (!validRows[0]?.valid)
          throw new Error(
            `Seeded ${component} result revision ${resultRevisionId} failed commercial_v1_private.assessment_result_is_valid() after derivation -- refusing to leave an invalid acceptance result in place.`,
          );
      }

      const submissionId = await seedAcceptanceLabSubmission(client, {
        activationId: course.activationId,
        practicalId: course.practicalId,
        enrolmentId: course.enrolmentId,
        studentId: course.studentId,
        // course.enrolmentId is already unique per acceptance run (one
        // enrolment per run) and doubles as a stable idempotency-key seed --
        // no need to fabricate a second, separate uniqueness token here.
        idempotencySeed: course.enrolmentId,
      });
      const labResult = await client.query(
        `insert into commercial_v1_lab_result_revisions(
          activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp
        ) values($1,$2,$3,$4,$5,1,$6,10,2000) returning id`,
        [
          course.activationId,
          course.enrolmentId,
          course.studentId,
          course.practicalId,
          submissionId,
          allCorrect ? 10 : 0,
        ],
      );
      const labResultRevisionId = labResult.rows[0].id;
      await client.query(
        "select commercial_v1_private.derive_and_insert_lab_objective_outcomes($1)",
        [labResultRevisionId],
      );
      const { rows: labValidRows } = await client.query(
        "select commercial_v1_private.lab_result_is_valid($1) as valid",
        [labResultRevisionId],
      );
      if (!labValidRows[0]?.valid)
        throw new Error(
          `Seeded lab result revision ${labResultRevisionId} failed commercial_v1_private.lab_result_is_valid() after derivation -- refusing to leave an invalid acceptance result in place.`,
        );

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
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
