"use server";

import { revalidatePath } from "next/cache";
import { submitAssignment } from "@/server/assignments";

export type AssignmentSubmissionActionState = {
  error?: string;
  message?: string;
};

export async function submitCoursework(
  _state: AssignmentSubmissionActionState,
  form: FormData,
): Promise<AssignmentSubmissionActionState> {
  try {
    await submitAssignment({
      assignmentId: form.get("assignmentId"),
      body: form.get("body"),
      idempotencyKey: form.get("idempotencyKey"),
    });
  } catch {
    return {
      error:
        "Unable to submit this assignment. Check the submission window, your active enrolment and the response content.",
    };
  }

  revalidatePath("/student/assignments");
  return { message: "Assignment submitted." };
}
