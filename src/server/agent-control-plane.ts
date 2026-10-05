import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ACADEMIC_ROLE_FACTS,
  PLATFORM_ROLE_FACTS,
  agentConfigurationScopePageSchema,
  canonicalJson,
  credentialForAdapter,
  deriveAcademicConfiguration,
  profileReadiness,
  resolveProfileEvidence,
  type AgentConfigurationScopePage,
  type CredentialReadiness,
  type DerivedAcademicConfiguration,
  type ProfileReadiness,
  type ProgrammeVersionScope,
  type ProviderCredentialReadiness,
  type ResolvedEvidence,
} from "@/domain/agent-control-plane";
import {
  agentRoleSchema,
  type AgentRole,
} from "@/domain/academic-capability-policy";
import type {
  RuntimeAdapterKind,
  RuntimeProfile,
} from "@/domain/academic-runtime-profile";
import type { RuntimeBudgetPolicy } from "@/domain/academic-runtime";
import {
  PLATFORM_ROLE_PROFILE_REF,
  platformAgentRoleSchema,
  type PlatformAgentRole,
} from "@/domain/platform-ai-policy";
import { PROVIDER_EXECUTION_DB_CEILING } from "@/domain/academic-provider-execution";
import { TUTOR_LAB_EXECUTION_DB_CEILING } from "@/domain/tutor-lab-execution";
import { EXAMINER_EXECUTION_DB_CEILING } from "@/domain/commercial-v1-examiner-grading";
import { AccessDenied } from "@/domain/policy";
import { ROLE_RUNTIME_PROFILE_POLICY } from "@/domain/academic-runtime-profile";
import { listProductionRuntimeProfiles } from "./academic-runtime/profile-registry";
import { isBehaviourRole } from "@/domain/agent-behaviour";
import { requireAnyRole } from "./identity";
import { createSupabase } from "./supabase";

// AGENT-CONTROL-1: the read-only operator control plane. Nothing here
// mutates configuration, selects a profile or calls a provider. Profile
// facts come from the server-owned registry; configuration comes from the
// admin-only database read (migration 050); credential readiness is
// presence-only and never returns, logs or derives anything from a value.
const OPERATORS = ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"] as const;

export function runtimeProfileFingerprint(profile: RuntimeProfile): string {
  return createHash("sha256")
    .update(canonicalJson(profile), "utf8")
    .digest("hex");
}

function present(name: string): CredentialReadiness {
  // Same truthiness the native adapters use to decide whether to construct
  // (provider.ts). The value itself is never read beyond this test.
  return process.env[name] ? "PRESENT" : "ABSENT";
}

export function providerCredentialReadiness(
  profiles: readonly RuntimeProfile[] = listProductionRuntimeProfiles(),
): ProviderCredentialReadiness {
  // The legacy generic HTTP_JSON gateway is reported only as NOT_USED while
  // no production profile routes through it; its presence is irrelevant.
  const legacyUsed = profiles.some((p) => p.adapterKind === "HTTP_JSON");
  return Object.freeze({
    OPENAI_API_KEY: present("OPENAI_API_KEY"),
    ANTHROPIC_API_KEY: present("ANTHROPIC_API_KEY"),
    ACADEMIC_PROVIDER_LEGACY: legacyUsed
      ? process.env.ACADEMIC_PROVIDER_BASE_URL &&
        process.env.ACADEMIC_PROVIDER_API_KEY
        ? "PRESENT"
        : "ABSENT"
      : "NOT_USED",
  });
}

export type DbCeiling = {
  maxProviderCalls: number;
  maxOutputTokens: number;
  maxEstimatedCostMicrousd: number;
};

export type ProfileView = {
  ref: string;
  roles: string[];
  adapterKind: RuntimeAdapterKind;
  model: string | null;
  reasoningEffort: string | null;
  tariff: {
    inputMicrousdPerMillionTokens: number;
    outputMicrousdPerMillionTokens: number;
    reviewedAt: string;
  } | null;
  budget: RuntimeBudgetPolicy;
  dbCeiling: DbCeiling | null;
  credential: string | null;
  readiness: ProfileReadiness;
  fingerprint: string;
  evidence: ResolvedEvidence;
};

