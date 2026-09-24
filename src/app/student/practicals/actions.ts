"use server";
import { requestPracticalSupport } from "@/server/course-activation";
import {
  tutorLabSupportRequestSchema,
  type TutorLabRole,
} from "@/domain/tutor-lab-execution";
import { executeTutorLabSupport } from "@/server/tutor-lab-execution";
import { submitPracticalLabWorkAndGrade } from "@/server/commercial-v1-submission-grading";

export async function requestPracticalSupportAction(
  value: unknown,
): Promise<{ ok: boolean; handoffId?: string }> {
  try {
    const handoffId = await requestPracticalSupport(value);
    return { ok: true, handoffId };
  } catch {
    return { ok: false };
  }
}

export type LabWorkSubmissionActionState = {
  status?: "SUBMITTED";
  grading?: "GRADED" | "ESCALATED" | "GRADING_PENDING" | "GRADING_UNAVAILABLE";
  error?: string;
};

// THE governed FINAL practical/lab submission -- structurally distinct from
// requestTutorLabSupportAction above (conversational Tutor/Lab Instructor
// assistance, never institutional work product). The browser supplies only
// identity/content fields already on submitCommercialV1LabWorkInputSchema;
// it can never choose the grading capability, provider, model or a recovery
// path. Submission and Examiner grading admission are composed server-side
// (src/server/commercial-v1-submission-grading.ts): a grading outcome other
// than GRADED is reported as calm additional status, never as the
// submission itself having failed.
export async function submitPracticalLabWorkAction(
  _previous: LabWorkSubmissionActionState,
  form: FormData,
): Promise<LabWorkSubmissionActionState> {
  try {
    const result = await submitPracticalLabWorkAndGrade({
      enrolmentId: form.get("enrolmentId"),
      practicalId: form.get("practicalId"),
      body: form.get("body"),
      idempotencyKey: form.get("idempotencyKey"),
    });
    return { status: "SUBMITTED", grading: result.grading };
  } catch {
    return {
      error:
        "Unable to submit this lab work. Check your active enrolment, the practical and whether it was already submitted.",
    };
  }
}

export type TutorLabSupportActionState = {
  status?:
    | "SUCCEEDED"
    | "ACTIVITY_BLOCKED"
    | "UNAVAILABLE"
    | "ESCALATED"
    | "RETRY_LATER"
    | "DUPLICATE";
  text?: string;
  role?: TutorLabRole;
  error?: string;
};

// The learner never selects a role, provider, model or budget: the exact
// destination (TUTOR or LAB_INSTRUCTOR) is derived server-side from the
// owning handoff itself (see src/server/tutor-lab-execution). This Server
// Action only validates the bounded message/idempotency-key shape before
// handing off to the governed entrypoint, and never propagates a raw
// exception to the learner.
export async function requestTutorLabSupportAction(
  _previous: TutorLabSupportActionState,
  form: FormData,
): Promise<TutorLabSupportActionState> {
  const parsed = tutorLabSupportRequestSchema.safeParse({
    handoffId: form.get("handoffId"),
    message: form.get("message"),
    idempotencyKey: form.get("idempotencyKey"),
  });
  if (!parsed.success)
    return { error: "Enter a message between 1 and 2,000 characters." };
  try {
    const result = await executeTutorLabSupport(parsed.data);
    return result.status === "SUCCEEDED"
      ? { status: "SUCCEEDED", text: result.text, role: result.role }
      : { status: result.status };
  } catch {
    return { status: "RETRY_LATER" };
  }
}
