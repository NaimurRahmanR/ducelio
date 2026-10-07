import { z } from "zod";
import {
  agentRoleSchema,
  roleCapabilityCatalogue,
  type AgentRole,
} from "./academic-capability-policy";
import {
  ROLE_RUNTIME_PROFILE_POLICY,
  validateRoleModelProfileRef,
  type RuntimeAdapterKind,
} from "./academic-runtime-profile";
import type { PlatformAgentRole } from "./platform-ai-policy";

// AGENT-CONTROL-1: the vocabulary of the read-only operator control plane
// (/admin/agents). Pure: no server built-ins, no database, no environment.
//
// Four concepts are deliberately kept apart and are never folded into one
// "healthy" flag:
//   CONFIGURED        -- what the stored, programme-version configuration
//                        says (and whether it is valid);
//   READY             -- whether the server credential the profile's adapter
//                        needs is PRESENT (presence only, never validity);
//   TESTED            -- reviewed evidence recorded against the exact runtime
//                        profile definition (local, hosted, live provider);
//   PRODUCTION-PROVEN -- never claimed by this checkpoint.

export const credentialReadinessSchema = z.enum([
  "PRESENT",
  "ABSENT",
  "NOT_USED",
]);
export type CredentialReadiness = z.infer<typeof credentialReadinessSchema>;

export const PROVIDER_CREDENTIALS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ACADEMIC_PROVIDER_LEGACY",
] as const;
export type ProviderCredential = (typeof PROVIDER_CREDENTIALS)[number];
export type ProviderCredentialReadiness = Readonly<
  Record<ProviderCredential, CredentialReadiness>
>;

// Which server credential each adapter kind needs. TEST_DETERMINISTIC never
// resolves in production code (profile-registry.ts) and needs none.
export function credentialForAdapter(
  adapterKind: RuntimeAdapterKind,
): ProviderCredential | null {
  switch (adapterKind) {
    case "OPENAI_RESPONSES":
      return "OPENAI_API_KEY";
    case "ANTHROPIC_MESSAGES":
      return "ANTHROPIC_API_KEY";
    case "HTTP_JSON":
      return "ACADEMIC_PROVIDER_LEGACY";
    case "TEST_DETERMINISTIC":
      return null;
  }
}

export type ProfileReadiness = "CREDENTIAL_PRESENT" | "CREDENTIAL_ABSENT";
export function profileReadiness(
  adapterKind: RuntimeAdapterKind,
  credentials: ProviderCredentialReadiness,
): ProfileReadiness {
  const credential = credentialForAdapter(adapterKind);
  return credential && credentials[credential] === "PRESENT"
    ? "CREDENTIAL_PRESENT"
    : "CREDENTIAL_ABSENT";
}

// ---------------------------------------------------------------------------
// Role facts (code-owned; reviewed alongside the runtime they describe).
// ---------------------------------------------------------------------------

export type Executability = {
  executable: boolean;
  description: string;
};

export const ACADEMIC_ROLE_FACTS: Readonly<
  Record<
    AgentRole,
    {
      displayName: string;
      execution: Executability;
      // Capabilities the role's only execution path reads; a configuration
      // missing them is enabled but cannot actually run.
      requiredAll: readonly string[];
      requiredAny: readonly string[];
      escalation: string;
    }
  >
> = Object.freeze({
  PROFESSOR: {
    displayName: "Professor",
    execution: {
      executable: true,
      description:
        "Learner Professor classroom (executeRoleCapability, get_lesson_context).",
    },
    requiredAll: ["get_lesson_context"],
    requiredAny: [],
    escalation:
      "ACADEMIC_REVIEW makes every Professor request return as unavailable without a provider call. No academic-review case or queue is created.",
  },
  TUTOR: {
    displayName: "Tutor",
    execution: {
      executable: true,
      description:
        "Learner-requested Tutor support from a delivery handoff (executeTutorLabSupport).",
    },
    requiredAll: ["get_lesson_context", "get_lesson_objectives"],
    requiredAny: [],
    escalation:
      "Not read by the current Tutor runtime. ACADEMIC_REVIEW has no effect and creates no review case.",
  },
  LAB_INSTRUCTOR: {
    displayName: "Lab Instructor",
    execution: {
      executable: true,
      description:
        "Learner-requested practical support from a delivery handoff (executeTutorLabSupport).",
    },
    requiredAll: ["get_lesson_context", "get_lesson_objectives"],
    requiredAny: [],
    escalation:
      "Not read by the current Lab runtime. ACADEMIC_REVIEW has no effect and creates no review case.",
  },
  EXAMINER: {
    displayName: "Examiner",
    execution: {
      executable: true,
      description:
        "Initial grading and admin recovery of controlled assessments and practical labs.",
    },
    requiredAll: [],
    requiredAny: ["grade_controlled_assessment", "grade_practical_lab"],
    escalation:
      "ACADEMIC_REVIEW makes initial grading and recovery create a durable ESCALATED claim that appears in the human academic-review worklist. Admin regrade does not read this field.",
  },
  COUNSELLOR: {
    displayName: "Academic Counsellor role (historical vocabulary)",
    execution: {
      executable: false,
      description:
        "No academic Counsellor execution path exists. This record does not launch Sarah Mitchell or any Counsellor AI: Sarah runs only on the separate platform COUNSELLOR plane.",
    },
    requiredAll: [],
    requiredAny: [],
    escalation: "Not applicable: there is no academic Counsellor runtime.",
  },
});