const ACADEMIC_DB_CEILING: Readonly<Record<AgentRole, DbCeiling | null>> = {
  PROFESSOR: PROVIDER_EXECUTION_DB_CEILING,
  TUTOR: TUTOR_LAB_EXECUTION_DB_CEILING,
  LAB_INSTRUCTOR: TUTOR_LAB_EXECUTION_DB_CEILING,
  EXAMINER: EXAMINER_EXECUTION_DB_CEILING,
  COUNSELLOR: null,
};

function rolesForProfile(ref: string): {
  labels: string[];
  ceiling: DbCeiling | null;
} {
  const academic = agentRoleSchema.options.filter(
    (role) => ROLE_RUNTIME_PROFILE_POLICY[role].allowedRef === ref,
  );
  const platform = platformAgentRoleSchema.options.filter(
    (role) => PLATFORM_ROLE_PROFILE_REF[role] === ref,
  );
  return {
    labels: [
      ...academic.map(
        (r) => `${ACADEMIC_ROLE_FACTS[r].displayName} (academic)`,
      ),
      ...platform.map(
        (r) => `${PLATFORM_ROLE_FACTS[r].displayName} (platform)`,
      ),
    ],
    ceiling: academic.length === 1 ? ACADEMIC_DB_CEILING[academic[0]] : null,
  };
}

export function describeProductionProfiles(
  credentials: ProviderCredentialReadiness,
  profiles: readonly RuntimeProfile[] = listProductionRuntimeProfiles(),
): ProfileView[] {
  return profiles.map((profile) => {
    const fingerprint = runtimeProfileFingerprint(profile);
    const { labels, ceiling } = rolesForProfile(profile.ref);
    const config =
      profile.adapterKind === "OPENAI_RESPONSES" ||
      profile.adapterKind === "ANTHROPIC_MESSAGES"
        ? profile.providerConfig
        : null;
    return {
      ref: profile.ref,
      roles: labels,
      adapterKind: profile.adapterKind,
      model: config?.model ?? null,
      reasoningEffort:
        profile.adapterKind === "OPENAI_RESPONSES"
          ? profile.providerConfig.reasoningEffort
          : null,
      tariff: config ? { ...config.tariff } : null,
      budget: { ...profile.budgetPolicy },
      dbCeiling: ceiling ? { ...ceiling } : null,
      credential: credentialForAdapter(profile.adapterKind),
      readiness: profileReadiness(profile.adapterKind, credentials),
      fingerprint,
      evidence: resolveProfileEvidence(profile.ref, fingerprint),
    };
  });
}

export type VersionView = Omit<
  ProgrammeVersionScope,
  "configs" | "behaviourConfigs" | "behaviourEffective"
> & {
  roles: (DerivedAcademicConfiguration & {
    displayName: string;
    executionDescription: string;
    escalationSemantics: string;
    escalationPolicy: "NONE" | "ACADEMIC_REVIEW" | null;
    enabled: boolean | null;
    hasInstructionalNotes: boolean;
    behaviour:
      | {
          state: "DRAFT" | "BOUND";
          behaviourVersion: string;
          source: "EXPLICIT" | "DEFAULT";
          configVersion: string;
          summary: string;
          hasCourseContextNotes: boolean;
        }
      | {
          state: "BEHAVIOUR_BINDING_MISSING" | "BEHAVIOUR_BINDING_INVALID";
        }
      | null;
    readiness: ProfileReadiness | "NOT_APPLICABLE";
  })[];
};

export type PlatformRoleView = {
  role: PlatformAgentRole;
  displayName: string;
  executable: false;
  executionDescription: string;
  profileRef: string;
};

export type AgentControlPlane = {
  credentials: ProviderCredentialReadiness;
  profiles: ProfileView[];
  platformRoles: PlatformRoleView[];
  page: Omit<AgentConfigurationScopePage, "versions"> & {
    versions: VersionView[];
  };
};

