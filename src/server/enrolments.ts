import "server-only";
import { z } from "zod";
import {
  enrolmentCreationSchema,
  enrolmentStatusSchema,
} from "@/domain/academy";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

const learnerSchema = z.object({
  user_id: z.uuid(),
  student_number: z.string(),
  app_users: z.object({ display_name: z.string() }),
});

const cohortSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  starts_on: z.string(),
  programme_version_id: z.uuid(),
  programme_versions: z.object({
    label: z.string(),
    status: z.enum(["DRAFT", "PUBLISHED"]),
    title_snapshot: z.string().nullable(),
  }),
});

const enrolmentSchema = z.object({
  id: z.uuid(),
  student_id: z.uuid(),
  cohort_id: z.uuid(),
  programme_version_id: z.uuid(),
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "WITHDRAWN"]),
  enrolled_at: z.string(),
  cohort_title_snapshot: z.string(),
  cohort_starts_on_snapshot: z.string(),
  app_users: z.object({ display_name: z.string() }),
  programme_versions: z.object({
    label: z.string(),
    title_snapshot: z.string().nullable(),
  }),
});

export async function getEnrolmentWorkspace() {
  await requireActor("admin");
  const client = await createSupabase();

  const [learners, cohorts, enrolments] = await Promise.all([
    client
      .from("student_profiles")
      .select("user_id,student_number,app_users(display_name)")
      .order("student_number")
      .limit(200),
    client
      .from("cohorts")
      .select(
        "id,title,starts_on,programme_version_id,programme_versions(label,status,title_snapshot)",
      )
      .order("starts_on", { ascending: false })
      .limit(200),
    client
      .from("enrolments")
      .select(
        "id,student_id,cohort_id,programme_version_id,status,enrolled_at,cohort_title_snapshot,cohort_starts_on_snapshot,app_users:student_profiles!enrolments_student_id_fkey(app_users(display_name)),programme_versions(label,title_snapshot)",
      )
      .order("enrolled_at", { ascending: false })
      .limit(200),
  ]);

  if (learners.error || cohorts.error || enrolments.error)
    throw new Error("Enrolment workspace could not be loaded.");

  const parsedEnrolments = z
    .array(
      enrolmentSchema.extend({
        app_users: z.object({ app_users: z.object({ display_name: z.string() }) }),
      }),
    )
    .parse(enrolments.data)
    .map((row) => ({
      ...row,
      app_users: row.app_users.app_users,
    }));

  return {
    learners: z.array(learnerSchema).parse(learners.data),
    cohorts: z.array(cohortSchema).parse(cohorts.data),
    enrolments: parsedEnrolments,
  };
}

export async function createEnrolment(input: unknown) {
  const payload = enrolmentCreationSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("create_enrolment", {
    p_student_id: payload.studentId,
    p_cohort_id: payload.cohortId,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Enrolment could not be created.");
  return z.uuid().parse(data);
}

export async function changeEnrolmentStatus(input: unknown) {
  const payload = enrolmentStatusSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("change_enrolment_status", {
    p_enrolment_id: payload.enrolmentId,
    p_status: payload.status,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Enrolment status could not be changed.");
  return z.uuid().parse(data);
}
