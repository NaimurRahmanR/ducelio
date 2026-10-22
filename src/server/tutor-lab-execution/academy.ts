import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  TUTOR_LAB_ALLOWED_REASONS,
  TUTOR_LAB_EXECUTION_DB_CEILING,
  learnerSupportMessageSchema,
  mapRuntimeResultToTutorLabFinalizeCommand,
  mapRuntimeResultToTutorLabOutcome,
  tutorLabHandoffReasonSchema,
  tutorLabRoleSchema,
  TutorLabExecutionDenied,
  type TutorLabRole,
} from "@/domain/tutor-lab-execution";
import {
  zeroUsage,
  type ProviderAdapter,
  type RuntimeResult,
} from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";
import { isCapabilityAuthorized } from "@/domain/academic-capability-policy";
import { buildTutorLabProviderContext } from "@/domain/tutor-lab-provider-context";
import { roleBaselineFor } from "@/domain/agent-behaviour";
import { requireStudentPrincipal } from "../identity";
import { createSupabase } from "../supabase";
import {
  attestTutorLabExecutionCommand,
  closeUnstartedTutorLabExecution,
} from "./authority";
import type { TutorLabContentRelease } from "./release";
import {
  resolveAdapterForProfile,
  resolveRoleBoundRuntimeProfile,
  resolveRuntimeProfile,
} from "../academic-runtime/profile-registry";
import { runGovernedProviderExecution } from "../academic-runtime/runtime";
import { verifiedLearnerBehaviourBinding } from "../agent-behaviour-config";
import {
  teachingController,
  teachingRpcResultSchema,
  teachingStudentId,
} from "../academic-runtime/professor-teaching";

// Ducelio Academy (B2C) AI Tutor and AI Lab Instructor (migration 063): the
// governed Tutor/Lab execution for an individual Academy enrolment, with no
// cohort, handoff or human instructor.
//
// It is the same pipeline as the cohort Tutor/Lab support in ./index.ts,
// composed from the same reviewed parts rather than a second engine: an
// idempotency reservation before any provider work -> a release in the
// shared tutor_lab_content_releases table, admitted by the learner's own
// Academy support request (ownership, ACTIVE unrevoked enrolment, lesson
// released by the current timetable, practical started, no controlled
// assessment) -> one bounded context read in the cohort Tutor/Lab context
// shapes -> the stored configuration and frozen behaviour binding ->
// role-bound runtime profile -> migration 028's AUTHORIZE / START, the
// provider runtime, release close (admission re-proven) and FINALIZE with
// the real usage -> the attested learner-visible exchange. It writes no
// evidence, mastery, progress, grade or completion.

export const academySupportRequestSchema = z.strictObject({
  requestId: z.uuid(),
  message: learnerSupportMessageSchema,
  idempotencyKey: z.uuid(),
});
export type AcademySupportRequest = z.infer<typeof academySupportRequestSchema>;

export type AcademySupportResult =
  | {
      status: "SUCCEEDED";
      text: string;
      role: TutorLabRole;
      // The reply is shown either way; NOT_RECORDED means it could not be
      // kept in this conversation's record.
      record: "RECORDED" | "NOT_RECORDED";
    }
  | { status: "ACTIVITY_BLOCKED" }
  | { status: "UNAVAILABLE" }
  | { status: "ESCALATED" }
  | { status: "RETRY_LATER" }
  | { status: "DUPLICATE" };

export class AcademySupportDenied extends Error {
  constructor(readonly code: string) {
    super("Academy support unavailable.");
    this.name = "AcademySupportDenied";
  }
}

type ProfileResolver = (ref: string) => RuntimeProfile | null;
type AdapterResolver = (profile: RuntimeProfile) => ProviderAdapter | null;

const refusal = z.strictObject({ ok: z.literal(false), code: z.string() });
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await (await createSupabase()).rpc(name, args);
  if (error) throw new AcademySupportDenied("SERVICE_UNAVAILABLE");
  return data as unknown;
}

