import "server-only";
import type { CapabilityName } from "@/domain/academic-capabilities";

// AI profile and action mapping are code-reviewed server configuration, not input.
export const PROFESSOR_PROFILE = "PROFESSOR" as const;
export const professorCatalogue = {
  get_actor_context: { academicRead: false },
  get_activity_permissions: { academicRead: false },
  get_current_learner_context: { academicRead: true },
  get_lesson_context: { academicRead: true },
  get_lesson_objectives: { academicRead: true },
  get_current_class_session: { academicRead: true },
  get_learning_resources: { academicRead: true },
  get_permitted_learning_history: { academicRead: true },
  get_current_mastery_state: { academicRead: true },
} as const satisfies Record<CapabilityName, { academicRead: boolean }>;
