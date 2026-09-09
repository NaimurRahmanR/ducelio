import "server-only";
import { z } from "zod";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

const enrolmentCorrectionSchema = z.object({
  enrolmentId: z.uuid(),
  status: z.enum(["ACTIVE", "PAUSED", "WITHDRAWN"]),
  reason: z.string().trim().min(5).max(300),
});

const attendanceCorrectionSchema = z.object({
  attendanceRecordId: z.uuid(),
  status: z.enum(["PRESENT", "LATE", "ABSENT", "EXCUSED"]),
  reason: z.string().trim().min(5).max(300),
});

const correctionSchema = z.object({
  id: z.uuid(),
  student_id: z.uuid(),
  correction_kind: z.enum(["ENROLMENT_STATUS", "ATTENDANCE_STATUS"]),
  enrolment_id: z.uuid().nullable(),
  attendance_record_id: z.uuid().nullable(),
  before_value: z.string(),
  after_value: z.string(),
  reason: z.string(),
  corrected_by: z.uuid(),
  corrected_at: z.string(),
});

export async function getRegistrarWorkspace() {
  const actor = await requireActor("admin");
  if (
    !actor.roles.includes("REGISTRAR") &&
    !actor.roles.includes("PLATFORM_ADMIN")
  ) {
    throw new Error("Registrar correction access is restricted.");
  }

  const client = await createSupabase();
  const [enrolments, attendance, corrections] = await Promise.all([
    client
      .from("enrolments")
      .select(
        "id,student_id,status,cohort_title_snapshot,cohort_starts_on_snapshot,student_profiles!enrolments_student_id_fkey(student_number,app_users(display_name))",
      )
      .order("enrolled_at", { ascending: false })
      .limit(500),
    client
      .from("attendance_records")
      .select(
        "id,student_id,enrolment_id,session_id,status,updated_at,class_sessions(scheduled_start,lessons(title))",
      )
      .order("updated_at", { ascending: false })
      .limit(500),
    client
      .from("registrar_corrections")
      .select(
        "id,student_id,correction_kind,enrolment_id,attendance_record_id,before_value,after_value,reason,corrected_by,corrected_at",
      )
      .order("corrected_at", { ascending: false })
      .limit(500),
  ]);

  if (enrolments.error || attendance.error || corrections.error)
    throw new Error("Registrar workspace could not be loaded.");

  return {
    enrolments: z
      .array(
        z.object({
          id: z.uuid(),
          student_id: z.uuid(),
          status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "WITHDRAWN"]),
          cohort_title_snapshot: z.string(),
          cohort_starts_on_snapshot: z.string(),
          student_profiles: z.object({
            student_number: z.string(),
            app_users: z.object({ display_name: z.string() }),
          }),
        }),
      )
      .parse(enrolments.data),
    attendance: z
      .array(
        z.object({
          id: z.uuid(),
          student_id: z.uuid(),
          enrolment_id: z.uuid(),
          session_id: z.uuid(),
          status: z.enum(["PRESENT", "LATE", "ABSENT", "EXCUSED"]),
          updated_at: z.string(),
          class_sessions: z.object({
            scheduled_start: z.string(),
            lessons: z.object({ title: z.string() }),
          }),
        }),
      )
      .parse(attendance.data),
    corrections: z.array(correctionSchema).parse(corrections.data),
  };
}

export async function correctEnrolmentStatus(input: unknown) {
  const payload = enrolmentCorrectionSchema.parse(input);
  const actor = await requireActor("admin");
  if (
    !actor.roles.includes("REGISTRAR") &&
    !actor.roles.includes("PLATFORM_ADMIN")
  ) {
    throw new Error("Registrar correction access is restricted.");
  }

  const client = await createSupabase();
  const { data, error } = await client.rpc("registrar_correct_enrolment_status", {
    p_enrolment_id: payload.enrolmentId,
    p_status: payload.status,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Enrolment correction could not be recorded.");
  return z.uuid().parse(data);
}

export async function correctAttendanceStatus(input: unknown) {
  const payload = attendanceCorrectionSchema.parse(input);
  const actor = await requireActor("admin");
  if (
    !actor.roles.includes("REGISTRAR") &&
    !actor.roles.includes("PLATFORM_ADMIN")
  ) {
    throw new Error("Registrar correction access is restricted.");
  }

  const client = await createSupabase();
  const { data, error } = await client.rpc("registrar_correct_attendance_status", {
    p_attendance_record_id: payload.attendanceRecordId,
    p_status: payload.status,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Attendance correction could not be recorded.");
  return z.uuid().parse(data);
}
