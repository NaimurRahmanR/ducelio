"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { learnerSupportMessageSchema } from "@/domain/tutor-lab-execution";
import { executeAcademySupport } from "@/server/tutor-lab-execution/academy";
import {
  AcademySupportUnavailable,
  openMyAcademyLabSupport,
  openMyAcademyTutorSupport,
} from "@/server/academy-support";

export type AcademySupportActionState = {
  status?:
    | "SUCCEEDED"
    | "ACTIVITY_BLOCKED"
    | "UNAVAILABLE"
    | "ESCALATED"
    | "RETRY_LATER"
    | "DUPLICATE";
  text?: string;
  notRecorded?: true;
  error?: string;
};

const noticeCode = (error: unknown) =>
  error instanceof AcademySupportUnavailable
    ? error.code
    : "SERVICE_UNAVAILABLE";

// "Ask the AI Tutor" on a released lesson objective. The form carries only
// identifiers; the database re-derives ownership, release and the firewall.
export async function openTutorSupportAction(form: FormData): Promise<void> {
  const input = z
    .strictObject({
      enrolmentId: z.uuid(),
      lessonRef: z.string().min(1).max(80),
      objectiveId: z.uuid(),
    })
    .safeParse({
      enrolmentId: form.get("enrolmentId"),
      lessonRef: form.get("lessonRef"),
      objectiveId: form.get("objectiveId"),
    });
  if (!input.success) redirect("/student/academy");
  let requestId: string;
  try {
    requestId = await openMyAcademyTutorSupport(
      input.data.enrolmentId,
      input.data.lessonRef,
      input.data.objectiveId,
    );
  } catch (error) {
    redirect(
      `/student/academy?enrolmentId=${input.data.enrolmentId}&supportNotice=${encodeURIComponent(noticeCode(error))}`,
    );
  }
  redirect(`/student/academy/support/${requestId}`);
}

// "Get help from the AI Lab Instructor" on a started practical session.
export async function openLabSupportAction(form: FormData): Promise<void> {
  const input = z
    .strictObject({ enrolmentId: z.uuid(), scheduleItemId: z.uuid() })
    .safeParse({
      enrolmentId: form.get("enrolmentId"),
      scheduleItemId: form.get("scheduleItemId"),
    });
  if (!input.success) redirect("/student/academy");
  let requestId: string;
  try {
    requestId = await openMyAcademyLabSupport(
      input.data.enrolmentId,
      input.data.scheduleItemId,
    );
  } catch (error) {
    redirect(
      `/student/academy?enrolmentId=${input.data.enrolmentId}&supportNotice=${encodeURIComponent(noticeCode(error))}`,
    );
  }
  redirect(`/student/academy/support/${requestId}`);
}

// The one place learner text reaches the Tutor or Lab Instructor, through
// the bounded message contract; the governed runtime chooses the role from
// the request itself, never from the form.
export async function askAcademySupportAction(
  _previous: AcademySupportActionState,
  form: FormData,
): Promise<AcademySupportActionState> {
  const parsed = z
    .strictObject({
      requestId: z.uuid(),
      idempotencyKey: z.uuid(),
      message: learnerSupportMessageSchema,
    })
    .safeParse({
      requestId: form.get("requestId"),
      idempotencyKey: form.get("idempotencyKey"),
      message: form.get("message"),
    });
  if (!parsed.success)
    return { error: "Enter a question between 1 and 2,000 characters." };
  let result;
  try {
    result = await executeAcademySupport(parsed.data);
  } catch {
    return { status: "RETRY_LATER" };
  }
  if (result.status !== "SUCCEEDED") return { status: result.status };
  return result.record === "NOT_RECORDED"
    ? { status: "SUCCEEDED", text: result.text, notRecorded: true }
    : { status: "SUCCEEDED", text: result.text };
}
