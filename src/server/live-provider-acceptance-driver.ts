import "server-only";
import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/env";
import type {
  ProviderAdapter,
  RuntimeBudgetPolicy,
  RuntimeResult,
} from "@/domain/academic-runtime";
import type {
  RuntimeAdapterKind,
  RuntimeProfile,
} from "@/domain/academic-runtime-profile";
import type { AgentRole } from "@/domain/academic-capability-policy";
import type {
  PlatformAgentRole,
  operationsEngineerCapabilityCatalogue,
} from "@/domain/platform-ai-policy";
import {
  examinerProviderContext,
  parseExaminerAssessmentProviderOutput,
  validateExaminerAssessmentMarks,
  type ExaminerAssessmentContext,
} from "@/domain/commercial-v1-examiner-grading";
import type { TUTOR_LAB_ALLOWED_REASONS } from "@/domain/tutor-lab-execution";
import type { LabContext } from "@/server/tutor-lab-execution/context";
import {
  resolveAdapterForProfile,
  resolvePlatformRuntimeProfile,
  resolveRoleBoundRuntimeProfile,
} from "@/server/academic-runtime/profile-registry";
import { runGovernedProviderExecution } from "@/server/academic-runtime/runtime";
import {
  defaultEffectiveBehaviour,
  isBehaviourRole,
} from "@/domain/agent-behaviour";

// ============================================================================
// Commercial V1 LIVE PROVIDER acceptance: the fail-closed gate and the three
// fixed smoke operations behind src/app/api/acceptance/live-provider/
// route.ts. Its only caller is scripts/acceptance/live-provider.mjs
// (`npm run acceptance:live-provider`), which starts a local `next dev`
// child for exactly one explicitly double-authorized run.
//
// This module adds no provider logic of its own. Each smoke reaches the
// EXISTING production path: resolveRoleBoundRuntimeProfile (academic
// AgentRole profiles) or resolvePlatformRuntimeProfile (the platform-level
// Operations Engineer profile) -> resolveAdapterForProfile ->
// runGovernedProviderExecution, i.e. the same
// native OpenAI Responses / Anthropic Messages adapters, request
// construction, response schemas, tariffs, failure mapping and budget/
// deadline enforcement the product uses. The Examiner smoke then applies
// the existing strict parseExaminerAssessmentProviderOutput and
// validateExaminerAssessmentMarks. No caller can choose a provider, model,
// profile, endpoint, key, tariff, budget, role, capability or context: the
// route accepts one of three operation names and nothing else.
//
// Unlike the examiner-app gate (src/server/acceptance-app-driver.ts) this
// deliberately does NOT attest a provider redirect -- this surface exists
// to produce genuine provider traffic -- and it refuses to run in a process
// that carries the examiner-app stub/redirect markers, so a stubbed
// response can never be reported as live evidence. The route answers 404
// unless EVERY one of these holds for the request, checked before the body
// is read or any provider work starts:
//
//   1. ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED is exactly "true" (set only
//      in the driver's own child process, never by any deployment);
//   2. NODE_ENV is not "production";
//   3. ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN is a 64-hex per-run secret and
//      the request presents exactly that value (constant-time comparison);
//   4. ACCEPTANCE_LIVE_PROVIDER_OPT_IN is exactly "true";
//   5. ACCEPTANCE_LIVE_PROVIDER_AUTHORIZED is exactly "true" -- the
//      driver's propagation of the operator's explicit
//      --authorize-live-provider command-line flag;
//   6. no examiner-app driver / provider-stub redirect marker is present;
//   7. APP_URL and the request's own Host are loopback;
//   8. the request carries no Origin / Sec-Fetch-Site header.
// ============================================================================

export const LIVE_PROVIDER_DRIVER_HEADER = "x-ducelio-live-provider-driver";

const TOKEN = /^[0-9a-f]{64}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Present only in an examiner-app acceptance child, whose preload redirects
// provider traffic to a deterministic local stub.
const STUB_REDIRECT_MARKERS = [
  "ACCEPTANCE_APP_DRIVER_ENABLED",
  "ACCEPTANCE_APP_DRIVER_TOKEN",
  "ACCEPTANCE_PROVIDER_STUB_URL",
  "ACCEPTANCE_PROVIDER_REDIRECT_TOKEN",
] as const;

function isLoopbackHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

export function liveProviderAcceptanceRequestAllowed(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED !== "true") return false;
  if (env.NODE_ENV === "production") return false;
  const expected = env.ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN ?? "";
  if (!TOKEN.test(expected)) return false;
  if (env.ACCEPTANCE_LIVE_PROVIDER_OPT_IN !== "true") return false;
  if (env.ACCEPTANCE_LIVE_PROVIDER_AUTHORIZED !== "true") return false;
  if (STUB_REDIRECT_MARKERS.some((name) => (env[name] ?? "") !== ""))
    return false;
  const supplied = request.headers.get(LIVE_PROVIDER_DRIVER_HEADER) ?? "";
  if (!TOKEN.test(supplied)) return false;
  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
    return false;
  let appHost: string;
  try {
    appHost = new URL(config().appUrl).host;
  } catch {
    return false;
  }
  if (!isLoopbackHost(appHost)) return false;
  if (!isLoopbackHost(request.headers.get("host"))) return false;
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site"))
    return false;
  return true;
}

// ---------------------------------------------------------------------------
// The three fixed smoke operations. Every value below is server-owned. The
// expected profile, adapter, model (and OpenAI reasoning effort) AND the
// exact execution envelope are pinned: any drift in the resolved production
// profile -- e.g. maxAttempts 2, which could otherwise make a second billable
// request -- fails closed as PROFILE_MISMATCH before the adapter is resolved
// or the runtime runs. Tariffs are deliberately NOT pinned here; they stay
// owned by the registry/adapter and only affect the reported cost, which the
// runtime and the envelope check below already bound.
// ---------------------------------------------------------------------------
export const LIVE_PROVIDER_SMOKE_OPERATIONS = [
  "OPENAI_EXAMINER_SMOKE",
  "ANTHROPIC_LAB_SMOKE",
  "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
] as const;
export type LiveProviderSmokeOperation =
  (typeof LIVE_PROVIDER_SMOKE_OPERATIONS)[number];

type SmokeEnvelope = {
  readonly maxProviderCalls: number;
  readonly maxAttempts: number;
  readonly maxOutputTokens: number;
  readonly maxEstimatedCostMicrousd: number;
  readonly totalDeadlineMs: number;
};

// Two profile planes, each resolved only by its own production resolver:
// ACADEMIC plans carry an academic AgentRole (resolveRoleBoundRuntimeProfile);
// the PLATFORM plan carries a PlatformAgentRole (resolvePlatformRuntimeProfile)
// and is never cast into, or reachable through, the academic resolver.
type SmokePlanBase = {
  readonly surface: string;
  readonly providerFamily: "OPENAI" | "ANTHROPIC";
  readonly capability: string;
  readonly profileRef: string;
  readonly adapterKind: RuntimeAdapterKind;
  readonly modelId: string;
  // OPENAI_RESPONSES only; null for Anthropic, which has no such setting.
  readonly reasoningEffort: string | null;
  readonly envelope: SmokeEnvelope;
};
type SmokePlan =
  | (SmokePlanBase & {
      readonly profilePlane: "ACADEMIC";
      readonly role: AgentRole;
    })
  | (SmokePlanBase & {
      readonly profilePlane: "PLATFORM";
      readonly role: PlatformAgentRole;
    });

// Typed against the existing Operations Engineer catalogue (no new
// capability, no second allowlist): an observation capability only.
const SYNTHETIC_OPERATIONS_ENGINEER_CAPABILITY: (typeof operationsEngineerCapabilityCatalogue)[number] =
  "read_system_health";

