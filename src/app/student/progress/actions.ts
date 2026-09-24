"use server";
import { revalidatePath } from "next/cache";
import { attemptCommercialV1CourseCompletion } from "@/server/commercial-v1-results-completion";

export type CompletionActionState = { error?: string; message?: string };

// Deterministic: every gate (all six components graded, every lab result
// present, the published pass mark, remediation clearance if required) is
// evaluated server-side from persisted, immutable result/policy state --
// never from a client-supplied score, flag or component list. Safe to press
// repeatedly: an already-completed enrolment returns its own existing
// receipt rather than erroring or creating a second one.
export async function attemptCourseCompletionAction(
  _state: CompletionActionState,
  form: FormData,
): Promise<CompletionActionState> {
  const enrolmentId = form.get("enrolmentId");
  let result;
  try {
    result = await attemptCommercialV1CourseCompletion({
      enrolmentId,
      reason: "Learner requested course completion",
    });
  } catch {
    return { error: "Course completion could not be evaluated." };
  }
  revalidatePath("/student/progress");
  if (result.ok)
    return {
      message:
        result.code === "ALREADY_COMPLETED"
          ? "This course was already completed."
          : "Course completed.",
    };
  const messages: Partial<Record<string, string>> = {
    COMPONENTS_INCOMPLETE:
      "Not every formal component has a current result yet.",
    BELOW_PASS_MARK:
      "Your current course score is below the published pass mark.",
    REMEDIATION_NOT_CLEAR:
      "Open remediation must be cleared before completion.",
    ENROLMENT_NOT_ACTIVE: "This enrolment is not active.",
    RESULT_POLICY_REQUIRED: "This course has no published result policy yet.",
  };
  return {
    error: messages[result.code] ?? "Course completion could not be granted.",
  };
}
