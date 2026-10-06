import "server-only";
import { z } from "zod";
import {
  learnerProfessorHandoffListSchema,
  professorHandoffCreateResultSchema,
  professorHandoffRequestSchema,
  professorTeachingRecordReadSchema,
  type LearnerProfessorHandoff,
  type ProfessorHandoffRefusal,
  type ProfessorTeachingRecord,
} from "@/domain/professor-academic-handoff";
import { requireStudentPrincipal } from "./identity";
import { createSupabase } from "./supabase";

// AC-3 (migration 052): the learner-initiated, minimum-data Professor
// academic handoff. Every identity (learner, enrolment, version, classroom,
// lesson, source Professor execution and provenance) is derived by the
// database from the authenticated learner's own classroom; this module only
// validates the closed input shape and the bounded results. No provider or
// model is ever involved in creating a handoff.

export class ProfessorHandoffRefused extends Error {
  constructor(readonly code: ProfessorHandoffRefusal | "SERVICE_UNAVAILABLE") {
    super("Professor follow-up request refused.");
    this.name = "ProfessorHandoffRefused";
  }
}

export async function requestProfessorAcademicHandoff(
  input: unknown,
): Promise<{ handoffId: string; duplicate: boolean }> {
  await requireStudentPrincipal();
  const parsed = professorHandoffRequestSchema.safeParse(input);
  if (!parsed.success) throw new ProfessorHandoffRefused("INVALID_INPUT");
  const request = parsed.data;
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "request_professor_academic_handoff",
    {
      p_class_session_id: request.classSessionId,
      p_reason_code: request.reasonCode,
      p_objective_id:
        request.reasonCode === "OBJECTIVE_REINFORCEMENT"
          ? request.objectiveId
          : null,
      p_practical_id:
        request.reasonCode === "PRACTICAL_HELP" ? request.practicalId : null,
    },
  );
  if (error) throw new ProfessorHandoffRefused("SERVICE_UNAVAILABLE");
  const result = professorHandoffCreateResultSchema.safeParse(data);
  if (!result.success) throw new ProfessorHandoffRefused("SERVICE_UNAVAILABLE");
  if (!result.data.ok) throw new ProfessorHandoffRefused(result.data.code);
  return { handoffId: result.data.handoffId, duplicate: result.data.duplicate };
}

// The learner's own Professor follow-ups for one classroom, or null when the
// read is refused (for example during a controlled assessment).
export async function listMyProfessorAcademicHandoffs(
  classSessionId: string,
): Promise<LearnerProfessorHandoff[] | null> {
  await requireStudentPrincipal();
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "list_my_professor_academic_handoffs",
    { p_class_session_id: z.uuid().parse(classSessionId) },
  );
  if (error) return null;
  const parsed = learnerProfessorHandoffListSchema.safeParse(data);
  if (!parsed.success || !parsed.data.ok) return null;
  return parsed.data.handoffs;
}

export class ProfessorTeachingRecordUnavailable extends Error {
  constructor() {
    super("Professor teaching record is unavailable.");
    this.name = "ProfessorTeachingRecordUnavailable";
  }
}

// The projection for the learner's own ACTIVE Tutor/Lab content release:
// null when that delivery handoff did not come from a Professor classroom.
// Any refusal or malformed result throws, and the caller fails closed.
export async function getProfessorTeachingRecordForRelease(
  releaseId: string,
): Promise<ProfessorTeachingRecord | null> {
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "get_professor_academic_handoff_for_release",
    { p_release_id: z.uuid().parse(releaseId) },
  );
  if (error) throw new ProfessorTeachingRecordUnavailable();
  const parsed = professorTeachingRecordReadSchema.safeParse(data);
  if (!parsed.success || !parsed.data.ok)
    throw new ProfessorTeachingRecordUnavailable();
  return parsed.data.available ? parsed.data.record : null;
}
