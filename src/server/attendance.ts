import "server-only";
import { z } from "zod";
import { attendanceRecordSchema } from "@/domain/academy";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

const sessionSchema = z.object({
  id: z.uuid(),
  cohort_id: z.uuid(),
  scheduled_start: z.string(),
  scheduled_end: z.string(),
  status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED"]),
  lessons: z.object({ title: z.string() }),
  cohorts: z.object({ title: z.string() }),
});

const enrolmentSchema = z.object({
  id: z.uuid(),
  student_id: z.uuid(),
  cohort_id: z.uuid(),
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "WITHDRAWN"]),
  student_profiles: z.object({
    student_number: z.string(),
    app_users: z.object({ display_name: z.string() }),
  }),
});

const attendanceSchema = z.object({
  id: z.uuid(),
  session_id: z.uuid(),
  enrolment_id: z.uuid(),
  student_id: z.uuid(),
  status: z.enum(["PRESENT", "LATE", "ABSENT", "EXCUSED"]),
  updated_at: z.string(),
});

export async function getAttendanceWorkspace() {
  await requireActor("admin");
  const client = await createSupabase();

  const [sessions, enrolments, attendance] = await Promise.all([
    client
      .from("class_sessions")
      .select(
        "id,cohort_id,scheduled_start,scheduled_end,status,lessons(title),cohorts(title)",
      )
      .order("scheduled_start", { ascending: false })
      .limit(200),
    client
      .from("enrolments")
      .select(
        "id,student_id,cohort_id,status,student_profiles!enrolments_student_id_fkey(student_number,app_users(display_name))",
      )
      .order("enrolled_at", { ascending: false })
      .limit(500),
    client
      .from("attendance_records")
      .select("id,session_id,enrolment_id,student_id,status,updated_at")
      .order("updated_at", { ascending: false })
      .limit(500),
  ]);

  if (sessions.error || enrolments.error || attendance.error)
    throw new Error("Attendance workspace could not be loaded.");

  return {
    sessions: z.array(sessionSchema).parse(sessions.data),
    enrolments: z
      .array(enrolmentSchema)
      .parse(enrolments.data)
      .map((row) => ({
        id: row.id,
        student_id: row.student_id,
        cohort_id: row.cohort_id,
        status: row.status,
        student_number: row.student_profiles.student_number,
        display_name: row.student_profiles.app_users.display_name,
      })),
    attendance: z.array(attendanceSchema).parse(attendance.data),
  };
}

export async function recordAttendance(input: unknown) {
  const payload = attendanceRecordSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("record_attendance", {
    p_session_id: payload.sessionId,
    p_enrolment_id: payload.enrolmentId,
    p_status: payload.status,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Attendance could not be recorded.");
  return z.uuid().parse(data);
}

export async function getStudentAttendance() {
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client
    .from("attendance_records")
    .select("id,session_id,status,updated_at")
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw new Error("Your attendance records could not be loaded.");
  return z
    .array(
      z.object({
        id: z.uuid(),
        session_id: z.uuid(),
        status: z.enum(["PRESENT", "LATE", "ABSENT", "EXCUSED"]),
        updated_at: z.string(),
      }),
    )
    .parse(data);
}
