import "server-only";
import { z } from "zod";
import {
  enrolmentCreationSchema,
  enrolmentStatusSchema,
} from "@/domain/academy";
import { requireActor, requireAnyRole } from "./identity";
import { createSupabase } from "./supabase";

const learnerSchema = z.object({
  user_id: z.uuid(),
  student_number: z.string(),
});
const userSchema = z.object({ id: z.uuid(), display_name: z.string() });
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
  programme_versions: z.object({
    label: z.string(),
    title_snapshot: z.string().nullable(),
  }),
});

export async function getEnrolmentWorkspace() {
  await requireActor("admin");
  const client = await createSupabase();

  const [learnersResult, cohortsResult, enrolmentsResult] = await Promise.all([
    client
      .from("student_profiles")
      .select("user_id,student_number")
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
        "id,student_id,cohort_id,programme_version_id,status,enrolled_at,cohort_title_snapshot,cohort_starts_on_snapshot,programme_versions(label,title_snapshot)",
      )
      .order("enrolled_at", { ascending: false })
      .limit(200),
  ]);

  if (learnersResult.error || cohortsResult.error || enrolmentsResult.error)
    throw new Error("Enrolment workspace could not be loaded.");

  const learners = z.array(learnerSchema).parse(learnersResult.data);
  const enrolments = z.array(enrolmentSchema).parse(enrolmentsResult.data);
  const ids = [
    ...new Set([
      ...learners.map((learner) => learner.user_id),
      ...enrolments.map((enrolment) => enrolment.student_id),
    ]),
  ];
  const usersResult = ids.length
    ? await client.from("app_users").select("id,display_name").in("id", ids)
    : { data: [], error: null };
  if (usersResult.error)
    throw new Error("Learner identities could not be loaded.");
  const users = z.array(userSchema).parse(usersResult.data);
  const names = new Map(users.map((user) => [user.id, user.display_name]));

  return {
    learners: learners.map((learner) => ({
      ...learner,
      display_name: names.get(learner.user_id) ?? "Learner",
    })),
    cohorts: z.array(cohortSchema).parse(cohortsResult.data),
    enrolments: enrolments.map((enrolment) => ({
      ...enrolment,
      display_name: names.get(enrolment.student_id) ?? "Learner",
    })),
  };
}

export async function createEnrolment(input: unknown) {
  const payload = enrolmentCreationSchema.parse(input);
  await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
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
  await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const client = await createSupabase();
  const { data, error } = await client.rpc("change_enrolment_status", {
    p_enrolment_id: payload.enrolmentId,
    p_status: payload.status,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Enrolment status could not be changed.");
  return z.uuid().parse(data);
}
