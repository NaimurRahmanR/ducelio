import "server-only";
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type {
  CapabilityName,
  CapabilityOutput,
} from "@/domain/academic-capabilities";
import {
  classroomStateResultSchema,
  classroomTurnsResultSchema,
  type ClassroomState,
  type ClassroomTurn,
} from "@/domain/professor-teaching-context";
import type { ProfessorClassroomInteraction } from "@/domain/professor-classroom";
import { getAuthenticatedActor } from "../identity";
import { createSupabase } from "../supabase";
import { withValidatedProfessorContent } from "../academic-capabilities";
import type { AcademicContentRelease } from "../academic-content-release";

// AC-2 Professor teaching plumbing (migration 051).
//
// * Classroom timing and memory are learner-owned database reads; memory is
//   additionally refused by the database while the controlled-assessment
//   firewall forbids explanation.
// * Provenance and memory writes are attested by the trusted controller with
//   the SAME controller key as migration 025 but their OWN protocol tags, so
//   no existing execution attestation format changes and no attestation of
//   one kind can authorize another.
// * withProfessorTeachingReleases composes ONLY the existing reviewed
//   PROFESSOR_READ_V2 capabilities, each under its own content release
//   through the existing gateway, nested so that every release is still
//   ACTIVE while the provider runs and every gateway performs its own final
//   principal/activity recheck and release closure afterwards. No direct
//   academic read happens in the runtime.

export class ProfessorTeachingDenied extends Error {
  constructor(readonly code: string) {
    super("Professor teaching context unavailable.");
    this.name = "ProfessorTeachingDenied";
  }
}

export async function getProfessorClassroomState(
  classSessionId: string,
): Promise<ClassroomState> {
  const client = await createSupabase();
  const { data, error } = await client.rpc("get_my_professor_classroom_state", {
    p_class_session_id: z.uuid().parse(classSessionId),
  });
  if (error) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  const parsed = classroomStateResultSchema.safeParse(data);
  if (!parsed.success) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new ProfessorTeachingDenied(parsed.data.code);
  return parsed.data.state;
}

export type ClassroomMemory = {
  turns: ClassroomTurn[];
  totalTurns: number;
  // Exchanges shown to the learner whose turn was never recorded (derived
  // by the database): memory continuity is DEGRADED when this is non-zero.
  unrecordedExchanges: number;
  capacityReached: boolean;
};

export async function listProfessorClassroomTurns(
  classSessionId: string,
  limit: number,
): Promise<ClassroomMemory> {
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "list_my_professor_classroom_turns",
    {
      p_class_session_id: z.uuid().parse(classSessionId),
      p_limit: z.number().int().min(1).max(50).parse(limit),
    },
  );
  if (error) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  const parsed = classroomTurnsResultSchema.safeParse(data);
  if (!parsed.success) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new ProfessorTeachingDenied(parsed.data.code);
  return {
    turns: parsed.data.turns,
    totalTurns: parsed.data.totalTurns,
    unrecordedExchanges: parsed.data.unrecordedExchanges,
    capacityReached: parsed.data.capacityReached,
  };
}

// ---------------------------------------------------------------------------
// Attested writes. No key material, MAC or canonical message ever leaves
// this module; callers learn only success or a bounded code.
// ---------------------------------------------------------------------------

function controller() {
  const keyId = z.uuid().safeParse(process.env.ACADEMIC_EXECUTION_KEY_ID);
  const keyHex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .safeParse(process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX);
  if (!keyId.success || !keyHex.success)
    throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    keyId: keyId.data.toLowerCase(),
    issuedAt,
    expiresAt: issuedAt + 10,
    sign: (canonical: string) =>
      createHmac("sha256", Buffer.from(keyHex.data, "hex"))
        .update(canonical, "utf8")
        .digest("hex"),
  };
}
async function studentId() {
  const actor = await getAuthenticatedActor();
  if (!actor || !actor.roles.includes("STUDENT"))
    throw new ProfessorTeachingDenied("FORBIDDEN");
  return actor.id.toLowerCase();
}
const rpcResultSchema = z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(true), duplicate: z.boolean() }),
  z.strictObject({ ok: z.literal(false), code: z.string().max(64) }),
]);

