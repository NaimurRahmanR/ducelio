import "server-only";
import { z } from "zod";
import {
  AcademyError,
  academyCatalogueSchema,
  academyErrorCode,
  academyLessonSchema,
  academyPlanSchema,
  attemptSchema,
  labWriteSchema,
  myAcademyEnrolmentsSchema,
  progressSchema,
  responseWriteSchema,
  resultsSchema,
  revisionInputSchema,
  scheduleInputSchema,
  scheduleWriteSchema,
  startAttemptSchema,
  submitAttemptSchema,
  timetableSchema,
} from "@/domain/academy-delivery";
import { config } from "@/lib/env";
import { getAuthenticatedActor } from "./identity";
import { createSupabase } from "./supabase";

// Ducelio Academy (B2C) learner delivery. The learner identity is the
// authenticated session only; enrolment ownership, format terms, schedule
// feasibility, sitting windows, attempt limits, timing and scoring are all
// decided by the database (migration 202610220060) from its own clock.
// No call here can move a date, unlock an assessment or change a mark.
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
const id = (value: unknown) => z.uuid().parse(value);

// Public: published Academy offers with their approved per-format prices.
export async function listAcademyCatalogue() {
  if (!config().configured) throw new AcademyError("SERVICE_UNAVAILABLE");
  const { data, error } = await (
    await createSupabase()
  ).rpc("list_academy_catalogue");
  if (error) throw new AcademyError("SERVICE_UNAVAILABLE");
  return academyCatalogueSchema.parse(data);
}

export const listMyAcademyEnrolments = () =>
  learnerRpc("list_my_academy_enrolments", {}, myAcademyEnrolmentsSchema);

export function previewMyAcademySchedule(input: unknown) {
  const p = scheduleInputSchema.parse(input);
  return learnerRpc(
    "preview_my_academy_schedule",
    {
      p_enrolment_id: p.enrolmentId,
      p_format_id: p.formatId,
      p_start_on: p.startOn,
      p_study_days: p.studyDays,
      p_local_time: p.localTime,
      p_timezone: p.timezone,
    },
    academyPlanSchema,
  );
}

export function confirmMyAcademySchedule(input: unknown, requestKey: string) {
  const p = scheduleInputSchema.parse(input);
  return learnerRpc(
    "confirm_my_academy_schedule",
    {
      p_enrolment_id: p.enrolmentId,
      p_format_id: p.formatId,
      p_start_on: p.startOn,
      p_study_days: p.studyDays,
      p_local_time: p.localTime,
      p_timezone: p.timezone,
      p_request_key: id(requestKey),
    },
    scheduleWriteSchema,
  );
}

export function previewMyAcademyRevision(input: unknown) {
  const p = revisionInputSchema.parse(input);
  return learnerRpc(
    "preview_my_academy_schedule_revision",
    {
      p_enrolment_id: p.enrolmentId,
      p_effective_on: p.effectiveOn,
      p_study_days: p.studyDays,
      p_local_time: p.localTime,
      p_timezone: p.timezone,
    },
    academyPlanSchema,
  );
}

export function reviseMyAcademySchedule(input: unknown, requestKey: string) {
  const p = revisionInputSchema.parse(input);
  return learnerRpc(
    "revise_my_academy_schedule",
    {
      p_enrolment_id: p.enrolmentId,
      p_expected_revision: p.expectedRevision,
      p_effective_on: p.effectiveOn,
      p_study_days: p.studyDays,
      p_local_time: p.localTime,
      p_timezone: p.timezone,
      p_request_key: id(requestKey),
    },
    scheduleWriteSchema,
  );
}

export const getMyAcademyTimetable = (enrolmentId: unknown) =>
  learnerRpc(
    "get_my_academy_timetable",
    { p_enrolment_id: id(enrolmentId) },
    timetableSchema,
  );

export const getMyAcademyLesson = (enrolmentId: unknown, lessonRef: unknown) =>
  learnerRpc(
    "get_my_academy_lesson",
    {
      p_enrolment_id: id(enrolmentId),
      p_lesson_ref: z.string().min(1).max(80).parse(lessonRef),
    },
    academyLessonSchema,
  );

export const startMyAcademyAssessment = (
  enrolmentId: unknown,
  assessmentRef: unknown,
) =>
  learnerRpc(
    "start_my_academy_assessment",
    {
      p_enrolment_id: id(enrolmentId),
      p_assessment_ref: z.string().min(1).max(80).parse(assessmentRef),
    },
    startAttemptSchema,
  );

export const getMyAcademyAttempt = (attemptId: unknown) =>
  learnerRpc(
    "get_my_academy_attempt",
    { p_attempt_id: id(attemptId) },
    attemptSchema,
  );

export const recordMyAcademyResponse = (
  attemptId: unknown,
  position: number,
  body: string,
  key: string,
) =>
  learnerRpc(
    "record_my_academy_response",
    {
      p_attempt_id: id(attemptId),
      p_question_position: z.number().int().positive().parse(position),
      p_body: z.string().min(1).max(20000).parse(body),
      p_idempotency_key: z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,128}$/)
        .parse(key),
    },
    responseWriteSchema,
  );

export const submitMyAcademyAttempt = (attemptId: unknown) =>
  learnerRpc(
    "submit_my_academy_attempt",
    { p_attempt_id: id(attemptId) },
    submitAttemptSchema,
  );

export const submitMyAcademyLab = (
  enrolmentId: unknown,
  labRef: unknown,
  body: unknown,
  requestKey: string,
) =>
  learnerRpc(
    "submit_my_academy_lab",
    {
      p_enrolment_id: id(enrolmentId),
      p_lab_ref: z.string().min(1).max(80).parse(labRef),
      p_body: z.string().trim().min(1).max(20000).parse(body),
      p_request_key: id(requestKey),
    },
    labWriteSchema,
  );

export const getMyAcademyResults = (enrolmentId: unknown) =>
  learnerRpc(
    "get_my_academy_results",
    { p_enrolment_id: id(enrolmentId) },
    resultsSchema,
  );

export const recordMyAcademyLessonStudied = (
  enrolmentId: unknown,
  lessonRef: unknown,
) =>
  learnerRpc(
    "record_my_academy_lesson_studied",
    {
      p_enrolment_id: id(enrolmentId),
      p_lesson_ref: z.string().min(1).max(80).parse(lessonRef),
    },
    z.union([
      z.object({ ok: z.literal(true), replayed: z.boolean() }),
      z.object({ ok: z.literal(false), code: z.string() }),
    ]),
  );

export const getMyAcademyProgress = (enrolmentId: unknown) =>
  learnerRpc(
    "get_my_academy_progress",
    { p_enrolment_id: id(enrolmentId) },
    progressSchema,
  );