export const PLATFORM_ROLE_FACTS: Readonly<
  Record<PlatformAgentRole, { displayName: string; execution: Executability }>
> = Object.freeze({
  COUNSELLOR: {
    displayName: "Sarah Mitchell (learner-success AI)",
    execution: {
      executable: true,
      description:
        "AC-5 learner guide at /student/sarah (executeSarahGuide, SARAH_EXECUTION_V1): onboarding, learner guidance and learner-confirmed support-profile proposals. Not the academic COUNSELLOR role and not a human counsellor account. Post-session feedback (AC-6) is deterministic structured data collected under Sarah's persona with no model call and never runs on this plane. Course guidance (AC-7) is not implemented.",
    },
  },
  OPERATIONS_ENGINEER: {
    displayName: "Operations Engineer (internal)",
    execution: {
      executable: false,
      description:
        "No production tool-execution plane. Only the explicitly authorised live-provider acceptance smoke has called this profile.",
    },
  },
});

// ---------------------------------------------------------------------------
// CONFIGURED: derived from one stored programme-version configuration row.
// ---------------------------------------------------------------------------

export const agentConfigScopeSchema = z.strictObject({
  role: agentRoleSchema,
  enabled: z.boolean(),
  modelProfileRef: z.string().max(100).nullable(),
  hasInstructionalNotes: z.boolean(),
  capabilities: z.array(z.string().max(80)).max(50),
  escalationPolicy: z.enum(["NONE", "ACADEMIC_REVIEW"]),
  updatedAt: z.string(),
});
export type AgentConfigScope = z.infer<typeof agentConfigScopeSchema>;

export const behaviourConfigScopeSchema = z.strictObject({
  role: z.enum(["PROFESSOR", "TUTOR", "LAB_INSTRUCTOR"]),
  responseDepth: z.enum(["CONCISE", "STANDARD", "DETAILED"]),
  teachingApproach: z.enum([
    "CONCEPT_FIRST",
    "WORKED_EXAMPLE_FIRST",
    "GUIDED_QUESTIONING",
  ]),
  understandingCheckFrequency: z.enum(["LOW", "STANDARD", "HIGH"]),
  challengeLevel: z.enum(["FOUNDATION", "STANDARD", "ADVANCED"]),
  hasCourseContextNotes: z.boolean(),
});
export type BehaviourConfigScope = z.infer<typeof behaviourConfigScopeSchema>;

// AC-2 (migration 051): the EFFECTIVE behaviour per role. DRAFT is the live
// resolution; BOUND is the binding frozen at publication (pinned role
// behaviour version and actual values, also for a default). A bound
// version whose binding is missing or does not verify reports that state,
// and every execution for it fails closed.
export const effectiveBehaviourScopeSchema = z.union([
  z.strictObject({
    role: z.enum(["PROFESSOR", "TUTOR", "LAB_INSTRUCTOR"]),
    state: z.enum(["DRAFT", "BOUND"]),
    behaviourVersion: z.string().max(100),
    source: z.enum(["EXPLICIT", "DEFAULT"]),
    configVersion: z.enum([
      "AGENT_BEHAVIOUR_CONFIG_V1",
      "AGENT_BEHAVIOUR_DEFAULT_V1",
    ]),
    responseDepth: behaviourConfigScopeSchema.shape.responseDepth,
    teachingApproach: behaviourConfigScopeSchema.shape.teachingApproach,
    understandingCheckFrequency:
      behaviourConfigScopeSchema.shape.understandingCheckFrequency,
    challengeLevel: behaviourConfigScopeSchema.shape.challengeLevel,
    hasCourseContextNotes: z.boolean(),
  }),
  z.strictObject({
    role: z.enum(["PROFESSOR", "TUTOR", "LAB_INSTRUCTOR"]),
    state: z.enum(["BEHAVIOUR_BINDING_MISSING", "BEHAVIOUR_BINDING_INVALID"]),
  }),
]);
export type EffectiveBehaviourScope = z.infer<
  typeof effectiveBehaviourScopeSchema
