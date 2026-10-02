import "server-only";
import { z } from "zod";
import { requireActor, requireStudentPrincipal } from "./identity";
import { createSupabase } from "./supabase";
import { getStudentLessonContext } from "./learning-context";
import { assertStudentExplanationAllowed } from "./academic-activity";
import {
  AcademicContextUnavailable,
  lessonContextInputSchema,
} from "@/domain/learning-context";
import {
  academicTimestampSchema,
  currentMasterySchema,
  MASTERY_ROW_LIMIT,
} from "@/domain/academic-reads";

const masteryStateSchema = z.enum([
  "NOT_STARTED",
  "DEVELOPING",
  "DEMONSTRATED",
  "NEEDS_REINFORCEMENT",
]);

const adminMasterySchema = z.object({
  id: z.uuid(),
  enrolment_id: z.uuid(),
  student_id: z.uuid(),
  objective_id: z.uuid(),
  lesson_id: z.uuid(),
  programme_version_id: z.uuid(),
  state: masteryStateSchema,
  evidence_count: z.number(),
  correct_evidence_count: z.number(),
  correct_session_count: z.number(),
  correct_kind_count: z.number(),
  policy_version: z.string(),
  evaluated_at: z.string(),
  lesson_objectives: z.object({
    description: z.string(),
    position: z.number(),
  }),
  lessons: z.object({ title: z.string() }),
});

const historySchema = z.object({
  id: z.uuid(),
  mastery_id: z.uuid(),
  from_state: masteryStateSchema,
  to_state: masteryStateSchema,
  trigger_evidence_id: z.uuid(),
  evidence_count: z.number(),
  correct_evidence_count: z.number(),
  correct_session_count: z.number(),
  correct_kind_count: z.number(),
  policy_version: z.string(),
  changed_at: z.string(),
});

export async function getObjectiveMasteryWorkspace() {
  await requireActor("admin");
  const client = await createSupabase();

  const [mastery, history] = await Promise.all([
    client
      .from("objective_mastery")
      .select(
        "id,enrolment_id,student_id,objective_id,lesson_id,programme_version_id,state,evidence_count,correct_evidence_count,correct_session_count,correct_kind_count,policy_version,evaluated_at,lesson_objectives(description,position,lessons(title))",
      )
      .order("evaluated_at", { ascending: false })
      .limit(1000),
    client
      .from("objective_mastery_history")
      .select(
        "id,mastery_id,from_state,to_state,trigger_evidence_id,evidence_count,correct_evidence_count,correct_session_count,correct_kind_count,policy_version,changed_at",
      )
      .order("changed_at", { ascending: false })
      .limit(1000),
  ]);

  if (mastery.error || history.error)
    throw new Error("Objective mastery workspace could not be loaded.");

  // objective_mastery has no foreign key to lessons; it reaches the lesson
  // through lesson_objectives, so the lesson title is embedded there and
  // lifted back out to keep the workspace shape.
  const masteryRows = z
    .array(
      adminMasterySchema.omit({ lessons: true }).extend({
        lesson_objectives: adminMasterySchema.shape.lesson_objectives.extend({
          lessons: adminMasterySchema.shape.lessons,
        }),
      }),
    )
    .parse(mastery.data);

  return {
    mastery: masteryRows.map(
      ({ lesson_objectives: { lessons, ...objective }, ...row }) => ({
        ...row,
        lesson_objectives: objective,
        lessons,
      }),
    ),
    history: z.array(historySchema).parse(history.data),
  };
}

export async function getStudentObjectiveMastery() {
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "get_student_retained_learning_history",
    { p_kind: "mastery" },
  );

  if (error) throw new Error("Your objective mastery could not be loaded.");

  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        objective_id: z.uuid(),
        lesson_id: z.uuid(),
        state: masteryStateSchema,
        evidence_count: z.number(),
        correct_evidence_count: z.number(),
        correct_session_count: z.number(),
        correct_kind_count: z.number(),
        policy_version: z.string(),
        evaluated_at: z.string(),
        lesson_objectives: z.object({
          description: z.string(),
          position: z.number(),
          lessons: z.object({ title: z.string() }),
        }),
      }),
    )
    .max(500)
    .parse(data);

  return rows.map(({ lesson_objectives, ...row }) => ({
    ...row,
    lesson_objectives: {
      description: lesson_objectives.description,
      position: lesson_objectives.position,
    },
    lessons: lesson_objectives.lessons,
  }));
}

export async function getStudentLessonMastery(input: unknown) {
  const payload = lessonContextInputSchema.parse(input);
  await assertStudentExplanationAllowed();
  const actor = await requireStudentPrincipal();
  const lesson = await getStudentLessonContext(payload);
  const client = await createSupabase();
  const { data, error } = await client
    .from("objective_mastery")
    .select(
      "enrolment_id,student_id,programme_version_id,lesson_id,objective_id,state,policy_version,evaluated_at,evidence_count,correct_evidence_count,correct_session_count,correct_kind_count,lesson_objectives!inner(id,lesson_id,programme_version_id)",
    )
    .eq("enrolment_id", lesson.enrolmentId)
    .eq("student_id", actor.id)
    .eq("programme_version_id", lesson.programmeVersionId)
    .eq("lesson_id", lesson.lessonId)
    .order("objective_id")
    .limit(MASTERY_ROW_LIMIT + 1);
  if (error) throw new Error("Lesson mastery could not be loaded.");
  // A non-paginated contract must fail on overflow rather than imply completeness.
  const rows = z
    .array(
      z.object({
        enrolment_id: z.uuid(),
        student_id: z.uuid(),
        programme_version_id: z.uuid(),
        lesson_id: z.uuid(),
        objective_id: z.uuid(),
        state: masteryStateSchema,
        policy_version: z.string(),
        evaluated_at: academicTimestampSchema,
        evidence_count: z.number(),
        correct_evidence_count: z.number(),
        correct_session_count: z.number(),
        correct_kind_count: z.number(),
        lesson_objectives: z.object({
          id: z.uuid(),
          lesson_id: z.uuid(),
          programme_version_id: z.uuid(),
        }),
      }),
    )
    .max(MASTERY_ROW_LIMIT)
    .parse(data);
  for (const row of rows) {
    if (
      row.enrolment_id !== lesson.enrolmentId ||
      row.student_id !== actor.id ||
      row.programme_version_id !== lesson.programmeVersionId ||
      row.lesson_id !== lesson.lessonId ||
      row.lesson_objectives.id !== row.objective_id ||
      row.lesson_objectives.lesson_id !== lesson.lessonId ||
      row.lesson_objectives.programme_version_id !== lesson.programmeVersionId
    )
      throw new AcademicContextUnavailable();
  }
  if (new Set(rows.map((row) => row.objective_id)).size !== rows.length)
    throw new Error("Invalid mastery projection.");
  const result = currentMasterySchema.parse({
    enrolmentId: lesson.enrolmentId,
    programmeVersionId: lesson.programmeVersionId,
    lessonId: lesson.lessonId,
    persistedOnly: true,
    records: rows.map((row) => ({
      objectiveId: row.objective_id,
      state: row.state,
      policyVersion: row.policy_version,
      evaluatedAt: row.evaluated_at,
      evidenceCount: row.evidence_count,
      correctEvidenceCount: row.correct_evidence_count,
      correctSessionCount: row.correct_session_count,
      correctKindCount: row.correct_kind_count,
    })),
  });
  await assertStudentExplanationAllowed();
  return result;
}
