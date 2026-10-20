"use server";

import { revalidatePath } from "next/cache";
import { submitAssignment } from "@/server/assignments";
import {
  recordAssessmentResponse,
  startAssessmentAttempt,
} from "@/server/assessments";
import { submitControlledAssessmentAndGrade } from "@/server/commercial-v1-submission-grading";
import { answerSaveIdempotencyKey } from "@/server/assessment-save-key";
import {
  canonicalResponseBody,
  objectiveQuestionTypeSchema,
} from "@/domain/assessment-question-types";

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

// CP2: an objective answer is re-serialised to its single canonical text so
// a retried save replays idempotently. The declared type only selects the
// serialiser; the database validates the body against the question's REAL
// published type and refuses any mismatch. Free text passes through.
function structuredBody(type: FormDataEntryValue | null, body: unknown) {
  const parsedType = objectiveQuestionTypeSchema.safeParse(type);
  if (!parsedType.success || typeof body !== "string") return body;
  return canonicalResponseBody(parsedType.data, JSON.parse(body));
}

export async function saveControlledAssessmentResponse(
  _state: AssessmentActionState,
  form: FormData,
): Promise<AssessmentActionState> {
  let outcome;
  try {
    const body = structuredBody(form.get("questionType"), form.get("body"));
    // CP2C: the exam workspace posts only the revision slot it is answering;
    // the key is derived here from SHA-256 of the exact body being saved
    // (src/server/assessment-save-key.ts). An explicit key is still accepted
    // for the pre-existing form contract.
    const idempotencyKey = form.has("revisionSlot")
      ? answerSaveIdempotencyKey({
          attemptId: form.get("attemptId"),
          questionId: form.get("questionId"),
          revisionSlot: form.get("revisionSlot"),
          body,
        })
      : form.get("idempotencyKey");
    // The server decides, from authoritative state, which response writer
    // handles the attempt. Nothing here (or in the form) selects it.
    outcome = await recordAssessmentResponse({
      attemptId: form.get("attemptId"),
      questionId: form.get("questionId"),
      body,
      idempotencyKey,
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

// One calm message per safe grading outcome. None names Examiner/provider/
// recovery internals -- a learner never sees "recovery", a reason code, a
// provider error or an admin-facing distinction between "not configured"
// and "terminally failed": both look identical from here on purpose.
const GRADING_MESSAGES: Record<
  Exclude<
    Awaited<ReturnType<typeof submitControlledAssessmentAndGrade>>["grading"],
    "GRADED"
  >,
  string
> = {
  ESCALATED: " This assessment has been sent for academic review.",
  GRADING_PENDING: " Grading is in progress; check back shortly.",
  GRADING_UNAVAILABLE: " Grading is not currently available for this attempt.",
};

export async function finishControlledAssessment(
  _state: AssessmentActionState,
  form: FormData,
): Promise<AssessmentActionState> {
  let result;
  try {
    // Submission (the durable institutional truth) and Examiner grading
    // admission are two separate authority boundaries composed here --
    // never one pseudo-transaction. A grading failure of any kind can never
    // unwind or hide a successful submission; only submitAssessmentAttempt
    // itself throwing is reported as a submission failure.
    result = await submitControlledAssessmentAndGrade(form.get("attemptId"));
  } catch {
    return {
      error: "Unable to submit this assessment attempt.",
    };
  }
  revalidatePath("/student/assessments");
  return {
    message:
      "Assessment submitted." +
      (result.grading === "GRADED" ? "" : GRADING_MESSAGES[result.grading]),
  };
}
