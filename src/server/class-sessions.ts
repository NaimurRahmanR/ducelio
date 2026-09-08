import "server-only";
import { z } from "zod";
import {
  classSessionCreationSchema,
  classSessionStatusSchema,
} from "@/domain/academy";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

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
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("create_class_session", {
    p_cohort_id: payload.cohortId,
    p_lesson_id: payload.lessonId,
    p_instructor_id: payload.instructorId,
    p_scheduled_start: payload.scheduledStart,
    p_scheduled_end: payload.scheduledEnd,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Class session could not be scheduled.");
  return z.uuid().parse(data);
}

export async function changeClassSessionStatus(input: unknown) {
  const payload = classSessionStatusSchema.parse(input);
  await requireActor("admin");
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
  const { data, error } = await client
    .from("class_sessions")
    .select(
      "id,scheduled_start,scheduled_end,status,cohorts(title),lessons(title),staff_profiles!class_sessions_instructor_id_fkey(title,app_users(display_name)),programme_versions(label,title_snapshot)",
    )
    .order("scheduled_start", { ascending: true })
    .limit(100);
  if (error) throw new Error("Your class sessions could not be loaded.");

  return z
    .array(
      z.object({
        id: z.uuid(),
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
      }),
    )
    .parse(data)
    .map((session) => ({
      id: session.id,
      scheduled_start: session.scheduled_start,
      scheduled_end: session.scheduled_end,
      status: session.status,
      cohort_title: session.cohorts.title,
      lesson_title: session.lessons.title,
      instructor_name: session.staff_profiles.app_users.display_name,
      instructor_title: session.staff_profiles.title,
      programme_title: session.programme_versions.title_snapshot ?? "Programme",
      programme_version_label: session.programme_versions.label,
    }));
}