export const LIVE_PROVIDER_SMOKE_PLANS = Object.freeze({
  OPENAI_EXAMINER_SMOKE: Object.freeze({
    surface: "LIVE_PROVIDER:OPENAI_EXAMINER",
    providerFamily: "OPENAI",
    profilePlane: "ACADEMIC",
    role: "EXAMINER",
    capability: "grade_controlled_assessment",
    profileRef: "EXAMINER_COMMERCIAL_V1",
    adapterKind: "OPENAI_RESPONSES",
    modelId: "gpt-5.6-luna",
    reasoningEffort: "medium",
    envelope: Object.freeze({
      maxProviderCalls: 1,
      maxAttempts: 1,
      maxOutputTokens: 1200,
      maxEstimatedCostMicrousd: 50_000,
      totalDeadlineMs: 15_000,
    }),
  }),
  ANTHROPIC_LAB_SMOKE: Object.freeze({
    surface: "LIVE_PROVIDER:ANTHROPIC_LAB",
    providerFamily: "ANTHROPIC",
    profilePlane: "ACADEMIC",
    role: "LAB_INSTRUCTOR",
    capability: "tutor_lab_support",
    profileRef: "LAB_INSTRUCTOR_COMMERCIAL_V1",
    adapterKind: "ANTHROPIC_MESSAGES",
    modelId: "claude-sonnet-5",
    reasoningEffort: null,
    envelope: Object.freeze({
      maxProviderCalls: 1,
      maxAttempts: 1,
      maxOutputTokens: 700,
      maxEstimatedCostMicrousd: 40_000,
      totalDeadlineMs: 15_000,
    }),
  }),
  ANTHROPIC_OPERATIONS_ENGINEER_SMOKE: Object.freeze({
    surface: "LIVE_PROVIDER:ANTHROPIC_OPERATIONS_ENGINEER",
    providerFamily: "ANTHROPIC",
    profilePlane: "PLATFORM",
    role: "OPERATIONS_ENGINEER",
    capability: SYNTHETIC_OPERATIONS_ENGINEER_CAPABILITY,
    profileRef: "OPERATIONS_ENGINEER_PLATFORM_V1",
    adapterKind: "ANTHROPIC_MESSAGES",
    modelId: "claude-opus-5-5",
    reasoningEffort: null,
    envelope: Object.freeze({
      maxProviderCalls: 1,
      maxAttempts: 1,
      maxOutputTokens: 1200,
      maxEstimatedCostMicrousd: 100_000,
      totalDeadlineMs: 20_000,
    }),
  }),
} as const satisfies Record<LiveProviderSmokeOperation, SmokePlan>);

// Synthetic, labelled demo content only: no real learner, course, question
// bank or official exam content, and no personal data. The identifiers are
// fixed UUID-shaped constants that exist in no database. Never returned to
// the caller.
export const SYNTHETIC_EXAMINER_CONTEXT: ExaminerAssessmentContext = {
  attemptId: "5a1e0000-0000-4000-8000-00000000a001",
  assessmentId: "5a1e0000-0000-4000-8000-00000000a002",
  component: "SYNTHETIC_LIVE_PROVIDER_SMOKE",
  title: "Synthetic live-provider smoke check (demo content)",
  instructions:
    "Synthetic acceptance check, not real course content. Answer the arithmetic question.",
  questions: [
    {
      questionId: "5a1e0000-0000-4000-8000-00000000a003",
      position: 1,
      prompt: "What is 2 + 3?",
      maxMarks: 2,
      expectedAnswer: "5",
      markingGuidance: "Award 2 marks for the answer 5, otherwise 0.",
      responseBody: "5",
    },
  ],
  objectiveMarks: [],
  objectiveQuestionCount: 0,
};

// Typed against the existing domain authority (no second allowlist): the
// synthetic Lab reason must be one the production release admits for
// LAB_INSTRUCTOR, so it can never drift to a Tutor-only reason.
const SYNTHETIC_LAB_REASON: (typeof TUTOR_LAB_ALLOWED_REASONS)["LAB_INSTRUCTOR"][number] =
  "PRACTICAL_HELP";

