"use server";
import {
  sessionFeedbackFormSchema,
  type SessionFeedbackOutcome,
} from "@/domain/session-feedback";
import { submitMySessionFeedback } from "@/server/session-feedback";

export type SessionFeedbackActionState = { outcome?: SessionFeedbackOutcome };

// AC-6: the learner sends only the session handle, a request UUID and three
// ratings; any other form field is ignored. Learner identity and
// eligibility are derived by the database. No model is called. A raw
// exception never reaches the learner.
//
// The page is not revalidated here: the prompt keeps showing its truthful
// outcome, and the next navigation reads a fresh, dynamic list.
export async function submitSessionFeedbackAction(
  _previous: SessionFeedbackActionState,
  form: FormData,
): Promise<SessionFeedbackActionState> {
  const parsed = sessionFeedbackFormSchema.safeParse({
    classSessionId: form.get("classSessionId"),
    requestId: form.get("requestId"),
    clarityRating: form.get("clarityRating"),
    paceRating: form.get("paceRating"),
    usefulnessRating: form.get("usefulnessRating"),
  });
  if (!parsed.success) return { outcome: "INVALID" };
  try {
    return { outcome: await submitMySessionFeedback(parsed.data) };
  } catch {
    return { outcome: "UNAVAILABLE" };
  }
}
