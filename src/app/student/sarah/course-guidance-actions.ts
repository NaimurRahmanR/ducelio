"use server";
import {
  sarahCourseGuidanceRequestSchema,
  type SarahCourseGuidanceResult,
  type SarahCourseRecommendationCard,
} from "@/domain/sarah-course-guidance";
import { executeSarahCourseGuidance } from "@/server/sarah/course-guidance";

export type SarahCourseGuidanceActionState = {
  status?: SarahCourseGuidanceResult["status"];
  reply?: string;
  recommendations?: SarahCourseRecommendationCard[];
  unavailableRecommendations?: number;
  error?: string;
};

// AC-7: the learner sends only the fixed COURSE_GUIDANCE intent, a bounded
// message and an idempotency key. Learner identity, mode, catalogue, offers,
// prices, completed courses, capabilities, profile and budget are all
// derived server-side (src/server/sarah/course-guidance.ts). Any other form
// field is ignored. This action never creates an order, checkout, campaign
// redemption, entitlement or enrolment. A raw exception never reaches the
// learner.
export async function askSarahCourseGuidanceAction(
  _previous: SarahCourseGuidanceActionState,
  form: FormData,
): Promise<SarahCourseGuidanceActionState> {
  const parsed = sarahCourseGuidanceRequestSchema.safeParse({
    intent: form.get("intent"),
    message: form.get("message"),
    idempotencyKey: form.get("idempotencyKey"),
  });
  if (!parsed.success) return { error: "Enter 1 to 1,000 characters." };
  let result: SarahCourseGuidanceResult;
  try {
    result = await executeSarahCourseGuidance(parsed.data);
  } catch {
    return { status: "RETRY_LATER" };
  }
  if (result.status !== "SUCCEEDED") return { status: result.status };
  return {
    status: "SUCCEEDED",
    reply: result.reply,
    recommendations: result.recommendations,
    unavailableRecommendations: result.unavailableRecommendations,
  };
}
