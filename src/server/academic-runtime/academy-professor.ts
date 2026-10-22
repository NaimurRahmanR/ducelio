import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  zeroUsage,
  type ProviderAdapter,
  type RuntimeBudgetPolicy,
  type RuntimeResult,
} from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";
import {
  PROVIDER_EXECUTION_DB_CEILING,
  providerExecutionBudgetProposalSchema,
  mapRuntimeResultToFinalizeCommand,
} from "@/domain/academic-provider-execution";
import { isCapabilityAuthorized } from "@/domain/academic-agent-config";
import {
  capabilitySchemas,
  type CapabilityName,
  type CapabilityOutput,
} from "@/domain/academic-capabilities";
import {
  professorClassroomInteractionSchema,
  type ProfessorClassroomInteraction,
} from "@/domain/professor-classroom";
import {
  INSTITUTIONAL_BASELINE_VERSION,
  roleBaselineFor,
  type EffectiveAgentBehaviour,
} from "@/domain/agent-behaviour";
import {
  TEACHING_CONTEXT_LIMITS,
  buildProfessorTeachingContext,
  classroomStateSchema,
  classroomTurnsResultSchema,
  type ClassroomState,
} from "@/domain/professor-teaching-context";
import { requireStudentPrincipal } from "../identity";
import { createSupabase } from "../supabase";
import {
  AcademicActivityBlocked,
  assertStudentExplanationAllowed,
} from "../academic-activity";
import {
  AcademicContentReleaseDenied,
  beginAcademicContentRelease,
  closeAcademicContentRelease,
  type AcademicContentRelease,
} from "../academic-content-release";
import {
  attestProviderExecutionCommand,
  ProviderExecutionDenied,
} from "../academic-provider-execution/authority";
import { verifiedLearnerBehaviourBinding } from "../agent-behaviour-config";
import {
  resolveAdapterForProfile,
  resolveRoleBoundRuntimeProfile,
  resolveRuntimeProfile,
} from "./profile-registry";
import { runGovernedProviderExecution } from "./runtime";
import {
  ProfessorTeachingDenied,
  teachingController,
  teachingRpcResultSchema,
  teachingStudentId,
  type ClassroomMemory,
  type ContextReleaseManifestEntry,
  type GatewayOutcome,
} from "./professor-teaching";

// Ducelio Academy (B2C) Professor classroom: the governed Professor
// execution for an individual Academy enrolment (migration 062), with no
// cohort, class session, instructor or B2B enrolment.
//
// It is the same pipeline as the cohort classroom in ./index.ts, composed
// from the same reviewed parts rather than a second provider engine:
// authenticated learner -> Academy classroom state from the database
// (ownership, ACTIVE unrevoked enrolment, scheduled time reached, lesson
// released, no controlled assessment) -> the programme version's stored
// Professor configuration and frozen behaviour binding -> role-bound
// runtime profile -> the reviewed PROFESSOR_READ_V2 reads, each under its
// own content release (migration 021), nested so the provider runs while
// every release is ACTIVE -> migration 025's AUTHORIZE, attested Academy
// provenance (re-proving admission), START -> runGovernedProviderExecution
// -> every release rechecked and closed -> FINALIZE with the real usage ->
// attested learner-visible memory. It writes no evidence, mastery,
// progress, grade or completion.
//
// Only the Academy classroom identity differs from the cohort path, so the
// cohort runtime, its tables and its behaviour are untouched.

const requestSchema = z.strictObject({
  classroomId: z.uuid(),
  interaction: professorClassroomInteractionSchema,
});

type ProfileResolver = (ref: string | null) => RuntimeProfile | null;
type AdapterResolver = (profile: RuntimeProfile) => ProviderAdapter | null;

// ---------------------------------------------------------------------------
// Learner-scoped Academy classroom reads and writes.
// ---------------------------------------------------------------------------
const refusalSchema = z.strictObject({
  ok: z.literal(false),
  code: z.string().max(64),
});
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await (await createSupabase()).rpc(name, args);
  if (error) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  return data as unknown;
}

