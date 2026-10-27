import "server-only";
import { z } from "zod";
import { AcademyError, academyErrorCode } from "@/domain/academy-delivery";
import type {
  AssessmentCentre,
  AssessmentLeaderboard,
  ClassEvidence,
  CourseProgression,
  CourseWorkspace,
  LearnerActivity,
  LearnerCourse,
  LearnerWeek,
  PracticalLab,
  ReleasedResult,
} from "@/domain/learner-contract";
import { openMyAcademyClass } from "./academy-professor-classroom";
import { getAuthenticatedActor } from "./identity";
import { createSupabase } from "./supabase";

// Learner academic projections (docs/61, migration 202611050075). The
// learner is the authenticated session only; every value below is decided
// by the database from its own clock: windows, attendance, release, results,
// attempt policy, collisions and leaderboards. Nothing here can move a date,
// reveal an unreleased result or change a mark. Release processing is
// idempotent and is triggered before reads so lazily expired attempts and
// closed windows are reflected; a failed refresh never exposes anything
// (unreleased results stay withheld at the database boundary).

async function learnerRpc<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const actor = await getAuthenticatedActor();
  if (!actor?.roles.includes("STUDENT")) throw new AcademyError("FORBIDDEN");
  const { data, error } = await (await createSupabase()).rpc(name, args);
  if (error) throw new AcademyError(academyErrorCode(error.message));
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new AcademyError("SERVICE_UNAVAILABLE");
  return parsed.data;
}
const uuid = (value: unknown) => z.uuid().parse(value);
const stamp = z.string().min(1).max(64);
const isoDate = z.iso.date();

const activityKind = z.enum(["LESSON", "LAB", "REVISION", "ASSESSMENT"]);
const activityState = z.enum([
  "UPCOMING",
  "OPEN",
  "ATTENDED",
  "SUBMITTED",
  "RELEASED",
  "MISSED",
  "CLOSED",
]);

const learnerCourseSchema = z.strictObject({
  enrolmentId: z.uuid(),
  courseId: z.uuid(),
  title: z.string(),
  provider: z.string(),
  status: z.enum(["ACTIVE", "COMPLETED"]),
  scheduled: z.boolean(),
  accessRevoked: z.boolean(),
});

const learnerActivitySchema = z.strictObject({
  itemId: z.uuid(),
  enrolmentId: z.uuid(),
  courseTitle: z.string(),
  provider: z.string(),
  kind: activityKind,
  ref: z.string(),
  title: z.string(),
  part: z.number().int(),
  parts: z.number().int(),
  startsAt: stamp,
  endsAt: stamp,
  opensAt: stamp.nullable(),
  closesAt: stamp.nullable(),
  state: activityState,
});

const learnerWeekSchema = z.strictObject({
  weekStart: isoDate,
  timezone: z.string().min(1).max(100),
  serverTime: stamp,
  activities: z.array(learnerActivitySchema),
});

const classEvidenceSchema = z.strictObject({
  checkedInAt: stamp.nullable(),
  correctInClassAnswers: z.number().int().min(0),
  lessonObjectives: z.array(
    z.strictObject({
      ref: z.string(),
      title: z.string(),
      covered: z.boolean(),
    }),
  ),
  topicsCovered: z.array(z.string()),
});

const releasedResultSchema = z.strictObject({
  enrolmentId: z.uuid(),
  courseTitle: z.string(),
  assessmentRef: z.string(),
  assessmentTitle: z.string(),
  kind: z.string(),
  releasedAt: stamp,
  bestScore: z.number().int(),
  maxScore: z.number().int(),
  attemptsUsed: z.number().int(),
  passed: z.boolean().nullable(),
});

const assessmentCentreSchema = z
  .strictObject({
    itemId: z.uuid(),
    ref: z.string(),
    title: z.string(),
    opensAt: stamp,
    closesAt: stamp,
    durationMinutes: z.number().int(),
    attemptsUsed: z.number().int(),
    attemptsAllowed: z.number().int().min(1).max(2),
    activeAttemptId: z.uuid().nullable(),
    state: activityState,
    canStart: z.boolean(),
    reason: z.string().nullable(),
  })
  .nullable();

const practicalLabSchema = z
  .strictObject({
    itemId: z.uuid(),
    ref: z.string(),
    title: z.string(),
    opensAt: stamp,
    closesAt: stamp.nullable(),
    state: activityState,
    canAttend: z.boolean(),
    submitted: z.boolean(),
    graded: z.boolean(),
  })
  .nullable();