export const SYNTHETIC_LAB_CONTEXT: LabContext & { learnerMessage: string } = {
  role: "LAB_INSTRUCTOR",
  reasonCode: SYNTHETIC_LAB_REASON,
  lesson: { title: "Synthetic smoke lesson (demo content)", position: 1 },
  practical: {
    kind: "EXERCISE",
    title: "Synthetic smoke exercise (demo content)",
    instructions:
      "Write a short list of three fruits in alphabetical order. Synthetic acceptance exercise, not real course content.",
  },
  objectives: [
    { description: "Sort a short list of words alphabetically.", position: 1 },
  ],
  learnerMessage: "What is the first step to put words in alphabetical order?",
};

// A tiny fixed, labelled synthetic systems snapshot. It is NOT read from any
// database, log, provider, CI system, repository or deployment: no real
// user, learner, customer, log line, secret, token or source code. It asks
// only for a short observation/proposal; the Operations Engineer has no
// tool-execution plane and nothing here can act on its answer.
export const SYNTHETIC_OPERATIONS_ENGINEER_CONTEXT = {
  label:
    "Synthetic live-provider smoke check (demo content, not real system data)",
  systemStatus: "SYNTHETIC",
  providerStatus: "HEALTHY",
  jobs: [
    {
      jobId: "synthetic-job-1",
      name: "synthetic-nightly-report",
      status: "FAILING",
      consecutiveFailures: 1,
    },
  ],
  request:
    "In at most three sentences, propose one short diagnostic next step for the synthetic failing job. Observation and proposal only.",
};

function syntheticContext(
  operation: LiveProviderSmokeOperation,
): Record<string, unknown> {
  switch (operation) {
    case "OPENAI_EXAMINER_SMOKE":
      // The provider receives exactly the pre-CP2 context shape.
      return examinerProviderContext(SYNTHETIC_EXAMINER_CONTEXT);
    case "ANTHROPIC_LAB_SMOKE":
      return SYNTHETIC_LAB_CONTEXT;
    case "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE":
      return SYNTHETIC_OPERATIONS_ENGINEER_CONTEXT;
  }
}

// ---------------------------------------------------------------------------
// Evidence: metadata only. Never the raw model output, the provider request
// or response, the synthetic context, parsed marks, or any key.
// ---------------------------------------------------------------------------
export type LiveProviderSmokeVerdict = "PASS" | "FAIL" | "BLOCKED";

export type LiveProviderSmokeEvidence = {
  operation: LiveProviderSmokeOperation;
  surface: string;
  providerFamily: "OPENAI" | "ANTHROPIC";
  adapterKind: RuntimeAdapterKind;
  profileRef: string;
  modelId: string;
  runtimeOutcome: RuntimeResult["outcome"] | "NOT_EXECUTED";
  // Bounded vocabulary only: a ProviderFailureCode, a runtime abstention
  // reason or a budget stage -- never provider error text.
  runtimeDetail: string | null;
  usage: {
    providerCalls: number;
    attempts: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostMicrousd: number;
    elapsedMs: number;
  };
  envelope: {
    maxProviderCalls: number;
    maxAttempts: number;
    maxOutputTokens: number;
    maxEstimatedCostMicrousd: number;
    totalDeadlineMs: number;
  } | null;
  withinEnvelope: boolean;
  examiner: {
    strictParsePassed: boolean;
    outcome: "GRADED" | "ESCALATE" | null;
    marksValidationPassed: boolean | null;
  } | null;
  lab: { outputLength: number } | null;
  operationsEngineer: { outputLength: number } | null;
  verdict: LiveProviderSmokeVerdict;
  verdictReason: string;
};

function withinEnvelope(
  usage: RuntimeResult["usage"],
  policy: RuntimeBudgetPolicy,
): boolean {
  return (
    usage.providerCalls <= policy.maxProviderCalls &&
    usage.attempts <= policy.maxAttempts &&
    usage.outputTokens <= policy.maxOutputTokens &&
    usage.estimatedCostMicrousd <= policy.maxEstimatedCostMicrousd &&
    usage.elapsedMs <= policy.totalDeadlineMs
  );
}

function runtimeDetail(result: RuntimeResult): string | null {
  switch (result.outcome) {
    case "FAILED":
    case "ABSTAINED":
      return result.reason;
    case "BUDGET_BLOCKED":
      return result.stage;
    case "ESCALATED":
      return result.reviewPath;
    default:
      return null;
  }
}

