import "server-only";
import { z } from "zod";
import {
  SessionOperationError,
  sessionErrorCode,
} from "@/domain/session-operations";
import {
  classSessionCreationSchema,
  classSessionStatusSchema,
} from "@/domain/academy";
import { requireActor, requireAnyRole } from "./identity";
import { createSupabase } from "./supabase";
import { getOwnedStudentEnrolment } from "./academy";
import {
  AcademicContextUnavailable,
  enrolmentContextInputSchema,
} from "@/domain/learning-context";
import {
  academicTimestampSchema,
  currentClassSessionSchema,
} from "@/domain/academic-reads";
import { assertStudentExplanationAllowed } from "./academic-activity";

const cohortSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  starts_on: z.string(),
  programme_version_id: z.uuid(),
  programme_versions: z.object({
    label: z.string(),
    status: z.enum(["DRAFT", "PUBLISHED"]),
    title_snapshot: z.string().nullable(),
  }),
});

const lessonSchema = z.object({
  id: z.uuid(),
  programme_version_id: z.uuid(),
  title: z.string(),
  position: z.number(),
  modules: z.object({ title: z.string(), position: z.number() }),
});

const instructorSchema = z.object({
  user_id: z.uuid(),
  display_name: z.string(),
  title: z.string(),
});

const sessionSchema = z.object({
  id: z.uuid(),
  cohort_id: z.uuid(),
  programme_version_id: z.uuid(),
  lesson_id: z.uuid(),
  instructor_id: z.uuid(),
  scheduled_start: z.string(),
  scheduled_end: z.string(),
  status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED"]),
  cohorts: z.object({ title: z.string() }),
  lessons: z.object({ title: z.string() }),
  staff_profiles: z.object({
    title: z.string(),
    app_users: z.object({ display_name: z.string() }),
  }),
  programme_versions: z.object({
    label: z.string(),
    title_snapshot: z.string().nullable(),
  }),
});

const studentSessionSchema = z.object({
  id: z.uuid(),
  scheduled_start: z.string(),
  scheduled_end: z.string(),
  status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED"]),
  cohort_title: z.string(),
  lesson_title: z.string(),
  instructor_name: z.string(),
  instructor_title: z.string(),
  programme_title: z.string(),
  programme_version_label: z.string(),
});

export async function getClassSessionWorkspace() {
  await requireActor("admin");
  const client = await createSupabase();

  const [cohorts, lessons, instructors, sessions] = await Promise.all([
    client
      .from("cohorts")
      .select(
        "id,title,starts_on,programme_version_id,programme_versions(label,status,title_snapshot)",
      )
      .order("starts_on", { ascending: false })
      .limit(200),
    client
      .from("lessons")
      .select("id,programme_version_id,title,position,modules(title,position)")
      .order("programme_version_id")
      .order("position")
      .limit(500),
    client.rpc("list_assignable_instructors"),
    client
      .from("class_sessions")
      .select(
        "id,cohort_id,programme_version_id,lesson_id,instructor_id,scheduled_start,scheduled_end,status,cohorts(title),lessons(title),staff_profiles!class_sessions_instructor_id_fkey(title,app_users(display_name)),programme_versions(label,title_snapshot)",
      )
      .order("scheduled_start", { ascending: true })
      .limit(300),
  ]);

  if (cohorts.error || lessons.error || instructors.error || sessions.error)
    throw new Error("Class session workspace could not be loaded.");

  const parsedSessions = z.array(sessionSchema).parse(sessions.data);

  return {
    cohorts: z.array(cohortSchema).parse(cohorts.data),
    lessons: z.array(lessonSchema).parse(lessons.data),
    instructors: z.array(instructorSchema).parse(instructors.data),
    sessions: parsedSessions.map((session) => ({
      id: session.id,
      cohort_id: session.cohort_id,
      programme_version_id: session.programme_version_id,
      lesson_id: session.lesson_id,
      instructor_id: session.instructor_id,
      scheduled_start: session.scheduled_start,
      scheduled_end: session.scheduled_end,
      status: session.status,
      cohort_title: session.cohorts.title,
      lesson_title: session.lessons.title,
      instructor_name: session.staff_profiles.app_users.display_name,
      instructor_title: session.staff_profiles.title,
      programme_title: session.programme_versions.title_snapshot ?? "Programme",
      programme_version_label: session.programme_versions.label,
    })),
  };
}