export type ContextReleaseManifestEntry = {
  capability: CapabilityName;
  releaseId: string;
};

// The manifest lists every content release that contributed data to this
// provider call, outermost first. It is bound into the attestation, and the
// database verifies it against the stored configuration and each release.
export async function recordProfessorExecutionProvenance(input: {
  executionId: string;
  release: AcademicContentRelease;
  classSessionId: string;
  contextReleases: readonly ContextReleaseManifestEntry[];
  runtimeProfileRef: string | null;
  // The Level-1 baseline actually applied to the instructions.
  institutionalBaselineVersion: string;
  behaviourVersion: string;
  behaviourConfigVersion: string;
}): Promise<void> {
  const actor = await studentId();
  if (actor !== input.release.student_id.toLowerCase())
    throw new ProfessorTeachingDenied("CONTEXT_CONFLICT");
  const c = controller();
  const executionId = z.uuid().parse(input.executionId).toLowerCase();
  const releaseId = z.uuid().parse(input.release.release_id).toLowerCase();
  const classSessionId = z.uuid().parse(input.classSessionId).toLowerCase();
  const manifest = input.contextReleases.map((entry) => ({
    capability: entry.capability,
    releaseId: z.uuid().parse(entry.releaseId).toLowerCase(),
  }));
  const canonical = [
    "DUCELIO_AGENT_PROVENANCE_HMAC_SHA256_V1",
    "PROFESSOR",
    c.keyId,
    actor,
    executionId,
    releaseId,
    classSessionId,
    manifest.map((entry) => `${entry.capability}:${entry.releaseId}`).join(","),
    input.runtimeProfileRef ?? "NONE",
    input.institutionalBaselineVersion,
    input.behaviourVersion,
    input.behaviourConfigVersion,
    String(c.issuedAt),
    String(c.expiresAt),
  ].join("\n");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "record_professor_execution_provenance",
    {
      p_key_id: c.keyId,
      p_execution_id: executionId,
      p_release_id: releaseId,
      p_class_session_id: classSessionId,
      p_context_capabilities: manifest.map((entry) => entry.capability),
      p_context_release_ids: manifest.map((entry) => entry.releaseId),
      p_runtime_profile_ref: input.runtimeProfileRef,
      p_institutional_baseline_version: input.institutionalBaselineVersion,
      p_behaviour_version: input.behaviourVersion,
      p_behaviour_config_version: input.behaviourConfigVersion,
      p_issued_at: c.issuedAt,
      p_expires_at: c.expiresAt,
      p_mac: c.sign(canonical),
    },
  );
  if (error) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  const parsed = rpcResultSchema.safeParse(data);
  if (!parsed.success) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new ProfessorTeachingDenied(parsed.data.code);
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

// Only the learner's visible message and the Professor's visible reply.
export async function recordProfessorClassroomTurn(input: {
  executionId: string;
  classSessionId: string;
  interaction: ProfessorClassroomInteraction;
  professorMessage: string;
}): Promise<void> {
  const actor = await studentId();
  const c = controller();
  const executionId = z.uuid().parse(input.executionId).toLowerCase();
  const classSessionId = z.uuid().parse(input.classSessionId).toLowerCase();
  const learnerMessage =
    input.interaction.kind === "LEARNER_QUESTION"
      ? input.interaction.learnerMessage
      : null;
  const canonical = [
    "DUCELIO_CLASSROOM_TURN_HMAC_SHA256_V1",
    "PROFESSOR",
    c.keyId,
    actor,
    executionId,
    classSessionId,
    input.interaction.kind,
    sha256(learnerMessage ?? ""),
    sha256(input.professorMessage),
    String(c.issuedAt),
    String(c.expiresAt),
  ].join("\n");
  const client = await createSupabase();
  const { data, error } = await client.rpc("record_professor_classroom_turn", {
    p_key_id: c.keyId,
    p_execution_id: executionId,
    p_class_session_id: classSessionId,
    p_interaction_kind: input.interaction.kind,
    p_learner_message: learnerMessage,
    p_professor_message: input.professorMessage,
    p_issued_at: c.issuedAt,
    p_expires_at: c.expiresAt,
    p_mac: c.sign(canonical),
  });
  if (error) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  const parsed = rpcResultSchema.safeParse(data);
  if (!parsed.success) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new ProfessorTeachingDenied(parsed.data.code);
}

