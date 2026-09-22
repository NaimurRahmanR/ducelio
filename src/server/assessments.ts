import { getMyCourseworkScope } from "./course-activation";
import "server-only";
import { z } from "zod";
import type { RecordCommercialV1ResponseResult } from "@/domain/commercial-v1-assessment-policy";
import { recordCommercialV1AssessmentResponse } from "./commercial-v1-assessment-policy";
import { requireActor, requireAnyRole } from "./identity";
import { createSupabase } from "./supabase";

const assessmentCreationSchema = z
  .object({
    cohortId: z.uuid(),
    lessonId: z.uuid(),
    instructorId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(12000),
    opensAt: z.iso.datetime({ offset: true }),
    closesAt: z.iso.datetime({ offset: true }),
    durationMinutes: z.coerce.number().int().min(1).max(360),
    attemptsAllowed: z.coerce.number().int().min(1).max(5),
    reason: z.string().trim().min(5).max(300),
  })
  .refine(
    (value) =>
      new Date(value.closesAt).getTime() > new Date(value.opensAt).getTime(),
    "Assessment close time must be after its opening time.",
  );

const assessmentQuestionSchema = z.object({
  assessmentId: z.uuid(),
  position: z.coerce.number().int().positive(),
  prompt: z.string().trim().min(1).max(12000),
  maxMarks: z.coerce.number().int().min(1).max(100),
  expectedAnswer: z.string().trim().min(1).max(12000),
  markingGuidance: z.string().trim().max(12000).nullable(),
  reason: z.string().trim().min(5).max(300),
});

const assessmentStatusSchema = z.object({
  assessmentId: z.uuid(),
  status: z.enum(["PUBLISHED", "CLOSED"]),
  reason: z.string().trim().min(5).max(300),
});

const assessmentResponseSchema = z.object({
  attemptId: z.uuid(),
  questionId: z.uuid(),
  body: z.string().trim().min(1).max(20000),
  idempotencyKey: z.string().trim().min(8).max(200),
});

const assessmentSchema = z.object({
  id: z.uuid(),
  cohort_id: z.uuid(),
  programme_version_id: z.uuid(),
  lesson_id: z.uuid(),
  instructor_id: z.uuid(),
  title: z.string(),
  instructions: z.string(),
  opens_at: z.string(),
  closes_at: z.string(),
  duration_minutes: z.number(),
  attempts_allowed: z.number(),
  status: z.enum(["DRAFT", "PUBLISHED", "CLOSED"]),
  created_at: z.string(),
  cohorts: z.object({ title: z.string() }),
  lessons: z.object({ title: z.string() }),
  programme_versions: z.object({
    label: z.string(),
    title_snapshot: z.string().nullable(),
  }),
});

const questionSchema = z.object({
  id: z.uuid(),
  position: z.number(),
  prompt: z.string(),
  max_marks: z.number(),
});

const attemptSchema = z.object({
  id: z.uuid(),
  assessment_id: z.uuid(),
  attempt_number: z.number(),
  state: z.enum(["ACTIVE", "SUBMITTED", "VOIDED"]),
  started_at: z.string(),
  expires_at: z.string(),
  submitted_at: z.string().nullable(),
});

const responseSchema = z.object({
  id: z.uuid(),
  attempt_id: z.uuid(),
  question_id: z.uuid(),
  revision_number: z.number(),
  recorded_at: z.string(),
});

export async function getAssessmentWorkspace() {
  await requireActor("admin");
  const client = await createSupabase();
  const [assessments, attempts, cohorts, lessons, instructors] =
    await Promise.all([
      client
        .from("assessments")
        .select(
          "id,cohort_id,programme_version_id,lesson_id,instructor_id,title,instructions,opens_at,closes_at,duration_minutes,attempts_allowed,status,created_at,cohorts(title),lessons(title),programme_versions(label,title_snapshot)",
        )
        .order("created_at", { ascending: false })
        .limit(300),
      client
        .from("assessment_attempts")
        .select(
          "id,assessment_id,attempt_number,state,started_at,expires_at,submitted_at",
        )
        .order("started_at", { ascending: false })
        .limit(1000),
      client
        .from("cohorts")
        .select("id,title,programme_version_id")
        .order("starts_on", { ascending: false })
        .limit(200),
      client
        .from("lessons")
        .select("id,title,programme_version_id")
        .order("title")
        .limit(500),
      client.rpc("list_assignable_instructors"),
    ]);

  if (
    assessments.error ||
    attempts.error ||
    cohorts.error ||
    lessons.error ||
    instructors.error
  )
    throw new Error("Assessment workspace could not be loaded.");

  const parsedAssessments = z.array(assessmentSchema).parse(assessments.data);
  const questionsByAssessment: Record<
    string,
    z.infer<typeof questionSchema>[]
  > = {};
  for (const assessment of parsedAssessments) {
    const { data, error } = await client.rpc(
      "list_assessment_authoring_questions",
      {
        p_assessment_id: assessment.id,
      },
    );
    if (error) throw new Error("Assessment questions could not be loaded.");
    questionsByAssessment[assessment.id] = z.array(questionSchema).parse(data);
  }

  return {
    assessments: parsedAssessments,
    attempts: z.array(attemptSchema).parse(attempts.data),
    questionsByAssessment,
    cohorts: z
      .array(
        z.object({
          id: z.uuid(),
          title: z.string(),
          programme_version_id: z.uuid(),
        }),
      )
      .parse(cohorts.data),
    lessons: z
      .array(
        z.object({
          id: z.uuid(),
          title: z.string(),
          programme_version_id: z.uuid(),
        }),
      )
      .parse(lessons.data),
    instructors: z
      .array(
        z.object({
          user_id: z.uuid(),
          display_name: z.string(),
          title: z.string(),
        }),
      )
      .parse(instructors.data),
  };
}

