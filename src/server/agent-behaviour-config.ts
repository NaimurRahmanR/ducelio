import "server-only";
import { z } from "zod";
import {
  AGENT_BEHAVIOUR_CONFIG_POLICY,
  AGENT_BEHAVIOUR_DEFAULTS,
  INSTITUTIONAL_BASELINE_VERSION,
  agentBehaviourConfigSchema,
  agentBehaviourDefaultVersionSchema,
  roleBaselineFor,
  type BehaviourRole,
  type EffectiveAgentBehaviour,
} from "@/domain/agent-behaviour";
import { AccessDenied } from "@/domain/policy";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

// AC-2 LEVEL-3 behaviour configuration (migration 051). The learner-scoped
// read returns the behaviour BINDING the database froze when the learner's
// programme version was published: the pinned role behaviour version and
// the actual effective values, also for a default. It never resolves
// against the current code default; a missing or unverifiable binding, an
// unreviewed pinned version, or frozen default values that disagree with
// the versioned default all fail closed. Admin authoring is draft-only and
// the database refuses anything else.

export class AgentBehaviourUnavailable extends Error {
  constructor() {
    super("Agent behaviour configuration is unavailable.");
    this.name = "AgentBehaviourUnavailable";
  }
}

const learnerReadSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    source: z.literal("DEFAULT"),
    configVersion: agentBehaviourDefaultVersionSchema,
    behaviourVersion: z.string().max(100),
    config: agentBehaviourConfigSchema,
    institutionalBaselineVersion: z.string().max(100),
  }),
  z.strictObject({
    ok: z.literal(true),
    source: z.literal("EXPLICIT"),
    configVersion: z.literal(AGENT_BEHAVIOUR_CONFIG_POLICY),
    behaviourVersion: z.string().max(100),
    config: agentBehaviourConfigSchema,
    institutionalBaselineVersion: z.string().max(100),
  }),
  z.strictObject({ ok: z.literal(false), code: z.string().max(64) }),
]);

const sameConfig = (
  a: EffectiveAgentBehaviour["config"],
  b: EffectiveAgentBehaviour["config"],
) =>
  a.responseDepth === b.responseDepth &&
  a.teachingApproach === b.teachingApproach &&
  a.understandingCheckFrequency === b.understandingCheckFrequency &&
  a.challengeLevel === b.challengeLevel &&
  a.courseContextNotes === b.courseContextNotes;

export async function getAgentBehaviourForEnrolment(
  enrolmentId: string,
  role: BehaviourRole,
): Promise<EffectiveAgentBehaviour> {
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "get_agent_behaviour_for_enrolment",
    { p_enrolment_id: z.uuid().parse(enrolmentId), p_role: role },
  );
  if (error) throw new AgentBehaviourUnavailable();
  const parsed = learnerReadSchema.safeParse(data);
  if (!parsed.success || !parsed.data.ok) throw new AgentBehaviourUnavailable();
  const binding = parsed.data;
  // The Level-1 baseline the database records in execution provenance must
  // be the one this code applies; disagreement fails closed.
  if (binding.institutionalBaselineVersion !== INSTITUTIONAL_BASELINE_VERSION)
    throw new AgentBehaviourUnavailable();
  // The pinned role behaviour version must be one this code has reviewed
  // text for, for this role. It is NOT required to be the current version.
  if (!roleBaselineFor(role, binding.behaviourVersion))
    throw new AgentBehaviourUnavailable();
  // A frozen default must carry exactly its version's values.
  if (
    binding.source === "DEFAULT" &&
    !sameConfig(binding.config, AGENT_BEHAVIOUR_DEFAULTS[binding.configVersion])
  )
    throw new AgentBehaviourUnavailable();
  return {
    behaviourVersion: binding.behaviourVersion,
    source: binding.source,
    configVersion: binding.configVersion,
    config: binding.config,
  };
}

export const agentBehaviourInputSchema = z.strictObject({
  programmeVersionId: z.uuid(),
  role: z.enum(["PROFESSOR", "TUTOR", "LAB_INSTRUCTOR"]),
  config: agentBehaviourConfigSchema,
  reason: z.string().trim().min(5).max(300),
});

export const agentBehaviourRefusalCodes = [
  "AGENT_BEHAVIOUR_CONFIG_FROZEN",
] as const;
export class AgentBehaviourRefused extends Error {
  constructor(readonly code: (typeof agentBehaviourRefusalCodes)[number]) {
    super("Agent behaviour configuration change refused.");
    this.name = "AgentBehaviourRefused";
  }
}

