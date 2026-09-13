import "server-only";
import { z } from "zod";
import {
  classSessionIdInputSchema,
  classroomIdempotencyKeySchema,
  openClassroomRpcResultSchema,
  interactionRpcResultSchema,
  ClassroomDenied,
  type ClassroomContext,
} from "@/domain/professor-classroom";
import { getAuthenticatedActor } from "./identity";
import { createSupabase } from "./supabase";
import {
  getStudentLessonContext,
  getStudentLessonObjectives,
} from "./learning-context";
import { getStudentLessonResources } from "./learning-resources";
import { getStudentLessonMastery } from "./objective-mastery";
import { AcademicActivityBlocked } from "./academic-activity";

// Never trusts a client-supplied enrolment/lesson/programme-version
// relationship: open_professor_classroom (migration 026) independently
// re-derives ownership from the class_session_id alone (the same cohort_id
// + programme_version_id join migration 019's list_my_class_sessions
// already relies on), and durably records first/last opened for resume.
// Recomputes LIVE/CATCH_UP against server/database time on every call.
export async function openProfessorClassroom(
  input: unknown,
): Promise<ClassroomContext> {
  const { classSessionId } = classSessionIdInputSchema.parse(input);
  const actor = await getAuthenticatedActor();
  if (!actor) throw new ClassroomDenied("UNAUTHENTICATED");
  const client = await createSupabase();
  const { data, error } = await client.rpc("open_professor_classroom", {
    p_class_session_id: classSessionId,
  });
  if (error) throw new ClassroomDenied("SERVICE_UNAVAILABLE");
  const result = openClassroomRpcResultSchema.safeParse(data);
  if (!result.success) throw new ClassroomDenied("SERVICE_UNAVAILABLE");
  if (!result.data.ok) throw new ClassroomDenied(result.data.code);
  if (result.data.classroom.classSessionId !== classSessionId)
    throw new ClassroomDenied("CONTEXT_CONFLICT");
  return result.data.classroom;
}

// Returns true when the caller should proceed (a new, previously-unseen
// idempotency key was durably reserved for this classroom); false when this
// exact key was already reserved -- including a key reserved before other,
// later interactions happened -- meaning a second provider call must NOT be
// made for what is intended to be one learner action. Requires an
// already-opened classroom (call openProfessorClassroom first).
export async function recordProfessorClassroomInteraction(
  classSessionId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const sessionId = classSessionIdInputSchema.parse({
    classSessionId,
  }).classSessionId;
  const key = classroomIdempotencyKeySchema.parse(idempotencyKey);
  const actor = await getAuthenticatedActor();
  if (!actor) throw new ClassroomDenied("UNAUTHENTICATED");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "record_professor_classroom_interaction",
    { p_class_session_id: sessionId, p_idempotency_key: key },
  );
  if (error) throw new ClassroomDenied("SERVICE_UNAVAILABLE");
  const result = interactionRpcResultSchema.safeParse(data);
  if (!result.success) throw new ClassroomDenied("SERVICE_UNAVAILABLE");
  if (!result.data.ok) throw new ClassroomDenied(result.data.code);
  return !result.data.duplicate;
}

export type ClassroomLessonContent =
  | {
      available: true;
      objectives: Awaited<ReturnType<typeof getStudentLessonObjectives>>;
      resources: Awaited<ReturnType<typeof getStudentLessonResources>>;
      mastery: Awaited<ReturnType<typeof getStudentLessonMastery>>;
    }
  | { available: false };

// Reuses the EXACT existing, reviewed Academy OS reads (never a parallel
// retrieval path): each independently re-verifies lesson/enrolment
// ownership again and enforces the existing controlled-assessment
// explanation firewall itself. When that firewall is active, all four
// throw AcademicActivityBlocked together, which this treats as "classroom
// content is currently unavailable" rather than a hard error -- the
// classroom page still renders its header/schedule (derived separately by
// openProfessorClassroom, which never calls the firewall), but no lesson
// content and no Professor interaction are offered while it is blocked.
export async function getClassroomLessonContent(context: {
  enrolmentId: string;
  lessonId: string;
}): Promise<ClassroomLessonContent> {
  try {
    // get_lesson_context itself is not surfaced separately here: the
    // classroom header already has lesson identity/title from
    // openProfessorClassroom, and get_lesson_context is instead the exact
    // capability the Professor provider path re-fetches and validates for
    // itself at interaction time (see requestProfessorClassroom).
    const [objectives, resources, mastery] = await Promise.all([
      getStudentLessonObjectives(context),
      getStudentLessonResources(context),
      getStudentLessonMastery(context),
    ]);
    return { available: true, objectives, resources, mastery };
  } catch (error) {
    if (error instanceof AcademicActivityBlocked) return { available: false };
    throw error;
  }
}

// Minimal bounded read for the Classes list CTA (Start vs Resume class /
// Start vs Resume catch-up) only: no title, timing or other column, just
// which class sessions this learner has already opened a classroom for.
export async function listMyProfessorClassroomSessionIds(): Promise<
  ReadonlySet<string>
> {
  const actor = await getAuthenticatedActor();
  if (!actor) throw new ClassroomDenied("UNAUTHENTICATED");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "list_my_professor_classroom_session_ids",
  );
  if (error) throw new ClassroomDenied("SERVICE_UNAVAILABLE");
  return new Set(z.array(z.uuid()).parse(data));
}

export { getStudentLessonContext };
