import "server-only";
import { z } from "zod";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";
import { assignCounsellor } from "./support";

const learnerSchema = z.object({
  user_id: z.uuid(),
  student_number: z.string(),
  app_users: z.object({ display_name: z.string() }),
});

const counsellorSchema = z.object({
  user_id: z.uuid(),
  display_name: z.string(),
  title: z.string(),
});

const assignmentSchema = z.object({
  id: z.uuid(),
  student_id: z.uuid(),
  counsellor_id: z.uuid(),
  starts_at: z.string(),
  ended_at: z.string().nullable(),
  student_profiles: z.object({
    student_number: z.string(),
    app_users: z.object({ display_name: z.string() }),
  }),
  staff_profiles: z.object({
    title: z.string(),
    app_users: z.object({ display_name: z.string() }),
  }),
});

export async function getCounsellorAssignmentWorkspace() {
  await requireActor("admin");
  const client = await createSupabase();

  const [learners, counsellors, assignments] = await Promise.all([
    client
      .from("student_profiles")
      .select("user_id,student_number,app_users(display_name)")
      .order("student_number")
      .limit(200),
    client.rpc("list_assignable_counsellors"),
    client
      .from("counsellor_assignments")
      .select(
        "id,student_id,counsellor_id,starts_at,ended_at,student_profiles!counsellor_assignments_student_id_fkey(student_number,app_users(display_name)),staff_profiles!counsellor_assignments_counsellor_id_fkey(title,app_users(display_name))",
      )
      .order("starts_at", { ascending: false })
      .limit(300),
  ]);

  if (learners.error || counsellors.error || assignments.error)
    throw new Error("Counsellor assignment workspace could not be loaded.");

  return {
    learners: z.array(learnerSchema).parse(learners.data),
    counsellors: z.array(counsellorSchema).parse(counsellors.data),
    assignments: z.array(assignmentSchema).parse(assignments.data),
  };
}

export async function reassignCounsellor(input: unknown) {
  return assignCounsellor(input);
}
