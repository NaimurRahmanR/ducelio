import { z } from "zod";
import { runtimeBudgetPolicySchema } from "./academic-runtime";
import type { AgentRole } from "./academic-capability-policy";

// A runtime/model profile is the ONLY server-owned source of a provider
// endpoint/adapter kind and a budget policy. Course-package and agent
// configuration may only reference a profile by this bounded identifier
// string; they can never define a provider endpoint, credential or budget
// themselves (see src/domain/academic-agent-config.ts's modelProfileRef and
// src/server/academic-runtime/profile-registry.ts's code-only registry). A
// profile reference that does not resolve in the registry fails closed
// before any provider call, regardless of what a course or agent
// configuration proposed.
export const runtimeProfileRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);
export type RuntimeProfileRef = z.infer<typeof runtimeProfileRefSchema>;

// adapterKind is provider-neutral vocabulary, not a vendor choice: HTTP_JSON
// names a transport shape (see src/server/academic-runtime/provider.ts),
// not a specific company's API. TEST_DETERMINISTIC profiles never resolve a
// production adapter (src/server/academic-runtime/profile-registry.ts);
// they exist only so tests can supply a deterministic fake adapter for an
// otherwise-real profile resolution path.
export const runtimeAdapterKindSchema = z.enum([
  "HTTP_JSON",
  "TEST_DETERMINISTIC",
]);
export type RuntimeAdapterKind = z.infer<typeof runtimeAdapterKindSchema>;

export const runtimeProfileSchema = z.strictObject({
  ref: runtimeProfileRefSchema,
  adapterKind: runtimeAdapterKindSchema,
  budgetPolicy: runtimeBudgetPolicySchema,
});
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;

// ---------------------------------------------------------------------------
// PR16A: the single DOMAIN-owned source of truth for which runtime/model
// profile ref each of the five academic-agent roles may ever be configured
// or executed with, and how a null modelProfileRef behaves for that role.
// course-package authoring validation (src/domain/course-package.ts),
// stored-configuration validation (src/domain/academic-agent-config.ts) and
// server-side runtime resolution (src/server/academic-runtime/profile-
// registry.ts) all consult this table instead of keeping independently
// drifting copies. Migration 036's SQL role/profile helper(s) are required
// to stay in semantic parity with this table; a change to one without the
// other is itself a defect. This table intentionally holds only literals/
// types/null policy (never a RuntimeProfile, adapter or budget) -- the
// server-owned registry above remains the only source of those.
// ---------------------------------------------------------------------------
export const roleRuntimeNullBehaviorSchema = z.enum([
  // A null modelProfileRef is invalid whenever the role is enabled -- see
  // validateRoleModelProfileRef below. PROFESSOR only.
  "REJECT",
  // A null modelProfileRef silently resolves to the role's own fixed
  // production profile. TUTOR, LAB_INSTRUCTOR, EXAMINER.
  "DEFAULT_TO_ROLE_PROFILE",
  // The role has no provider-backed profile at all; modelProfileRef must
  // always remain null. COUNSELLOR only.
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

// Pure authoring/storage-time validation, shared by course-package.ts's
// COURSE_PACKAGE_V1 authoring schema and academic-agent-config.ts's stored
// agentConfigInputSchema. ANY non-null ref that is not the exact role's
// allowedRef is invalid regardless of enabled=true/false (this also covers
// COUNSELLOR, whose allowedRef is null: any non-null ref fails here).
// PROFESSOR additionally requires a non-null ref whenever enabled=true; a
// disabled Professor row may be null or its own exact ref.
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
