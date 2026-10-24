"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAuthenticatedActor } from "@/server/identity";
import { createSupabase } from "@/server/supabase";
export async function createCourseOrganisation(
  _state: { error?: string; message?: string },
  form: FormData,
): Promise<{ error?: string; message?: string }> {
  try {
    const actor = await getAuthenticatedActor();
    if (!actor?.roles.includes("PLATFORM_ADMIN")) throw new Error("FORBIDDEN");
    const p = z
      .object({
        slug: z
          .string()
          .min(3)
          .max(60)
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
        name: z.string().trim().min(3).max(150),
        email: z.email().max(254),
        reason: z.string().trim().min(5).max(300),
      })
      .parse({
        slug: form.get("slug"),
        name: form.get("name"),
        email: form.get("email"),
        reason: form.get("reason"),
      });
    const { error } = await (
      await createSupabase()
    ).rpc("create_course_organisation_by_email", {
      p_slug: p.slug,
      p_name: p.name,
      p_owner_email: p.email,
      p_reason: p.reason,
    });
    if (error) throw new Error("REFUSED");
    revalidatePath("/admin/course-engineering");
    return {
      message:
        "Organisation created. Its owner can manage courses in this same workspace.",
    };
  } catch {
    return {
      error:
        "Creation was refused. Check platform authority, a unique address and the owner's verified account email.",
    };
  }
}
export async function changeOrganisationMember(
  _state: { error?: string; message?: string },
  form: FormData,
): Promise<{ error?: string; message?: string }> {
  try {
    if (!(await getAuthenticatedActor())) throw new Error("FORBIDDEN");
    const p = z
      .object({
        org: z.uuid(),
        email: z.email().max(254),
        role: z.enum(["OWNER", "COURSE_MANAGER", "ACADEMIC_REVIEWER"]),
        active: z.enum(["true", "false"]),
        reason: z.string().trim().min(5).max(300),
      })
      .parse({
        org: form.get("organisationId"),
        email: form.get("email"),
        role: form.get("role"),
        active: form.get("active"),
        reason: form.get("reason"),
      });
    const { error } = await (
      await createSupabase()
    ).rpc("set_course_organisation_member_by_email", {
      p_organisation_id: p.org,
      p_email: p.email,
      p_role: p.role,
      p_active: p.active === "true",
      p_reason: p.reason,
    });
    if (error) throw new Error(error.message);
    revalidatePath("/admin/course-engineering");
    return {
      message: "Membership updated. Authority is checked on every operation.",
    };
  } catch (e) {
    return {
      error:
        e instanceof Error && e.message === "LAST_OWNER"
          ? "An active organisation owner must remain."
          : "Membership was refused. Check ownership and the verified account email.",
    };
  }
}
