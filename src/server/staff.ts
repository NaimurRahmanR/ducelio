import "server-only";
import { z } from "zod";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";
export async function getCounsellorCaseload() {
  const actor = await requireActor("support");
  const client = await createSupabase();
  const { data, error } = await client
    .from("counsellor_assignments")
    .select("student_id,starts_at")
    .eq("counsellor_id", actor.id)
    .is("ended_at", null)
    .lte("starts_at", new Date().toISOString())
    .order("starts_at")
    .limit(100);
  if (error) throw new Error("Your learner assignments could not be loaded.");
  const assignments = z
    .array(z.object({ student_id: z.uuid(), starts_at: z.string() }))
    .parse(data);
  if (!assignments.length) return { actor, learners: [] };
  const users = await client
    .from("app_users")
    .select("id,display_name")
    .in(
      "id",
      assignments.map((a) => a.student_id),
    );
  if (users.error) throw new Error("Your learner list could not be loaded.");
  return {
    actor,
    learners: z
      .array(z.object({ id: z.uuid(), display_name: z.string() }))
      .parse(users.data),
  };
}
export async function getAdminOverview() {
  const actor = await requireActor("admin");
  const client = await createSupabase();
  const counts = await Promise.all(
    ["programmes", "student_profiles", "cohorts", "staff_profiles"].map(
      (table) => client.from(table).select("*", { count: "exact", head: true }),
    ),
  );
  if (counts.some((c) => c.error))
    throw new Error("Academy overview could not be loaded.");
  const programmes = await client
    .from("programmes")
    .select("id,title,examination_body,is_demo")
    .order("title")
    .limit(50);
  if (programmes.error) throw new Error("Programmes could not be loaded.");
  const audit = actor.roles.includes("PLATFORM_ADMIN")
    ? await client
        .from("audit_events")
        .select("id,action,target_type,occurred_at,source")
        .order("occurred_at", { ascending: false })
        .limit(25)
    : null;
  if (audit?.error) throw new Error("Audit history could not be loaded.");
  return {
    actor,
    counts: counts.map((c) => c.count ?? 0),
    programmes: z
      .array(
        z.object({
          id: z.uuid(),
          title: z.string(),
          examination_body: z.string(),
          is_demo: z.boolean(),
        }),
      )
      .parse(programmes.data),
    audit: z
      .array(
        z.object({
          id: z.uuid(),
          action: z.string(),
          target_type: z.string(),
          occurred_at: z.string(),
          source: z.string(),
        }),
      )
      .parse(audit?.data ?? []),
  };
}