export class AgentControlPlaneUnavailable extends Error {
  constructor() {
    super("Agent configuration could not be loaded.");
    this.name = "AgentControlPlaneUnavailable";
  }
}

const cursorSchema = z.strictObject({
  createdAt: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/,
    ),
  id: z.uuid(),
});

// A malformed or half-specified cursor falls back to the first page; it is
// never forwarded to the database as anything but two typed parameters.
export function parseAgentControlCursor(
  params: Record<string, string | string[] | undefined>,
): { createdAt: string; id: string } | null {
  const first = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const parsed = cursorSchema.safeParse({
    createdAt: first(params.after),
    id: first(params.afterId),
  });
  return parsed.success ? parsed.data : null;
}

function buildVersionView(
  scope: ProgrammeVersionScope,
  profiles: readonly ProfileView[],
): VersionView {
  // behaviourConfigs (explicit draft rows) is superseded here by the
  // database-resolved effective behaviour, which is what executions use.
  const {
    configs,
    behaviourConfigs: _explicitRows,
    behaviourEffective,
    ...version
  } = scope;
  void _explicitRows;
  return {
    ...version,
    roles: agentRoleSchema.options.map((role) => {
      const config = configs.find((c) => c.role === role);
      const effective = behaviourEffective.find((b) => b.role === role);
      const derived = deriveAcademicConfiguration(role, config);
      const profile = profiles.find(
        (p) => p.ref === derived.effectiveProfileRef,
      );
      return {
        ...derived,
        displayName: ACADEMIC_ROLE_FACTS[role].displayName,
        executionDescription: ACADEMIC_ROLE_FACTS[role].execution.description,
        escalationSemantics: ACADEMIC_ROLE_FACTS[role].escalation,
        escalationPolicy: config?.escalationPolicy ?? null,
        enabled: config?.enabled ?? null,
        hasInstructionalNotes: config?.hasInstructionalNotes ?? false,
        behaviour:
          !isBehaviourRole(role) || !effective
            ? null
            : effective.state === "DRAFT" || effective.state === "BOUND"
              ? {
                  state: effective.state,
                  behaviourVersion: effective.behaviourVersion,
                  source: effective.source,
                  configVersion: effective.configVersion,
                  summary: `${effective.responseDepth} depth, ${effective.teachingApproach}, ${effective.understandingCheckFrequency} understanding checks, ${effective.challengeLevel} challenge`,
                  hasCourseContextNotes: effective.hasCourseContextNotes,
                }
              : { state: effective.state },
        readiness:
          derived.executable && profile ? profile.readiness : "NOT_APPLICABLE",
      };
    }),
  };
}

export async function getAgentControlPlane(
  cursor: { createdAt: string; id: string } | null,
): Promise<{
  actor: Awaited<ReturnType<typeof requireAnyRole>>;
  plane: AgentControlPlane;
}> {
  const actor = await requireAnyRole(OPERATORS);
  const credentials = providerCredentialReadiness();
  const profiles = describeProductionProfiles(credentials);
  const { data, error } = await (
    await createSupabase()
  ).rpc("admin_list_agent_configuration_scopes", {
    p_cursor_created_at: cursor?.createdAt ?? null,
    p_cursor_id: cursor?.id ?? null,
  });
  if (error) {
    if (error.message.includes("FORBIDDEN")) throw new AccessDenied();
    throw new AgentControlPlaneUnavailable();
  }
  const parsed = agentConfigurationScopePageSchema.safeParse(data);
  if (!parsed.success) throw new AgentControlPlaneUnavailable();
  const { versions, ...page } = parsed.data;
  return {
    actor,
    plane: {
      credentials,
      profiles,
      platformRoles: platformAgentRoleSchema.options.map((role) => ({
        role,
        displayName: PLATFORM_ROLE_FACTS[role].displayName,
        executable: false,
        executionDescription: PLATFORM_ROLE_FACTS[role].execution.description,
        profileRef: PLATFORM_ROLE_PROFILE_REF[role],
      })),
      page: {
        ...page,
        versions: versions.map((v) => buildVersionView(v, profiles)),
      },
    },
  };
}
