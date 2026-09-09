"use server";

import { revalidatePath } from "next/cache";
import {
  correctAttendanceStatus,
  correctEnrolmentStatus,
} from "@/server/registrar";

export type RegistrarActionState = { error?: string; message?: string };

export async function correctEnrolmentRecord(
  _state: RegistrarActionState,
  form: FormData,
): Promise<RegistrarActionState> {
  try {
    await correctEnrolmentStatus({
      enrolmentId: form.get("enrolmentId"),
      status: form.get("status"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to record this enrolment correction. Check the current record, requested status, reason and registrar permissions.",
    };
  }

  revalidatePath("/admin");
  revalidatePath("/student");
  return { message: "Enrolment correction recorded." };
}

export async function correctAttendanceRecord(
  _state: RegistrarActionState,
  form: FormData,
): Promise<RegistrarActionState> {
  try {
    await correctAttendanceStatus({
      attendanceRecordId: form.get("attendanceRecordId"),
      status: form.get("status"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to record this attendance correction. Check the current record, requested status, reason and registrar permissions.",
    };
  }

  revalidatePath("/admin");
  revalidatePath("/student/classes");
  return { message: "Attendance correction recorded." };
}