const progressionSchema = z.strictObject({
  enrolmentId: z.uuid(),
  classes: z.strictObject({
    total: z.number().int(),
    attended: z.number().int(),
    missed: z.number().int(),
  }),
  objectives: z.strictObject({
    total: z.number().int(),
    demonstrated: z.number().int(),
  }),
  practicals: z.strictObject({
    total: z.number().int(),
    submitted: z.number().int(),
    graded: z.number().int(),
  }),
  assessments: z.strictObject({
    total: z.number().int(),
    released: z.number().int(),
  }),
  completion: z.strictObject({
    completed: z.boolean(),
    completedAt: stamp.nullable(),
  }),
});

const workspaceSchema = z.strictObject({
  course: learnerCourseSchema,
  currentClass: learnerActivitySchema
    .extend({ evidence: classEvidenceSchema, classroomId: z.uuid().nullable() })
    .nullable(),
  tutorAvailable: z.boolean(),
  assessment: assessmentCentreSchema,
  lab: practicalLabSchema,
  results: z.array(releasedResultSchema),
  progression: progressionSchema,
});

const leaderboardSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    courseTitle: z.string(),
    assessmentRef: z.string(),
    assessmentTitle: z.string(),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    entries: z
      .array(
        z.strictObject({
          rank: z.number().int().min(1).max(10),
          label: z.string().max(40),
          bestScore: z.number().int(),
          maxScore: z.number().int(),
          isMe: z.boolean(),
        }),
      )
      .max(10),
  }),
  z.strictObject({ ok: z.literal(false), code: z.string().max(64) }),
]);

const leaderboardListSchema = z.array(
  z.strictObject({
    enrolmentId: z.uuid(),
    courseTitle: z.string(),
    assessmentRef: z.string(),
    assessmentTitle: z.string(),
    month: z.string().regex(/^\d{4}-\d{2}$/),
  }),
);
export type LeaderboardAvailability = z.infer<
  typeof leaderboardListSchema
>[number];

const refreshSchema = z.strictObject({
  ok: z.literal(true),
  enrolmentId: z.uuid(),
  released: z.array(z.string()),
});

const checkInSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    checkedInAt: stamp,
    replayed: z.boolean(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.string().max(64),
    opensAt: stamp.nullable().optional(),
    closesAt: stamp.nullable().optional(),
  }),
]);

const classEvidenceMapSchema = z.strictObject({
  weekStart: isoDate,
  timezone: z.string(),
  evidence: z.record(z.uuid(), classEvidenceSchema),
});

// ---------------------------------------------------------------------------
// Release processing.
// ---------------------------------------------------------------------------
// Idempotent: finalises the enrolment's expired attempts and processes every
// assessment whose window has closed. Returns the released assessment refs.
export async function refreshMyReleases(
  enrolmentId: string,
): Promise<{ released: string[] }> {
  const result = await learnerRpc(
    "refresh_my_academy_releases",
    { p_enrolment_id: uuid(enrolmentId) },
    refreshSchema,
  );
  return { released: result.released };
}

async function refreshQuietly(enrolmentId: string) {
  try {
    await refreshMyReleases(enrolmentId);
  } catch {
    // A refresh is best effort: the read below stays confidential anyway.
  }
}

async function refreshActive(courses: LearnerCourse[]) {
  for (const course of courses)
    if (course.status === "ACTIVE" && !course.accessRevoked)
      await refreshQuietly(course.enrolmentId);
}

// ---------------------------------------------------------------------------
// Courses, week and next activity.
// ---------------------------------------------------------------------------
const listCourses = () =>
  learnerRpc("list_my_academy_courses", {}, z.array(learnerCourseSchema));

export async function listMyLearnerCourses(): Promise<LearnerCourse[]> {
  const courses = await listCourses();
  if (!courses.some((c) => c.status === "ACTIVE" && !c.accessRevoked))
    return courses;
  await refreshActive(courses);
  return listCourses();
}

const weekArg = (weekStartIso?: string) => {
  const parsed = isoDate.safeParse(weekStartIso);
  return parsed.success ? parsed.data : null;
};

// Every activity of every current timetable in the learner's week (Monday
// in the learner's timetable timezone), with no truncation.
export async function getMyLearnerWeek(
  weekStartIso?: string,
): Promise<LearnerWeek> {
  await refreshActive(await listCourses());
  return learnerRpc(
    "list_my_academy_week",
    { p_week_start: weekArg(weekStartIso) },
    learnerWeekSchema,
  );
}

export async function getMyNextActivity(): Promise<LearnerActivity | null> {
  await refreshActive(await listCourses());
  return learnerRpc(
    "get_my_academy_next_activity",
    {},
    learnerActivitySchema.nullable(),
  );
}

// Display-only class evidence for every LESSON of the week, keyed by the
// schedule item id (optionally one enrolment).
export async function getMyClassEvidence(
  enrolmentId?: string,
  weekStartIso?: string,
): Promise<Record<string, ClassEvidence>> {
  const result = await learnerRpc(
    "list_my_academy_class_evidence",
    {
      p_enrolment_id: enrolmentId ? uuid(enrolmentId) : null,
      p_week_start: weekArg(weekStartIso),
    },
    classEvidenceMapSchema,
  );
  return result.evidence;
}

