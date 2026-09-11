import "server-only";
import { z } from "zod";
import { requireActor, requireStudentPrincipal } from "./identity";
import { createSupabase } from "./supabase";
import {
  AcademicContextUnavailable,
  enrolmentContextInputSchema,
  learnerContextSchema,
} from "@/domain/learning-context";
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

// A narrow Academy OS read, explicitly self-scoped even when RLS permits more.
// Keep historical enrolment statuses/version relationships; do not filter by publication.
export async function getOwnedStudentEnrolment(input: unknown) {
  const { enrolmentId } = enrolmentContextInputSchema.parse(input);
  const actor = await requireStudentPrincipal();
  const client = await createSupabase();
  const { data, error } = await client
    .from("enrolments")
    .select(
      "id,student_id,cohort_id,status,programme_version_id,cohort_title_snapshot,cohort_starts_on_snapshot,programme_versions(label,title_snapshot)",
    )
    .eq("id", enrolmentId)
    .eq("student_id", actor.id)
    .maybeSingle();
  if (error) throw new Error("Learner context could not be loaded.");
  if (!data) throw new AcademicContextUnavailable();
  const row = z
    .object({
      id: z.uuid(),
      student_id: z.uuid(),
      cohort_id: z.uuid(),
      status: learnerContextSchema.shape.enrolmentStatus,
      programme_version_id: z.uuid(),
      cohort_title_snapshot: z.string(),
      cohort_starts_on_snapshot: z.string(),
      programme_versions: z.object({
        label: z.string(),
        title_snapshot: z.string(),
      }),
    })
    .parse(data);
  if (row.id !== enrolmentId || row.student_id !== actor.id)
    throw new AcademicContextUnavailable();
  return learnerContextSchema.parse({
    enrolmentId: row.id,
    programmeVersionId: row.programme_version_id,
    cohortId: row.cohort_id,
    enrolmentStatus: row.status,
    programmeTitle: row.programme_versions.title_snapshot,
    programmeVersionLabel: row.programme_versions.label,
    cohortTitle: row.cohort_title_snapshot,
    cohortStartsOn: row.cohort_starts_on_snapshot,
  });
}
