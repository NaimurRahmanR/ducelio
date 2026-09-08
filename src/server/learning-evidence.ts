import "server-only";
import { z } from "zod";
import { learningEvidenceSchema } from "@/domain/academy";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

const sessionSchema = z.object({
  id: z.uuid(),
  cohort_id: z.uuid(),
  lesson_id: z.uuid(),
  programme_version_id: z.uuid(),
  scheduled_start: z.string(),
  status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED"]),
  lessons: z.object({ title: z.string() }),
  cohorts: z.object({ title: z.string() }),
});

const enrolmentSchema = z.object({
  id: z.uuid(),
  student_id: z.uuid(),
  cohort_id: z.uuid(),
  programme_version_id: z.uuid(),
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "WITHDRAWN"]),
  student_profiles: z.object({
    student_number: z.string(),
    app_users: z.object({ display_name: z.string() }),
  }),
});

const objectiveSchema = z.object({
  id: z.uuid(),
  lesson_id: z.uuid(),
  programme_version_id: z.uuid(),
  description: z.string(),
  position: z.number(),
  lessons: z.object({ title: z.string() }),
});

const evidenceSchema = z.object({
  id: z.uuid(),
  enrolment_id: z.uuid(),
  student_id: z.uuid(),
  objective_id: z.uuid(),
  lesson_id: z.uuid(),
  session_id: z.uuid(),
  evidence_kind: z.enum([
    "CLASS_RESPONSE",
    "RETRIEVAL_CHECK",
    "PRACTICAL_TASK",
    "DEBUGGING_TASK",
  ]),
  result: z.enum(["CORRECT", "PARTIAL", "INCORRECT"]),
  evidence_reference: z.string(),
  idempotency_key: z.string(),
  recorded_at: z.string(),
});

export async function getLearningEvidenceWorkspace() {
  await requireActor("admin");
  const client = await createSupabase();

  const [sessions, enrolments, objectives, evidence] = await Promise.all([
    client
      .from("class_sessions")
      .select(
        "id,cohort_id,lesson_id,programme_version_id,scheduled_start,status,lessons(title),cohorts(title)",
      )
      .order("scheduled_start", { ascending: false })
      .limit(200),
    client
      .from("enrolments")
      .select(
        "id,student_id,cohort_id,programme_version_id,status,student_profiles!enrolments_student_id_fkey(student_number,app_users(display_name))",
      )
      .order("enrolled_at", { ascending: false })
      .limit(500),
    client
      .from("lesson_objectives")
      .select(
        "id,lesson_id,programme_version_id,description,position,lessons(title)",
      )
      .order("lesson_id")
      .order("position")
      .limit(1000),
    client
      .from("learning_evidence")
      .select(
        "id,enrolment_id,student_id,objective_id,lesson_id,session_id,evidence_kind,result,evidence_reference,idempotency_key,recorded_at",
      )
      .order("recorded_at", { ascending: false })
      .limit(1000),
  ]);

  if (sessions.error || enrolments.error || objectives.error || evidence.error)
    throw new Error("Learning evidence workspace could not be loaded.");

  return {
    sessions: z.array(sessionSchema).parse(sessions.data),
    enrolments: z
      .array(enrolmentSchema)
      .parse(enrolments.data)
      .map((row) => ({
        id: row.id,
        student_id: row.student_id,
        cohort_id: row.cohort_id,
        programme_version_id: row.programme_version_id,
        status: row.status,
        student_number: row.student_profiles.student_number,
        display_name: row.student_profiles.app_users.display_name,
      })),
    objectives: z.array(objectiveSchema).parse(objectives.data),
    evidence: z.array(evidenceSchema).parse(evidence.data),
  };
}

export async function recordLearningEvidence(input: unknown) {
  const payload = learningEvidenceSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("record_learning_evidence", {
    p_session_id: payload.sessionId,
    p_enrolment_id: payload.enrolmentId,
    p_objective_id: payload.objectiveId,
    p_evidence_kind: payload.evidenceKind,
    p_result: payload.result,
    p_evidence_reference: payload.evidenceReference,
    p_idempotency_key: payload.idempotencyKey,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Learning evidence could not be recorded.");
  return z.uuid().parse(data);
}

export async function getStudentLearningEvidence() {
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client
    .from("learning_evidence")
    .select(
      "id,objective_id,evidence_kind,result,evidence_reference,recorded_at,lesson_objectives(description,position),lessons(title)",
    )
    .order("recorded_at", { ascending: false })
    .limit(500);

  if (error) throw new Error("Your learning evidence could not be loaded.");

  return z
    .array(
      z.object({
        id: z.uuid(),
        objective_id: z.uuid(),
        evidence_kind: z.enum([
          "CLASS_RESPONSE",
          "RETRIEVAL_CHECK",
          "PRACTICAL_TASK",
          "DEBUGGING_TASK",
        ]),
        result: z.enum(["CORRECT", "PARTIAL", "INCORRECT"]),
        evidence_reference: z.string(),
        recorded_at: z.string(),
        lesson_objectives: z.object({
          description: z.string(),
          position: z.number(),
        }),
        lessons: z.object({ title: z.string() }),
      }),
    )
    .parse(data);
}