// ---------------------------------------------------------------------------
// Course workspace, progression and released results.
// ---------------------------------------------------------------------------
export async function getMyCourseWorkspace(
  enrolmentId: string,
): Promise<CourseWorkspace> {
  const id = uuid(enrolmentId);
  await refreshQuietly(id);
  const workspace = await learnerRpc(
    "get_my_academy_course_workspace",
    { p_enrolment_id: id },
    workspaceSchema,
  );
  return {
    ...workspace,
    assessment: workspace.assessment as AssessmentCentre,
    lab: workspace.lab as PracticalLab,
  };
}

export async function getMyCourseProgression(
  enrolmentId: string,
): Promise<CourseProgression> {
  const id = uuid(enrolmentId);
  await refreshQuietly(id);
  return learnerRpc(
    "get_my_academy_progression",
    { p_enrolment_id: id },
    progressionSchema,
  );
}

// Released assessment results only (one enrolment, or every enrolment).
export async function getMyReleasedResults(
  enrolmentId?: string,
): Promise<ReleasedResult[]> {
  if (enrolmentId) await refreshQuietly(uuid(enrolmentId));
  else await refreshActive(await listCourses());
  return learnerRpc(
    "list_my_academy_released_results",
    { p_enrolment_id: enrolmentId ? uuid(enrolmentId) : null },
    z.array(releasedResultSchema),
  );
}

// ---------------------------------------------------------------------------
// Leaderboards.
// ---------------------------------------------------------------------------
export const listMyLeaderboardAvailability = () =>
  learnerRpc("list_my_academy_leaderboards", {}, leaderboardListSchema);

export async function getMyLeaderboard(
  enrolmentId: string,
  assessmentRef: string,
  month: string,
): Promise<AssessmentLeaderboard> {
  const yearMonth = z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .parse(month);
  const result = await learnerRpc(
    "get_my_academy_assessment_leaderboard",
    {
      p_enrolment_id: uuid(enrolmentId),
      p_assessment_ref: z.string().min(1).max(80).parse(assessmentRef),
      p_month: `${yearMonth}-01`,
    },
    leaderboardSchema,
  );
  if (!result.ok) throw new AcademyError(academyErrorCode(result.code));
  return {
    courseTitle: result.courseTitle,
    assessmentRef: result.assessmentRef,
    assessmentTitle: result.assessmentTitle,
    month: result.month,
    entries: result.entries,
  };
}

// Every available monthly board of the learner's courses (released entries
// only), bounded so one page never fans out unboundedly.
export const LEADERBOARD_PAGE_LIMIT = 24;
export async function listMyLeaderboards(): Promise<AssessmentLeaderboard[]> {
  const available = await listMyLeaderboardAvailability();
  const boards: AssessmentLeaderboard[] = [];
  for (const board of available.slice(0, LEADERBOARD_PAGE_LIMIT))
    boards.push(
      await getMyLeaderboard(
        board.enrolmentId,
        board.assessmentRef,
        board.month,
      ),
    );
  return boards;
}

// ---------------------------------------------------------------------------
// Attendance.
// ---------------------------------------------------------------------------
export type CheckInResult =
  | {
      ok: true;
      checkedInAt: string;
      replayed: boolean;
      // The existing classroom flow, opened after check-in; null with a
      // code when the class itself cannot open (e.g. during an exam).
      classroomId: string | null;
      classroomCode: string | null;
    }
  | { ok: false; code: string };

// Records attendance for one scheduled LESSON inside its window (idempotent;
// attendance is not completion or mastery), then opens or resumes the
// existing classroom.
export async function checkInToClass(
  enrolmentId: string,
  itemId: string,
): Promise<CheckInResult> {
  const enrolment = uuid(enrolmentId);
  const item = uuid(itemId);
  const result = await learnerRpc(
    "check_in_my_academy_class",
    { p_enrolment_id: enrolment, p_item_id: item },
    checkInSchema,
  );
  if (!result.ok) return { ok: false, code: result.code };
  try {
    const opened = await openMyAcademyClass(enrolment, item);
    return {
      ok: true,
      checkedInAt: result.checkedInAt,
      replayed: result.replayed,
      classroomId: opened.classroomId,
      classroomCode: null,
    };
  } catch (error) {
    return {
      ok: true,
      checkedInAt: result.checkedInAt,
      replayed: result.replayed,
      classroomId: null,
      classroomCode:
        error instanceof Error && "code" in error
          ? String((error as { code: unknown }).code)
          : "SERVICE_UNAVAILABLE",
    };
  }
}
