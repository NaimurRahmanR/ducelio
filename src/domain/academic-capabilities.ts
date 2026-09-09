import { z } from "zod";
import {
  enrolmentContextInputSchema,
  learnerContextSchema,
  lessonContextInputSchema,
  lessonContextSchema,
  lessonObjectivesInputSchema,
  lessonObjectivesSchema,
} from "./learning-context";

export const CAPABILITY_CONTRACT_VERSION = "PROFESSOR_READ_V1" as const;
export const capabilityNameSchema = z.enum([
  "get_actor_context",
  "get_activity_permissions",
  "get_current_learner_context",
  "get_lesson_context",
  "get_lesson_objectives",
]);
export type CapabilityName = z.infer<typeof capabilityNameSchema>;

export const capabilityErrorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "INVALID_INPUT",
  "CAPABILITY_UNAVAILABLE",
  "FORBIDDEN",
  "NOT_FOUND_OR_FORBIDDEN",
  "ACTIVITY_BLOCKED",
  "CONTEXT_CONFLICT",
  "SERVICE_UNAVAILABLE",
]);
export type CapabilityErrorCode = z.infer<typeof capabilityErrorCodeSchema>;

const emptyInput = z.strictObject({});
export const capabilitySchemas = {
  get_actor_context: {
    input: emptyInput,
    output: z.strictObject({
      actor_user_id: z.uuid(),
      effective_institutional_role: z.literal("STUDENT"),
    }),
  },
  get_activity_permissions: {
    input: emptyInput,
    output: z.strictObject({
      activity_state: z.enum(["NORMAL", "CONTROLLED_ASSESSMENT_ACTIVE"]),
      informational_only: z.literal(true),
      permissions: z.strictObject({
        get_actor_context: z.literal(true),
        get_activity_permissions: z.literal(true),
        get_current_learner_context: z.boolean(),
        get_lesson_context: z.boolean(),
        get_lesson_objectives: z.boolean(),
      }),
    }),
  },
  get_current_learner_context: {
    input: enrolmentContextInputSchema,
    output: learnerContextSchema,
  },
  get_lesson_context: {
    input: lessonContextInputSchema,
    output: lessonContextSchema,
  },
  get_lesson_objectives: {
    input: lessonObjectivesInputSchema,
    output: lessonObjectivesSchema,
  },
} as const;

export type CapabilityInput<N extends CapabilityName> = z.input<
  (typeof capabilitySchemas)[N]["input"]
>;
export type CapabilityOutput<N extends CapabilityName> = z.output<
  (typeof capabilitySchemas)[N]["output"]
>;
export type CapabilityRequest<N extends CapabilityName = CapabilityName> = {
  [K in N]: { capability: K; input: CapabilityInput<K> };
}[N];

export const authorizedScopeSchema = z.strictObject({
  student_user_id: z.uuid(),
  enrolment_id: z.uuid().optional(),
  programme_version_id: z.uuid().optional(),
  lesson_id: z.uuid().optional(),
});
export const capabilityProvenanceSchema = z.strictObject({
  invocation_id: z.uuid(),
  actor_user_id: z.uuid().nullable(),
  agent_profile: z.literal("PROFESSOR"),
  capability_name: capabilityNameSchema.nullable(),
  capability_contract_version: z.literal(CAPABILITY_CONTRACT_VERSION),
  authorized_scope: authorizedScopeSchema.nullable(),
  outcome: z.enum(["SUCCESS", "DENIED", "ERROR"]),
  denial_code: capabilityErrorCodeSchema.nullable(),
  server_timestamp: z.iso.datetime(),
});
export type CapabilityProvenance = z.infer<typeof capabilityProvenanceSchema>;
export type CapabilityResult<N extends CapabilityName = CapabilityName> =
  | {
      ok: true;
      data: CapabilityOutput<N>;
      provenance: CapabilityProvenance;
    }
  | {
      ok: false;
      error: { code: CapabilityErrorCode; message: string };
      provenance: CapabilityProvenance;
    };

// Provider-independent, JSON-only port. The server binds identity/profile internally.
export interface ProfessorCapabilities {
  invoke<N extends CapabilityName>(
    request: CapabilityRequest<N>,
  ): Promise<CapabilityResult<N>>;
}