// The exact cohort Tutor/Lab context shapes (src/server/tutor-lab-execution
// /context.ts), strictly validated, so the shared provider-context builder
// is reused unchanged.
const lesson = z.strictObject({
  title: z.string().max(500),
  position: z.number().int().positive(),
});
const objective = z.strictObject({
  description: z.string().max(4000),
  position: z.number().int().positive(),
});
const tutorContextSchema = z.strictObject({
  role: z.literal("TUTOR"),
  reasonCode: z.literal("OBJECTIVE_REINFORCEMENT"),
  lesson,
  objectives: z.array(objective).max(50),
  requestedObjective: z.strictObject({ description: z.string().max(4000) }),
  resources: z
    .array(
      z.strictObject({
        title: z.string().max(200),
        kind: z.enum(["LECTURE_NOTE", "REFERENCE_LINK"]),
      }),
    )
    .max(5)
    .nullable(),
});
const labContextSchema = z.strictObject({
  role: z.literal("LAB_INSTRUCTOR"),
  reasonCode: z.literal("PRACTICAL_HELP"),
  lesson,
  practical: z.strictObject({
    kind: z.enum(["EXERCISE", "PRACTICAL_LAB"]),
    title: z.string().min(1).max(200),
    instructions: z.string().min(1).max(12000),
  }),
  objectives: z.array(objective).min(1).max(250),
});
const contextSchema = z.discriminatedUnion("role", [
  tutorContextSchema,
  labContextSchema,
]);

const grantSchema = z.strictObject({
  ok: z.literal(true),
  release_id: z.uuid(),
  student_id: z.uuid(),
  invocation_id: z.uuid(),
  role: tutorLabRoleSchema,
  reason_code: tutorLabHandoffReasonSchema,
  request_id: z.uuid(),
  enrolment_id: z.uuid(),
  lesson_id: z.uuid(),
  objective_id: z.uuid().nullable(),
});

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

// Before any release or provider work; the fingerprint is domain-separated
// from the cohort reservation material.
async function reserve(payload: AcademySupportRequest): Promise<boolean> {
  const parsed = z
    .union([
      z.strictObject({ ok: z.literal(true), duplicate: z.boolean() }),
      refusal,
    ])
    .safeParse(
      await rpc("reserve_my_academy_support_interaction", {
        p_request_id: payload.requestId,
        p_idempotency_key: payload.idempotencyKey,
        p_request_hash: sha256(
          `ACADEMY_SUPPORT_V1\n${payload.requestId}\n${payload.message}`,
        ),
      }),
    );
  if (!parsed.success) throw new AcademySupportDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new AcademySupportDenied(parsed.data.code);
  return !parsed.data.duplicate;
}

async function beginRelease(requestId: string) {
  const invocationId = randomUUID();
  const parsed = z.union([grantSchema, refusal]).safeParse(
    await rpc("begin_my_academy_support_release", {
      p_invocation_id: invocationId,
      p_request_id: requestId,
    }),
  );
  if (!parsed.success) throw new AcademySupportDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new AcademySupportDenied(parsed.data.code);
  const g = parsed.data;
  if (
    g.request_id !== requestId ||
    g.invocation_id !== invocationId ||
    !TUTOR_LAB_ALLOWED_REASONS[g.role].includes(g.reason_code)
  )
    throw new AcademySupportDenied("CONTEXT_CONFLICT");
  // The shared Tutor/Lab release identity, as the existing attestation
  // transport consumes it (learner, release, invocation and role).
  const release: TutorLabContentRelease = {
    releaseId: g.release_id,
    studentId: g.student_id,
    invocationId: g.invocation_id,
    role: g.role,
    reasonCode: g.reason_code,
    enrolmentId: g.enrolment_id,
    lessonId: g.lesson_id,
    objectiveId: g.objective_id,
    practicalId: null,
  };
  return release;
}

