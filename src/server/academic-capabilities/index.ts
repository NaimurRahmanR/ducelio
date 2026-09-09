import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CAPABILITY_CONTRACT_VERSION,
  capabilityNameSchema,
  capabilityProvenanceSchema,
  capabilitySchemas,
  type CapabilityErrorCode,
  type CapabilityName,
  type CapabilityProvenance,
  type CapabilityRequest,
  type CapabilityResult,
  type ProfessorCapabilities,
} from "@/domain/academic-capabilities";
import { AccessDenied, AuthenticationRequired } from "@/domain/policy";
import { AcademicContextUnavailable } from "@/domain/learning-context";
import { getAuthenticatedActor, requireStudentPrincipal } from "../identity";
import {
  AcademicActivityBlocked,
  assertStudentExplanationAllowed,
  getStudentAcademicActivity,
} from "../academic-activity";
import { getOwnedStudentEnrolment } from "../academy";
import {
  getStudentLessonContext,
  getStudentLessonObjectives,
} from "../learning-context";
import { PROFESSOR_PROFILE, professorCatalogue } from "./catalogue";

const envelopeSchema = z.strictObject({
  capability: z.string().min(1).max(80),
  input: z.unknown(),
});
const messages: Record<CapabilityErrorCode, string> = {
  UNAUTHENTICATED: "Authentication is required.",
  INVALID_INPUT: "The capability request is invalid.",
  CAPABILITY_UNAVAILABLE: "This capability is unavailable.",
  FORBIDDEN: "This capability requires a student principal.",
  NOT_FOUND_OR_FORBIDDEN: "The requested academic context is unavailable.",
  ACTIVITY_BLOCKED:
    "Academic learning reads are blocked by the current activity.",
  CONTEXT_CONFLICT:
    "The authenticated academic context changed. Retry the request.",
  SERVICE_UNAVAILABLE: "The capability could not be completed.",
};

export function invokeProfessorCapability<N extends CapabilityName>(
  request: CapabilityRequest<N>,
): Promise<CapabilityResult<N>>;
// The runtime boundary also accepts untrusted provider/client JSON for validation.
export function invokeProfessorCapability(
  request: unknown,
): Promise<CapabilityResult>;
export async function invokeProfessorCapability(
  request: unknown,
): Promise<CapabilityResult> {
  const invocationId = randomUUID();
  let actorId: string | null = null;
  let capability: CapabilityName | null = null;
  let authorizedScope: CapabilityProvenance["authorized_scope"] = null;

  function provenance(code: CapabilityErrorCode | null): CapabilityProvenance {
    return capabilityProvenanceSchema.parse({
      invocation_id: invocationId,
      actor_user_id: actorId,
      agent_profile: PROFESSOR_PROFILE,
      capability_name: capability,
      capability_contract_version: CAPABILITY_CONTRACT_VERSION,
      authorized_scope: authorizedScope,
      outcome:
        code === null
          ? "SUCCESS"
          : code === "SERVICE_UNAVAILABLE"
            ? "ERROR"
            : "DENIED",
      denial_code: code,
      server_timestamp: new Date().toISOString(),
    });
  }
  function fail(code: CapabilityErrorCode): CapabilityResult {
    return {
      ok: false,
      error: { code, message: messages[code] },
      provenance: provenance(code),
    };
  }

  try {
    const actor = await getAuthenticatedActor();
    if (!actor) return fail("UNAUTHENTICATED");
    actorId = z.uuid().parse(actor.id);
    if (!actor.roles.includes("STUDENT")) return fail("FORBIDDEN");
    const envelope = envelopeSchema.safeParse(request);
    if (!envelope.success) return fail("INVALID_INPUT");
    const name = capabilityNameSchema.safeParse(envelope.data.capability);
    if (!name.success) return fail("CAPABILITY_UNAVAILABLE");
    capability = name.data;
    const definition = capabilitySchemas[capability];
    const input = definition.input.safeParse(envelope.data.input);
    if (!input.success) return fail("INVALID_INPUT");
    authorizedScope = { student_user_id: actorId };

    if (professorCatalogue[capability].academicRead)
      await assertStudentExplanationAllowed();

    let output: unknown;
    switch (capability) {
      case "get_actor_context":
        output = {
          actor_user_id: actorId,
          effective_institutional_role: "STUDENT",
        };
        break;
      case "get_activity_permissions": {
        const activity = await getStudentAcademicActivity();
        output = {
          activity_state: activity.activityState,
          informational_only: true,
          permissions: {
            get_actor_context: true,
            get_activity_permissions: true,
            get_current_learner_context: activity.explanationAllowed,
            get_lesson_context: activity.explanationAllowed,
            get_lesson_objectives: activity.explanationAllowed,
          },
        };
        break;
      }
      case "get_current_learner_context":
        output = await getOwnedStudentEnrolment(input.data);
        break;
      case "get_lesson_context":
        output = await getStudentLessonContext(input.data);
        break;
      case "get_lesson_objectives":
        output = await getStudentLessonObjectives(input.data);
        break;
    }
    // Reject unexpected output fields, including fields accidentally added by a service.
    const data = definition.output.parse(output);
    if ("enrolmentId" in data) {
      if (
        !("enrolmentId" in input.data) ||
        data.enrolmentId !== input.data.enrolmentId
      )
        return fail("CONTEXT_CONFLICT");
      if (
        "lessonId" in data &&
        (!("lessonId" in input.data) || data.lessonId !== input.data.lessonId)
      )
        return fail("CONTEXT_CONFLICT");
    }

    const currentPrincipal = await requireStudentPrincipal();
    if (currentPrincipal.id !== actorId) {
      authorizedScope = null;
      return fail("CONTEXT_CONFLICT");
    }
    if (professorCatalogue[capability].academicRead)
      await assertStudentExplanationAllowed();

    if ("enrolmentId" in data) {
      authorizedScope = {
        student_user_id: actorId,
        enrolment_id: data.enrolmentId,
        programme_version_id: data.programmeVersionId,
        ...("lessonId" in data ? { lesson_id: data.lessonId } : {}),
      };
    }
    return { ok: true, data, provenance: provenance(null) };
  } catch (error) {
    if (error instanceof AuthenticationRequired) return fail("UNAUTHENTICATED");
    if (error instanceof AccessDenied) return fail("FORBIDDEN");
    if (error instanceof AcademicActivityBlocked)
      return fail("ACTIVITY_BLOCKED");
    if (error instanceof AcademicContextUnavailable)
      return fail("NOT_FOUND_OR_FORBIDDEN");
    return fail("SERVICE_UNAVAILABLE");
  }
}

export const professorCapabilities: ProfessorCapabilities = {
  invoke: invokeProfessorCapability,
};
