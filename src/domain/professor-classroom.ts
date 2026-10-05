import { z } from "zod";
import { academicTimestampSchema } from "./academic-reads";
import type { RuntimeResult } from "./academic-runtime";

// Commercial V1: learner-facing Professor classroom. Pure domain module: no
// node/server built-ins, no database access. Describes migration 026's
// professor_classroom_sessions contract (learner-owned, NON-AUTHORITATIVE
// UX state -- never attendance, LearningEvidence, ObjectiveMastery,
// LessonProgress, a grade or any other institutional academic record) and
// the one reviewed learner-message contract that reaches the Professor
// provider runtime.

export const classroomModeSchema = z.enum(["LIVE", "CATCH_UP"]);
export type ClassroomMode = z.infer<typeof classroomModeSchema>;

export const classSessionIdInputSchema = z.strictObject({
  classSessionId: z.uuid(),
});

// Server-generated per opened classroom, or client-generated once per
// logical learner action and reused only while that same action is still
// in flight/being retried. Durably and permanently reserved per classroom
// once spent (public.professor_classroom_interaction_reservations,
// migration 026) so a replay of an OLD key remains a duplicate even after
// other interactions happened in between -- never persisted as, or treated
// as, academic evidence: metadata only, no learner prose or provider
// content.
export const classroomIdempotencyKeySchema = z.string().trim().min(1).max(100);

// The one reviewed bounded contract for learner prose reaching the
// Professor provider: string only, trimmed, 1..2000 characters. No
// arbitrary JSON, no browser-selected role/capability/provider/model/
// budget, no browser-supplied academic context -- those remain entirely
// server-chosen (src/server/professor-classroom.ts).
export const learnerMessageSchema = z.string().trim().min(1).max(2000);

export const professorClassroomInteractionSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("BEGIN_LESSON") }),
    z.strictObject({
      kind: z.literal("LEARNER_QUESTION"),
      learnerMessage: learnerMessageSchema,
    }),
  ],
);
export type ProfessorClassroomInteraction = z.infer<
  typeof professorClassroomInteractionSchema
>;

export const classroomErrorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CANCELLED",
  "NOT_YET_STARTED",
  "INVALID_INPUT",
  "SERVICE_UNAVAILABLE",
  "CONTEXT_CONFLICT",
]);
export type ClassroomErrorCode = z.infer<typeof classroomErrorCodeSchema>;

export class ClassroomDenied extends Error {
  constructor(readonly code: ClassroomErrorCode) {
    super("Professor classroom is unavailable.");
    this.name = "ClassroomDenied";
  }
}

// The bounded, learner-safe context open_professor_classroom (migration
// 026) returns once every ownership relationship has been independently
// re-verified server-side from the class_session_id alone.
export const classroomContextSchema = z.strictObject({
  classroomId: z.uuid(),
  classSessionId: z.uuid(),
  enrolmentId: z.uuid(),
  programmeVersionId: z.uuid(),
  lessonId: z.uuid(),
  mode: classroomModeSchema,
  firstOpenedAt: academicTimestampSchema,
  lastOpenedAt: academicTimestampSchema,
  scheduledStart: academicTimestampSchema,
  scheduledEnd: academicTimestampSchema,
  lessonTitle: z.string(),
  moduleTitle: z.string(),
  cohortTitle: z.string(),
  programmeTitle: z.string(),
  programmeVersionLabel: z.string(),
});
export type ClassroomContext = z.infer<typeof classroomContextSchema>;

export const openClassroomRpcResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), classroom: classroomContextSchema }),
  z.strictObject({ ok: z.literal(false), code: classroomErrorCodeSchema }),
]);

export const interactionRpcResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), duplicate: z.boolean() }),
  z.strictObject({ ok: z.literal(false), code: classroomErrorCodeSchema }),
]);

// Pure mapping from the governed RuntimeResult (src/domain/academic-
// runtime.ts) onto a small, learner-safe vocabulary the classroom UI can
// render directly. No internals ever cross this boundary: no raw provider/
// network payload, no reason codes, no execution/usage identifiers, no HMAC
// or controller detail. Only SUCCEEDED carries content, and only the
// provider's own outputText -- never anything else from the RuntimeResult.
export type ClassroomProfessorOutcome =
  // memoryNotRecorded: the answer is confirmed, but this exchange could not
  // be recorded in the classroom's learner-visible memory (AC-2).
  | { kind: "SUCCEEDED"; text: string; memoryNotRecorded?: true }
  | { kind: "MEMORY_FULL" }
  | { kind: "ACTIVITY_BLOCKED" }
  | { kind: "UNAVAILABLE" }
  | { kind: "ESCALATED" }
  | { kind: "RETRY_LATER" };
export function mapRuntimeResultToClassroomOutcome(
  result: RuntimeResult,
): ClassroomProfessorOutcome {
  switch (result.outcome) {
    case "SUCCEEDED":
      return result.classroomMemory === "NOT_RECORDED"
        ? {
            kind: "SUCCEEDED",
            text: result.response.outputText,
            memoryNotRecorded: true,
          }
        : { kind: "SUCCEEDED", text: result.response.outputText };
    case "ABSTAINED":
      if (result.classroomMemory === "CAPACITY_REACHED")
        return { kind: "MEMORY_FULL" };
      return result.reason === "ACTIVITY_BLOCKED"
        ? { kind: "ACTIVITY_BLOCKED" }
        : { kind: "UNAVAILABLE" };
    case "ESCALATED":
      return { kind: "ESCALATED" };
    case "BUDGET_BLOCKED":
    case "TIMEOUT":
    case "FAILED":
    case "CANCELLED":
      return { kind: "RETRY_LATER" };
  }
}

// Pure, DB-free eligibility preview for the Classes list: the SAME
// LIVE/FUTURE/CATCH_UP/CANCELLED rule migration 026's SQL independently
// re-derives (server/database time against the class_session's own
// scheduled_start/scheduled_end), so the list's CTA and the classroom's own
// authoritative admission agree except for the ordinary, unavoidable clock
// skew between rendering the list and clicking into a session moments
// later. Never itself a source of authorization -- entering the classroom
// always re-verifies ownership and eligibility server-side again.
export type ClassroomPreview =
  | { kind: "CANCELLED" }
  | { kind: "FUTURE" }
  | { kind: "LIVE" }
  | { kind: "CATCH_UP" };
export function previewClassroomEligibility(
  session: { status: string; scheduledStart: string; scheduledEnd: string },
  now: Date,
): ClassroomPreview {
  if (session.status === "CANCELLED") return { kind: "CANCELLED" };
  const start = Date.parse(session.scheduledStart);
  const end = Date.parse(session.scheduledEnd);
  const stamp = now.getTime();
  if (stamp < start) return { kind: "FUTURE" };
  if (stamp <= end) return { kind: "LIVE" };
  return { kind: "CATCH_UP" };
}
