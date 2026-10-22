"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  confirmMyAcademySchedule,
  previewMyAcademyRevision,
  previewMyAcademySchedule,
  recordMyAcademyResponse,
  reviseMyAcademySchedule,
  startMyAcademyAssessment,
  submitMyAcademyAttempt,
  submitMyAcademyLab,
} from "@/server/academy-delivery";
import type { AcademyPlan } from "@/domain/academy-delivery";
import type { AssessmentActionState } from "@/app/student/actions";

export type PlanActionState = {
  plan?: AcademyPlan;
  error?: string;
  message?: string;
  done?: boolean;
};
const UNAVAILABLE =
  "The timetable service is unavailable. Nothing was changed.";

function scheduleFields(form: FormData) {
  return {
    enrolmentId: form.get("enrolmentId"),
    studyDays: form.getAll("studyDays").map(Number),
    localTime: form.get("localTime"),
    timezone: form.get("timezone"),
  };
}
const initial = (form: FormData) => ({
  ...scheduleFields(form),
  formatId: form.get("formatId"),
  startOn: form.get("startOn"),
});
const revision = (form: FormData) => ({
  ...scheduleFields(form),
  effectiveOn: form.get("effectiveOn"),
  expectedRevision: Number(form.get("expectedRevision")),
});
const refusal = (r: { code: string; message?: string }) =>
  r.message ?? `This change was refused (${r.code}).`;

export async function previewScheduleAction(
  _s: PlanActionState,
  form: FormData,
): Promise<PlanActionState> {
  try {
    return { plan: await previewMyAcademySchedule(initial(form)) };
  } catch (e) {
    return {
      error:
        e instanceof z.ZodError
          ? "Choose a format, start date, at least one study day, a time and a timezone."
          : UNAVAILABLE,
    };
  }
}

export async function confirmScheduleAction(
  _s: PlanActionState,
  form: FormData,
): Promise<PlanActionState> {
  try {
    const result = await confirmMyAcademySchedule(
      initial(form),
      String(form.get("requestKey")),
    );
    if (!result.ok) return { error: refusal(result) };
  } catch {
    return { error: UNAVAILABLE };
  }
  revalidatePath("/student/academy");
  return { done: true, message: "Your personal timetable is confirmed." };
}

export async function previewRevisionAction(
  _s: PlanActionState,
  form: FormData,
): Promise<PlanActionState> {
  try {
    return { plan: await previewMyAcademyRevision(revision(form)) };
  } catch (e) {
    return {
      error:
        e instanceof z.ZodError
          ? "Choose a change date, at least one study day, a time and a timezone."
          : UNAVAILABLE,
    };
  }
}

export async function reviseScheduleAction(
  _s: PlanActionState,
  form: FormData,
): Promise<PlanActionState> {
  try {
    const result = await reviseMyAcademySchedule(
      revision(form),
      String(form.get("requestKey")),
    );
    if (!result.ok) return { error: refusal(result) };
  } catch {
    return { error: UNAVAILABLE };
  }
  revalidatePath("/student/academy");
  return {
    done: true,
    message: "Future dates updated. Completed work is unchanged.",
  };
}

const START_TEXT: Record<string, string> = {
  SITTING_NOT_OPEN:
    "This assessment has not opened yet. It opens at the time shown in your timetable.",
  SITTING_CLOSED:
    "The sitting window has closed, or too little of it remains for the full assessment time.",
  NO_ATTEMPTS_REMAINING: "You have used every permitted attempt.",
  PLAN_REQUIRED: "Confirm your timetable first.",
  ENROLMENT_CLOSED: "This course is complete.",
};
export async function startAssessmentAction(
  _s: AssessmentActionState,
  form: FormData,
): Promise<AssessmentActionState> {
  let attemptId: string;
  try {
    const result = await startMyAcademyAssessment(
      form.get("enrolmentId"),
      form.get("assessmentRef"),
    );
    if (!result.ok)
      return {
        error:
          START_TEXT[result.code] ?? "This assessment cannot be started now.",
      };
    attemptId = result.attemptId;
  } catch {
    return { error: "This assessment cannot be started now." };
  }
  redirect(`/student/academy/attempt/${attemptId}`);
}

// Same contract as the institutional exam workspace: the browser posts the
// revision slot it answers; the idempotency key is derived here from
// SHA-256 of the exact body, so an identical retry replays.
export async function saveAcademyResponseAction(
  _s: AssessmentActionState,
  form: FormData,
): Promise<AssessmentActionState> {
  try {
    const attemptId = z.uuid().parse(form.get("attemptId"));
    const position = z.coerce
      .number()
      .int()
      .positive()
      .parse(String(form.get("questionId")).replace(/^q-/, ""));
    const slot = z.coerce
      .number()
      .int()
      .min(1)
      .max(999999)
      .parse(form.get("revisionSlot"));
    const body = z.string().min(1).max(20000).parse(form.get("body"));
    const key =
      "a" +
      createHash("sha256")
        .update(`${attemptId}:${position}:${slot}:${body}`, "utf8")
        .digest("hex");
    const result = await recordMyAcademyResponse(
      attemptId,
      position,
      body,
      key,
    );
    revalidatePath(`/student/academy/attempt/${attemptId}`);
    if (!result.ok)
      return {
        error:
          result.code === "EXPIRED"
            ? "Time is up. Your saved answers were submitted automatically."
            : result.code === "INVALID_RESPONSE"
              ? "That answer is not valid for this question."
              : "This attempt is closed.",
      };
    return { message: "Answer saved." };
  } catch {
    return { error: "Your answer could not be saved. Try again." };
  }
}

export async function finishAcademyAttemptAction(
  _s: AssessmentActionState,
  form: FormData,
): Promise<AssessmentActionState> {
  const attemptId = String(form.get("attemptId"));
  try {
    await submitMyAcademyAttempt(attemptId);
  } catch {
    return { error: "Unable to submit this assessment attempt." };
  }
  revalidatePath(`/student/academy/attempt/${attemptId}`);
  revalidatePath("/student/academy");
  return { message: "Assessment submitted and marked." };
}

export async function submitLabAction(
  _s: AssessmentActionState,
  form: FormData,
): Promise<AssessmentActionState> {
  try {
    const result = await submitMyAcademyLab(
      form.get("enrolmentId"),
      form.get("labRef"),
      form.get("body"),
      String(form.get("requestKey")),
    );
    if (!result.ok)
      return {
        error:
          result.code === "LAB_NOT_OPEN"
            ? "This practical opens at its scheduled session."
            : result.code === "ALREADY_SUBMITTED"
              ? "You have already submitted this practical."
              : "This practical cannot be submitted.",
      };
  } catch {
    return { error: "Your practical could not be submitted. Try again." };
  }
  revalidatePath("/student/academy");
  return { message: "Practical submitted." };
}
