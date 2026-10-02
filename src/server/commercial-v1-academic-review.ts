import "server-only";
import type { z } from "zod";
import {
  AcademicReviewError,
  academicReviewAssessmentGradeInput,
  academicReviewCaseListSchema,
  academicReviewCaseSchema,
  academicReviewGradeResultSchema,
  academicReviewLabGradeInput,
  academicReviewRefusalCode,
} from "@/domain/commercial-v1-academic-review";
import { getAuthenticatedActor, requireAnyRole } from "./identity";
import { createSupabase } from "./supabase";

// Human academic review (migration 202610020047). Only a freshly
// authenticated ACADEMIC_ADMIN or PLATFORM_ADMIN may read review cases or
// record a manual first grade. The role check here only avoids a pointless
// round trip: the database re-derives the actor, re-checks the role under
// the learner/enrolment locks and resolves every target identity and policy
// value from the case id. The browser supplies only the case id, the human
// marks and a bounded reason.
const REVIEWERS = ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"] as const;

async function reviewRpc<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const actor = await getAuthenticatedActor();
    if (!actor || !REVIEWERS.some((role) => actor.roles.includes(role)))
      throw new AcademicReviewError("FORBIDDEN");
    const { data, error } = await (await createSupabase()).rpc(name, args);
    if (error)
      throw new AcademicReviewError(academicReviewRefusalCode(error.message));
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AcademicReviewError("SERVICE_UNAVAILABLE");
    return parsed.data;
  } catch (error) {
    if (error instanceof AcademicReviewError) throw error;
    throw new AcademicReviewError("SERVICE_UNAVAILABLE");
  }
}

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AcademicReviewError("INVALID_INPUT");
  return parsed.data;
}

export async function getAcademicReviewWorkspace(caseId?: string | null) {
  const actor = await requireAnyRole(REVIEWERS);
  const list = await reviewRpc(
    "list_commercial_v1_academic_review_cases",
    {},
    academicReviewCaseListSchema,
  );
  let selected = null;
  let selectedError: AcademicReviewError | null = null;
  if (caseId) {
    try {
      selected = await reviewRpc(
        "get_commercial_v1_academic_review_case",
        {
          p_case_id: input(
            academicReviewAssessmentGradeInput.shape.caseId,
            caseId,
          ),
        },
        academicReviewCaseSchema,
      );
    } catch (error) {
      selectedError =
        error instanceof AcademicReviewError
          ? error
          : new AcademicReviewError("SERVICE_UNAVAILABLE");
    }
  }
  return { actor, cases: list.cases, selected, selectedError };
}

export async function submitAssessmentReviewGrade(value: unknown) {
  const p = input(academicReviewAssessmentGradeInput, value);
  return reviewRpc(
    "submit_commercial_v1_academic_review_assessment_grade",
    { p_case_id: p.caseId, p_marks: p.marks, p_reason: p.reason },
    academicReviewGradeResultSchema,
  );
}

export async function submitLabReviewGrade(value: unknown) {
  const p = input(academicReviewLabGradeInput, value);
  return reviewRpc(
    "submit_commercial_v1_academic_review_lab_grade",
    {
      p_case_id: p.caseId,
      p_marks_awarded: p.marksAwarded,
      p_reason: p.reason,
    },
    academicReviewGradeResultSchema,
  );
}
