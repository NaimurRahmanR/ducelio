import { z } from "zod";
import { capabilityNameSchema } from "./academic-capabilities";

// Single source of truth for academic-agent role vocabulary and the
// code-owned capability allowlist per role. src/domain/course-package.ts
// (package authoring validation), src/domain/academic-agent-config.ts
// (stored configuration validation) and src/server/academic-runtime
// (execution-time authorization) all import from here rather than keeping
// independent copies that can drift apart. Extracted to its own module
// specifically to avoid a circular import between course-package.ts and
// academic-agent-config.ts.
export const agentRoleSchema = z.enum([
  "PROFESSOR",
  "TUTOR",
  "LAB_INSTRUCTOR",
  "EXAMINER",
  "COUNSELLOR",
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

// Reviewed, code-owned capability allowlists, one per role. This is the only
// vocabulary a package's proposed configuration or a stored agent
// configuration may ever select from. PROFESSOR reuses the exact nine-name
// capability catalogue already enforced by the server
// (src/server/academic-capabilities) under PROFESSOR_READ_V2. EXAMINER's two
// capabilities are its real, live grade_controlled_assessment/
// grade_practical_lab execution authorities (PR16A,
// src/server/commercial-v1-examiner-grading), governed by the database's own
// AUTHORIZE admission (migration 036) -- not a placeholder. TUTOR,
// LAB_INSTRUCTOR and COUNSELLOR still have no independent server-enforced
// execution capability today beyond the existing delivery-access/
// Counsellor-scope gating in src/domain/delivery.ts; their catalogues here
// remain a reviewed placeholder boundary for future capability work, not a
// live execution path. Listing a capability here is necessary but never
// sufficient authorization: callers must independently confirm a stored
// configuration also requested it (see isCapabilityAuthorized) and, for any
// role without a reviewed live execution path, fail closed regardless.
export const roleCapabilityCatalogue: Record<AgentRole, readonly string[]> =
  Object.freeze({
    PROFESSOR: capabilityNameSchema.options,
    TUTOR: Object.freeze([
      "get_current_learner_context",
      "get_lesson_context",
      "get_lesson_objectives",
      "get_learning_resources",
    ]) as readonly string[],
    LAB_INSTRUCTOR: Object.freeze([
      "get_current_learner_context",
      "get_lesson_context",
      "get_lesson_objectives",
    ]) as readonly string[],
    // EXAMINER's real execution authorities (PR16A): the exact two grading
    // capabilities commercial_v1_examiner_grading.ts's runtime invokes,
    // replacing the earlier context-read placeholder that never matched a
    // live execution path. Must stay byte-for-byte in step with SQL
    // course_engineering_private.role_capability_allowlist('EXAMINER')
    // (migration 036).
    EXAMINER: Object.freeze([
      "grade_controlled_assessment",
      "grade_practical_lab",
    ]) as readonly string[],
    COUNSELLOR: Object.freeze([
      "get_current_learner_context",
    ]) as readonly string[],
  });

export function isCapabilityInRoleCatalogue(
  role: AgentRole,
  capability: string,
): boolean {
  return roleCapabilityCatalogue[role].includes(capability);
}

// A capability is authorized only when it is BOTH in the code-owned role
// catalogue AND explicitly present in the caller-independent stored
// configuration. Neither source alone is sufficient: database drift (a
// configuration row saved under an older, broader catalogue) can never
// widen authorization beyond the current code-owned list, and a catalogue
// entry can never substitute for an explicit configuration request.
export function isCapabilityAuthorized(
  role: AgentRole,
  capability: string,
  configuredCapabilities: readonly string[],
): boolean {
  return (
    isCapabilityInRoleCatalogue(role, capability) &&
    configuredCapabilities.includes(capability)
  );
}
