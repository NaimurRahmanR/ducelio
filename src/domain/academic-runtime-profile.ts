import { z } from "zod";
import { runtimeBudgetPolicySchema } from "./academic-runtime";
import type { AgentRole } from "./academic-capability-policy";

export const runtimeProfileRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);
export type RuntimeProfileRef = z.infer<typeof runtimeProfileRefSchema>;

export const runtimeAdapterKindSchema = z.enum([
  "HTTP_JSON",
  "OPENAI_RESPONSES",
  "ANTHROPIC_MESSAGES",
  "TEST_DETERMINISTIC",
]);
export type RuntimeAdapterKind = z.infer<typeof runtimeAdapterKindSchema>;

const runtimeModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.:-]+$/);

export const providerTariffSchema = z.strictObject({
  inputMicrousdPerMillionTokens: z
    .number()
    .int()
    .positive()
    .max(100_000_000),
  outputMicrousdPerMillionTokens: z
    .number()
    .int()
    .positive()
    .max(100_000_000),
  reviewedAt: z.iso.date(),
});
export type ProviderTariff = z.infer<typeof providerTariffSchema>;

export const openAIReasoningEffortSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const openAIResponsesConfigSchema = z.strictObject({
  model: runtimeModelIdSchema,
  reasoningEffort: openAIReasoningEffortSchema,
  tariff: providerTariffSchema,
});
export type OpenAIResponsesConfig = z.infer<
  typeof openAIResponsesConfigSchema
>;

export const anthropicMessagesConfigSchema = z.strictObject({
  model: runtimeModelIdSchema,
  tariff: providerTariffSchema,
});
export type AnthropicMessagesConfig = z.infer<
  typeof anthropicMessagesConfigSchema
>;

const commonProfileFields = {
  ref: runtimeProfileRefSchema,
  budgetPolicy: runtimeBudgetPolicySchema,
};

export const runtimeProfileSchema = z.discriminatedUnion("adapterKind", [
  z.strictObject({
    ...commonProfileFields,
    adapterKind: z.literal("HTTP_JSON"),
  }),
  z.strictObject({
    ...commonProfileFields,
    adapterKind: z.literal("OPENAI_RESPONSES"),
    providerConfig: openAIResponsesConfigSchema,
  }),
  z.strictObject({
    ...commonProfileFields,
    adapterKind: z.literal("ANTHROPIC_MESSAGES"),
    providerConfig: anthropicMessagesConfigSchema,
  }),
  z.strictObject({
    ...commonProfileFields,
    adapterKind: z.literal("TEST_DETERMINISTIC"),
  }),
]);
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;

// This is the single domain-owned authority for which academic role may
// resolve which profile reference. Provider/model/tariff details remain
// server-owned in profile-registry.ts and cannot be supplied by a browser,
// course package, learner or stored agent configuration.
export const roleRuntimeNullBehaviorSchema = z.enum([
  "REJECT",
  "DEFAULT_TO_ROLE_PROFILE",
  "ONLY_NULL",
]);
export type RoleRuntimeNullBehavior = z.infer<
  typeof roleRuntimeNullBehaviorSchema
>;

export type RoleRuntimeProfilePolicy = {
  readonly providerBacked: boolean;
  readonly allowedRef: RuntimeProfileRef | null;
  readonly nullBehavior: RoleRuntimeNullBehavior;
};

export const ROLE_RUNTIME_PROFILE_POLICY: Readonly<
  Record<AgentRole, RoleRuntimeProfilePolicy>
> = Object.freeze({
  PROFESSOR: Object.freeze({
    providerBacked: true,
    allowedRef: "PROFESSOR_COMMERCIAL_V1",
    nullBehavior: "REJECT",
  }),
  TUTOR: Object.freeze({
    providerBacked: true,
    allowedRef: "TUTOR_COMMERCIAL_V1",
    nullBehavior: "DEFAULT_TO_ROLE_PROFILE",
  }),
  LAB_INSTRUCTOR: Object.freeze({
    providerBacked: true,
    allowedRef: "LAB_INSTRUCTOR_COMMERCIAL_V1",
    nullBehavior: "DEFAULT_TO_ROLE_PROFILE",
  }),
  EXAMINER: Object.freeze({
    providerBacked: true,
    allowedRef: "EXAMINER_COMMERCIAL_V1",
    nullBehavior: "DEFAULT_TO_ROLE_PROFILE",
  }),
  COUNSELLOR: Object.freeze({
    providerBacked: false,
    allowedRef: null,
    nullBehavior: "ONLY_NULL",
  }),
});

export type RoleProfileRefIssue =
  "NULL_NOT_ALLOWED_WHEN_ENABLED" | "CROSS_ROLE_REF";

export function validateRoleModelProfileRef(
  role: AgentRole,
  modelProfileRef: string | null,
  enabled: boolean,
): { ok: true } | { ok: false; issue: RoleProfileRefIssue } {
  const policy = ROLE_RUNTIME_PROFILE_POLICY[role];
  if (modelProfileRef !== null && modelProfileRef !== policy.allowedRef) {
    return { ok: false, issue: "CROSS_ROLE_REF" };
  }
  if (modelProfileRef === null && policy.nullBehavior === "REJECT" && enabled) {
    return { ok: false, issue: "NULL_NOT_ALLOWED_WHEN_ENABLED" };
  }
  return { ok: true };
}
