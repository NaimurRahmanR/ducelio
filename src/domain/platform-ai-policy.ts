import { z } from "zod";
import type { RuntimeProfileRef } from "./academic-runtime-profile";

// Platform-level AI roles are deliberately separate from academic AgentRole.
// They do not inherit course-time academic authority, grade authority, raw
// support-note access, database access, shell access or deployment power.
export const platformAgentRoleSchema = z.enum([
  "COUNSELLOR",
  "OPERATIONS_ENGINEER",
]);
export type PlatformAgentRole = z.infer<typeof platformAgentRoleSchema>;

export const counsellorModeSchema = z.enum([
  "PROSPECT",
  "ACTIVE_COURSE",
  "POST_COURSE",
]);
export type CounsellorMode = z.infer<typeof counsellorModeSchema>;

export const PLATFORM_ROLE_PROFILE_REF: Readonly<
  Record<PlatformAgentRole, RuntimeProfileRef>
> = Object.freeze({
  COUNSELLOR: "COUNSELLOR_PLATFORM_V1",
  OPERATIONS_ENGINEER: "OPERATIONS_ENGINEER_PLATFORM_V1",
});

export const counsellorCapabilityByMode: Readonly<
  Record<CounsellorMode, readonly string[]>
> = Object.freeze({
  PROSPECT: Object.freeze([
    "read_public_course_catalogue",
    "explain_course_prerequisites",
    "explain_duration_pricing_format",
    "help_choose_course",
    "capture_optional_prospect_preferences",
  ]),
  ACTIVE_COURSE: Object.freeze([
    "read_owned_course_logistics",
    "explain_schedule_and_access",
    "read_owned_support_state",
    "coordinate_academic_handoff",
    "record_bounded_support_followup",
  ]),
  POST_COURSE: Object.freeze([
    "read_owned_completion_summary",
    "explain_next_course_options",
    "coordinate_progression",
    "explain_reenrolment_and_pricing",
  ]),
});

// These are the only capabilities the future Operations Engineer execution
// plane may expose. They are observation/proposal capabilities. There is no
// raw SQL, shell, service-role, secret, merge, deploy or production-mutation
// capability in this catalogue.
export const operationsEngineerCapabilityCatalogue = Object.freeze([
  "read_system_health",
  "read_provider_failures",
  "read_usage_and_costs",
  "read_jobs_and_ci",
  "read_migration_status",
  "read_error_summary",
  "propose_fix",
  "propose_pull_request",
  "draft_release_notes",
] as const);

export function isCounsellorCapabilityAllowed(
  mode: CounsellorMode,
  capability: string,
): boolean {
  return counsellorCapabilityByMode[mode].includes(capability);
}

export function isOperationsEngineerCapabilityAllowed(
  capability: string,
): boolean {
  return operationsEngineerCapabilityCatalogue.includes(
    capability as (typeof operationsEngineerCapabilityCatalogue)[number],
  );
}

// Global prohibitions remain true in every Counsellor mode. The one
// institutional Counsellor persona may change context/mode across the
// learner lifecycle, but it never becomes Professor/Tutor/Examiner.
export const COUNSELLOR_PROHIBITED_SCOPES = Object.freeze([
  "teach_course_content",
  "solve_lab",
  "answer_controlled_assessment",
  "grade_or_award_marks",
  "change_institutional_records",
  "general_chat",
  "therapy_or_diagnosis",
] as const);

export const OPERATIONS_ENGINEER_PROHIBITED_SCOPES = Object.freeze([
  "raw_database_access",
  "raw_shell_access",
  "service_role_access",
  "read_or_write_secrets",
  "merge_pull_request",
  "deploy_production",
  "unbounded_github_mutation",
] as const);
