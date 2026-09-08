"use server";

import { revalidatePath } from "next/cache";
import { publishProgrammeVersion } from "@/server/programmes";
import { createEnrolment, changeEnrolmentStatus } from "@/server/enrolments";
import { reassignCounsellor } from "@/server/counsellor-assignments";
import {
  createClassSession,
  changeClassSessionStatus,
} from "@/server/class-sessions";
import { recordAttendance } from "@/server/attendance";

export type ProgrammeActionState = { error?: string; message?: string };
export type EnrolmentActionState = { error?: string; message?: string };
export type CounsellorAssignmentActionState = {
  error?: string;
  message?: string;
};
export type ClassSessionActionState = { error?: string; message?: string };
export type AttendanceActionState = { error?: string; message?: string };

export async function publishProgramme(
  _state: ProgrammeActionState,
  form: FormData,
): Promise<ProgrammeActionState> {
  try {
    await publishProgrammeVersion({
      programmeVersionId: form.get("programmeVersionId"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to publish this version. Check its curriculum completeness and your permissions.",
    };
  }

  revalidatePath("/admin");
  return { message: "Programme version published." };
}

export async function addEnrolment(
  _state: EnrolmentActionState,
  form: FormData,
): Promise<EnrolmentActionState> {
  try {
    await createEnrolment({
      studentId: form.get("studentId"),
      cohortId: form.get("cohortId"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to create this enrolment. Check the learner, cohort, published curriculum and your permissions.",
    };
  }
  revalidatePath("/admin");
  revalidatePath("/student");
  return { message: "Learner enrolled." };
}

export async function updateEnrolmentStatus(
  _state: EnrolmentActionState,
  form: FormData,
): Promise<EnrolmentActionState> {
  try {
    await changeEnrolmentStatus({
      enrolmentId: form.get("enrolmentId"),
      status: form.get("status"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to change this enrolment status. Check the requested transition and your permissions.",
    };
  }
  revalidatePath("/admin");
  revalidatePath("/student");
  return { message: "Enrolment status updated." };
}

export async function assignLearnerCounsellor(
  _state: CounsellorAssignmentActionState,
  form: FormData,
): Promise<CounsellorAssignmentActionState> {
  try {
    await reassignCounsellor({
      studentId: form.get("studentId"),
      counsellorId: form.get("counsellorId"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to assign this counsellor. Check the learner, staff role and your permissions.",
    };
  }

  revalidatePath("/admin");
  revalidatePath("/support");
  revalidatePath("/student");
  return { message: "Counsellor assignment updated." };
}

export async function addClassSession(
  _state: ClassSessionActionState,
  form: FormData,
): Promise<ClassSessionActionState> {
  try {
    const scheduledStart = new Date(
      String(form.get("scheduledStart")),
    ).toISOString();
    const scheduledEnd = new Date(
      String(form.get("scheduledEnd")),
    ).toISOString();
    await createClassSession({
      cohortId: form.get("cohortId"),
      lessonId: form.get("lessonId"),
      instructorId: form.get("instructorId"),
      scheduledStart,
      scheduledEnd,
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to schedule this class. Check the cohort, lesson, instructor, times and conflicts.",
    };
  }
  revalidatePath("/admin");
  revalidatePath("/student");
  return { message: "Class session scheduled." };
}

export async function updateClassSessionStatus(
  _state: ClassSessionActionState,
  form: FormData,
): Promise<ClassSessionActionState> {
  try {
    await changeClassSessionStatus({
      sessionId: form.get("sessionId"),
      status: form.get("status"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to change this class session status. Check the requested transition and timing.",
    };
  }
  revalidatePath("/admin");
  revalidatePath("/student");
  return { message: "Class session status updated." };
}

export async function saveAttendance(
  _state: AttendanceActionState,
  form: FormData,
): Promise<AttendanceActionState> {
  try {
    await recordAttendance({
      sessionId: form.get("sessionId"),
      enrolmentId: form.get("enrolmentId"),
      status: form.get("status"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to record attendance. Check the session timing, learner enrolment, requested status and your permissions.",
    };
  }
  revalidatePath("/admin");
  revalidatePath("/student");
  return { message: "Attendance record saved." };
}
