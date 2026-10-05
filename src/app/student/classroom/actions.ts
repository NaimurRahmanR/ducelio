"use server";
import { z } from "zod";
import {
  learnerMessageSchema,
  classroomIdempotencyKeySchema,
  mapRuntimeResultToClassroomOutcome,
  type ProfessorClassroomInteraction,
} from "@/domain/professor-classroom";
import {
  openProfessorClassroom,
  recordProfessorClassroomInteraction,
} from "@/server/professor-classroom";
import { executeRoleCapability } from "@/server/academic-runtime";

export type ClassroomActionState = {
  status?:
    | "SUCCEEDED"
    | "MEMORY_FULL"
    | "ACTIVITY_BLOCKED"
    | "UNAVAILABLE"
    | "ESCALATED"
    | "RETRY_LATER"
    | "DUPLICATE";
  text?: string;
  // AC-2: the answer is shown, but this exchange is not in the classroom's
  // memory, so the Professor may not remember it later.
  memoryNotRecorded?: true;
  error?: string;
};

// Shared by both learner-facing Professor actions. Never trusts anything
// about the learner/enrolment/lesson relationship from the submitted form:
// openProfessorClassroom re-derives and re-verifies ownership fresh from
// classSessionId alone, on every call, exactly as it does on first page
// load. The idempotency check runs before any provider call, so a
// duplicated/replayed submission of the same logical action can never
// itself cause a second provider call. executeRoleCapability -- the
// existing governed entrypoint, narrowly extended with the closed classroom
// interaction contract -- is the only path to the provider; this function chooses PROFESSOR and the reviewed classroom
// capability itself, never from caller input.
async function requestProfessorClassroom(
  classSessionId: string,
  interaction: ProfessorClassroomInteraction,
  idempotencyKey: string,
): Promise<ClassroomActionState> {
  const context = await openProfessorClassroom({ classSessionId }).catch(
    () => null,
  );
  if (!context) return { error: "This classroom is not currently available." };

  const proceed = await recordProfessorClassroomInteraction(
    classSessionId,
    idempotencyKey,
  ).catch(() => null);
  if (proceed === null)
    return { error: "This classroom is not currently available." };
  if (!proceed) return { status: "DUPLICATE" };

  // The idempotency key is already durably reserved above (migration 026's
  // reservation table), regardless of what happens next: an unexpected
  // failure here must never be treated as "nothing happened yet". A
  // deliberate retry is a fresh learner action with a fresh key, never an
  // automatic one from this boundary.
  //
  // Correction pass (independent review): executeRoleCapability itself is
  // the governed entrypoint with its closed classroom interaction contract.
  // This call site must not assume it can only ever resolve -- an infrastructure/database/
  // controller/schema/runtime exception (never expected in normal
  // operation, but never impossible either) must not propagate its raw
  // message, and must not be logged, to the learner. It is mapped to the
  // exact same safe RETRY_LATER state already used for an ordinary
  // transient execution failure, with no automatic second attempt from
  // here.
  let result;
  try {
    result = await executeRoleCapability({
      enrolmentId: context.enrolmentId,
      role: "PROFESSOR",
      capability: "get_lesson_context",
      lessonId: context.lessonId,
      interaction,
      // AC-2: the classroom identity from the server-opened classroom (never
      // the form), so the runtime can re-derive timing and memory.
      classSessionId: context.classSessionId,
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

// "Begin with Professor": a deliberate user action, never triggered merely
// by the page rendering or refreshing. The interaction descriptor carries
// no learner-supplied content at all.
export async function beginLessonAction(
  _previous: ClassroomActionState,
  form: FormData,
): Promise<ClassroomActionState> {
  const parsed = formInputSchema.safeParse({
    classSessionId: form.get("classSessionId"),
    idempotencyKey: form.get("idempotencyKey"),
  });
  if (!parsed.success) return { error: "Invalid request." };
  return requestProfessorClassroom(
    parsed.data.classSessionId,
    { kind: "BEGIN_LESSON" },
    parsed.data.idempotencyKey,
  );
}

// "Ask Professor": the one place learner plain text reaches the provider,
// through the single reviewed bounded contract (learnerMessageSchema:
// string, trimmed, 1..2000 characters). Message validation happens before
// any classroom lookup or provider call, so an overlong or empty message
// never reaches either.
export async function askProfessorAction(
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
    return {
      error: "Enter a question between 1 and 2,000 characters.",
    };
  return requestProfessorClassroom(
    parsed.data.classSessionId,
    { kind: "LEARNER_QUESTION", learnerMessage: parsed.data.message },
    parsed.data.idempotencyKey,
  );
}
