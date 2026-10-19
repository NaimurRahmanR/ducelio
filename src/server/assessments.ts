import { getMyCourseworkScope } from "./course-activation";
import "server-only";
import { z } from "zod";
import type { RecordCommercialV1ResponseResult } from "@/domain/commercial-v1-assessment-policy";
import {
  answerKeyIssues,
  interactionIssues,
  isObjectiveQuestionType,
  objectiveQuestionTypeSchema,
  questionTypeSchema,
  type QuestionType,
} from "@/domain/assessment-question-types";
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
  // `assessments` has no foreign key to programme_versions (see
  // getStudentAssessments), so the version snapshot is read separately below.
  const [assessments, attempts, cohorts, lessons, instructors] =
    await Promise.all([
      client
        .from("assessments")
        .select(
          "id,cohort_id,programme_version_id,lesson_id,instructor_id,title,instructions,opens_at,closes_at,duration_minutes,attempts_allowed,status,created_at,cohorts(title),lessons(title)",
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

  const assessmentRows = z
    .array(assessmentSchema.omit({ programme_versions: true }))
    .parse(assessments.data);
  const versionIds = [
    ...new Set(assessmentRows.map((row) => row.programme_version_id)),
  ];
  const versions = new Map<
    string,
    z.infer<typeof assessmentSchema>["programme_versions"]
  >();
  if (versionIds.length) {
    const { data, error } = await client
      .from("programme_versions")
      .select("id,label,title_snapshot")
      .in("id", versionIds);
    if (error) throw new Error("Assessment workspace could not be loaded.");
    for (const { id, ...version } of z
      .array(assessmentSchema.shape.programme_versions.extend({ id: z.uuid() }))
      .parse(data))
      versions.set(id, version);
  }
  // Fail closed: never render an assessment without its version snapshot.
  const parsedAssessments = assessmentRows.map((row) => {
    const version = versions.get(row.programme_version_id);
    if (!version) throw new Error("Assessment workspace could not be loaded.");
    return { ...row, programme_versions: version };
  });
  const questionsByAssessment: Record<
    string,
    (z.infer<typeof questionSchema> & { question_type: QuestionType })[]
  > = {};
  for (const assessment of parsedAssessments) {
    const [questions, interactions] = await Promise.all([
      client.rpc("list_assessment_authoring_questions", {
        p_assessment_id: assessment.id,
      }),
      // Types only: the authoring list never carries answer keys.
      client.rpc("list_assessment_authoring_interactions", {
        p_assessment_id: assessment.id,
      }),
    ]);
    if (questions.error || interactions.error)
      throw new Error("Assessment questions could not be loaded.");
    const types = new Map(
      z
        .array(interactionRowSchema)
        .parse(interactions.data)
        .map((row) => [row.question_id, row.question_type] as const),
    );
    questionsByAssessment[assessment.id] = z
      .array(questionSchema)
      .parse(questions.data)
      .map((question) => ({
        ...question,
        question_type: types.get(question.id) ?? "FREE_TEXT",
      }));
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

const jsonObjectText = z
  .string()
  .trim()
  .min(2)
  .max(65536)
  .transform((text, ctx) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid JSON." });
      return z.NEVER;
    }
  });

const objectiveQuestionSchema = z.object({
  assessmentId: z.uuid(),
  position: z.coerce.number().int().positive(),
  prompt: z.string().trim().min(1).max(12000),
  maxMarks: z.coerce.number().int().min(1).max(100),
  questionType: objectiveQuestionTypeSchema,
  interaction: jsonObjectText,
  answerKey: jsonObjectText,
  // Protected rationale shown only to staff reviewers.
  expectedAnswer: z.string().trim().min(1).max(12000),
  markingGuidance: z.string().trim().max(12000).nullable(),
  reason: z.string().trim().min(5).max(300),
});

export class ObjectiveQuestionDefinitionError extends Error {
  constructor() {
    super("The objective question definition is invalid.");
    this.name = "ObjectiveQuestionDefinitionError";
  }
}

// CP2 governed authoring for the five objective types. The same domain
// rules the package validator uses run here first (so an author gets a
// clear refusal without a round trip); the database independently
// re-validates the definition and key and is the authority. Neither the
// key nor any submitted value is ever echoed in an error.
export async function addObjectiveAssessmentQuestion(input: unknown) {
  const payload = objectiveQuestionSchema.parse(input);
  if (
    interactionIssues(payload.questionType, payload.interaction).length ||
    answerKeyIssues(
      payload.questionType,
      payload.interaction,
      payload.answerKey,
    ).length
  )
    throw new ObjectiveQuestionDefinitionError();
  await requireAnyRole(["INSTRUCTOR", "ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "add_objective_assessment_question",
    {
      p_assessment_id: payload.assessmentId,
      p_position: payload.position,
      p_prompt: payload.prompt,
      p_max_marks: payload.maxMarks,
      p_question_type: payload.questionType,
      p_interaction: payload.interaction,
      p_answer_key: payload.answerKey,
      p_expected_answer: payload.expectedAnswer,
      p_marking_guidance: payload.markingGuidance,
      p_reason: payload.reason,
    },
  );
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

// Bounded diagnostic for getStudentAssessments: WHICH Supabase request
// returned an error result. Only these six fixed stage codes exist; the
// message is the same generic learner-facing text as before and the
// upstream Supabase/PostgREST error (message, details, hint, SQL) is never
// copied into it. Zod failures, fail-closed invariants and unexpected
// exceptions are NOT wrapped in this class.
export const STUDENT_ASSESSMENT_READ_STAGES = [
  "FINALIZE",
  "READ_ASSESSMENTS",
  "READ_ATTEMPTS",
  "READ_RESPONSES",
  "ACTIVITY",
  "READ_VERSIONS",
] as const;
export type StudentAssessmentReadStage =
  (typeof STUDENT_ASSESSMENT_READ_STAGES)[number];

export class StudentAssessmentReadFailure extends Error {
  readonly stage: StudentAssessmentReadStage;
  constructor(stage: StudentAssessmentReadStage) {
    super("Your assessments could not be loaded.");
    this.name = "StudentAssessmentReadFailure";
    this.stage = stage;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const studentVersionSnapshotSchema = z.object({
  label: z.string(),
  title_snapshot: z.string().nullable(),
});
const studentAssessmentRowSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  instructions: z.string(),
  opens_at: z.string(),
  closes_at: z.string(),
  duration_minutes: z.number(),
  attempts_allowed: z.number(),
  status: z.enum(["PUBLISHED", "CLOSED"]),
  programme_version_id: z.uuid(),
  lessons: z.object({ title: z.string() }),
});

// Learner assessment list pagination. The projection used to read the 100
// EARLIEST assessments (opens_at ascending), so a learner with more than 100
// visible assessments never saw newly published ones; it also read the 100
// newest attempts and the 1000 newest responses across ALL attempts, which
// could under-count a listed assessment's attempts. It now reads:
//   * one page of assessments, newest first (opens_at, then id, both
//     descending -- a total order, so pages never overlap or skip);
//   * the learner's own ACTIVE attempt and its assessment independently of
//     the page, so an active attempt is always visible and resumable;
//   * attempts only for the assessments on the page (each allows at most 5);
//   * response revisions only for the active attempt.
// Every read stays under the learner's own session and RLS. A read that
// reaches its cap fails closed instead of presenting a truncated history.
export const STUDENT_ASSESSMENT_PAGE_SIZE = 25;
export const STUDENT_ASSESSMENT_MAX_PAGE = 1000;
// Both caps (plus the one overflow row each read requests) stay below
// hosted PostgREST's max-rows ceiling (1000 by default), so an overflow is
// always observable rather than silently truncated by the server. A page
// lists at most 25 assessments x 5 allowed attempts = 125 attempts.
const PAGE_ATTEMPT_CAP = 500;
const ACTIVE_RESPONSE_CAP = 900;

// The page number from an untrusted query string: digits only, 1..1000;
// anything else is page 1.
export function studentAssessmentPage(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,3}$/.test(raw)) return 1;
  return Math.min(Number(raw), STUDENT_ASSESSMENT_MAX_PAGE);
}

const STUDENT_ASSESSMENT_COLUMNS =
  "id,title,instructions,opens_at,closes_at,duration_minutes,attempts_allowed,status,programme_version_id,lessons(title)";
const STUDENT_ATTEMPT_COLUMNS =
  "id,assessment_id,attempt_number,state,started_at,expires_at,submitted_at";

export async function getStudentAssessments(options: { page?: number } = {}) {
  await requireActor("student");
  const page = studentAssessmentPage(String(options.page ?? 1));
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
      activeAssessment: null,
      attempts: [],
      responses: [],
      activityState: "NORMAL" as const,
      activeQuestions: [] as ActiveExamQuestion[],
      serverNow: new Date().toISOString(),
      pagination: {
        page,
        pageSize: STUDENT_ASSESSMENT_PAGE_SIZE,
        hasPreviousPage: page > 1,
        hasNextPage: false,
      },
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
  if (finalized.error) throw new StudentAssessmentReadFailure("FINALIZE");
  // `assessments` has composite foreign keys to cohorts and lessons but NO
  // foreign key to programme_versions, so PostgREST cannot embed
  // programme_versions from it (hosted PostgREST answers HTTP 400 PGRST200
  // for that select, which made this whole projection fail). The version
  // snapshot is therefore read separately below, under the learner's own
  // RLS, by the programme_version_id each visible assessment carries.
  const offset = (page - 1) * STUDENT_ASSESSMENT_PAGE_SIZE;
  const [assessments, activeAttempts, firstActivity] = await Promise.all([
    client
      .from("assessments")
      .select(STUDENT_ASSESSMENT_COLUMNS)
      .in("cohort_id", scope.cohortIds)
      .in("status", ["PUBLISHED", "CLOSED"])
      .order("opens_at", { ascending: false })
      .order("id", { ascending: false })
      // One row beyond the page shows whether an older page exists.
      .range(offset, offset + STUDENT_ASSESSMENT_PAGE_SIZE),
    client
      .from("assessment_attempts")
      .select(STUDENT_ATTEMPT_COLUMNS)
      .eq("student_id", scope.actorId)
      .eq("state", "ACTIVE")
      .order("started_at", { ascending: false })
      .limit(1),
    client.rpc("current_academic_activity_state"),
  ]);

  // Each request's error result is attributed to its own fixed stage (the
  // first failing one in this fixed order when several fail).
  if (assessments.error)
    throw new StudentAssessmentReadFailure("READ_ASSESSMENTS");
  if (activeAttempts.error)
    throw new StudentAssessmentReadFailure("READ_ATTEMPTS");
  // current_academic_activity_state is a STABLE, side-effect-free read. The
  // client sends every .rpc() as a POST, which postgrest-js does not
  // automatically retry, unlike eligible GET table reads. A client-side
  // failure represented without a usable HTTP response (status 0) is therefore
  // retried exactly once here, with no delay. Hosted journey run #4 was one
  // concrete pre-edge instance: no activity request reached the API gateway.
  // Any nonzero HTTP/PostgREST/database/auth error result is not retried here.
  // No other request receives an additional application-level retry here.
  const activity =
    firstActivity.error && firstActivity.status === 0
      ? await client.rpc("current_academic_activity_state")
      : firstActivity;
  if (activity.error) throw new StudentAssessmentReadFailure("ACTIVITY");

  const fetchedRows = z
    .array(studentAssessmentRowSchema)
    .parse(assessments.data);
  const pageRows = fetchedRows.slice(0, STUDENT_ASSESSMENT_PAGE_SIZE);
  const activeAttempt = z
    .array(attemptSchema)
    .max(1)
    .parse(activeAttempts.data)[0];
  const pageIds = pageRows.map((row) => row.id);

  // The active attempt's assessment, when it is not on this page.
  let activeRow = activeAttempt
    ? pageRows.find((row) => row.id === activeAttempt.assessment_id)
    : undefined;
  if (activeAttempt && !activeRow) {
    const { data, error } = await client
      .from("assessments")
      .select(STUDENT_ASSESSMENT_COLUMNS)
      .in("cohort_id", scope.cohortIds)
      .in("id", [activeAttempt.assessment_id])
      .limit(1);
    if (error) throw new StudentAssessmentReadFailure("READ_ASSESSMENTS");
    activeRow = z.array(studentAssessmentRowSchema).parse(data)[0];
  }

  const [pageAttempts, activeResponses] = await Promise.all([
    pageIds.length
      ? client
          .from("assessment_attempts")
          .select(STUDENT_ATTEMPT_COLUMNS)
          .eq("student_id", scope.actorId)
          .in("assessment_id", pageIds)
          .order("started_at", { ascending: false })
          .limit(PAGE_ATTEMPT_CAP + 1)
      : Promise.resolve({ data: [], error: null }),
    activeAttempt
      ? client
          .from("assessment_responses")
          .select("id,attempt_id,question_id,revision_number,recorded_at")
          .eq("student_id", scope.actorId)
          .eq("attempt_id", activeAttempt.id)
          .order("recorded_at", { ascending: false })
          .limit(ACTIVE_RESPONSE_CAP + 1)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (pageAttempts.error)
    throw new StudentAssessmentReadFailure("READ_ATTEMPTS");
  if (activeResponses.error)
    throw new StudentAssessmentReadFailure("READ_RESPONSES");
  const listedAttempts = z.array(attemptSchema).parse(pageAttempts.data);
  if (listedAttempts.length > PAGE_ATTEMPT_CAP)
    throw new StudentAssessmentReadFailure("READ_ATTEMPTS");
  const responses = z.array(responseSchema).parse(activeResponses.data);
  if (responses.length > ACTIVE_RESPONSE_CAP)
    throw new StudentAssessmentReadFailure("READ_RESPONSES");
  const parsedAttempts =
    activeAttempt && !listedAttempts.some((a) => a.id === activeAttempt.id)
      ? [activeAttempt, ...listedAttempts]
      : listedAttempts;

  const versionIds = [
    ...new Set(
      [...pageRows, ...(activeRow ? [activeRow] : [])].map(
        (row) => row.programme_version_id,
      ),
    ),
  ];
  const versions = new Map<
    string,
    z.infer<typeof studentVersionSnapshotSchema>
  >();
  if (versionIds.length) {
    const { data, error } = await client
      .from("programme_versions")
      .select("id,label,title_snapshot")
      .in("id", versionIds);
    if (error) throw new StudentAssessmentReadFailure("READ_VERSIONS");
    for (const version of z
      .array(studentVersionSnapshotSchema.extend({ id: z.uuid() }))
      .parse(data))
      versions.set(version.id, {
        label: version.label,
        title_snapshot: version.title_snapshot,
      });
  }
  // Fail closed: never render an assessment without the version snapshot
  // the learner is entitled to see for it.
  const withVersion = ({
    programme_version_id,
    ...row
  }: z.infer<typeof studentAssessmentRowSchema>) => {
    const version = versions.get(programme_version_id);
    if (!version) throw new Error("Your assessments could not be loaded.");
    return { ...row, programme_versions: version };
  };
  const visibleAssessments = pageRows.map(withVersion);

  const activityState = z
    .enum(["NORMAL", "CONTROLLED_ASSESSMENT_ACTIVE"])
    .parse(activity.data);
  let activeQuestions: ActiveExamQuestion[] = [];
  if (activeAttempt) {
    const { data, error } = await client.rpc(
      "get_active_assessment_questions",
      {
        p_assessment_id: activeAttempt.assessment_id,
      },
    );
    if (!error)
      activeQuestions = await withExamState(
        client,
        activeAttempt,
        z.array(questionSchema).parse(data),
        activityState,
      );
    // While the server itself reports a live controlled attempt, the
    // learner UI renders that attempt's protected-content shell and its
    // Submit button (src/components/student-assessments.tsx). Silently
    // returning no questions there would present a submittable attempt with
    // nothing to answer -- attempts are single-use -- so a protected-question
    // read failure in that state fails closed instead. Outside it (e.g. an
    // expired attempt the activity state already reports NORMAL) the shell is
    // not rendered and no questions are the honest projection.
    else if (activityState === "CONTROLLED_ASSESSMENT_ACTIVE")
      throw new Error("Your assessments could not be loaded.");
  }

  return {
    assessments: visibleAssessments,
    activeAssessment: activeRow ? withVersion(activeRow) : null,
    attempts: parsedAttempts,
    responses,
    activityState,
    activeQuestions,
    // Display calibration only: the countdown measures against server time
    // rather than the browser clock. Expiry itself is decided solely by the
    // database (assessment_attempts.expires_at).
    serverNow: new Date().toISOString(),
    pagination: {
      page,
      pageSize: STUDENT_ASSESSMENT_PAGE_SIZE,
      hasPreviousPage: page > 1,
      hasNextPage: fetchedRows.length > STUDENT_ASSESSMENT_PAGE_SIZE,
    },
  };
}

const interactionRowSchema = z.object({
  question_id: z.uuid(),
  question_type: objectiveQuestionTypeSchema,
  definition: z.unknown(),
});
const examStateRowSchema = z.object({
  question_id: z.uuid(),
  question_type: questionTypeSchema,
  definition: z.unknown().nullable(),
  saved_body: z.string().nullable(),
  revision_count: z.number().int().min(0),
});

export type ActiveExamQuestion = z.infer<typeof questionSchema> & {
  question_type: QuestionType;
  interaction: unknown;
  saved_body: string | null;
  revision_count: number;
};

// CP2: attaches, for the learner's OWN active attempt, each question's type
// and learner-visible interaction (never the answer key) plus the learner's
// latest saved answer, so a refresh resumes exactly where they left off.
// One gated RPC (get_active_assessment_exam_state, migration 059) applies
// the same release gate as get_active_assessment_questions. Any read
// failure, mismatch or malformed definition fails closed while the attempt
// is live.
async function withExamState(
  client: Awaited<ReturnType<typeof createSupabase>>,
  attempt: z.infer<typeof attemptSchema>,
  questions: z.infer<typeof questionSchema>[],
  activityState: "NORMAL" | "CONTROLLED_ASSESSMENT_ACTIVE",
): Promise<ActiveExamQuestion[]> {
  const { data, error } = await client.rpc("get_active_assessment_exam_state", {
    p_assessment_id: attempt.assessment_id,
  });
  if (error) {
    if (activityState === "CONTROLLED_ASSESSMENT_ACTIVE")
      throw new Error("Your assessments could not be loaded.");
    return [];
  }
  const state = new Map(
    z
      .array(examStateRowSchema)
      .parse(data)
      .map((row) => [row.question_id, row] as const),
  );
  return questions.map((question) => {
    const row = state.get(question.id);
    if (!row) throw new Error("Your assessments could not be loaded.");
    if (
      isObjectiveQuestionType(row.question_type) &&
      interactionIssues(row.question_type, row.definition).length
    )
      throw new Error("Your assessments could not be loaded.");
    return {
      ...question,
      question_type: row.question_type,
      interaction: row.definition,
      saved_body: row.saved_body,
      revision_count: row.revision_count,
    };
  });
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
