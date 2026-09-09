import "server-only";
import { z } from "zod";
import { programmePublicationSchema } from "@/domain/academy";
import { AccessDenied } from "@/domain/policy";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

const programmeVersionSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  status: z.enum(["DRAFT", "PUBLISHED"]),
  is_demo: z.boolean(),
  published_at: z.string().nullable(),
  programmes: z.object({
    title: z.string(),
    examination_body: z.string(),
  }),
});

export async function getProgrammeVersions() {
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client
    .from("programme_versions")
    .select(
      "id,label,status,is_demo,published_at,programmes(title,examination_body)",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error("Programme versions could not be loaded.");
  return z.array(programmeVersionSchema).parse(data);
}

export async function publishProgrammeVersion(input: unknown) {
  const payload = programmePublicationSchema.parse(input);
  const actor = await requireActor("admin");
  if (
    !actor.roles.some(
      (role) => role === "ACADEMIC_ADMIN" || role === "PLATFORM_ADMIN",
    )
  ) {
    throw new AccessDenied();
  }
  const client = await createSupabase();
  const { data, error } = await client.rpc("publish_programme_version", {
    p_version_id: payload.programmeVersionId,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Programme version could not be published.");
  return z.uuid().parse(data);
}
