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
  contextBytes,
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
  closeUnstartedProviderExecution,
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
  timezone: z.string().min(1).max(100),
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
// Missed-class recap and display-only class evidence (migration 075).
// ---------------------------------------------------------------------------
const recapResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    classroomId: z.uuid(),
    missedLessons: z
      .array(
        z.strictObject({
          lessonRef: z.string().max(80),
          lessonTitle: z.string().max(500),
          objectives: z.array(z.string().max(2000)).max(50),
        }),
      )
      .max(10),
  }),
  refusalSchema,
]);
export type MissedLessonRecap = {
  lessonTitle: string;
  objectives: string[];
};

// The missed lessons since the learner's last attended class: titles and
// objective descriptions only (minimum data), under the same admission and
// controlled-assessment firewall as every classroom read.
export async function readAcademyClassRecap(
  classroomId: string,
): Promise<MissedLessonRecap[]> {
  const parsed = recapResultSchema.safeParse(
    await rpc("get_my_academy_class_recap", {
      p_classroom_id: z.uuid().parse(classroomId),
    }),
  );
  if (!parsed.success) throw new ProfessorTeachingDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new ProfessorTeachingDenied(parsed.data.code);
  return parsed.data.missedLessons.map((lesson) => ({
    lessonTitle: lesson.lessonTitle,
    objectives: lesson.objectives,
  }));
}

export const CLASS_EVIDENCE_MARKER = "DUCELIO_CLASS_EVIDENCE";

// Code-owned, server-derived class directives added to serverContext. The
// recap is required only when the learner missed classes; the evidence line
// is optional, is removed before the learner sees the reply, and is
// display-only: it is never mastery, a grade, evidence or completion.
export function academyClassDirectives(missed: MissedLessonRecap[]) {
  return {
    authority: "AUTHORITATIVE_SERVER_DERIVED",
    missedClassRecap:
      missed.length > 0
        ? {
            required: true,
            note: "The learner missed the classes below since their last attended class. Begin with a concise recap of these objectives, then ask short mastery-check questions on them before continuing this lesson. A missed class is not completed by this recap.",
            missedLessons: missed,
          }
        : { required: false },
    classEvidenceLine: {
      optional: true,
      format: `${CLASS_EVIDENCE_MARKER} {"coveredObjectiveRefs":["<objectiveId>"],"check":{"objectiveRef":"<objectiveId>","correct":true}}`,
      note: `You may end the reply with exactly one final line in this format. coveredObjectiveRefs lists objectiveId values from serverContext.objectives that this reply actually taught. Include check only when the learner's latest message answered an understanding-check question you asked about that objective, with correct true or false; otherwise use "check":null. Ducelio removes this line before the learner sees the reply and records it as display-only class notes, never as mastery, a grade or evidence.`,
    },
  };
}

const classEvidenceProposalSchema = z.strictObject({
  coveredObjectiveRefs: z.array(z.uuid()).max(50),
  check: z
    .strictObject({ objectiveRef: z.uuid(), correct: z.boolean() })
    .nullable()
    .optional(),
});
export type ClassEvidenceProposal = {
  coveredObjectiveIds: string[];
  check: { objectiveId: string; correct: boolean } | null;
};

// Separates the optional final evidence line from the learner-visible
// reply and validates it against the lesson's own objectives. Anything
// malformed, outside the lesson or empty is dropped (never guessed).
export function extractClassEvidence(
  outputText: string,
  lessonObjectiveIds: readonly string[],
): { visibleText: string; proposal: ClassEvidenceProposal | null } {
  const lines = outputText.replace(/\s+$/u, "").split("\n");
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (!last.startsWith(`${CLASS_EVIDENCE_MARKER} `))
    return { visibleText: outputText, proposal: null };
  const visibleText = lines.slice(0, -1).join("\n").replace(/\s+$/u, "");
  if (visibleText.length === 0)
    return { visibleText: outputText, proposal: null };
  let raw: unknown;
  try {
    raw = JSON.parse(last.slice(CLASS_EVIDENCE_MARKER.length + 1));
  } catch {
    return { visibleText, proposal: null };
  }
  const parsed = classEvidenceProposalSchema.safeParse(raw);
  if (!parsed.success) return { visibleText, proposal: null };
  const allowed = new Set(lessonObjectiveIds.map((id) => id.toLowerCase()));
  const covered = [
    ...new Set(
      parsed.data.coveredObjectiveRefs
        .map((id) => id.toLowerCase())
        .filter((id) => allowed.has(id)),
    ),
  ].sort();
  const check =
    parsed.data.check &&
    allowed.has(parsed.data.check.objectiveRef.toLowerCase())
      ? {
          objectiveId: parsed.data.check.objectiveRef.toLowerCase(),
          correct: parsed.data.check.correct,
        }
      : null;
  if (covered.length === 0 && !check) return { visibleText, proposal: null };
  return { visibleText, proposal: { coveredObjectiveIds: covered, check } };
}

