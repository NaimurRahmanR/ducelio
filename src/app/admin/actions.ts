"use server";

import { revalidatePath } from "next/cache";
import { publishProgrammeVersion } from "@/server/programmes";
import {
  createEnrolment,
  changeEnrolmentStatus,
} from "@/server/enrolments";

export type ProgrammeActionState = { error?: string; message?: string };
export type EnrolmentActionState = { error?: string; message?: string };

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