>;

export const programmeVersionScopeSchema = z.strictObject({
  programmeVersionId: z.uuid(),
  programmeTitle: z.string().max(2000),
  versionLabel: z.string().max(2000),
  versionStatus: z.enum(["DRAFT", "PUBLISHED"]),
  isDemo: z.boolean(),
  createdAt: z.string(),
  hasEnrolments: z.boolean(),
  semanticConfigFrozen: z.boolean(),
  // AC-2: AGENT_BEHAVIOUR_FINGERPRINT_V1 of the actual effective behaviour
  // values. Separate from, and not covered by, the package publication
  // fingerprint. Null when a bound version's binding is missing or invalid.
  behaviourFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  behaviourEffective: z.array(effectiveBehaviourScopeSchema).length(3),
  configs: z.array(agentConfigScopeSchema).max(5),
  // AC-2 (migration 051): explicit Level-3 behaviour rows; whether notes are
  // stored, never their text.
  behaviourConfigs: z.array(behaviourConfigScopeSchema).max(3),
});
export type ProgrammeVersionScope = z.infer<typeof programmeVersionScopeSchema>;

export const agentConfigurationScopePageSchema = z.strictObject({
  versions: z.array(programmeVersionScopeSchema).max(50),
  pageSize: z.literal(50),
  hasMore: z.boolean(),
  nextCursor: z
    .strictObject({ createdAt: z.string(), id: z.uuid() })
    .nullable(),
});
export type AgentConfigurationScopePage = z.infer<
  typeof agentConfigurationScopePageSchema
>;

export type ConfigurationState =
  "NOT_CONFIGURED" | "DISABLED" | "ENABLED" | "INVALID";

export type DerivedAcademicConfiguration = {
  role: AgentRole;
  state: ConfigurationState;
  issues: string[];
  // The profile this role can ever execute with: fixed by code, never by
  // the stored reference (which is only ever null or this exact value).
  effectiveProfileRef: string | null;
  storedProfileRef: string | null;
  configuredCapabilities: string[];
  // configured AND in the current code-owned catalogue
  effectiveCapabilities: string[];
  missingRequiredCapabilities: string[];
  executable: boolean;
  // Enabled, valid, executable and carrying the capabilities its execution
  // path reads. Still says nothing about credentials or evidence.
  runnableByConfiguration: boolean;
};

export function deriveAcademicConfiguration(
  role: AgentRole,
  config: AgentConfigScope | undefined,
): DerivedAcademicConfiguration {
  const facts = ACADEMIC_ROLE_FACTS[role];
  const policy = ROLE_RUNTIME_PROFILE_POLICY[role];
  const catalogue = new Set(roleCapabilityCatalogue[role]);
  const effectiveProfileRef = policy.providerBacked ? policy.allowedRef : null;
  if (!config)
    return {
      role,
      state: "NOT_CONFIGURED",
      issues: [],
      effectiveProfileRef,
      storedProfileRef: null,
      configuredCapabilities: [],
      effectiveCapabilities: [],
      missingRequiredCapabilities: [],
      executable: facts.execution.executable,
      runnableByConfiguration: false,
    };
  const issues: string[] = [];
  const profile = validateRoleModelProfileRef(
    role,
    config.modelProfileRef,
    config.enabled,
  );
  if (!profile.ok)
    issues.push(
      profile.issue === "CROSS_ROLE_REF"
        ? "Stored model profile reference is not this role's profile."
        : "An enabled Professor needs its profile reference.",
    );
  const outside = config.capabilities.filter((c) => !catalogue.has(c));
  if (outside.length)
    issues.push(
      `Capabilities outside the reviewed ${role} catalogue: ${outside.join(", ")}.`,
    );
  const effectiveCapabilities = config.capabilities.filter((c) =>
    catalogue.has(c),
  );
  const missingAll = facts.requiredAll.filter(
    (c) => !effectiveCapabilities.includes(c),
  );
  const missingAny =
    facts.requiredAny.length > 0 &&
    !facts.requiredAny.some((c) => effectiveCapabilities.includes(c))
      ? [facts.requiredAny.join(" or ")]
      : [];
  const missingRequiredCapabilities = [...missingAll, ...missingAny];
  const state: ConfigurationState = issues.length
    ? "INVALID"
    : config.enabled
      ? "ENABLED"
      : "DISABLED";
  return {
    role,
    state,
    issues,
    effectiveProfileRef,
    storedProfileRef: config.modelProfileRef,
    configuredCapabilities: config.capabilities,
    effectiveCapabilities,
    missingRequiredCapabilities,
    executable: facts.execution.executable,
    runnableByConfiguration:
      state === "ENABLED" &&
      facts.execution.executable &&
      missingRequiredCapabilities.length === 0,
  };
}