async function recordAcademyClassEvidence(input: {
  executionId: string;
  classroomId: string;
  proposal: ClassEvidenceProposal;
}): Promise<void> {
  const actor = await teachingStudentId();
  const c = teachingController();
  const executionId = z.uuid().parse(input.executionId).toLowerCase();
  const classroomId = z.uuid().parse(input.classroomId).toLowerCase();
  const covered = [...new Set(input.proposal.coveredObjectiveIds)].sort();
  const check = input.proposal.check;
  const canonical = [
    "DUCELIO_ACADEMY_CLASS_EVIDENCE_HMAC_SHA256_V1",
    "PROFESSOR",
    c.keyId,
    actor,
    executionId,
    classroomId,
    covered.join(","),
    check ? check.objectiveId : "NONE",
    check ? String(check.correct) : "NONE",
    String(c.issuedAt),
    String(c.expiresAt),
  ].join("\n");
  const parsed = teachingRpcResultSchema.safeParse(
    await rpc("record_my_academy_class_evidence", {
      p_key_id: c.keyId,
      p_execution_id: executionId,
      p_classroom_id: classroomId,
      p_covered_objective_ids: covered,
      p_check_objective_id: check ? check.objectiveId : null,
      p_check_correct: check ? check.correct : null,
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
        // A release is COMPLETED only when the whole governed use under it
        // succeeded: an inner failure aborts every enclosing release too.
        if (!inner.ok)
          throw new ProfessorTeachingDenied(
            inner.activityBlocked ? "ACTIVITY_BLOCKED" : "INNER_RELEASE_FAILED",
          );
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
  let lessonObjectiveIds: string[] = [];
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
      // Nothing has STARTED: an admitted execution, or one whose AUTHORIZE
      // response was lost, is abandoned at once (migration 064) unless the
      // database already closed it.
      if (
        (authorized || error.code === "SERVICE_UNAVAILABLE") &&
        !(error instanceof ProviderExecutionDenied && error.databaseTerminal)
      )
        await closeUnstartedProviderExecution(
          executionId,
          release,
          "INTERNAL_ERROR",
        );
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
      // Missed-class recap (migration 075), read while every release is
      // ACTIVE under the same admission and firewall as the other reads.
      let missed: MissedLessonRecap[];
      try {
        missed = await readAcademyClassRecap(classroomId);
      } catch (error) {
        providerResult = abstain(
          error instanceof ProfessorTeachingDenied &&
            error.code === "ACTIVITY_BLOCKED"
            ? "ACTIVITY_BLOCKED"
            : "POLICY_BLOCKED",
        );
        return;
      }
      lessonObjectiveIds = reads.objectives.objectives.map(
        (objective) => objective.objectiveId,
      );
      const buildWith = (directives: Record<string, unknown> | null) => {
        const reserved = directives
          ? contextBytes({ academyClass: directives })
          : 0;
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
          profile.budgetPolicy.maxInputContextBytes - reserved,
        );
        if (!built.ok || !directives) return built;
        const serverContext = built.context.serverContext as Record<
          string,
          unknown
        >;
        return {
          ...built,
          context: {
            ...built.context,
            serverContext: { ...serverContext, academyClass: directives },
          },
        };
      };
      // The recap and evidence directives never displace mandatory context:
      // they are dropped (recap first) rather than blocking the class.
      let built = buildWith(academyClassDirectives(missed));
      if (!built.ok && missed.length > 0)
        built = buildWith(academyClassDirectives([]));
      if (!built.ok) built = buildWith(null);
      if (!built.ok) {
        providerResult =
          built.reason === "MANDATORY_CONTEXT_EXCEEDS_BUDGET"
            ? { outcome: "BUDGET_BLOCKED", usage, stage: "PRE_CALL" }
            : abstain("POLICY_BLOCKED");
        return;
      }
      await governedProviderCall(release, built.context, manifest);
      // Admission is re-proven after the provider call, while every release
      // is still ACTIVE: a revocation (for example a refund), a closed
      // enrolment, a timetable change that withdrew the lesson, or a
      // controlled assessment that began during the call discards the
      // output. Throwing here aborts the releases, and the real usage is
      // still finalized below.
      await getAcademyClassroomState(classroomId);
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
  // The optional evidence line is removed before the learner sees or the
  // classroom records the reply; it is validated against this lesson's own
  // objectives here and again by the database.
  const { visibleText, proposal } = extractClassEvidence(
    finished.response.outputText,
    lessonObjectiveIds,
  );
  let recorded = false;
  if (Array.from(visibleText).length <= 12_000) {
    try {
      await recordAcademyTurn({
        executionId,
        classroomId,
        interaction,
        professorMessage: visibleText,
      });
      recorded = true;
    } catch {
      recorded = false;
    }
  }
  if (recorded && proposal) {
    try {
      await recordAcademyClassEvidence({ executionId, classroomId, proposal });
    } catch {
      // Display-only notes: a refusal never affects the recorded exchange.
    }
  }
  return {
    ...finished,
    response: { ...finished.response, outputText: visibleText },
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
