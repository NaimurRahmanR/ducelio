import "server-only";
import {
  feedbackOpportunitiesResultSchema,
  sessionFeedbackOutcome,
  sessionFeedbackResultSchema,
  sessionFeedbackSubmissionSchema,
  teachingQualityInputSchema,
  teachingQualitySchema,
  type FeedbackOpportunity,
  type SessionFeedbackOutcome,
  type TeachingQuality,
} from "@/domain/session-feedback";
import { requireAnyRole, requireStudentPrincipal } from "./identity";
import { createSupabase } from "./supabase";

// AC-6: Sarah post-session feedback. Deterministic institutional data only.
//
// This module deliberately imports nothing from the Sarah execution plane
// (src/server/sarah), the academic runtime, any provider adapter or profile
// registry: recording three ratings needs no model. The database derives the
// learner from the authenticated session and owns every eligibility check
// (migration 055); the browser supplies only the session handle, a request
// UUID and the ratings.

export type FeedbackOpportunityPage =
  | { status: "OK"; opportunities: FeedbackOpportunity[] }
  | { status: "UNAVAILABLE" };

export async function listMySessionFeedbackOpportunities(): Promise<FeedbackOpportunityPage> {
  await requireStudentPrincipal();
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "list_my_session_feedback_opportunities",
  );
  if (error) return { status: "UNAVAILABLE" };
  const parsed = feedbackOpportunitiesResultSchema.safeParse(data);
  if (!parsed.success || !parsed.data.ok) return { status: "UNAVAILABLE" };
  return { status: "OK", opportunities: parsed.data.opportunities };
}

// Only the authenticated learner submits, for themselves. Unknown fields
// (a learner, instructor, cohort, lesson or version) are refused by the
// strict schema before anything reaches the database.
export async function submitMySessionFeedback(
  input: unknown,
): Promise<SessionFeedbackOutcome> {
  await requireStudentPrincipal();
  const request = sessionFeedbackSubmissionSchema.safeParse(input);
  if (!request.success) return "INVALID";
  const client = await createSupabase();
  const { data, error } = await client.rpc("submit_my_session_feedback", {
    p_class_session_id: request.data.classSessionId,
    p_request_id: request.data.requestId,
    p_clarity_rating: request.data.clarityRating,
    p_pace_rating: request.data.paceRating,
    p_usefulness_rating: request.data.usefulnessRating,
  });
  if (error) return "UNAVAILABLE";
  const parsed = sessionFeedbackResultSchema.safeParse(data);
  if (!parsed.success) return "UNAVAILABLE";
  return sessionFeedbackOutcome(parsed.data);
}

export type TeachingQualityPage =
  | { status: "OK"; data: TeachingQuality }
  | { status: "INVALID_FILTERS" }
  | { status: "UNAVAILABLE" };

// Academic Admin and Platform Admin only (the database checks again and
// refuses REGISTRAR, INSTRUCTOR, COUNSELLOR and STUDENT). Aggregate only.
export async function getTeachingQuality(
  input: unknown,
): Promise<TeachingQualityPage> {
  await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const filters = teachingQualityInputSchema.safeParse(input);
  if (!filters.success) return { status: "INVALID_FILTERS" };
  const client = await createSupabase();
  const { data, error } = await client.rpc("admin_session_teaching_quality", {
    p_instructor_id: filters.data.instructorId ?? null,
    p_cohort_id: filters.data.cohortId ?? null,
    p_from: filters.data.from ?? null,
    p_until: filters.data.until ?? null,
    p_offset: filters.data.offset,
  });
  if (error) return { status: "UNAVAILABLE" };
  const parsed = teachingQualitySchema.safeParse(data);
  if (!parsed.success) return { status: "UNAVAILABLE" };
  return { status: "OK", data: parsed.data };
}
