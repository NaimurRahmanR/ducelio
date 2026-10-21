"use server";
import { revalidatePath } from "next/cache";
import {
  completeAcademicEnrolment,
  regradeAcademicResult,
} from "@/server/commercial-v1-academic-results";
import {
  academicResultsRefusalMessage,
  completionOutcomeMessages,
  regradeOutcomeMessages,
} from "@/domain/commercial-v1-academic-results";

// Every action re-enters the server-only authority, which re-derives the
// actor. The browser sends only the revision id (a hidden field from the
// server-rendered detail) or the enrolment id, plus a bounded reason --
// never a kind, revision number, target, learner, enrolment for a regrade,
// activation, model/provider, weight, max marks, budget or score.
export type AcademicResultsActionState = {
  error?: string;
  message?: string;
  resultRevisionId?: string;
};

function text(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

export async function regradeAcademicResultAction(
  _state: AcademicResultsActionState,
  form: FormData,
): Promise<AcademicResultsActionState> {
  try {
    const result = await regradeAcademicResult({
      resultId: text(form, "resultId"),
      reason: text(form, "reason"),
    });
    revalidatePath("/admin/academic-results");
    revalidatePath("/admin", "layout");
    if (result.status === "REGRADED" || result.status === "ALREADY_REGRADED")
      return {
        message: regradeOutcomeMessages[result.status],
        resultRevisionId: result.resultRevisionId,
      };
    return { error: regradeOutcomeMessages[result.status] };
  } catch (error) {
    return { error: academicResultsRefusalMessage(error) };
  }
}

export async function completeAcademicEnrolmentAction(
  _state: AcademicResultsActionState,
  form: FormData,
): Promise<AcademicResultsActionState> {
  try {
    const result = await completeAcademicEnrolment({
      enrolmentId: text(form, "enrolmentId"),
      reason: text(form, "reason"),
    });
    revalidatePath("/admin/academic-results");
    revalidatePath("/admin", "layout");
    return result.ok
      ? { message: completionOutcomeMessages[result.code] }
      : { error: completionOutcomeMessages[result.code] };
  } catch (error) {
    return { error: academicResultsRefusalMessage(error) };
  }
}
