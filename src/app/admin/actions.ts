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
import { recordLessonProgress } from "@/server/lesson-progress";
import { createLearningResource } from "@/server/learning-resources";
import { recordLearningEvidence } from "@/server/learning-evidence";
import { createAssignment, changeAssignmentStatus } from "@/server/assignments";

export type ProgrammeActionState = { error?: string; message?: string };
export type EnrolmentActionState = { error?: string; message?: string };
export type CounsellorAssignmentActionState = {
  error?: string;
  message?: string;
};
export type ClassSessionActionState = { error?: string; message?: string };
export type AttendanceActionState = { error?: string; message?: string };
export type LessonProgressActionState = { error?: string; message?: string };
export type LearningResourceActionState = { error?: string; message?: string };
export type LearningEvidenceActionState = { error?: string; message?: string };
export type AssignmentActionState = { error?: string; message?: string };

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

export async function saveLessonProgress(
  _state: LessonProgressActionState,
  form: FormData,
): Promise<LessonProgressActionState> {
  try {
    await recordLessonProgress({
      sessionId: form.get("sessionId"),
      enrolmentId: form.get("enrolmentId"),
      segmentId: form.get("segmentId"),
      status: form.get("status"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to record lesson progress. Check the session, learner enrolment, planned segment and your permissions.",
    };
  }
  revalidatePath("/admin");
  revalidatePath("/student");
  return { message: "Lesson progress saved." };
}

export async function addLearningResource(
  _state: LearningResourceActionState,
  form: FormData,
): Promise<LearningResourceActionState> {
  try {
    const rawBody = String(form.get("body") ?? "").trim();
    const rawUrl = String(form.get("url") ?? "").trim();
    await createLearningResource({
      lessonId: form.get("lessonId"),
      kind: form.get("kind"),
      title: form.get("title"),
      body: rawBody || null,
      url: rawUrl || null,
      position: form.get("position"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to add this resource. Check the draft lesson, resource type, content or HTTPS URL, position and your permissions.",
    };
  }
  revalidatePath("/admin");
  revalidatePath("/student/notes");
  return { message: "Learning resource added." };
}

export async function saveLearningEvidence(
  _state: LearningEvidenceActionState,
  form: FormData,
): Promise<LearningEvidenceActionState> {
  try {
    await recordLearningEvidence({
      sessionId: form.get("sessionId"),
      enrolmentId: form.get("enrolmentId"),
      objectiveId: form.get("objectiveId"),
      evidenceKind: form.get("evidenceKind"),
      result: form.get("result"),
      evidenceReference: form.get("evidenceReference"),
      idempotencyKey: form.get("idempotencyKey"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to record learning evidence. Check the session, learner, objective, provenance key and your permissions.",
    };
  }
  revalidatePath("/admin");
  revalidatePath("/student/classes");
  return { message: "Learning evidence recorded." };
}

export async function addAssignment(
  _state: AssignmentActionState,
  form: FormData,
): Promise<AssignmentActionState> {
  try {
    const opensAt = new Date(String(form.get("opensAt"))).toISOString();
    const dueAt = new Date(String(form.get("dueAt"))).toISOString();
    await createAssignment({
      cohortId: form.get("cohortId"),
      lessonId: form.get("lessonId"),
      instructorId: form.get("instructorId"),
      title: form.get("title"),
      instructions: form.get("instructions"),
      opensAt,
      dueAt,
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to create this assignment. Check the cohort, lesson, instructor, coursework window and your permissions.",
    };
  }
  revalidatePath("/admin");
  return { message: "Assignment draft created." };
}

export async function publishOrCloseAssignment(
  _state: AssignmentActionState,
  form: FormData,
): Promise<AssignmentActionState> {
  try {
    await changeAssignmentStatus({
      assignmentId: form.get("assignmentId"),
      status: form.get("status"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to change this assignment status. Check the lifecycle transition and your permissions.",
    };
  }
  revalidatePath("/admin");
  revalidatePath("/student/assignments");
  return { message: "Assignment status updated." };
}
