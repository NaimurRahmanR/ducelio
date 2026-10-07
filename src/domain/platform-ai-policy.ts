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

// The platform COUNSELLOR is the technical role of Sarah Mitchell, Ducelio's
// AI learner-success counsellor (AC-5). The catalogue below is the full
// policy vocabulary across checkpoints; being listed here does NOT make a
// capability executable. Only SARAH_AC5_EXECUTABLE_CAPABILITIES (learner
// support) and SARAH_AC7_EXECUTABLE_CAPABILITIES (course guidance), below,
// are executable, and only where also listed for the learner's mode.
// AC-5 added exactly two narrow capabilities, in every mode:
// guide_learner_journey (onboarding and navigation of Ducelio itself) and
// propose_support_profile_update (an optional, learner-confirmed proposal).
export const counsellorCapabilityByMode: Readonly<
  Record<CounsellorMode, readonly string[]>
> = Object.freeze({
  PROSPECT: Object.freeze([
    "read_public_course_catalogue",
    "explain_course_prerequisites",
    "explain_duration_pricing_format",
    "help_choose_course",
    "capture_optional_prospect_preferences",
    "guide_learner_journey",
    "propose_support_profile_update",
  ]),
  ACTIVE_COURSE: Object.freeze([
    "read_owned_course_logistics",
    "explain_schedule_and_access",
    "read_owned_support_state",
    "coordinate_academic_handoff",
    "record_bounded_support_followup",
    "guide_learner_journey",
    "propose_support_profile_update",
  ]),
  POST_COURSE: Object.freeze([
    "read_owned_completion_summary",
    "explain_next_course_options",
    "coordinate_progression",
    "explain_reenrolment_and_pricing",
    "guide_learner_journey",
    "read_owned_support_state",
    "propose_support_profile_update",
  ]),
});

// AC-5: the ONLY learner-support Sarah capabilities that execute, per mode
// (GUIDE and SUPPORT_PROFILE intents). Code-owned; a browser, learner message
// or stored configuration can never add one. Every entry must also be in
// counsellorCapabilityByMode for the same mode (tested). Deliberately absent:
// every commercial/course-guidance capability (those belong only to the
// separate AC-7 set below), academic handoff coordination and support
// follow-up recording (human-counsellor domain).
export const SARAH_AC5_EXECUTABLE_CAPABILITIES: Readonly<
  Record<CounsellorMode, readonly string[]>
> = Object.freeze({
  PROSPECT: Object.freeze([
    "guide_learner_journey",
    "propose_support_profile_update",
  ]),
  ACTIVE_COURSE: Object.freeze([
    "guide_learner_journey",
    "read_owned_course_logistics",
    "explain_schedule_and_access",
    "read_owned_support_state",
    "propose_support_profile_update",
  ]),
  POST_COURSE: Object.freeze([
    "guide_learner_journey",
    "read_owned_support_state",
    "propose_support_profile_update",
  ]),
});

// AC-7: the ONLY course-guidance (commercial) capabilities that execute,
// per mode, and only for the COURSE_GUIDANCE intent. Code-owned and kept
// physically separate from the AC-5 set above: the support path never gains
// a commercial capability, and the commercial path never gains a support
// capability. ACTIVE_COURSE has none by design: an active course is never an
// upselling opportunity. Every entry must also be in counsellorCapabilityByMode
// for the same mode (tested).
export const SARAH_AC7_EXECUTABLE_CAPABILITIES: Readonly<
  Record<CounsellorMode, readonly string[]>
> = Object.freeze({
  PROSPECT: Object.freeze([
    "read_public_course_catalogue",
    "explain_duration_pricing_format",
    "help_choose_course",
  ]),
  ACTIVE_COURSE: Object.freeze([]),
  POST_COURSE: Object.freeze([
    "read_owned_completion_summary",
    "explain_next_course_options",
    "explain_reenrolment_and_pricing",
  ]),
});

// Catalogue vocabulary that stays NON-executable after AC-7 (AC-6 has no
// capability at all: feedback is deterministic data with no model call,
// src/domain/session-feedback.ts):
// - explain_course_prerequisites: no authoritative prerequisite field is
//   currently published anywhere in Ducelio, and prerequisites are never
//   inferred from titles, qualification levels, course order or completion;
// - capture_optional_prospect_preferences: there is no approved persistent
//   preference model with learner visibility, retention and deletion rules,
//   so a learner's stated preferences stay ephemeral request data;
// - coordinate_progression: names coordinating (acting on) a progression;
//   AC-7 is recommendation and read-only navigation only.
export const SARAH_AC7_NON_EXECUTABLE_CAPABILITIES = Object.freeze([
  "explain_course_prerequisites",
  "capture_optional_prospect_preferences",
  "coordinate_progression",
] as const);

export function isSarahCapabilityExecutable(
  mode: CounsellorMode,
  capability: string,
): boolean {
  return (
    (SARAH_AC5_EXECUTABLE_CAPABILITIES[mode].includes(capability) ||
      SARAH_AC7_EXECUTABLE_CAPABILITIES[mode].includes(capability)) &&
    isCounsellorCapabilityAllowed(mode, capability)
  );
}

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
// institutional Counsellor persona (Sarah Mitchell) may change context/mode
// across the learner lifecycle, but it never becomes Professor/Tutor/Lab
// Instructor/Examiner.
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
