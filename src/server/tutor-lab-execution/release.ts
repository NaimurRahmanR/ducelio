import "server-only";
import { z } from "zod";
import {
  tutorLabRoleSchema,
  tutorLabHandoffReasonSchema,
  TUTOR_LAB_ALLOWED_REASONS,
  type TutorLabHandoffReason,
} from "@/domain/tutor-lab-execution";
import { createSupabase } from "../supabase";

const denialSchema = z.strictObject({
  ok: z.literal(false),
  code: z.string(),
});
const grantSchema = z.strictObject({
  ok: z.literal(true),
  release_id: z.uuid(),
  student_id: z.uuid(),
  invocation_id: z.uuid(),
  role: tutorLabRoleSchema,
  reason_code: tutorLabHandoffReasonSchema,
  enrolment_id: z.uuid(),
  lesson_id: z.uuid(),
  objective_id: z.uuid().nullable(),
  practical_id: z.uuid().nullable(),
});
export type TutorLabContentRelease = {
  releaseId: string;
  studentId: string;
  invocationId: string;
  role: "TUTOR" | "LAB_INSTRUCTOR";
  reasonCode: TutorLabHandoffReason;
  enrolmentId: string;
  lessonId: string;
  objectiveId: string | null;
  practicalId: string | null;
};
export class TutorLabContentReleaseDenied extends Error {
  constructor(readonly code: string) {
    super("Tutor/Lab content release denied.");
    this.name = "TutorLabContentReleaseDenied";
  }
}

// Proves handoff ownership (current actor === handoff.requested_by AND
// enrolment.student_id === current actor), derives the destination role
// EXCLUSIVELY from the handoff's own destination_profile (never a
// caller-supplied value), validates reason-specific selector requirements,
// and opens a bounded 30-second release scoped to the exact enrolment/
// lesson/objective/practical this handoff proves -- all inside one
// SECURITY DEFINER transaction (migration 028's begin_tutor_lab_content_
// release). A forged/foreign/wrong-reason handoff fails closed here, before
// any provider context is ever built.
export async function beginTutorLabContentRelease(
  invocationId: string,
  handoffId: string,
): Promise<TutorLabContentRelease> {
  const client = await createSupabase();
  const { data, error } = await client.rpc("begin_tutor_lab_content_release", {
    p_invocation_id: z.uuid().parse(invocationId),
    p_handoff_id: z.uuid().parse(handoffId),
  });
  if (error) throw new Error("Tutor/Lab content release could not be opened.");
  const result = z.union([grantSchema, denialSchema]).parse(data);
  if (!result.ok) throw new TutorLabContentReleaseDenied(result.code);
  // Defense-in-depth re-assertion of the same role/reason binding migration
  // 028's own SQL gate already enforces (see TUTOR_LAB_ALLOWED_REASONS):
  // never trust a single layer alone to keep a wrong combination from ever
  // reaching context construction.
  if (!TUTOR_LAB_ALLOWED_REASONS[result.role].includes(result.reason_code))
    throw new TutorLabContentReleaseDenied("CONTEXT_CONFLICT");
  return {
    releaseId: result.release_id,
    studentId: result.student_id,
    invocationId: result.invocation_id,
    role: result.role,
    reasonCode: result.reason_code,
    enrolmentId: result.enrolment_id,
    lessonId: result.lesson_id,
    objectiveId: result.objective_id,
    practicalId: result.practical_id,
  };
}

export async function closeTutorLabContentRelease(
  release: TutorLabContentRelease,
  complete: boolean,
): Promise<void> {
  const client = await createSupabase();
  const { data, error } = await client.rpc("close_tutor_lab_content_release", {
    p_release_id: release.releaseId,
    p_complete: complete,
  });
  if (error) throw new Error("Tutor/Lab content release could not be closed.");
  const result = z
    .union([
      z.strictObject({
        ok: z.literal(true),
        state: z.enum(["COMPLETED", "ABORTED", "EXPIRED", "BLOCKED"]),
        transitioned: z.boolean(),
      }),
      denialSchema,
    ])
    .parse(data);
  if (
    !result.ok ||
    (complete
      ? result.state !== "COMPLETED" || !result.transitioned
      : !["ABORTED", "EXPIRED"].includes(result.state))
  )
    throw new Error("Tutor/Lab content release was not finalized as required.");
}
