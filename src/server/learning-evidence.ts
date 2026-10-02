import "server-only";
import { z } from "zod";
import { learningEvidenceSchema } from "@/domain/academy";
import {
  requireActor,
  requireAnyRole,
  requireStudentPrincipal,
} from "./identity";
import { createSupabase } from "./supabase";
import { getOwnedStudentEnrolment } from "./academy";
import { assertStudentExplanationAllowed } from "./academic-activity";
import { AcademicContextUnavailable } from "@/domain/learning-context";
import {
  academicTimestampSchema,
  HISTORY_PAGE_SIZE,
  learningHistoryInputSchema,
  learningHistoryPageSchema,
} from "@/domain/academic-reads";

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
  await requireAnyRole(["INSTRUCTOR", "ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
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
  const { data, error } = await client.rpc(
    "get_student_retained_learning_history",
    { p_kind: "evidence" },
  );

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
    .max(500)
    .parse(data);
}

export async function getStudentPermittedLearningHistory(input: unknown) {
  const payload = learningHistoryInputSchema.parse(input);
  await assertStudentExplanationAllowed();
  const actor = await requireStudentPrincipal();
  const enrolment = await getOwnedStudentEnrolment({
    enrolmentId: payload.enrolmentId,
  });
  const client = await createSupabase();
  if (payload.objectiveId) {
    const { data, error } = await client
      .from("lesson_objectives")
      .select("id,programme_version_id")
      .eq("id", payload.objectiveId)
      .eq("programme_version_id", enrolment.programmeVersionId)
      .maybeSingle();
    if (error)
      throw new Error("Learning history objective could not be loaded.");
    if (!data) throw new AcademicContextUnavailable();
    const objective = z
      .object({ id: z.uuid(), programme_version_id: z.uuid() })
      .parse(data);
    if (
      objective.id !== payload.objectiveId ||
      objective.programme_version_id !== enrolment.programmeVersionId
    )
      throw new AcademicContextUnavailable();
  }
  // Deliberately never select evidence_reference, recorder, idempotency key or prose.
  let query = client
    .from("learning_evidence")
    .select(
      "id,enrolment_id,student_id,programme_version_id,lesson_id,objective_id,session_id,evidence_kind,result,recorded_at,lesson_objectives!inner(id,lesson_id,programme_version_id)",
    )
    .eq("enrolment_id", enrolment.enrolmentId)
    .eq("student_id", actor.id)
    .eq("programme_version_id", enrolment.programmeVersionId);
  if (payload.objectiveId)
    query = query.eq("objective_id", payload.objectiveId);
  if (payload.cursor) {
    // Only strict ISO timestamps and UUIDs enter this PostgREST filter expression.
    const { beforeRecordedAt, beforeId } = payload.cursor;
    query = query.or(
      `recorded_at.lt.${beforeRecordedAt},and(recorded_at.eq.${beforeRecordedAt},id.lt.${beforeId})`,
    );
  }
  const { data, error } = await query
    .order("recorded_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(HISTORY_PAGE_SIZE + 1);
  if (error) throw new Error("Learning history could not be loaded.");
  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        enrolment_id: z.uuid(),
        student_id: z.uuid(),
        programme_version_id: z.uuid(),
        lesson_id: z.uuid(),
        objective_id: z.uuid(),
        session_id: z.uuid(),
        evidence_kind: evidenceSchema.shape.evidence_kind,
        result: evidenceSchema.shape.result,
        recorded_at: academicTimestampSchema,
        lesson_objectives: z.object({
          id: z.uuid(),
          lesson_id: z.uuid(),
          programme_version_id: z.uuid(),
        }),
      }),
    )
    .max(HISTORY_PAGE_SIZE + 1)
    .parse(data);
  for (const row of rows) {
    if (
      row.enrolment_id !== enrolment.enrolmentId ||
      row.student_id !== actor.id ||
      row.programme_version_id !== enrolment.programmeVersionId ||
      (payload.objectiveId && row.objective_id !== payload.objectiveId) ||
      row.lesson_objectives.id !== row.objective_id ||
      row.lesson_objectives.lesson_id !== row.lesson_id ||
      row.lesson_objectives.programme_version_id !==
        enrolment.programmeVersionId
    )
      throw new AcademicContextUnavailable();
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error("Invalid evidence projection.");
  const page = rows.slice(0, HISTORY_PAGE_SIZE);
  const last = page[page.length - 1];
  const result = learningHistoryPageSchema.parse({
    enrolmentId: enrolment.enrolmentId,
    programmeVersionId: enrolment.programmeVersionId,
    objectiveId: payload.objectiveId ?? null,
    events: page.map((row) => ({
      evidenceId: row.id,
      objectiveId: row.objective_id,
      sessionId: row.session_id,
      evidenceKind: row.evidence_kind,
      result: row.result,
      recordedAt: row.recorded_at,
    })),
    nextCursor:
      rows.length > HISTORY_PAGE_SIZE
        ? { beforeRecordedAt: last.recorded_at, beforeId: last.id }
        : null,
  });
  await assertStudentExplanationAllowed();
  return result;
}