async function requireBehaviourAdmin() {
  const actor = await requireActor("admin");
  if (
    !actor.roles.includes("ACADEMIC_ADMIN") &&
    !actor.roles.includes("PLATFORM_ADMIN")
  )
    throw new AccessDenied();
  return actor;
}

export async function setAgentBehaviourConfig(input: unknown): Promise<string> {
  await requireBehaviourAdmin();
  const payload = agentBehaviourInputSchema.parse(input);
  const client = await createSupabase();
  const { data, error } = await client.rpc("admin_set_agent_behaviour_config", {
    p_programme_version_id: payload.programmeVersionId,
    p_role: payload.role,
    p_response_depth: payload.config.responseDepth,
    p_teaching_approach: payload.config.teachingApproach,
    p_understanding_check_frequency: payload.config.understandingCheckFrequency,
    p_challenge_level: payload.config.challengeLevel,
    p_course_context_notes: payload.config.courseContextNotes,
    p_reason: payload.reason,
  });
  if (error) {
    if (error.message?.startsWith("AGENT_BEHAVIOUR_CONFIG_FROZEN"))
      throw new AgentBehaviourRefused("AGENT_BEHAVIOUR_CONFIG_FROZEN");
    throw new Error("Agent behaviour configuration could not be saved.");
  }
  return z.uuid().parse(data);
}

const effectiveRoleSchema = z.union([
  z.strictObject({
    role: z.enum(["PROFESSOR", "TUTOR", "LAB_INSTRUCTOR"]),
    // DRAFT: live (editable) resolution. BOUND: the frozen binding.
    state: z.enum(["DRAFT", "BOUND"]),
    behaviourVersion: z.string().max(100),
    source: z.enum(["EXPLICIT", "DEFAULT"]),
    configVersion: z.enum([
      AGENT_BEHAVIOUR_CONFIG_POLICY,
      ...agentBehaviourDefaultVersionSchema.options,
    ]),
    responseDepth: agentBehaviourConfigSchema.shape.responseDepth,
    teachingApproach: agentBehaviourConfigSchema.shape.teachingApproach,
    understandingCheckFrequency:
      agentBehaviourConfigSchema.shape.understandingCheckFrequency,
    challengeLevel: agentBehaviourConfigSchema.shape.challengeLevel,
    courseContextNotes: z.string().max(2000).nullable(),
  }),
  z.strictObject({
    role: z.enum(["PROFESSOR", "TUTOR", "LAB_INSTRUCTOR"]),
    state: z.enum(["BEHAVIOUR_BINDING_MISSING", "BEHAVIOUR_BINDING_INVALID"]),
  }),
]);
export type EffectiveRoleBehaviour = z.infer<typeof effectiveRoleSchema>;

export const agentBehaviourListSchema = z.strictObject({
  programmeVersionId: z.uuid(),
  frozen: z.boolean(),
  fingerprintPolicy: z.literal("AGENT_BEHAVIOUR_FINGERPRINT_V1"),
  // Null when a bound version's binding is missing or does not verify.
  behaviourFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  effective: z.array(effectiveRoleSchema).length(3),
  configs: z
    .array(
      z.strictObject({
        role: z.enum(["PROFESSOR", "TUTOR", "LAB_INSTRUCTOR"]),
        responseDepth: agentBehaviourConfigSchema.shape.responseDepth,
        teachingApproach: agentBehaviourConfigSchema.shape.teachingApproach,
        understandingCheckFrequency:
          agentBehaviourConfigSchema.shape.understandingCheckFrequency,
        challengeLevel: agentBehaviourConfigSchema.shape.challengeLevel,
        courseContextNotes: z.string().max(2000).nullable(),
        updatedAt: z.string(),
      }),
    )
    .max(3),
});
export type AgentBehaviourList = z.infer<typeof agentBehaviourListSchema>;

export async function listAgentBehaviourConfigs(
  programmeVersionId: string,
): Promise<AgentBehaviourList> {
  await requireBehaviourAdmin();
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "admin_list_agent_behaviour_configs",
    { p_programme_version_id: z.uuid().parse(programmeVersionId) },
  );
  if (error)
    throw new Error("Agent behaviour configuration could not be loaded.");
  return agentBehaviourListSchema.parse(data);
}