const classroomViewSchema = z.strictObject({
  courseTitle: z.string().max(500),
  lessonRef: z.string().max(80),
  part: z.number().int().positive(),
  parts: z.number().int().positive(),
  openedAt: z.string().min(1).max(64),
});
const stateResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    state: classroomStateSchema,
    view: classroomViewSchema,
  }),
  refusalSchema,
]);
export type AcademyClassroomView = {
  state: ClassroomState;
  view: z.infer<typeof classroomViewSchema>;
};

export async function getAcademyClassroomState(
  classroomId: string,
): Promise<AcademyClassroomView> {
  const parsed = stateResultSchema.safeParse(
    await rpc("get_my_academy_professor_classroom_state", {
      p_classroom_id: z.uuid().parse(classroomId),
    }),
  );
  if (!parsed.success) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new ProfessorTeachingDenied(parsed.data.code);
  return { state: parsed.data.state, view: parsed.data.view };
}

const agentResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    config: z.strictObject({
      enabled: z.boolean(),
      modelProfileRef: z.string().max(100).nullable(),
      capabilities: z.array(z.string().max(80)).max(20),
      escalationPolicy: z.string().max(40),
    }),
    behaviour: z.unknown(),
  }),
  refusalSchema,
]);
async function getAcademyProfessorAgent(enrolmentId: string) {
  const parsed = agentResultSchema.safeParse(
    await rpc("get_my_academy_professor_agent", {
      p_enrolment_id: z.uuid().parse(enrolmentId),
    }),
  );
  if (!parsed.success) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new ProfessorTeachingDenied(parsed.data.code);
  // The same validation as the cohort binding read: an unverifiable,
  // unreviewed or inconsistent binding fails closed.
  const behaviour = verifiedLearnerBehaviourBinding(
    parsed.data.behaviour,
    "PROFESSOR",
  );
  return { config: parsed.data.config, behaviour };
}

export async function listAcademyClassroomTurns(
  classroomId: string,
  limit: number,
): Promise<ClassroomMemory> {
  const parsed = classroomTurnsResultSchema.safeParse(
    await rpc("list_my_academy_professor_turns", {
      p_classroom_id: z.uuid().parse(classroomId),
      p_limit: z.number().int().min(1).max(50).parse(limit),
    }),
  );
  if (!parsed.success) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new ProfessorTeachingDenied(parsed.data.code);
  return {
    turns: parsed.data.turns,
    totalTurns: parsed.data.totalTurns,
    unrecordedExchanges: parsed.data.unrecordedExchanges,
    capacityReached: parsed.data.capacityReached,
  };
}

// One governed read under its own ACTIVE release (consumed by the read).
async function readAcademyContext<N extends TeachingCapability>(
  release: AcademicContentRelease,
  classroomId: string,
  capability: N,
): Promise<CapabilityOutput<N>> {
  const parsed = z
    .union([
      z.strictObject({ ok: z.literal(true), data: z.unknown() }),
      refusalSchema,
    ])
    .safeParse(
      await rpc("read_my_academy_professor_context", {
        p_release_id: release.release_id,
        p_classroom_id: classroomId,
        p_capability: capability,
      }),
    );
  if (!parsed.success) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new ProfessorTeachingDenied(parsed.data.code);
  // The reviewed capability output contract, unexpected fields rejected.
  return capabilitySchemas[capability].output.parse(
    parsed.data.data,
  ) as CapabilityOutput<N>;
}

