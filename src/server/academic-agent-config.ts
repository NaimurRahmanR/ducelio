import "server-only";
import { z } from "zod";
import {
  agentConfigInputSchema,
  agentConfigRecordSchema,
  AGENT_CONFIG_POLICY,
  agentRoleSchema,
  type AgentConfigRecord,
} from "@/domain/academic-agent-config";
import { AccessDenied } from "@/domain/policy";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

// Reusable per-role academic-agent configuration, shared across every
// course/programme version. The server independently re-checks every
// capability against the fixed allowlist (domain + migration 024 RPC); a
// stored row narrows what a future role runtime may request and can never
// widen authorization beyond that review.
async function requireAgentConfigAdmin() {
  const actor = await requireActor("admin");
  if (
    !actor.roles.includes("ACADEMIC_ADMIN") &&
    !actor.roles.includes("PLATFORM_ADMIN")
  ) {
    throw new AccessDenied();
  }
  return actor;
}

export async function setAgentConfig(input: unknown): Promise<string> {
  await requireAgentConfigAdmin();
  const payload = agentConfigInputSchema.parse(input);
  const client = await createSupabase();
  const { data, error } = await client.rpc("set_agent_config", {
    p_programme_version_id: payload.programmeVersionId,
    p_role: payload.role,
    p_enabled: payload.enabled,
    p_model_profile_ref: payload.modelProfileRef,
    p_instructional_notes: payload.instructionalNotes,
    p_capabilities: payload.capabilities,
    p_escalation_policy: payload.escalationPolicy,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Agent configuration could not be saved.");
  return z.uuid().parse(data);
}

const rawConfigRowSchema = z.object({
  id: z.uuid(),
  programme_version_id: z.uuid(),
  role: z.string(),
  enabled: z.boolean(),
  model_profile_ref: z.string().nullable(),
  instructional_notes: z.string().nullable(),
  capabilities: z.array(z.string()),
  escalation_policy: z.string(),
  updated_at: z.string(),
});

export async function listAgentConfigs(
  programmeVersionId: string,
): Promise<AgentConfigRecord[]> {
  await requireAgentConfigAdmin();
  const id = z.uuid().parse(programmeVersionId);
  const client = await createSupabase();
  const { data, error } = await client.rpc("list_agent_configs", {
    p_programme_version_id: id,
  });
  if (error) throw new Error("Agent configurations could not be loaded.");
  const rows = z.array(rawConfigRowSchema).parse(data ?? []);
  return rows.map((row) =>
    agentConfigRecordSchema.parse({
      id: row.id,
      programmeVersionId: row.programme_version_id,
      role: agentRoleSchema.parse(row.role),
      policyVersion: AGENT_CONFIG_POLICY,
      enabled: row.enabled,
      modelProfileRef: row.model_profile_ref,
      instructionalNotes: row.instructional_notes,
      capabilities: row.capabilities,
      escalationPolicy: row.escalation_policy,
      updatedAt: row.updated_at,
    }),
  );
}

const effectiveConfigRowSchema = z.object({
  enabled: z.boolean(),
  model_profile_ref: z.string().nullable(),
  capabilities: z.array(z.string()),
  escalation_policy: z.string(),
});
export type EffectiveAgentConfig = {
  enabled: boolean;
  modelProfileRef: string | null;
  capabilities: string[];
  escalationPolicy: "NONE" | "ACADEMIC_REVIEW";
};

// Learner-scoped read, ownership-checked server-side. Missing configuration
// fails closed to a disabled default; it is never treated as an error or as
// an implicit grant of every capability.
export async function getAgentConfigForEnrolment(
  enrolmentId: string,
  role: unknown,
): Promise<EffectiveAgentConfig> {
  const parsedRole = agentRoleSchema.parse(role);
  const client = await createSupabase();
  const { data, error } = await client.rpc("get_agent_config_for_enrolment", {
    p_enrolment_id: z.uuid().parse(enrolmentId),
    p_role: parsedRole,
  });
  if (error) throw new Error("Agent configuration could not be loaded.");
  const row = Array.isArray(data) ? data[0] : data;
  const parsed = effectiveConfigRowSchema.parse(row);
  return {
    enabled: parsed.enabled,
    modelProfileRef: parsed.model_profile_ref,
    capabilities: parsed.capabilities,
    escalationPolicy:
      parsed.escalation_policy === "ACADEMIC_REVIEW"
        ? "ACADEMIC_REVIEW"
        : "NONE",
  };
}
