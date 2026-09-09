"use server";

import { revalidatePath } from "next/cache";
import { submitAssignment } from "@/server/assignments";
import {
  recordAssessmentResponse,
  startAssessmentAttempt,
  submitAssessmentAttempt,
} from "@/server/assessments";

export type AssignmentSubmissionActionState = {
  error?: string;
  message?: string;
};

export type AssessmentActionState = {
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

export async function beginControlledAssessment(
  _state: AssessmentActionState,
  form: FormData,
): Promise<AssessmentActionState> {
  try {
    await startAssessmentAttempt(form.get("assessmentId"));
  } catch {
    return {
      error:
        "Unable to start this assessment. Check the release window, active enrolment, remaining attempts and whether another controlled assessment is active.",
    };
  }
  revalidatePath("/student/assessments");
  return { message: "Controlled assessment started." };
}

export async function saveControlledAssessmentResponse(
  _state: AssessmentActionState,
  form: FormData,
): Promise<AssessmentActionState> {
  try {
    await recordAssessmentResponse({
      attemptId: form.get("attemptId"),
      questionId: form.get("questionId"),
      body: form.get("body"),
      idempotencyKey: form.get("idempotencyKey"),
    });
  } catch {
    return {
      error:
        "Unable to save this response. Check the active attempt, protected question, time window and submission reference.",
    };
  }
  revalidatePath("/student/assessments");
  return { message: "Response revision saved." };
}

export async function finishControlledAssessment(
  _state: AssessmentActionState,
  form: FormData,
): Promise<AssessmentActionState> {
  try {
    await submitAssessmentAttempt(form.get("attemptId"));
  } catch {
    return {
      error: "Unable to submit this assessment attempt.",
    };
  }
  revalidatePath("/student/assessments");
  return { message: "Assessment submitted." };
}