async function recordAcademyProvenance(input: {
  executionId: string;
  release: AcademicContentRelease;
  classroomId: string;
  contextReleases: readonly ContextReleaseManifestEntry[];
  runtimeProfileRef: string | null;
  behaviourVersion: string;
  behaviourConfigVersion: string;
}): Promise<void> {
  const actor = await teachingStudentId();
  if (actor !== input.release.student_id.toLowerCase())
    throw new ProfessorTeachingDenied("CONTEXT_CONFLICT");
  const c = teachingController();
  const executionId = z.uuid().parse(input.executionId).toLowerCase();
  const releaseId = z.uuid().parse(input.release.release_id).toLowerCase();
  const classroomId = z.uuid().parse(input.classroomId).toLowerCase();
  const manifest = input.contextReleases.map((entry) => ({
    capability: entry.capability,
    releaseId: z.uuid().parse(entry.releaseId).toLowerCase(),
  }));
  const canonical = [
    "DUCELIO_ACADEMY_PROFESSOR_PROVENANCE_HMAC_SHA256_V1",
    "PROFESSOR",
    c.keyId,
    actor,
    executionId,
    releaseId,
    classroomId,
    manifest.map((entry) => `${entry.capability}:${entry.releaseId}`).join(","),
    input.runtimeProfileRef ?? "NONE",
    INSTITUTIONAL_BASELINE_VERSION,
    input.behaviourVersion,
    input.behaviourConfigVersion,
    String(c.issuedAt),
    String(c.expiresAt),
  ].join("\n");
  const parsed = teachingRpcResultSchema.safeParse(
    await rpc("record_my_academy_professor_provenance", {
      p_key_id: c.keyId,
      p_execution_id: executionId,
      p_release_id: releaseId,
      p_classroom_id: classroomId,
      p_context_capabilities: manifest.map((entry) => entry.capability),
      p_context_release_ids: manifest.map((entry) => entry.releaseId),
      p_runtime_profile_ref: input.runtimeProfileRef,
      p_institutional_baseline_version: INSTITUTIONAL_BASELINE_VERSION,
      p_behaviour_version: input.behaviourVersion,
      p_behaviour_config_version: input.behaviourConfigVersion,
      p_issued_at: c.issuedAt,
      p_expires_at: c.expiresAt,
      p_mac: c.sign(canonical),
    }),
  );
  if (!parsed.success) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new ProfessorTeachingDenied(parsed.data.code);
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

async function recordAcademyTurn(input: {
  executionId: string;
  classroomId: string;
  interaction: ProfessorClassroomInteraction;
  professorMessage: string;
}): Promise<void> {
  const actor = await teachingStudentId();
  const c = teachingController();
  const executionId = z.uuid().parse(input.executionId).toLowerCase();
  const classroomId = z.uuid().parse(input.classroomId).toLowerCase();
  const learnerMessage =
    input.interaction.kind === "LEARNER_QUESTION"
      ? input.interaction.learnerMessage
      : null;
  const canonical = [
    "DUCELIO_ACADEMY_CLASSROOM_TURN_HMAC_SHA256_V1",
    "PROFESSOR",
    c.keyId,
    actor,
    executionId,
    classroomId,
    input.interaction.kind,
    sha256(learnerMessage ?? ""),
    sha256(input.professorMessage),
    String(c.issuedAt),
    String(c.expiresAt),
  ].join("\n");
  const parsed = teachingRpcResultSchema.safeParse(
    await rpc("record_my_academy_professor_turn", {
      p_key_id: c.keyId,
      p_execution_id: executionId,
      p_classroom_id: classroomId,
      p_interaction_kind: input.interaction.kind,
      p_learner_message: learnerMessage,
      p_professor_message: input.professorMessage,
      p_issued_at: c.issuedAt,
      p_expires_at: c.expiresAt,
      p_mac: c.sign(canonical),
    }),
  );
  if (!parsed.success) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new ProfessorTeachingDenied(parsed.data.code);
}

// ---------------------------------------------------------------------------
// Nested reviewed releases over the Academy classroom.
// ---------------------------------------------------------------------------
type TeachingCapability =
  | "get_lesson_context"
  | "get_lesson_objectives"
  | "get_learning_resources"
  | "get_current_mastery_state";
type AcademyTeachingReads = {
  objectives: CapabilityOutput<"get_lesson_objectives">;
  resources: CapabilityOutput<"get_learning_resources"> | null;
  mastery: CapabilityOutput<"get_current_mastery_state"> | null;
};

// The same lifecycle as the cohort gateway (withValidatedProfessorContent):
// begin the release, assert the firewall, read, validate, consume while the
// release is ACTIVE, recheck the principal and firewall, then close it
// COMPLETED only on success. A failed close discards everything.
async function withAcademyRelease(
  capability: TeachingCapability,
  read: (release: AcademicContentRelease) => Promise<void>,
): Promise<GatewayOutcome> {
  const principal = await requireStudentPrincipal();
  const invocationId = randomUUID();
  let release: AcademicContentRelease | null = null;
  let ok = false;
  let activityBlocked = false;
  try {
    release = await beginAcademicContentRelease(invocationId, capability);
    if (
      release.student_id !== principal.id ||
      release.invocation_id !== invocationId
    )
      throw new ProfessorTeachingDenied("CONTEXT_CONFLICT");
    await assertStudentExplanationAllowed();
    await read(release);
    if ((await requireStudentPrincipal()).id !== principal.id)
      throw new ProfessorTeachingDenied("CONTEXT_CONFLICT");
    await assertStudentExplanationAllowed();
    ok = true;
  } catch (error) {
    activityBlocked =
      error instanceof AcademicActivityBlocked ||
      (error instanceof AcademicContentReleaseDenied &&
        error.code === "ACTIVITY_BLOCKED") ||
      (error instanceof ProfessorTeachingDenied &&
        error.code === "ACTIVITY_BLOCKED");
  }
  if (release) {
    try {
      await closeAcademicContentRelease(release, ok);
    } catch {
      return { ok: false, activityBlocked, releaseFinalizationFailed: true };
    }
  }
  return { ok, activityBlocked, releaseFinalizationFailed: false };
}

async function withAcademyTeachingReleases(
  params: {
    classroom: ClassroomState;
    includeResources: boolean;
    includeMastery: boolean;
  },
  consume: (context: {
    release: AcademicContentRelease;
    manifest: ContextReleaseManifestEntry[];
    reads: AcademyTeachingReads;
  }) => Promise<void>,
): Promise<GatewayOutcome> {
  const { classroom } = params;
  const steps: TeachingCapability[] = [
    "get_lesson_context",
    "get_lesson_objectives",
    ...(params.includeResources ? (["get_learning_resources"] as const) : []),
    ...(params.includeMastery ? (["get_current_mastery_state"] as const) : []),
  ];
  const collected: Partial<Record<TeachingCapability, unknown>> = {};
  const manifest: ContextReleaseManifestEntry[] = [];
  let outerRelease: AcademicContentRelease | null = null;

  async function level(index: number): Promise<GatewayOutcome> {
    let inner: GatewayOutcome | null = null;
    const capability = steps[index];
    const self = await withAcademyRelease(capability, async (release) => {
      const data = await readAcademyContext(
        release,
        classroom.classroomId,
        capability,
      );
      // Every read must be about this classroom's own enrolment, version
      // and lesson; anything else is a context conflict.
      if (
        data.enrolmentId !== classroom.enrolmentId ||
        data.programmeVersionId !== classroom.programmeVersionId ||
        data.lessonId !== classroom.lessonId
      )
        throw new ProfessorTeachingDenied("CONTEXT_CONFLICT");
      collected[capability] = data;
      manifest.push({
        capability: capability as CapabilityName,
        releaseId: release.release_id,
      });
      if (index === 0) outerRelease = release;
      if (index < steps.length - 1) {
        inner = await level(index + 1);
        return;
      }
      await consume({
        release: outerRelease!,
        manifest: [...manifest],
        reads: {
          objectives:
            collected.get_lesson_objectives as AcademyTeachingReads["objectives"],
          resources:
            (collected.get_learning_resources as AcademyTeachingReads["resources"]) ??
            null,
          mastery:
            (collected.get_current_mastery_state as AcademyTeachingReads["mastery"]) ??
            null,
        },
      });
    });
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

// ---------------------------------------------------------------------------
// The governed execution.
// ---------------------------------------------------------------------------
const abstain = (
  reason: "ACTIVITY_BLOCKED" | "POLICY_BLOCKED" | "UNKNOWN_MODEL_PROFILE",
): RuntimeResult => ({ outcome: "ABSTAINED", usage: zeroUsage(), reason });

async function executeAcademyProfessorCore(
  request: unknown,
  deps: { resolveProfile: ProfileResolver; resolveAdapter: AdapterResolver },
): Promise<RuntimeResult> {
  await requireStudentPrincipal();
  const payload = requestSchema.parse(request);
  const usage = zeroUsage();
  const classroomId = payload.classroomId;
  const interaction = payload.interaction;

  // The database derives everything from the classroom identity alone.
  let classroom: ClassroomState;
  try {
    classroom = (await getAcademyClassroomState(classroomId)).state;
  } catch (error) {
    return abstain(
      error instanceof ProfessorTeachingDenied &&
        error.code === "ACTIVITY_BLOCKED"
        ? "ACTIVITY_BLOCKED"
        : "POLICY_BLOCKED",
    );
  }

  let config: Awaited<ReturnType<typeof getAcademyProfessorAgent>>["config"];
  let behaviour: EffectiveAgentBehaviour;
  try {
    ({ config, behaviour } = await getAcademyProfessorAgent(
      classroom.enrolmentId,
    ));
  } catch {
    return abstain("POLICY_BLOCKED");
  }
  if (!config.enabled) return abstain("POLICY_BLOCKED");
  // The code-owned catalogue AND the stored configuration must both allow
  // the lesson read and the (mandatory) objectives read.
  if (
    !isCapabilityAuthorized(
      "PROFESSOR",
      "get_lesson_context",
      config.capabilities,
    ) ||
    !isCapabilityAuthorized(
      "PROFESSOR",
      "get_lesson_objectives",
      config.capabilities,
    )
  )
    return abstain("POLICY_BLOCKED");
  // An Academy course has no instructor or academic reviewer to escalate
  // to, so a configuration that requires review simply does not teach.
  if (config.escalationPolicy !== "NONE") return abstain("POLICY_BLOCKED");
  const profile = resolveRoleBoundRuntimeProfile(
    "PROFESSOR",
    config.modelProfileRef,
    (ref) => deps.resolveProfile(ref),
  );
  if (!profile) return abstain("UNKNOWN_MODEL_PROFILE");
  if (!roleBaselineFor("PROFESSOR", behaviour.behaviourVersion))
    return abstain("POLICY_BLOCKED");

  const adapter = deps.resolveAdapter(profile);
  const proposedBudget = {
    maxProviderCalls: Math.min(
      profile.budgetPolicy.maxProviderCalls,
      PROVIDER_EXECUTION_DB_CEILING.maxProviderCalls,
    ),
    maxOutputTokens: Math.min(
      profile.budgetPolicy.maxOutputTokens,
      PROVIDER_EXECUTION_DB_CEILING.maxOutputTokens,
    ),
    maxEstimatedCostMicrousd: Math.min(
      profile.budgetPolicy.maxEstimatedCostMicrousd,
      PROVIDER_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd,
    ),
  };
  const budgetParsed =
    proposedBudget.maxProviderCalls >= 1 &&
    proposedBudget.maxOutputTokens >= 1 &&
    proposedBudget.maxEstimatedCostMicrousd >= 1
      ? providerExecutionBudgetProposalSchema.safeParse(proposedBudget)
      : null;

  let providerResult: RuntimeResult | null = null;
  let executionId: string | null = null;
  let authorized = false;
  let started = false;
  let capturedRelease: AcademicContentRelease | null = null;
  const lastKnownUsage = () => (providerResult ? providerResult.usage : usage);

  const governedProviderCall = async (
    release: AcademicContentRelease,
    context: Record<string, unknown>,
    manifest: readonly ContextReleaseManifestEntry[],
  ) => {
    if (!budgetParsed || !budgetParsed.success) {
      providerResult = { outcome: "BUDGET_BLOCKED", usage, stage: "PRE_CALL" };
      return;
    }
    executionId = randomUUID();
    try {
      await attestProviderExecutionCommand(executionId, release, {
        operation: "AUTHORIZE",
        budget: budgetParsed.data,
      });
      authorized = true;
      // Admission is re-proven by the database before START: no Academy
      // provider call can happen without attested provenance.
      await recordAcademyProvenance({
        executionId,
        release,
        classroomId,
        contextReleases: manifest,
        runtimeProfileRef: profile.ref,
        behaviourVersion: behaviour.behaviourVersion,
        behaviourConfigVersion: behaviour.configVersion,
      });
      await attestProviderExecutionCommand(executionId, release, {
        operation: "START",
      });
      started = true;
      const policy: RuntimeBudgetPolicy = {
        ...profile.budgetPolicy,
        maxProviderCalls: budgetParsed.data.maxProviderCalls,
        maxOutputTokens: budgetParsed.data.maxOutputTokens,
        maxEstimatedCostMicrousd: budgetParsed.data.maxEstimatedCostMicrousd,
      };
      providerResult = await runGovernedProviderExecution(
        adapter,
        {
          role: "PROFESSOR",
          capability: "get_lesson_context",
          context,
          behaviour,
        },
        policy,
      );
    } catch (error) {
      if (
        !(error instanceof ProviderExecutionDenied) &&
        !(error instanceof ProfessorTeachingDenied)
      )
        throw error;
      providerResult = {
        outcome: "ABSTAINED",
        usage,
        reason:
          error.code === "ACTIVITY_BLOCKED"
            ? "ACTIVITY_BLOCKED"
            : "POLICY_BLOCKED",
      };
      if (
        authorized &&
        !(error instanceof ProviderExecutionDenied && error.databaseTerminal)
      ) {
        try {
          await attestProviderExecutionCommand(executionId, release, {
            operation: "FINALIZE",
            state: "FAILED",
            reason: "INTERNAL_ERROR",
            budgetStage: null,
            usage: zeroUsage(),
          });
        } catch {
          // Lazy DB-owned expiry remains the backstop.
        }
      }
    }
  };

  const gateway = await withAcademyTeachingReleases(
    {
      classroom,
      includeResources: isCapabilityAuthorized(
        "PROFESSOR",
        "get_learning_resources",
        config.capabilities,
      ),
      includeMastery: isCapabilityAuthorized(
        "PROFESSOR",
        "get_current_mastery_state",
        config.capabilities,
      ),
    },
    async ({ release, manifest, reads }) => {
      capturedRelease = release;
      let memory: ClassroomMemory;
      try {
        memory = await listAcademyClassroomTurns(
          classroomId,
          TEACHING_CONTEXT_LIMITS.memoryTurns,
        );
      } catch (error) {
        providerResult = abstain(
          error instanceof ProfessorTeachingDenied &&
            error.code === "ACTIVITY_BLOCKED"
            ? "ACTIVITY_BLOCKED"
            : "POLICY_BLOCKED",
        );
        return;
      }
      if (memory.capacityReached) {
        providerResult = {
          outcome: "ABSTAINED",
          usage,
          reason: "POLICY_BLOCKED",
          classroomMemory: "CAPACITY_REACHED",
        };
        return;
      }
      const built = buildProfessorTeachingContext(
        {
          classroom,
          objectives: reads.objectives,
          mastery: reads.mastery,
          resources: reads.resources,
          turns: memory.turns,
          totalTurns: memory.totalTurns,
          unrecordedExchanges: memory.unrecordedExchanges,
          courseContextNotes: behaviour.config.courseContextNotes,
          behaviourVersion: behaviour.behaviourVersion,
          interaction,
        },
        profile.budgetPolicy.maxInputContextBytes,
      );
      if (!built.ok) {
        providerResult =
          built.reason === "MANDATORY_CONTEXT_EXCEEDS_BUDGET"
            ? { outcome: "BUDGET_BLOCKED", usage, stage: "PRE_CALL" }
            : abstain("POLICY_BLOCKED");
        return;
      }
      await governedProviderCall(release, built.context, manifest);
    },
  );

  // A release that failed its final recheck or closure discards the
  // output, but the real usage is still reconciled and returned.
  if (gateway.releaseFinalizationFailed || !gateway.ok) {
    const reason = gateway.releaseFinalizationFailed
      ? "CONTENT_RELEASE_UNAVAILABLE"
      : gateway.activityBlocked
        ? "ACTIVITY_BLOCKED"
        : "POLICY_BLOCKED";
    if (started && executionId && capturedRelease) {
      try {
        await attestProviderExecutionCommand(executionId, capturedRelease, {
          operation: "FINALIZE",
          state: "FAILED",
          reason,
          budgetStage: null,
          usage: lastKnownUsage(),
        });
      } catch {
        // Lazy DB-owned expiry remains the backstop.
      }
    }
    return {
      outcome: "ABSTAINED",
      usage: lastKnownUsage(),
      reason:
        reason === "ACTIVITY_BLOCKED" ? "ACTIVITY_BLOCKED" : "POLICY_BLOCKED",
    };
  }
  if (!providerResult) return abstain("POLICY_BLOCKED");
  if (!started || !executionId || !capturedRelease) return providerResult;

  // FINALIZE strictly after every release closed; only a database-confirmed
  // terminal state lets a success escape.
  try {
    const command = mapRuntimeResultToFinalizeCommand(providerResult);
    const snapshot = await attestProviderExecutionCommand(
      executionId,
      capturedRelease,
      { operation: "FINALIZE", ...command },
    );
    if (snapshot.state !== command.state)
      return {
        outcome: "ABSTAINED",
        usage: lastKnownUsage(),
        reason: "POLICY_BLOCKED",
      };
  } catch {
    return {
      outcome: "ABSTAINED",
      usage: lastKnownUsage(),
      reason: "POLICY_BLOCKED",
    };
  }
  const finished = providerResult as RuntimeResult;
  if (finished.outcome !== "SUCCEEDED") return finished;
  let recorded = false;
  if (Array.from(finished.response.outputText).length <= 12_000) {
    try {
      await recordAcademyTurn({
        executionId,
        classroomId,
        interaction,
        professorMessage: finished.response.outputText,
      });
      recorded = true;
    } catch {
      recorded = false;
    }
  }
  return {
    ...finished,
    classroomMemory: recorded ? "RECORDED" : "NOT_RECORDED",
  };
}

// PRODUCTION entrypoint: always the code-owned profile registry and
// provider resolution, with no override parameter.
export function executeAcademyProfessorClassroom(
  request: unknown,
): Promise<RuntimeResult> {
  return executeAcademyProfessorCore(request, {
    resolveProfile: resolveRuntimeProfile,
    resolveAdapter: resolveAdapterForProfile,
  });
}

// TEST-ONLY entrypoint; refuses to run under NODE_ENV=production.
export function executeAcademyProfessorClassroomWithTestOverrides(
  request: unknown,
  overrides: {
    resolveProfile?: ProfileResolver;
    resolveAdapter?: AdapterResolver;
  } = {},
): Promise<RuntimeResult> {
  if (process.env.NODE_ENV === "production")
    throw new Error(
      "executeAcademyProfessorClassroomWithTestOverrides must never run in production.",
    );
  return executeAcademyProfessorCore(request, {
    resolveProfile: overrides.resolveProfile ?? resolveRuntimeProfile,
    resolveAdapter: overrides.resolveAdapter ?? resolveAdapterForProfile,
  });
}