async function closeRelease(
  release: TutorLabContentRelease,
  complete: boolean,
): Promise<void> {
  const parsed = z
    .union([
      z.strictObject({
        ok: z.literal(true),
        state: z.enum(["COMPLETED", "ABORTED", "EXPIRED", "BLOCKED"]),
        transitioned: z.boolean(),
      }),
      refusal,
    ])
    .safeParse(
      await rpc("close_my_academy_support_release", {
        p_release_id: release.releaseId,
        p_complete: complete,
      }),
    );
  if (
    !parsed.success ||
    !parsed.data.ok ||
    (complete
      ? parsed.data.state !== "COMPLETED" || !parsed.data.transitioned
      : !["ABORTED", "EXPIRED"].includes(parsed.data.state))
  )
    throw new AcademySupportDenied("RELEASE_NOT_FINALIZED");
}

async function readContext(release: TutorLabContentRelease) {
  const parsed = z
    .union([
      z.strictObject({ ok: z.literal(true), data: z.unknown() }),
      refusal,
    ])
    .safeParse(
      await rpc("read_my_academy_support_context", {
        p_release_id: release.releaseId,
      }),
    );
  if (!parsed.success) throw new AcademySupportDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new AcademySupportDenied(parsed.data.code);
  const context = contextSchema.parse(parsed.data.data);
  if (context.role !== release.role)
    throw new AcademySupportDenied("CONTEXT_CONFLICT");
  return context;
}

const agentSchema = z.union([
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
  refusal,
]);
async function readAgent(enrolmentId: string, role: TutorLabRole) {
  const parsed = agentSchema.safeParse(
    await rpc("get_my_academy_support_agent", {
      p_enrolment_id: enrolmentId,
      p_role: role,
    }),
  );
  if (!parsed.success) throw new AcademySupportDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new AcademySupportDenied(parsed.data.code);
  return {
    config: parsed.data.config,
    behaviour: verifiedLearnerBehaviourBinding(parsed.data.behaviour, role),
  };
}

async function recordTurn(input: {
  executionId: string;
  requestId: string;
  learnerMessage: string;
  agentMessage: string;
}) {
  const actor = await teachingStudentId();
  const c = teachingController();
  const executionId = z.uuid().parse(input.executionId).toLowerCase();
  const requestId = z.uuid().parse(input.requestId).toLowerCase();
  const canonical = [
    "DUCELIO_ACADEMY_SUPPORT_TURN_HMAC_SHA256_V1",
    c.keyId,
    actor,
    executionId,
    requestId,
    sha256(input.learnerMessage),
    sha256(input.agentMessage),
    String(c.issuedAt),
    String(c.expiresAt),
  ].join("\n");
  const parsed = teachingRpcResultSchema.safeParse(
    await rpc("record_my_academy_support_turn", {
      p_key_id: c.keyId,
      p_execution_id: executionId,
      p_request_id: requestId,
      p_learner_message: input.learnerMessage,
      p_agent_message: input.agentMessage,
      p_issued_at: c.issuedAt,
      p_expires_at: c.expiresAt,
      p_mac: c.sign(canonical),
    }),
  );
  if (!parsed.success || !parsed.data.ok)
    throw new AcademySupportDenied("NOT_RECORDED");
}

const isActivityBlocked = (error: unknown) =>
  (error instanceof AcademySupportDenied ||
    error instanceof TutorLabExecutionDenied) &&
  error.code === "ACTIVITY_BLOCKED";

