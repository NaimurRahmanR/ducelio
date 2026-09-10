import "server-only";
import { z } from "zod";
import {
  CAPABILITY_CONTRACT_VERSION,
  type CapabilityName,
} from "@/domain/academic-capabilities";
import { createSupabase } from "./supabase";

const denialSchema = z.strictObject({
  ok: z.literal(false),
  code: z.enum([
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "INVALID_INPUT",
    "CONTEXT_CONFLICT",
    "ACTIVITY_BLOCKED",
    "NOT_FOUND_OR_FORBIDDEN",
  ]),
});
const grantSchema = z.strictObject({
  ok: z.literal(true),
  release_id: z.uuid(),
  student_id: z.uuid(),
  invocation_id: z.uuid(),
});
export type AcademicContentRelease = z.infer<typeof grantSchema>;
export class AcademicContentReleaseDenied extends Error {
  constructor(readonly code: z.infer<typeof denialSchema>["code"]) {
    super("Academic content release denied.");
  }
}

// Authenticated-callable RPCs: these prove authorization lifecycle only.
// No caller-supplied scope/profile/action/TTL or generic audit payload.
export async function beginAcademicContentRelease(
  invocationId: string,
  capability: CapabilityName,
): Promise<AcademicContentRelease> {
  const client = await createSupabase();
  const { data, error } = await client.rpc("begin_academic_content_release", {
    p_invocation_id: z.uuid().parse(invocationId),
    p_capability_name: capability,
    p_contract_version: CAPABILITY_CONTRACT_VERSION,
  });
  if (error) throw new Error("Content release could not be opened.");
  const result = z.union([grantSchema, denialSchema]).parse(data);
  if (!result.ok) throw new AcademicContentReleaseDenied(result.code);
  return result;
}

export async function closeAcademicContentRelease(
  release: AcademicContentRelease,
  complete: boolean,
): Promise<void> {
  const client = await createSupabase();
  const { data, error } = await client.rpc("close_academic_content_release", {
    p_release_id: release.release_id,
    p_complete: complete,
  });
  if (error) throw new Error("Content release could not be closed.");
  const result = z
    .union([
      z.strictObject({
        ok: z.literal(true),
        state: z.enum(["COMPLETED", "ABORTED", "EXPIRED", "BLOCKED"]),
        transitioned: z.boolean(),
      }),
      denialSchema,
    ])
    .parse(data);
  // Idempotent RPC responses never authorize a second delivery. Expiry also
  // invalidates loaded content, even if an assessment has not yet started.
  if (
    !result.ok ||
    (complete
      ? result.state !== "COMPLETED" || !result.transitioned
      : !["ABORTED", "EXPIRED"].includes(result.state))
  )
    throw new Error("Content release was not finalized as required.");
}
