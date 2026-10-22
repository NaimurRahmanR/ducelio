"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  classroomIdempotencyKeySchema,
  learnerMessageSchema,
  mapRuntimeResultToClassroomOutcome,
  type ProfessorClassroomInteraction,
} from "@/domain/professor-classroom";
import type { ClassroomActionState } from "@/app/student/classroom/actions";
import { executeAcademyProfessorClassroom } from "@/server/academic-runtime/academy-professor";
import {
  AcademyClassDenied,
  academyClassDenialText,
  openMyAcademyClass,
  reserveAcademyClassInteraction,
} from "@/server/academy-professor-classroom";

// "Enter AI class" on the learner's own timetable. The form carries only
// the enrolment and scheduled-session identifiers; the database re-derives
// ownership, the scheduled time, release, revocation and the exam firewall.
export async function enterAcademyClassAction(form: FormData): Promise<void> {
  const input = z
    .strictObject({ enrolmentId: z.uuid(), scheduleItemId: z.uuid() })
    .safeParse({
      enrolmentId: form.get("enrolmentId"),
      scheduleItemId: form.get("scheduleItemId"),
    });
  if (!input.success) redirect("/student/academy");
  let classroomId: string;
  try {
    ({ classroomId } = await openMyAcademyClass(
      input.data.enrolmentId,
      input.data.scheduleItemId,
    ));
  } catch (error) {
    const code =
      error instanceof AcademyClassDenied ? error.code : "SERVICE_UNAVAILABLE";
    redirect(
      `/student/academy?enrolmentId=${input.data.enrolmentId}&classNotice=${encodeURIComponent(code)}`,
    );
  }
  redirect(`/student/academy/classroom/${classroomId}`);
}

// The same learner contract as the cohort classroom: a reserved
// idempotency key before any provider call, then the governed execution,
// which re-derives everything from the classroom identity.
async function requestAcademyProfessor(
  classroomId: string,
  interaction: ProfessorClassroomInteraction,
  idempotencyKey: string,
): Promise<ClassroomActionState> {
  let proceed: boolean;
  try {
    proceed = await reserveAcademyClassInteraction(classroomId, idempotencyKey);
  } catch (error) {
    if (
      error instanceof AcademyClassDenied &&
      error.code === "ACTIVITY_BLOCKED"
    )
      return { status: "ACTIVITY_BLOCKED" };
    return {
      error:
        error instanceof AcademyClassDenied
          ? academyClassDenialText(error.code)
          : "This class is not available.",
    };
  }
  if (!proceed) return { status: "DUPLICATE" };
  let result;
  try {
    result = await executeAcademyProfessorClassroom({
      classroomId,
      interaction,
    });
  } catch {
    return { status: "RETRY_LATER" };
  }
  const outcome = mapRuntimeResultToClassroomOutcome(result);
  if (outcome.kind !== "SUCCEEDED") return { status: outcome.kind };
  return outcome.memoryNotRecorded
    ? { status: "SUCCEEDED", text: outcome.text, memoryNotRecorded: true }
    : { status: "SUCCEEDED", text: outcome.text };
}

const formInputSchema = z.strictObject({
  classSessionId: z.uuid(),
  idempotencyKey: classroomIdempotencyKeySchema,
});

// The shared classroom panel posts the classroom identity as
// classSessionId; for the Academy it is the Academy classroom id.
export async function beginAcademyLessonAction(
  _previous: ClassroomActionState,
  form: FormData,
): Promise<ClassroomActionState> {
  const parsed = formInputSchema.safeParse({
    classSessionId: form.get("classSessionId"),
    idempotencyKey: form.get("idempotencyKey"),
  });
  if (!parsed.success) return { error: "Invalid request." };
  return requestAcademyProfessor(
    parsed.data.classSessionId,
    { kind: "BEGIN_LESSON" },
    parsed.data.idempotencyKey,
  );
}

export async function askAcademyProfessorAction(
  _previous: ClassroomActionState,
  form: FormData,
): Promise<ClassroomActionState> {
  const parsed = formInputSchema
    .extend({ message: learnerMessageSchema })
    .safeParse({
      classSessionId: form.get("classSessionId"),
      idempotencyKey: form.get("idempotencyKey"),
      message: form.get("message"),
    });
  if (!parsed.success)
    return { error: "Enter a question between 1 and 2,000 characters." };
  return requestAcademyProfessor(
    parsed.data.classSessionId,
    { kind: "LEARNER_QUESTION", learnerMessage: parsed.data.message },
    parsed.data.idempotencyKey,
  );
}