async function executeAcademySupportCore(
  request: unknown,
  deps: { resolveProfile: ProfileResolver; resolveAdapter: AdapterResolver },
): Promise<AcademySupportResult> {
  await requireStudentPrincipal();
  const payload = academySupportRequestSchema.parse(request);

  let proceed: boolean;
  try {
    proceed = await reserve(payload);
  } catch (error) {
    return isActivityBlocked(error)
      ? { status: "ACTIVITY_BLOCKED" }
      : { status: "UNAVAILABLE" };
  }
  if (!proceed) return { status: "DUPLICATE" };

  let release: TutorLabContentRelease;
  try {
    release = await beginRelease(payload.requestId);
  } catch (error) {
    return isActivityBlocked(error)
      ? { status: "ACTIVITY_BLOCKED" }
      : { status: "UNAVAILABLE" };
  }

  let contextOk = false;
  let providerResult: RuntimeResult | null = null;
  let executionId: string | null = null;
  let authorized = false;
  let started = false;
  const abstain = (reason: "ACTIVITY_BLOCKED" | "POLICY_BLOCKED") => {
    providerResult = { outcome: "ABSTAINED", usage: zeroUsage(), reason };
  };

  try {
    const context = await readContext(release);
    contextOk = true;
    const { config, behaviour } = await readAgent(
      release.enrolmentId,
      release.role,
    );
    // The code-owned catalogue AND the stored configuration must both
    // allow every read that contributed to this context.
    const required =
      context.role === "TUTOR" && context.resources !== null
        ? [
            "get_lesson_context",
            "get_lesson_objectives",
            "get_learning_resources",
          ]
        : ["get_lesson_context", "get_lesson_objectives"];
    const permitted =
      config.enabled &&
      required.every((capability) =>
        isCapabilityAuthorized(release.role, capability, config.capabilities),
      ) &&
      // An Academy course has no instructor or reviewer to escalate to.
      config.escalationPolicy === "NONE" &&
      roleBaselineFor(release.role, behaviour.behaviourVersion) !== null;
    if (!permitted) {
      abstain("POLICY_BLOCKED");
    } else {
      const profile = resolveRoleBoundRuntimeProfile(
        release.role,
        config.modelProfileRef,
        (ref) => deps.resolveProfile(ref),
      );
      if (!profile) {
        providerResult = {
          outcome: "ABSTAINED",
          usage: zeroUsage(),
          reason: "UNKNOWN_MODEL_PROFILE",
        };
      } else {
        executionId = randomUUID();
        const budget = {
          maxProviderCalls: TUTOR_LAB_EXECUTION_DB_CEILING.maxProviderCalls,
          maxOutputTokens: Math.min(
            profile.budgetPolicy.maxOutputTokens,
            TUTOR_LAB_EXECUTION_DB_CEILING.maxOutputTokens,
          ),
          maxEstimatedCostMicrousd: Math.min(
            profile.budgetPolicy.maxEstimatedCostMicrousd,
            TUTOR_LAB_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd,
          ),
        };
        try {
          await attestTutorLabExecutionCommand(
            release.role,
            executionId,
            release,
            { operation: "AUTHORIZE", budget },
          );
          authorized = true;
          await attestTutorLabExecutionCommand(
            release.role,
            executionId,
            release,
            { operation: "START" },
          );
          started = true;
          providerResult = await runGovernedProviderExecution(
            deps.resolveAdapter(profile),
            {
              role: release.role,
              capability: "tutor_lab_support",
              // No Professor academic handoff exists for an Academy
              // request, so the context says so explicitly.
              context: buildTutorLabProviderContext(
                context,
                payload.message,
                behaviour.config.courseContextNotes,
                profile.budgetPolicy.maxInputContextBytes,
                behaviour.behaviourVersion,
                null,
              ),
              behaviour: behaviour,
            },
            {
              ...profile.budgetPolicy,
              maxProviderCalls: budget.maxProviderCalls,
              maxOutputTokens: budget.maxOutputTokens,
              maxEstimatedCostMicrousd: budget.maxEstimatedCostMicrousd,
            },
          );
        } catch (error) {
          if (!(error instanceof TutorLabExecutionDenied)) throw error;
          abstain(
            error.code === "ACTIVITY_BLOCKED"
              ? "ACTIVITY_BLOCKED"
              : "POLICY_BLOCKED",
          );
          // As the cohort path: nothing has STARTED, so an admitted
          // execution, or one whose AUTHORIZE response was lost, is
          // abandoned at once (migration 064) unless the database already
          // closed it.
          if (
            (authorized || error.code === "SERVICE_UNAVAILABLE") &&
            !error.databaseTerminal
          )
            await closeUnstartedTutorLabExecution(
              release.role,
              executionId,
              release,
              "INTERNAL_ERROR",
            );
        }
      }
    }
  } catch (error) {
    contextOk = false;
    abstain(isActivityBlocked(error) ? "ACTIVITY_BLOCKED" : "POLICY_BLOCKED");
  }

  // The release closes COMPLETED only if admission still holds now, after
  // the provider call; otherwise the reply is discarded and the real usage
  // is still finalized.
  let closed = false;
  try {
    await closeRelease(release, contextOk);
    closed = true;
  } catch {
    closed = false;
  }
  const result = providerResult as RuntimeResult | null;
  if (!closed) {
    if (started && executionId) {
      try {
        await attestTutorLabExecutionCommand(
          release.role,
          executionId,
          release,
          {
            operation: "FINALIZE",
            state: "FAILED",
            reason: "CONTENT_RELEASE_UNAVAILABLE",
            budgetStage: null,
            usage: result?.usage ?? zeroUsage(),
          },
        );
      } catch {
        // Lazy DB-owned expiry remains the backstop.
      }
    }
    return { status: "UNAVAILABLE" };
  }
  if (!result) return { status: "UNAVAILABLE" };
  const outcome = mapRuntimeResultToTutorLabOutcome(result);
  // Nothing was admitted to the provider: the abstention is the whole truth.
  if (!started || !executionId)
    return outcome.kind === "SUCCEEDED"
      ? { status: "UNAVAILABLE" }
      : { status: outcome.kind };

  try {
    const command = mapRuntimeResultToTutorLabFinalizeCommand(result);
    const snapshot = await attestTutorLabExecutionCommand(
      release.role,
      executionId,
      release,
      { operation: "FINALIZE", ...command },
    );
    if (snapshot.state !== command.state) return { status: "RETRY_LATER" };
  } catch {
    return { status: "RETRY_LATER" };
  }
  if (outcome.kind !== "SUCCEEDED") return { status: outcome.kind };
  let record: "RECORDED" | "NOT_RECORDED" = "NOT_RECORDED";
  if (Array.from(outcome.text).length <= 12_000) {
    try {
      await recordTurn({
        executionId,
        requestId: payload.requestId,
        learnerMessage: payload.message,
        agentMessage: outcome.text,
      });
      record = "RECORDED";
    } catch {
      record = "NOT_RECORDED";
    }
  }
  return {
    status: "SUCCEEDED",
    text: outcome.text,
    role: release.role,
    record,
  };
}

// PRODUCTION entrypoint: always the code-owned profile registry and
// provider resolution.
export function executeAcademySupport(
  request: unknown,
): Promise<AcademySupportResult> {
  return executeAcademySupportCore(request, {
    resolveProfile: resolveRuntimeProfile,
    resolveAdapter: resolveAdapterForProfile,
  });
}

// TEST-ONLY entrypoint; refuses to run under NODE_ENV=production.
export function executeAcademySupportWithTestOverrides(
  request: unknown,
  overrides: {
    resolveProfile?: ProfileResolver;
    resolveAdapter?: AdapterResolver;
  } = {},
): Promise<AcademySupportResult> {
  if (process.env.NODE_ENV === "production")
    throw new Error(
      "executeAcademySupportWithTestOverrides must never run in production.",
    );
  return executeAcademySupportCore(request, {
    resolveProfile: overrides.resolveProfile ?? resolveRuntimeProfile,
    resolveAdapter: overrides.resolveAdapter ?? resolveAdapterForProfile,
  });
}