export type LiveProviderSmokeDeps = {
  resolveProfile: (role: AgentRole, ref: string) => RuntimeProfile | null;
  resolvePlatformProfile: (role: PlatformAgentRole) => RuntimeProfile | null;
  resolveAdapter: (profile: RuntimeProfile) => ProviderAdapter | null;
  execute: typeof runGovernedProviderExecution;
};

const productionDeps: LiveProviderSmokeDeps = {
  resolveProfile: (role, ref) => resolveRoleBoundRuntimeProfile(role, ref),
  resolvePlatformProfile: (role) => resolvePlatformRuntimeProfile(role),
  resolveAdapter: resolveAdapterForProfile,
  execute: runGovernedProviderExecution,
};

function profileMatchesPlan(profile: RuntimeProfile, plan: SmokePlan) {
  if (profile.ref !== plan.profileRef) return false;
  if (profile.adapterKind !== plan.adapterKind) return false;
  if (profile.adapterKind === "OPENAI_RESPONSES") {
    if (profile.providerConfig.model !== plan.modelId) return false;
    if (profile.providerConfig.reasoningEffort !== plan.reasoningEffort)
      return false;
  } else if (profile.adapterKind === "ANTHROPIC_MESSAGES") {
    if (profile.providerConfig.model !== plan.modelId) return false;
    if (plan.reasoningEffort !== null) return false;
  } else {
    return false;
  }
  const policy = profile.budgetPolicy;
  return (
    policy.maxProviderCalls === plan.envelope.maxProviderCalls &&
    policy.maxAttempts === plan.envelope.maxAttempts &&
    policy.maxOutputTokens === plan.envelope.maxOutputTokens &&
    policy.maxEstimatedCostMicrousd ===
      plan.envelope.maxEstimatedCostMicrousd &&
    policy.totalDeadlineMs === plan.envelope.totalDeadlineMs
  );
}

// A LIVE-PROVIDER-TESTED PASS must itself prove that exactly one provider
// request happened, rather than rely on an implicit runtime invariant.
function requireExactlyOneRequest(
  evidence: LiveProviderSmokeEvidence,
): LiveProviderSmokeEvidence {
  if (
    evidence.verdict === "PASS" &&
    (evidence.usage.providerCalls !== 1 || evidence.usage.attempts !== 1)
  )
    return {
      ...evidence,
      verdict: "FAIL",
      verdictReason: "PASS_WITHOUT_EXACTLY_ONE_PROVIDER_REQUEST",
    };
  return evidence;
}

// Runs exactly one governed execution for the named operation. The only
// retry is whatever the resolved production profile itself permits, which
// profileMatchesPlan pins to maxAttempts 1; nothing here loops.
export async function runLiveProviderSmoke(
  operation: LiveProviderSmokeOperation,
  deps: LiveProviderSmokeDeps = productionDeps,
): Promise<LiveProviderSmokeEvidence> {
  return requireExactlyOneRequest(await evaluateSmoke(operation, deps));
}

