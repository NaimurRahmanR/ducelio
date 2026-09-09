import "server-only";
import { z } from "zod";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

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
  student_profiles: z.object({
    student_number: z.string(),
    app_users: z.object({ display_name: z.string() }),
  }),
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
        "id,enrolment_id,student_id,objective_id,lesson_id,programme_version_id,state,evidence_count,correct_evidence_count,correct_session_count,correct_kind_count,policy_version,evaluated_at,lesson_objectives(description,position),lessons(title),student_profiles!objective_mastery_student_id_fkey(student_number,app_users(display_name))",
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

  return {
    mastery: z.array(adminMasterySchema).parse(mastery.data),
    history: z.array(historySchema).parse(history.data),
  };
}

export async function getStudentObjectiveMastery() {
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client
    .from("objective_mastery")
    .select(
      "id,objective_id,lesson_id,state,evidence_count,correct_evidence_count,correct_session_count,correct_kind_count,policy_version,evaluated_at,lesson_objectives(description,position),lessons(title)",
    )
    .order("evaluated_at", { ascending: false })
    .limit(500);

  if (error) throw new Error("Your objective mastery could not be loaded.");

  return z
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
        }),
        lessons: z.object({ title: z.string() }),
      }),
    )
    .parse(data);
}