// ---------------------------------------------------------------------------
// TESTED: reviewed evidence keyed to the exact runtime profile definition.
// ---------------------------------------------------------------------------
//
// Evidence is never inferred from configuration or from a credential being
// present. Each entry was reviewed against docs/38 and
// docs/implementation-progress.md, and is bound to the SHA-256 fingerprint
// of the canonical runtime profile it was recorded against
// (runtimeProfileFingerprint in src/server/agent-control-plane.ts). Any
// change to that profile -- model, adapter, reasoning, tariff or budget --
// changes the fingerprint, and every level then reports NOT_CURRENT until
// the evidence is re-reviewed and re-recorded here.

export const EVIDENCE_LEVELS = [
  "LOCAL_DETERMINISTIC",
  "HOSTED",
  "LIVE_PROVIDER",
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
export type EvidenceStatus = "RECORDED" | "PARTIAL" | "NONE";
export type ResolvedEvidenceStatus = EvidenceStatus | "NOT_CURRENT";

type EvidenceRecord = {
  readonly profileFingerprint: string;
  readonly reviewedAt: string;
  readonly levels: Readonly<
    Record<EvidenceLevel, { status: EvidenceStatus; scope: string }>
  >;
};

const JOURNEY_RUN = "hosted acceptance run 1790635594309-jz55ep";

export const AGENT_PROFILE_EVIDENCE: Readonly<Record<string, EvidenceRecord>> =
  Object.freeze({
    PROFESSOR_COMMERCIAL_V1: {
      profileFingerprint:
        "90570547a0e9aafa6da1c0cd9ccf6c6ea22ae9d213d5b1012f9bd27d6226bf78",
      reviewedAt: "2026-10-05",
      levels: {
        LOCAL_DETERMINISTIC: {
          status: "RECORDED",
          scope:
            "Deterministic classroom, composition and provider-adapter tests with mocked transport.",
        },
        HOSTED: {
          status: "PARTIAL",
          scope: `FULL_JOURNEY:CLASSROOM stage passed in ${JOURNEY_RUN} with the deterministic loopback provider stub. The full journey has no hosted pass, and no live model was called.`,
        },
        LIVE_PROVIDER: {
          status: "NONE",
          scope: "No live-provider request has ever used this profile.",
        },
      },
    },
    TUTOR_COMMERCIAL_V1: {
      profileFingerprint:
        "addd8559f98ca8aa2a0b60e091ad3f6d4c7933c4bde435ffa30b25d68e25c2ea",
      reviewedAt: "2026-10-05",
      levels: {
        LOCAL_DETERMINISTIC: {
          status: "RECORDED",
          scope:
            "Deterministic Tutor/Lab execution, context and provider-adapter tests with mocked transport.",
        },
        HOSTED: {
          status: "PARTIAL",
          scope: `FULL_JOURNEY:TUTOR_LAB stage passed in ${JOURNEY_RUN} with the deterministic loopback provider stub. The full journey has no hosted pass.`,
        },
        LIVE_PROVIDER: {
          status: "NONE",
          scope:
            "No live-provider request has used this profile. The Examiner live smoke used the same model id, which is not evidence for this profile or path.",
        },
      },
    },
    LAB_INSTRUCTOR_COMMERCIAL_V1: {
      profileFingerprint:
        "a126acddf6b2937dadcc8de20edb9ae667d43407f4a0e50980cdc5e2c25b6d91",
      reviewedAt: "2026-10-05",
      levels: {
        LOCAL_DETERMINISTIC: {
          status: "RECORDED",
          scope:
            "Deterministic Tutor/Lab execution, context and provider-adapter tests with mocked transport.",
        },
        HOSTED: {
          status: "PARTIAL",
          scope: `FULL_JOURNEY:TUTOR_LAB stage passed in ${JOURNEY_RUN} through the governed handoff path with the deterministic loopback provider stub. The full journey has no hosted pass.`,
        },
        LIVE_PROVIDER: {
          status: "PARTIAL",
          scope:
            "LIVE_PROVIDER:ANTHROPIC_LAB passed one synthetic request through the production adapter and runtime (acceptance driver). The governed handoff, content-release and attestation workflow was not live-tested.",
        },
      },
    },
    EXAMINER_COMMERCIAL_V1: {
      profileFingerprint:
        "664b720dde082ffc2743efc2752c3715657c0f6ba7d7a6e4772f04932fb6d2b9",
      reviewedAt: "2026-10-05",
      levels: {
        LOCAL_DETERMINISTIC: {
          status: "RECORDED",
          scope:
            "Deterministic grading, recovery and regrade tests, including database governance.",
        },
        HOSTED: {
          status: "RECORDED",
          scope:
            "EXAMINER_APP:GRADING, INITIAL_RECOVERY and REGRADE passed hosted with the deterministic loopback provider stub, not a live model.",
        },
        LIVE_PROVIDER: {
          status: "PARTIAL",
          scope:
            "LIVE_PROVIDER:OPENAI_EXAMINER passed one synthetic request through the production adapter, runtime and strict marks validation (acceptance driver). The governed grading workflow was not live-tested.",
        },
      },
    },
    COUNSELLOR_PLATFORM_V1: {
      profileFingerprint:
        "2899e69ec577812e9e6d14f6830ad4918baa8289c674cbef54d8cee9f2c2fc1e",
      reviewedAt: "2026-10-06",
      levels: {
        LOCAL_DETERMINISTIC: {
          status: "RECORDED",
          scope:
            "AC-5 deterministic Sarah tests (2026-10-06): the SARAH_EXECUTION_V1 database governance on the real migration chain (PGlite, single connection), the governed orchestrator, strict output and proposal contract, and the OpenAI adapter with mocked transport. No hosted run and no live model.",
        },
        HOSTED: {
          status: "NONE",
          scope: "Never run hosted. Migration 054 is not deployed.",
        },
        LIVE_PROVIDER: {
          status: "NONE",
          scope: "No live-provider request has used this profile.",
        },
      },
    },
    OPERATIONS_ENGINEER_PLATFORM_V1: {
      profileFingerprint:
        "3388738e06df34b74e20163901b474e417efd215ea4a3fa316e4d146e13d410c",
      reviewedAt: "2026-10-05",
      levels: {
        LOCAL_DETERMINISTIC: {
          status: "PARTIAL",
          scope:
            "Routing, profile-schema and acceptance-driver tests only. There is no production execution path.",
        },
        HOSTED: { status: "NONE", scope: "Never run hosted." },
        LIVE_PROVIDER: {
          status: "PARTIAL",
          scope:
            "LIVE_PROVIDER:ANTHROPIC_OPERATIONS_ENGINEER passed one synthetic request through the production adapter and runtime (acceptance driver). It proves model accessibility only.",
        },
      },
    },
  });

export type ResolvedEvidence = {
  fingerprintMatches: boolean;
  reviewedAt: string | null;
  levels: Record<
    EvidenceLevel,
    { status: ResolvedEvidenceStatus; scope: string }
  >;
  // Never claimed by AGENT-CONTROL-1, for any profile.
  productionProven: false;
};

export function resolveProfileEvidence(
  ref: string,
  currentFingerprint: string,
  registry: Readonly<Record<string, EvidenceRecord>> = AGENT_PROFILE_EVIDENCE,
): ResolvedEvidence {
  const record = Object.hasOwn(registry, ref) ? registry[ref] : undefined;
  const matches = record?.profileFingerprint === currentFingerprint;
  const levels = Object.fromEntries(
    EVIDENCE_LEVELS.map((level) => [
      level,
      !record
        ? { status: "NONE", scope: "No reviewed evidence is recorded." }
        : matches
          ? record.levels[level]
          : {
              status: "NOT_CURRENT",
              scope:
                "Evidence was recorded against a different profile definition. Re-review is required.",
            },
    ]),
  ) as ResolvedEvidence["levels"];
  return {
    fingerprintMatches: matches,
    reviewedAt: record?.reviewedAt ?? null,
    levels,
    productionProven: false,
  };
}

// Deterministic, key-order-independent JSON used to fingerprint a runtime
// profile definition (arrays keep order; object keys are sorted).
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
