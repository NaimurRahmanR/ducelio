import "server-only";
import { z } from "zod";
import { lessonProgressSchema, lessonSegmentSchema } from "@/domain/academy";
import { requireActor, requireAnyRole } from "./identity";
import { createSupabase } from "./supabase";

const sessionSchema = z.object({
  id: z.uuid(),
  cohort_id: z.uuid(),
  lesson_id: z.uuid(),
  programme_version_id: z.uuid(),
  scheduled_start: z.string(),
  status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED"]),
  lessons: z.object({ title: z.string() }),
  cohorts: z.object({ title: z.string() }),
});

const enrolmentSchema = z.object({
  id: z.uuid(),
  student_id: z.uuid(),
  cohort_id: z.uuid(),
  programme_version_id: z.uuid(),
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "WITHDRAWN"]),
  student_profiles: z.object({
    student_number: z.string(),
    app_users: z.object({ display_name: z.string() }),
  }),
});

const segmentSchema = z.object({
  id: z.uuid(),
  lesson_id: z.uuid(),
  programme_version_id: z.uuid(),
  title: z.string(),
  position: z.number(),
  lessons: z.object({ title: z.string() }),
});

const progressSchema = z.object({
  id: z.uuid(),
  enrolment_id: z.uuid(),
  student_id: z.uuid(),
  segment_id: z.uuid(),
  lesson_id: z.uuid(),
  last_session_id: z.uuid(),
  status: z.enum(["IN_PROGRESS", "COMPLETED"]),
  updated_at: z.string(),
});

export async function getLessonProgressWorkspace() {
  await requireActor("admin");
  const client = await createSupabase();

  const [sessions, enrolments, segments, progress] = await Promise.all([
    client
      .from("class_sessions")
      .select(
        "id,cohort_id,lesson_id,programme_version_id,scheduled_start,status,lessons(title),cohorts(title)",
      )
      .order("scheduled_start", { ascending: false })
      .limit(200),
    client
      .from("enrolments")
      .select(
        "id,student_id,cohort_id,programme_version_id,status,student_profiles!enrolments_student_id_fkey(student_number,app_users(display_name))",
      )
      .order("enrolled_at", { ascending: false })
      .limit(500),
    client
      .from("lesson_segments")
      .select("id,lesson_id,programme_version_id,title,position,lessons(title)")
      .order("lesson_id")
      .order("position")
      .limit(1000),
    client
      .from("lesson_progress")
      .select(
        "id,enrolment_id,student_id,segment_id,lesson_id,last_session_id,status,updated_at",
      )
      .order("updated_at", { ascending: false })
      .limit(1000),
  ]);

  if (sessions.error || enrolments.error || segments.error || progress.error)
    throw new Error("Lesson progress workspace could not be loaded.");

  return {
    sessions: z.array(sessionSchema).parse(sessions.data),
    enrolments: z
      .array(enrolmentSchema)
      .parse(enrolments.data)
      .map((row) => ({
        id: row.id,
        student_id: row.student_id,
        cohort_id: row.cohort_id,
        programme_version_id: row.programme_version_id,
        status: row.status,
        student_number: row.student_profiles.student_number,
        display_name: row.student_profiles.app_users.display_name,
      })),
    segments: z.array(segmentSchema).parse(segments.data),
    progress: z.array(progressSchema).parse(progress.data),
  };
}

export async function createLessonSegment(input: unknown) {
  const payload = lessonSegmentSchema.parse(input);
  await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const client = await createSupabase();
  const { data, error } = await client.rpc("create_lesson_segment", {
    p_lesson_id: payload.lessonId,
    p_title: payload.title,
    p_position: payload.position,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Lesson segment could not be created.");
  return z.uuid().parse(data);
}

export async function recordLessonProgress(input: unknown) {
  const payload = lessonProgressSchema.parse(input);
  await requireAnyRole(["INSTRUCTOR", "ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const client = await createSupabase();
  const { data, error } = await client.rpc("record_lesson_progress", {
    p_session_id: payload.sessionId,
    p_enrolment_id: payload.enrolmentId,
    p_segment_id: payload.segmentId,
    p_status: payload.status,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Lesson progress could not be recorded.");
  return z.uuid().parse(data);
}

export async function getStudentLessonProgress() {
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client
    .from("lesson_progress")
    .select(
      "id,lesson_id,segment_id,status,updated_at,lesson_segments(title,position),lessons(title)",
    )
    .order("updated_at", { ascending: false })
    .limit(500);

  if (error) throw new Error("Your lesson progress could not be loaded.");

  return z
    .array(
      z.object({
        id: z.uuid(),
        lesson_id: z.uuid(),
        segment_id: z.uuid(),
        status: z.enum(["IN_PROGRESS", "COMPLETED"]),
        updated_at: z.string(),
        lesson_segments: z.object({ title: z.string(), position: z.number() }),
        lessons: z.object({ title: z.string() }),
      }),
    )
    .parse(data);
}