export async function createClassSession(input: unknown) {
  const payload = classSessionCreationSchema.parse(input);
  await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const client = await createSupabase();
  const { data, error } = await client.rpc("create_class_session", {
    p_cohort_id: payload.cohortId,
    p_lesson_id: payload.lessonId,
    p_instructor_id: payload.instructorId,
    p_scheduled_start: payload.scheduledStart,
    p_scheduled_end: payload.scheduledEnd,
    p_reason: payload.reason,
  });
  if (error) throw new SessionOperationError(sessionErrorCode(error));
  return z.uuid().parse(data);
}

export async function changeClassSessionStatus(input: unknown) {
  const payload = classSessionStatusSchema.parse(input);
  await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const client = await createSupabase();
  const { data, error } = await client.rpc("change_class_session_status", {
    p_session_id: payload.sessionId,
    p_status: payload.status,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Class session status could not be changed.");
  return z.uuid().parse(data);
}

export async function getStudentClassSessions() {
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client.rpc("list_my_class_sessions");
  if (error) throw new Error("Your class sessions could not be loaded.");
  return z.array(studentSessionSchema).parse(data);
}

// The timetable RPC intentionally omits cohort/version IDs and returns all sessions.
// This bounded projection extends the owning service without broadening that RPC.
export async function getStudentRelevantClassSession(input: unknown) {
  const payload = enrolmentContextInputSchema.parse(input);
  await assertStudentExplanationAllowed();
  const enrolment = await getOwnedStudentEnrolment(payload);
  const selectedAt = new Date().toISOString();
  const scope = {
    enrolmentId: enrolment.enrolmentId,
    programmeVersionId: enrolment.programmeVersionId,
    cohortId: enrolment.cohortId,
    selectedAt,
  };
  if (!["ACTIVE", "PAUSED"].includes(enrolment.enrolmentStatus)) {
    await assertStudentExplanationAllowed();
    return currentClassSessionSchema.parse({
      ...scope,
      selection: "NONE",
      session: null,
    });
  }
  const client = await createSupabase();
  const { data, error } = await client
    .from("class_sessions")
    .select(
      "id,cohort_id,programme_version_id,lesson_id,scheduled_start,scheduled_end,status",
    )
    .eq("cohort_id", enrolment.cohortId)
    .eq("programme_version_id", enrolment.programmeVersionId)
    .eq("status", "SCHEDULED")
    .gt("scheduled_end", selectedAt)
    .order("scheduled_start")
    .order("id")
    .limit(2);
  if (error) throw new Error("Current class session could not be loaded.");
  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        cohort_id: z.uuid(),
        programme_version_id: z.uuid(),
        lesson_id: z.uuid(),
        scheduled_start: academicTimestampSchema,
        scheduled_end: academicTimestampSchema,
        status: z.literal("SCHEDULED"),
      }),
    )
    .max(2)
    .parse(data);
  const now = Date.parse(selectedAt);
  for (const row of rows) {
    if (
      row.cohort_id !== enrolment.cohortId ||
      row.programme_version_id !== enrolment.programmeVersionId
    )
      throw new AcademicContextUnavailable();
    if (
      Date.parse(row.scheduled_end) <= now ||
      Date.parse(row.scheduled_end) <= Date.parse(row.scheduled_start)
    )
      throw new Error("Invalid current session projection.");
  }
  if (
    rows.length === 2 &&
    (Date.parse(rows[1].scheduled_start) <= now ||
      Date.parse(rows[0].scheduled_start) > Date.parse(rows[1].scheduled_start))
  )
    throw new Error("Ambiguous current session projection.");
  const row = rows[0];
  const result = currentClassSessionSchema.parse(
    row
      ? {
          ...scope,
          selection:
            Date.parse(row.scheduled_start) <= now ? "CURRENT" : "UPCOMING",
          session: {
            sessionId: row.id,
            lessonId: row.lesson_id,
            scheduledStart: row.scheduled_start,
            scheduledEnd: row.scheduled_end,
          },
        }
      : { ...scope, selection: "NONE", session: null },
  );
  await assertStudentExplanationAllowed();
  return result;
}