// ---------------------------------------------------------------------------
// Nested reviewed releases.
// ---------------------------------------------------------------------------

export type TeachingReads = {
  lesson: CapabilityOutput<"get_lesson_context">;
  objectives: CapabilityOutput<"get_lesson_objectives">;
  resources: CapabilityOutput<"get_learning_resources"> | null;
  mastery: CapabilityOutput<"get_current_mastery_state"> | null;
};
export type GatewayOutcome = {
  ok: boolean;
  activityBlocked: boolean;
  releaseFinalizationFailed: boolean;
};

export async function withProfessorTeachingReleases(
  params: {
    enrolmentId: string;
    lessonId: string;
    includeResources: boolean;
    includeMastery: boolean;
  },
  consume: (context: {
    release: AcademicContentRelease;
    manifest: ContextReleaseManifestEntry[];
    reads: TeachingReads;
  }) => Promise<void>,
): Promise<GatewayOutcome> {
  const input = { enrolmentId: params.enrolmentId, lessonId: params.lessonId };
  const steps: CapabilityName[] = [
    "get_lesson_context",
    "get_lesson_objectives",
    ...(params.includeResources ? (["get_learning_resources"] as const) : []),
    ...(params.includeMastery ? (["get_current_mastery_state"] as const) : []),
  ];
  const collected: Partial<Record<CapabilityName, unknown>> = {};
  const manifest: ContextReleaseManifestEntry[] = [];
  let outerRelease: AcademicContentRelease | null = null;

  async function level(index: number): Promise<GatewayOutcome> {
    let inner: GatewayOutcome | null = null;
    const capability = steps[index];
    const outcome = await withValidatedProfessorContent(
      { capability, input },
      async ({ release, data }) => {
        collected[capability] = data;
        manifest.push({ capability, releaseId: release.release_id });
        if (index === 0) outerRelease = release;
        if (index < steps.length - 1) {
          inner = await level(index + 1);
          return;
        }
        await consume({
          // The provider execution is attested against the outermost
          // (get_lesson_context) release, exactly as before AC-2.
          release: outerRelease!,
          manifest: [...manifest],
          reads: {
            lesson: collected.get_lesson_context as TeachingReads["lesson"],
            objectives:
              collected.get_lesson_objectives as TeachingReads["objectives"],
            resources:
              (collected.get_learning_resources as TeachingReads["resources"]) ??
              null,
            mastery:
              (collected.get_current_mastery_state as TeachingReads["mastery"]) ??
              null,
          },
        });
      },
    );
    const self: GatewayOutcome = {
      ok: outcome.result.ok,
      activityBlocked:
        !outcome.result.ok && outcome.result.error.code === "ACTIVITY_BLOCKED",
      releaseFinalizationFailed: outcome.releaseFinalizationFailed,
    };
    const nested = inner as GatewayOutcome | null;
    if (!nested) return self;
    return {
      ok: self.ok && nested.ok,
      activityBlocked: self.activityBlocked || nested.activityBlocked,
      releaseFinalizationFailed:
        self.releaseFinalizationFailed || nested.releaseFinalizationFailed,
    };
  }
  return level(0);
}

// Learner-visible transcript for the classroom page, with its truthful
// continuity and capacity state. Any denial (another learner, an active
// controlled assessment, no classroom yet) shows nothing.
export type LearnerClassroomTranscript = {
  turns: { learnerMessage: string | null; professorMessage: string }[];
  unrecordedExchanges: number;
  capacityReached: boolean;
};
export async function getLearnerClassroomTranscript(
  classSessionId: string,
): Promise<LearnerClassroomTranscript> {
  try {
    const memory = await listProfessorClassroomTurns(classSessionId, 50);
    return {
      turns: memory.turns.map((turn) => ({
        learnerMessage: turn.learnerMessage,
        professorMessage: turn.professorMessage,
      })),
      unrecordedExchanges: memory.unrecordedExchanges,
      capacityReached: memory.capacityReached,
    };
  } catch {
    return { turns: [], unrecordedExchanges: 0, capacityReached: false };
  }
}
