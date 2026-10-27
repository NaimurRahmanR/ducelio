"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { learnerSupportMessageSchema } from "@/domain/tutor-lab-execution";
import { getMyAcademyLesson } from "@/server/academy-delivery";
import { openMyAcademyTutorSupport } from "@/server/academy-support";
import { executeAcademySupport } from "@/server/tutor-lab-execution/academy";
import { checkInToClass } from "@/server/learner-academics";

// Course workspace actions (docs/61 §2). Forms carry only identifiers; the
// database re-derives ownership, the availability window and the exam
// firewall. Attendance is not completion or mastery.
export type CourseActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
};

const CHECK_IN_TEXT: Record<string, string> = {
  NOT_YET_STARTED: "This class has not started yet.",
  WINDOW_CLOSED: "The attendance window for this class has closed.",
  NOT_A_CLASS: "Attendance is recorded for classes only.",
  SCHEDULE_SUPERSEDED:
    "Your timetable has changed. Reload the page to see the current class.",
  ACTIVITY_BLOCKED:
    "Attendance is unavailable while a controlled assessment is in progress.",
  NOT_FOUND_OR_FORBIDDEN: "This class is not on your timetable.",
};

// "Give attendance": records one attendance row for the scheduled class.
export async function checkInMyClassAction(
  _previous: CourseActionState,
  form: FormData,
): Promise<CourseActionState> {
  const input = z
    .strictObject({ enrolmentId: z.uuid(), scheduleItemId: z.uuid() })
    .safeParse({
      enrolmentId: form.get("enrolmentId"),
      scheduleItemId: form.get("scheduleItemId"),
    });
  if (!input.success)
    return { ok: false, error: CHECK_IN_TEXT.NOT_FOUND_OR_FORBIDDEN };
  try {
    const result = await checkInToClass(
      input.data.enrolmentId,
      input.data.scheduleItemId,
    );
    if (!result.ok)
      return {
        ok: false,
        error:
          CHECK_IN_TEXT[result.code] ??
          "Attendance could not be recorded. Try again later.",
      };
    revalidatePath(`/student/courses/${input.data.enrolmentId}`);
    return {
      ok: true,
      message: result.replayed
        ? "Your attendance was already recorded."
        : "Attendance recorded.",
    };
  } catch {
    return {
      ok: false,
      error: "Attendance could not be recorded. Try again later.",
    };
  }
}

// AI Tutor from the workspace. The governed Tutor conversation is scoped to
// one released lesson objective, so the class's first objective anchors it;
// the Tutor's context is the whole lesson. The quick actions send a fixed
// learner request; the free-text form sends the learner's own question.
// The answer is shown in the existing Tutor conversation page.
export async function openMyTutorAction(form: FormData): Promise<void> {
  const input = z
    .strictObject({
      enrolmentId: z.uuid(),
      lessonRef: z.string().min(1).max(80).optional(),
      request: z.enum(["CLASS_NOTES", "EXPLAIN_TOPICS", "QUESTION"]),
      message: z.string().max(2000).optional(),
    })
    .safeParse({
      enrolmentId: form.get("enrolmentId"),
      lessonRef: form.get("lessonRef") ?? undefined,
      request: form.get("request"),
      message: form.get("message") ?? undefined,
    });
  if (!input.success) redirect("/student/learning");
  const { enrolmentId, lessonRef, request } = input.data;
  const back: (notice: string) => never = (notice) =>
    redirect(
      `/student/courses/${enrolmentId}?tutorNotice=${encodeURIComponent(notice)}#tutor`,
    );
  if (!lessonRef) back("NO_CLASS");

  let lesson: Awaited<ReturnType<typeof getMyAcademyLesson>>;
  try {
    lesson = await getMyAcademyLesson(enrolmentId, lessonRef);
  } catch {
    return back("NOT_RELEASED");
  }
  const objective = lesson.objectives[0];
  if (!objective) back("NO_OBJECTIVES");

  const text =
    request === "CLASS_NOTES"
      ? `Please give me concise class notes for "${lesson.title}".`
      : request === "EXPLAIN_TOPICS"
        ? `Please explain the topics covered in "${lesson.title}".`
        : (input.data.message ?? "").trim();
  const message = learnerSupportMessageSchema.safeParse(text);
  if (!message.success) back("INVALID_MESSAGE");

  let requestId: string;
  try {
    requestId = await openMyAcademyTutorSupport(
      enrolmentId,
      lesson.lessonRef,
      objective.id,
    );
  } catch {
    return back("UNAVAILABLE");
  }
  // A failed or refused answer still lands on the conversation, which says
  // so and lets the learner ask again; nothing is reported as answered.
  let status = "RETRY_LATER";
  try {
    status = (
      await executeAcademySupport({
        requestId,
        idempotencyKey: randomUUID(),
        message: message.data,
      })
    ).status;
  } catch {
    // status stays RETRY_LATER
  }
  redirect(
    status === "SUCCEEDED"
      ? `/student/academy/support/${requestId}`
      : `/student/academy/support/${requestId}?notice=${encodeURIComponent(status)}`,
  );
}