export async function createAssessment(input: unknown) {
  const payload = assessmentCreationSchema.parse(input);
  await requireAnyRole(["INSTRUCTOR", "ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const client = await createSupabase();
  const { data, error } = await client.rpc("create_assessment", {
    p_cohort_id: payload.cohortId,
    p_lesson_id: payload.lessonId,
    p_instructor_id: payload.instructorId,
    p_title: payload.title,
    p_instructions: payload.instructions,
    p_opens_at: payload.opensAt,
    p_closes_at: payload.closesAt,
    p_duration_minutes: payload.durationMinutes,
    p_attempts_allowed: payload.attemptsAllowed,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Assessment could not be created.");
  return z.uuid().parse(data);
}

export async function addAssessmentQuestion(input: unknown) {
  const payload = assessmentQuestionSchema.parse(input);
  await requireAnyRole(["INSTRUCTOR", "ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const client = await createSupabase();
  const { data, error } = await client.rpc("add_assessment_question", {
    p_assessment_id: payload.assessmentId,
    p_position: payload.position,
    p_prompt: payload.prompt,
    p_max_marks: payload.maxMarks,
    p_expected_answer: payload.expectedAnswer,
    p_marking_guidance: payload.markingGuidance,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Assessment question could not be added.");
  return z.uuid().parse(data);
}

export async function changeAssessmentStatus(input: unknown) {
  const payload = assessmentStatusSchema.parse(input);
  await requireAnyRole(["INSTRUCTOR", "ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const client = await createSupabase();
  const { data, error } = await client.rpc("change_assessment_status", {
    p_assessment_id: payload.assessmentId,
    p_status: payload.status,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Assessment status could not be changed.");
  return z.uuid().parse(data);
}

export async function getStudentAssessments() {
  await requireActor("student");
  const scope = await getMyCourseworkScope();
  // A legitimate STUDENT with zero enrolments has an empty cohort scope. Real
  // Supabase/PostgREST does not guarantee `.in("cohort_id", [])` behaves like
  // the empty-array semantics a local test double might emulate, so this is
  // short-circuited before any query is ever issued. No valid controlled
  // assessment attempt can exist without an enrolment, so NORMAL is the
  // correct, honest activity state here -- not a fabricated enrolment or
  // sentinel value.
  if (scope.cohortIds.length === 0)
    return {
      assessments: [],
      attempts: [],
      responses: [],
      activityState: "NORMAL" as const,
      activeQuestions: [],
    };
  const client = await createSupabase();
  // A Commercial V1-governed attempt whose deadline has elapsed (or whose
  // assessment was administratively closed) stays state=ACTIVE in
  // assessment_attempts until something finalises it -- there is no scheduler.
  // Finalise it, through the existing database authority, BEFORE reading so
  // this projection can never present an expired governed attempt as active.
  // The RPC is self-scoped to this STUDENT, restricted to explicitly bound
  // assessments under a published policy, anchors submitted_at to the
  // attempt's own expires_at, and is idempotent. Time is decided by the
  // database clock only. Fail closed: if finalisation cannot be established,
  // do not render a possibly stale lifecycle.
  const finalized = await client.rpc("finalize_expired_commercial_v1_attempts");
  if (finalized.error) throw new Error("Your assessments could not be loaded.");
  const [assessments, attempts, responses, activity] = await Promise.all([
    client
      .from("assessments")
      .select(
        "id,title,instructions,opens_at,closes_at,duration_minutes,attempts_allowed,status,lessons(title),programme_versions(label,title_snapshot)",
      )
      .in("cohort_id", scope.cohortIds)
      .in("status", ["PUBLISHED", "CLOSED"])
      .order("opens_at", { ascending: true })
      .limit(100),
    client
      .from("assessment_attempts")
      .select(
        "id,assessment_id,attempt_number,state,started_at,expires_at,submitted_at",
      )
      .eq("student_id", scope.actorId)
      .order("started_at", { ascending: false })
      .limit(100),
    client
      .from("assessment_responses")
      .select("id,attempt_id,question_id,revision_number,recorded_at")
      .eq("student_id", scope.actorId)
      .order("recorded_at", { ascending: false })
      .limit(1000),
    client.rpc("current_academic_activity_state"),
  ]);

  if (assessments.error || attempts.error || responses.error || activity.error)
    throw new Error("Your assessments could not be loaded.");

  const parsedAttempts = z.array(attemptSchema).parse(attempts.data);
  const activeAttempt = parsedAttempts.find(
    (attempt) => attempt.state === "ACTIVE",
  );
  let activeQuestions: z.infer<typeof questionSchema>[] = [];
  if (activeAttempt) {
    const { data, error } = await client.rpc(
      "get_active_assessment_questions",
      {
        p_assessment_id: activeAttempt.assessment_id,
      },
    );
    if (!error) activeQuestions = z.array(questionSchema).parse(data);
  }

  return {
    assessments: z
      .array(
        z.object({
          id: z.uuid(),
          title: z.string(),
          instructions: z.string(),
          opens_at: z.string(),
          closes_at: z.string(),
          duration_minutes: z.number(),
          attempts_allowed: z.number(),
          status: z.enum(["PUBLISHED", "CLOSED"]),
          lessons: z.object({ title: z.string() }),
          programme_versions: z.object({
            label: z.string(),
            title_snapshot: z.string().nullable(),
          }),
        }),
      )
      .parse(assessments.data),
    attempts: parsedAttempts,
    responses: z.array(responseSchema).parse(responses.data),
    activityState: z
      .enum(["NORMAL", "CONTROLLED_ASSESSMENT_ACTIVE"])
      .parse(activity.data),
    activeQuestions,
  };
}

export async function startAssessmentAttempt(assessmentId: unknown) {
  const id = z.uuid().parse(assessmentId);
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client.rpc("start_assessment_attempt", {
    p_assessment_id: id,
  });
  if (error) throw new Error("Assessment attempt could not be started.");
  return z.uuid().parse(data);
}

// The legacy (pre-Commercial V1) response writer. Deliberately NOT exported:
// migration 029 makes record_assessment_response refuse every Commercial
// V1-governed attempt, so this must only ever be reached through
// recordAssessmentResponse below, and only after the governed surface has
// itself said the attempt is not governed.
async function recordLegacyAssessmentResponse(
  payload: z.infer<typeof assessmentResponseSchema>,
) {
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client.rpc("record_assessment_response", {
    p_attempt_id: payload.attemptId,
    p_question_id: payload.questionId,
    p_body: payload.body,
    p_idempotency_key: payload.idempotencyKey,
  });
  if (error) throw new Error("Assessment response could not be saved.");
  return z.uuid().parse(data);
}

// What a caller of the response composition can ever see. It is the governed
// surface's own structured result minus its internal routing signal: a caller
// is never told, and can never choose, which writer handled its request.
export type AssessmentResponseOutcome = Exclude<
  RecordCommercialV1ResponseResult,
  { ok: false; code: "NOT_COMMERCIAL_V1_GOVERNED" }
>;

// THE single server-owned boundary for saving a controlled-assessment
// response. Which writer handles a request is decided here from
// authoritative database state -- never from anything the browser supplies
// (the only inputs are the four bounded fields below).
//
// Routing: the Commercial V1 governed writer is always tried FIRST. Only its
// explicit NOT_COMMERCIAL_V1_GOVERNED answer routes to the legacy writer;
// every other outcome -- success, EXPIRED, RESPONSE_WINDOW_CLOSED,
// ATTEMPT_NOT_ACTIVE, NOT_FOUND_OR_FORBIDDEN, IDEMPOTENCY_CONFLICT,
// INVALID_INPUT -- is final and is returned as-is. A transport error or an
// unrecognised result throws and likewise never falls back.
//
// Why probing governed-first is side-effect safe (migration 029): for an
// attempt that is not governed, record_commercial_v1_assessment_response
// returns NOT_COMMERCIAL_V1_GOVERNED after proving ownership and before any
// finalisation, insert or audit write; ownership is checked first, so a
// non-owner only ever sees NOT_FOUND_OR_FORBIDDEN and learns nothing about
// governance. And an attempt's governed status cannot change once it exists:
// publishing a grading policy is refused while any attempt history exists on
// a bound assessment, and published policies/bindings are immutable. So the
// answer cannot flip between the probe and the fallback -- and if it somehow
// did, the legacy RPC refuses a governed attempt, failing closed.
export async function recordAssessmentResponse(
  input: unknown,
): Promise<AssessmentResponseOutcome> {
  const payload = assessmentResponseSchema.parse(input);
  const governed = await recordCommercialV1AssessmentResponse(payload);
  if (governed.ok || governed.code !== "NOT_COMMERCIAL_V1_GOVERNED")
    return governed;
  return {
    ok: true,
    responseId: await recordLegacyAssessmentResponse(payload),
  };
}

export async function submitAssessmentAttempt(attemptId: unknown) {
  const id = z.uuid().parse(attemptId);
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client.rpc("submit_assessment_attempt", {
    p_attempt_id: id,
  });
  if (error) throw new Error("Assessment attempt could not be submitted.");
  return z.uuid().parse(data);
}
