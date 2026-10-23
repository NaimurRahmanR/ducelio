import "server-only";
import { z } from "zod";
import { requireActor, getAuthenticatedActor } from "./identity";
import { createSupabase } from "./supabase";
import { AcademyError } from "@/domain/academy-delivery";

export const DUCELIO_ORGANISATION = "00000000-0000-4000-8000-000000000001";
const organisation = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  canManage: z.boolean(),
  canReview: z.boolean(),
  canOwn: z.boolean(),
});
export type CourseOrganisation = z.infer<typeof organisation>;
export async function listMyCourseOrganisations() {
  if (!(await getAuthenticatedActor())) throw new AcademyError("FORBIDDEN");
  const { data, error } = await (
    await createSupabase()
  ).rpc("list_my_course_organisations");
  if (error) throw new AcademyError("SERVICE_UNAVAILABLE");
  return z.array(organisation).parse(data);
}
export async function courseEngineeringAccess() {
  const actor = await requireActor();
  const organisations = await listMyCourseOrganisations().catch(() => []);
  return {
    actor,
    organisations,
    allowed:
      organisations.length > 0 ||
      actor.roles.some((r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN"),
  };
}
export async function setCourseOrganisationMember(input: unknown) {
  if (!(await getAuthenticatedActor())) throw new AcademyError("FORBIDDEN");
  const p = z
    .strictObject({
      organisationId: z.uuid(),
      userId: z.uuid(),
      role: z.enum(["OWNER", "COURSE_MANAGER", "ACADEMIC_REVIEWER"]),
      active: z.boolean(),
      reason: z.string().trim().min(5).max(300),
    })
    .parse(input);
  const { data, error } = await (
    await createSupabase()
  ).rpc("set_course_organisation_member", {
    p_organisation_id: p.organisationId,
    p_user_id: p.userId,
    p_role: p.role,
    p_active: p.active,
    p_reason: p.reason,
  });
  if (error)
    throw new Error(
      error.message === "LAST_OWNER" ? "LAST_OWNER" : "MEMBERSHIP_REFUSED",
    );
  return z.uuid().parse(data);
}
