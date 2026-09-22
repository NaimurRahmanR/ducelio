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

// One message per structured governed refusal. None reveals whether another
// learner's attempt exists, and none echoes protected assessment content.
const RESPONSE_REFUSAL_MESSAGES = {
  EXPIRED:
    "Your time for this assessment has ended. The attempt was submitted automatically at its deadline, and this response was not saved.",
  RESPONSE_WINDOW_CLOSED:
    "This assessment is no longer accepting responses, so this response was not saved.",
  ATTEMPT_NOT_ACTIVE:
    "This attempt is no longer active, so this response was not saved.",
} as const;
const RESPONSE_GENERIC_ERROR =
  "Unable to save this response. Check the active attempt, protected question, time window and submission reference.";

export async function saveControlledAssessmentResponse(
  _state: AssessmentActionState,
  form: FormData,
): Promise<AssessmentActionState> {
  let outcome;
  try {
    // The server decides, from authoritative state, which response writer
    // handles the attempt. Nothing here (or in the form) selects it.
    outcome = await recordAssessmentResponse({
      attemptId: form.get("attemptId"),
      questionId: form.get("questionId"),
      body: form.get("body"),
      idempotencyKey: form.get("idempotencyKey"),
    });
  } catch {
    return { error: RESPONSE_GENERIC_ERROR };
  }
  // A refusal can itself have durably changed the attempt (a governed EXPIRED
  // or closed-assessment refusal finalises it in the same call), so the page
  // is revalidated for every structured outcome, not only success.
  revalidatePath("/student/assessments");
  if (outcome.ok) return { message: "Response revision saved." };
  return {
    error:
      outcome.code in RESPONSE_REFUSAL_MESSAGES
        ? RESPONSE_REFUSAL_MESSAGES[
            outcome.code as keyof typeof RESPONSE_REFUSAL_MESSAGES
          ]
        : RESPONSE_GENERIC_ERROR,
  };
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
