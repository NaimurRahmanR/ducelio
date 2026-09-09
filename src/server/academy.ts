import "server-only";
import { z } from "zod";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";
const enrolmentSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  programme_version_id: z.uuid(),
  cohort_title_snapshot: z.string(),
  cohort_starts_on_snapshot: z.string(),
  programme_versions: z.object({
    label: z.string(),
    title_snapshot: z.string(),
    examination_body_snapshot: z.string(),
    is_demo: z.boolean(),
  }),
});
export async function getStudentAcademy() {
  const actor = await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client
    .from("enrolments")
    .select(
      "id,status,programme_version_id,cohort_title_snapshot,cohort_starts_on_snapshot,programme_versions(label,title_snapshot,examination_body_snapshot,is_demo)",
    )
    .eq("student_id", actor.id)
    .order("enrolled_at", { ascending: false });
  if (error) throw new Error("Your enrolment records could not be loaded.");
  const profile = await client
    .from("student_profiles")
    .select("student_number,timezone")
    .eq("user_id", actor.id)
    .single();
  if (profile.error)
    throw new Error("Your student profile could not be loaded.");
  return {
    actor,
    enrolments: z.array(enrolmentSchema).parse(data),
    profile: z
      .object({ student_number: z.string(), timezone: z.string() })
      .parse(profile.data),
  };
}
