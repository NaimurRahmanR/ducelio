"use server";
import { revalidatePath } from "next/cache";
import {
  submitAssessmentReviewGrade,
  submitLabReviewGrade,
} from "@/server/commercial-v1-academic-review";
import { academicReviewRefusalMessage } from "@/domain/commercial-v1-academic-review";

// Every action re-enters the server-only authority, which re-derives the
// actor; the database re-checks reviewer authority under lock and resolves
// every target identity and policy value from the case id. The browser sends
// only the case id (a hidden field from the server-rendered case), the human
// marks and a bounded reason -- never max marks, weight, component, learner,
// enrolment, activation, assessment, revision or target kind.
export type AcademicReviewActionState = {
  error?: string;
  message?: string;
};

function text(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}
function wholeNumber(value: string | undefined) {
  if (value === undefined || !/^\d+$/.test(value.trim())) return Number.NaN;
  return Number(value.trim());
}
function outcome(code: "RESULT_CREATED" | "ALREADY_RESOLVED") {
  revalidatePath("/admin/academic-review");
  revalidatePath("/admin", "layout");
  revalidatePath("/admin/activation/recovery");
  revalidatePath("/admin", "layout");
  return {
    message:
      code === "RESULT_CREATED"
        ? "First grade recorded. The result is now part of the learner's record."
        : "This case was already resolved; the existing first grade was kept.",
  };
}

const MARK_FIELD = /^mark:([0-9a-f-]{36})$/i;

export async function submitAssessmentReviewAction(
  _state: AcademicReviewActionState,
  form: FormData,
): Promise<AcademicReviewActionState> {
  try {
    const marks: { questionId: string; marksAwarded: number }[] = [];
    for (const [key, value] of form.entries()) {
      const match = MARK_FIELD.exec(key);
      if (match && typeof value === "string")
        marks.push({ questionId: match[1], marksAwarded: wholeNumber(value) });
    }
    const result = await submitAssessmentReviewGrade({
      caseId: text(form, "caseId"),
      marks,
      reason: text(form, "reason"),
    });
    return outcome(result.code);
  } catch (error) {
    return { error: academicReviewRefusalMessage(error) };
  }
}

export async function submitLabReviewAction(
  _state: AcademicReviewActionState,
  form: FormData,
): Promise<AcademicReviewActionState> {
  try {
    const result = await submitLabReviewGrade({
      caseId: text(form, "caseId"),
      marksAwarded: wholeNumber(text(form, "marksAwarded")),
      reason: text(form, "reason"),
    });
    return outcome(result.code);
  } catch (error) {
    return { error: academicReviewRefusalMessage(error) };
  }
}