async function evaluateSmoke(
  operation: LiveProviderSmokeOperation,
  deps: LiveProviderSmokeDeps,
): Promise<LiveProviderSmokeEvidence> {
  const plan: SmokePlan = LIVE_PROVIDER_SMOKE_PLANS[operation];
  const base = {
    operation,
    surface: plan.surface,
    providerFamily: plan.providerFamily,
    adapterKind: plan.adapterKind,
    profileRef: plan.profileRef,
    modelId: plan.modelId,
  };

  const profile =
    plan.profilePlane === "PLATFORM"
      ? deps.resolvePlatformProfile(plan.role)
      : deps.resolveProfile(plan.role, plan.profileRef);
  if (!profile || !profileMatchesPlan(profile, plan)) {
    return {
      ...base,
      runtimeOutcome: "NOT_EXECUTED",
      runtimeDetail: null,
      usage: {
        providerCalls: 0,
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicrousd: 0,
        elapsedMs: 0,
      },
      envelope: null,
      withinEnvelope: true,
      examiner: null,
      lab: null,
      operationsEngineer: null,
      verdict: "FAIL",
      verdictReason: "PROFILE_MISMATCH",
    };
  }

  const policy = profile.budgetPolicy;
  const result = await deps.execute(
    deps.resolveAdapter(profile),
    {
      role: plan.role,
      capability: plan.capability,
      context: syntheticContext(operation),
      // AC-2: a teaching role never runs without explicit behaviour. This
      // synthetic smoke has no programme version, so it states the current
      // code default explicitly instead of relying on a runtime fallback.
      ...(isBehaviourRole(plan.role)
        ? { behaviour: defaultEffectiveBehaviour(plan.role) }
        : {}),
    },
    policy,
  );
  const inEnvelope = withinEnvelope(result.usage, policy);
  const evidence: LiveProviderSmokeEvidence = {
    ...base,
    runtimeOutcome: result.outcome,
    runtimeDetail: runtimeDetail(result),
    usage: {
      providerCalls: result.usage.providerCalls,
      attempts: result.usage.attempts,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCostMicrousd: result.usage.estimatedCostMicrousd,
      elapsedMs: result.usage.elapsedMs,
    },
    envelope: {
      maxProviderCalls: policy.maxProviderCalls,
      maxAttempts: policy.maxAttempts,
      maxOutputTokens: policy.maxOutputTokens,
      maxEstimatedCostMicrousd: policy.maxEstimatedCostMicrousd,
      totalDeadlineMs: policy.totalDeadlineMs,
    },
    withinEnvelope: inEnvelope,
    examiner: null,
    lab: null,
    operationsEngineer: null,
    verdict: "FAIL",
    verdictReason: `RUNTIME_${result.outcome}`,
  };

  if (result.outcome === "ABSTAINED" && result.usage.providerCalls === 0) {
    // NO_PROVIDER_CONFIGURED: this process holds no key for this provider.
    return {
      ...evidence,
      verdict: "BLOCKED",
      verdictReason: `RUNTIME_ABSTAINED_${result.reason}`,
    };
  }
  if (result.outcome !== "SUCCEEDED") return evidence;
  if (!inEnvelope)
    return { ...evidence, verdictReason: "USAGE_OUTSIDE_PROFILE_ENVELOPE" };

  if (operation === "OPENAI_EXAMINER_SMOKE") {
    const parsed = parseExaminerAssessmentProviderOutput(
      result.response.outputText,
    );
    if (!parsed.ok)
      return {
        ...evidence,
        examiner: {
          strictParsePassed: false,
          outcome: null,
          marksValidationPassed: null,
        },
        verdictReason: "EXAMINER_OUTPUT_INVALID",
      };
    if (parsed.output.outcome === "ESCALATE")
      return {
        ...evidence,
        examiner: {
          strictParsePassed: true,
          outcome: "ESCALATE",
          marksValidationPassed: null,
        },
        verdict: "PASS",
        verdictReason: "EXAMINER_ESCALATE_VALID",
      };
    const marksValid = validateExaminerAssessmentMarks(
      SYNTHETIC_EXAMINER_CONTEXT,
      parsed.output.marks,
    );
    return {
      ...evidence,
      examiner: {
        strictParsePassed: true,
        outcome: "GRADED",
        marksValidationPassed: marksValid,
      },
      verdict: marksValid ? "PASS" : "FAIL",
      verdictReason: marksValid
        ? "EXAMINER_GRADED_VALID"
        : "EXAMINER_MARKS_INVALID",
    };
  }

  // The production adapter's bounded parser already accepted this text
  // (non-empty, at most 20,000 characters); only its length is recorded.
  // For the Operations Engineer this PASS proves transport/runtime/model
  // accessibility only -- never diagnostic, coding or remediation quality.
  const outputLength = result.response.outputText.length;
  if (operation === "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE")
    return {
      ...evidence,
      operationsEngineer: { outputLength },
      verdict: "PASS",
      verdictReason: "OPERATIONS_ENGINEER_OUTPUT_ACCEPTED",
    };
  return {
    ...evidence,
    lab: { outputLength },
    verdict: "PASS",
    verdictReason: "LAB_OUTPUT_ACCEPTED",
  };
}
