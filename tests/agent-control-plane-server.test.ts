import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AGENT-CONTROL-1 server layer and pure domain: the read-only operator
// control plane. The real server-owned profile registry, fingerprinting,
// evidence registry and credential readiness run unmodified; only the
// session identity and the Supabase transport are stubbed.
const mocks = vi.hoisted(() => ({
  requireAnyRole: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireAnyRole: mocks.requireAnyRole,
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));

import {
  listProductionRuntimeProfiles,
  resolveAdapterForProfile,
  resolveRoleBoundRuntimeProfile,
  resolveRuntimeProfile,
} from "@/server/academic-runtime/profile-registry";
import {
  AgentControlPlaneUnavailable,
  describeProductionProfiles,
  getAgentControlPlane,
  parseAgentControlCursor,
  providerCredentialReadiness,
  runtimeProfileFingerprint,
} from "@/server/agent-control-plane";
import {
  AGENT_PROFILE_EVIDENCE,
  EVIDENCE_LEVELS,
  canonicalJson,
  deriveAcademicConfiguration,
  resolveProfileEvidence,
  type AgentConfigScope,
} from "@/domain/agent-control-plane";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";
import { DEFAULT_RUNTIME_BUDGET_POLICY } from "@/domain/academic-runtime";
import { AccessDenied } from "@/domain/policy";

const OPERATOR = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Ada Academic",
  roles: ["ACADEMIC_ADMIN"],
};
const VERSION = "22222222-2222-4222-8222-222222222222";
// Deliberately secret-shaped values: none of them, nor any part of them,
// may ever appear in a readiness result or control-plane payload.
const OPENAI_SECRET = "sk-proj-SENTINELopenaiKEY0123456789abcdef";
const ANTHROPIC_SECRET = "sk-ant-api03-SENTINELanthropicKEY987654";
const LEGACY_SECRET = "legacy-SENTINEL-gateway-key";

function expectNoSecretMaterial(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [OPENAI_SECRET, ANTHROPIC_SECRET, LEGACY_SECRET]) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(secret.slice(0, 8));
    expect(text).not.toContain(secret.slice(-8));
  }
  expect(text).not.toMatch(/SENTINEL/);
  expect(text).not.toMatch(/sk-(proj|ant)/);
  expect(text).not.toMatch(/"(length|prefix|suffix|hash|value)"\s*:/);
}

function config(over: Partial<AgentConfigScope> = {}): AgentConfigScope {
  return {
    role: "TUTOR",
    enabled: true,
    modelProfileRef: null,
    hasInstructionalNotes: false,
    capabilities: ["get_lesson_context", "get_lesson_objectives"],
    escalationPolicy: "NONE",
    updatedAt: "2026-10-05T10:00:00+00:00",
    ...over,
  };
}
function scopePage(configs: AgentConfigScope[]) {
  return {
    versions: [
      {
        programmeVersionId: VERSION,
        programmeTitle: "Security+",
        versionLabel: "v1",
        versionStatus: "PUBLISHED",
        isDemo: false,
        createdAt: "2026-10-01T10:00:00.123456+00:00",
        hasEnrolments: true,
        semanticConfigFrozen: true,
        behaviourFingerprint:
          "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        configs,
        behaviourConfigs: [],
        behaviourEffective: ["PROFESSOR", "TUTOR", "LAB_INSTRUCTOR"].map(
          (role) => ({
            role,
            state: "BOUND",
            behaviourVersion: `${role}_BEHAVIOUR_V1`,
            source: "DEFAULT",
            configVersion: "AGENT_BEHAVIOUR_DEFAULT_V1",
            responseDepth: "STANDARD",
            teachingApproach: "CONCEPT_FIRST",
            understandingCheckFrequency: "STANDARD",
            challengeLevel: "STANDARD",
            hasCourseContextNotes: false,
          }),
        ),
      },
    ],
    pageSize: 50,
    hasMore: false,
    nextCursor: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAnyRole.mockResolvedValue(OPERATOR);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("server-owned production profile registry", () => {
  it("contains exactly the reviewed production profile set (a new profile cannot appear without test review)", () => {
    expect(
      listProductionRuntimeProfiles()
        .map((p) => p.ref)
        .sort(),
    ).toEqual([
      "COUNSELLOR_PLATFORM_V1",
      "EXAMINER_COMMERCIAL_V1",
      "LAB_INSTRUCTOR_COMMERCIAL_V1",
      "OPERATIONS_ENGINEER_PLATFORM_V1",
      "PROFESSOR_COMMERCIAL_V1",
      "TUTOR_COMMERCIAL_V1",
    ]);
  });

  it("routes no production profile through the legacy HTTP_JSON gateway or a test adapter", () => {
    for (const profile of listProductionRuntimeProfiles())
      expect(["OPENAI_RESPONSES", "ANTHROPIC_MESSAGES"]).toContain(
        profile.adapterKind,
      );
  });

  it("returns frozen profiles that cannot be altered through the listing", () => {
    const [first] = listProductionRuntimeProfiles();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(listProductionRuntimeProfiles())).toBe(true);
  });

  it("preserves role/profile crossover rejection, unknown-profile rejection and null semantics", () => {
    expect(
      resolveRoleBoundRuntimeProfile("TUTOR", "PROFESSOR_COMMERCIAL_V1"),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("EXAMINER", "COUNSELLOR_PLATFORM_V1"),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile(
        "PROFESSOR",
        "OPERATIONS_ENGINEER_PLATFORM_V1",
      ),
    ).toBeNull();
    expect(resolveRoleBoundRuntimeProfile("TUTOR", "NOT_A_PROFILE")).toBeNull();
    expect(resolveRuntimeProfile("NOT_A_PROFILE")).toBeNull();
    expect(resolveRoleBoundRuntimeProfile("PROFESSOR", null)).toBeNull();
    expect(resolveRoleBoundRuntimeProfile("TUTOR", null)?.ref).toBe(
      "TUTOR_COMMERCIAL_V1",
    );
    expect(resolveRoleBoundRuntimeProfile("COUNSELLOR", null)).toBeNull();
  });

  it("never resolves TEST_DETERMINISTIC to an adapter, including under NODE_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const profile: RuntimeProfile = {
      ref: "TUTOR_COMMERCIAL_V1",
      adapterKind: "TEST_DETERMINISTIC",
      budgetPolicy: DEFAULT_RUNTIME_BUDGET_POLICY,
    };
    expect(resolveAdapterForProfile(profile)).toBeNull();
  });
});

describe("provider credential readiness", () => {
  it("reports PRESENT/ABSENT/NOT_USED only and never any credential material", () => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_SECRET);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ACADEMIC_PROVIDER_BASE_URL", "https://legacy.example.com");
    vi.stubEnv("ACADEMIC_PROVIDER_API_KEY", LEGACY_SECRET);
    const readiness = providerCredentialReadiness();
    expect(readiness).toEqual({
      OPENAI_API_KEY: "PRESENT",
      ANTHROPIC_API_KEY: "ABSENT",
      ACADEMIC_PROVIDER_LEGACY: "NOT_USED",
    });
    for (const status of Object.values(readiness))
      expect(["PRESENT", "ABSENT", "NOT_USED"]).toContain(status);
    expectNoSecretMaterial(readiness);
  });

  it("would report the legacy gateway truthfully only if a profile actually used it", () => {
    vi.stubEnv("ACADEMIC_PROVIDER_BASE_URL", "");
    vi.stubEnv("ACADEMIC_PROVIDER_API_KEY", LEGACY_SECRET);
    const legacy: RuntimeProfile = {
      ref: "LEGACY_REVIEW_ONLY",
      adapterKind: "HTTP_JSON",
      budgetPolicy: DEFAULT_RUNTIME_BUDGET_POLICY,
    };
    expect(providerCredentialReadiness([legacy]).ACADEMIC_PROVIDER_LEGACY).toBe(
      "ABSENT",
    );
  });

  it("makes no network request to determine readiness or describe profiles", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("OPENAI_API_KEY", OPENAI_SECRET);
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_SECRET);
    const profiles = describeProductionProfiles(providerCredentialReadiness());
    expect(fetchSpy).not.toHaveBeenCalled();
    expectNoSecretMaterial(profiles);
  });

  it("maps each profile to the credential its adapter actually needs", () => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_SECRET);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const byRef = new Map(
      describeProductionProfiles(providerCredentialReadiness()).map((p) => [
        p.ref,
        p,
      ]),
    );
    expect(byRef.get("PROFESSOR_COMMERCIAL_V1")).toMatchObject({
      credential: "OPENAI_API_KEY",
      readiness: "CREDENTIAL_PRESENT",
    });
    expect(byRef.get("LAB_INSTRUCTOR_COMMERCIAL_V1")).toMatchObject({
      credential: "ANTHROPIC_API_KEY",
      readiness: "CREDENTIAL_ABSENT",
    });
    expect(byRef.get("OPERATIONS_ENGINEER_PLATFORM_V1")).toMatchObject({
      credential: "ANTHROPIC_API_KEY",
      readiness: "CREDENTIAL_ABSENT",
    });
  });
});

describe("exact profile metadata", () => {
  it("exposes the registry's own provider, model, reasoning, budget and the role's DB ceiling", () => {
    const byRef = new Map(
      describeProductionProfiles(providerCredentialReadiness()).map((p) => [
        p.ref,
        p,
      ]),
    );
    expect(byRef.get("PROFESSOR_COMMERCIAL_V1")).toMatchObject({
      adapterKind: "OPENAI_RESPONSES",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      budget: {
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 16_000,
        maxOutputTokens: 900,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 50_000,
      },
      dbCeiling: {
        maxProviderCalls: 3,
        maxOutputTokens: 4000,
        maxEstimatedCostMicrousd: 200_000,
      },
      roles: ["Professor (academic)"],
    });
    expect(byRef.get("TUTOR_COMMERCIAL_V1")).toMatchObject({
      model: "gpt-5.6-luna",
      dbCeiling: { maxProviderCalls: 1, maxOutputTokens: 2000 },
    });
    expect(byRef.get("LAB_INSTRUCTOR_COMMERCIAL_V1")).toMatchObject({
      adapterKind: "ANTHROPIC_MESSAGES",
      model: "claude-sonnet-5",
      reasoningEffort: null,
    });
    expect(byRef.get("EXAMINER_COMMERCIAL_V1")).toMatchObject({
      model: "gpt-5.6-luna",
      dbCeiling: {
        maxProviderCalls: 1,
        maxOutputTokens: 1200,
        maxEstimatedCostMicrousd: 50_000,
      },
    });
    // AC-5: the platform COUNSELLOR (Sarah Mitchell) now has its own
    // database ceiling, equal to the reviewed profile budget.
    expect(byRef.get("COUNSELLOR_PLATFORM_V1")).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      dbCeiling: {
        maxProviderCalls: 1,
        maxOutputTokens: 500,
        maxEstimatedCostMicrousd: 10_000,
      },
      roles: ["Sarah Mitchell (learner-success AI) (platform)"],
    });
    expect(byRef.get("OPERATIONS_ENGINEER_PLATFORM_V1")).toMatchObject({
      model: "claude-opus-5-5",
      dbCeiling: null,
    });
  });
});

describe("reviewed evidence keyed to the exact profile definition", () => {
  it("records evidence for exactly the production profiles, matching their current fingerprints", () => {
    const profiles = listProductionRuntimeProfiles();
    expect(Object.keys(AGENT_PROFILE_EVIDENCE).sort()).toEqual(
      profiles.map((p) => p.ref).sort(),
    );
    // If this fails, a profile definition changed: re-review its evidence
    // and record the new fingerprint deliberately. Never just copy it.
    for (const profile of profiles)
      expect([profile.ref, runtimeProfileFingerprint(profile)]).toEqual([
        profile.ref,
        AGENT_PROFILE_EVIDENCE[profile.ref].profileFingerprint,
      ]);
  });

  it("is independent of object key order but sensitive to every value", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: "x" } })).toBe(
      canonicalJson({ a: { c: "x", d: [2, 1] }, b: 1 }),
    );
    const professor = resolveRuntimeProfile("PROFESSOR_COMMERCIAL_V1")!;
    expect(professor.adapterKind).toBe("OPENAI_RESPONSES");
    if (professor.adapterKind !== "OPENAI_RESPONSES") return;
    const variants: RuntimeProfile[] = [
      {
        ...professor,
        providerConfig: { ...professor.providerConfig, model: "gpt-5.6-luna" },
      },
      {
        ...professor,
        providerConfig: {
          ...professor.providerConfig,
          reasoningEffort: "high",
        },
      },
      {
        ...professor,
        providerConfig: {
          ...professor.providerConfig,
          tariff: {
            ...professor.providerConfig.tariff,
            outputMicrousdPerMillionTokens: 1,
          },
        },
      },
      {
        ...professor,
        budgetPolicy: { ...professor.budgetPolicy, maxAttempts: 2 },
      },
    ];
    const current = runtimeProfileFingerprint(professor);
    for (const variant of variants)
      expect(runtimeProfileFingerprint(variant)).not.toBe(current);
  });

  it("invalidates every evidence level when the model of a profile changes, and never claims production proof", () => {
    const lab = resolveRuntimeProfile("LAB_INSTRUCTOR_COMMERCIAL_V1")!;
    if (lab.adapterKind !== "ANTHROPIC_MESSAGES") throw new Error("unexpected");
    const changed = {
      ...lab,
      providerConfig: { ...lab.providerConfig, model: "claude-opus-5-5" },
    };
    const before = resolveProfileEvidence(
      lab.ref,
      runtimeProfileFingerprint(lab),
    );
    const after = resolveProfileEvidence(
      lab.ref,
      runtimeProfileFingerprint(changed),
    );
    expect(before.fingerprintMatches).toBe(true);
    expect(before.levels.LIVE_PROVIDER.status).toBe("PARTIAL");
    expect(after.fingerprintMatches).toBe(false);
    for (const level of EVIDENCE_LEVELS)
      expect(after.levels[level].status).toBe("NOT_CURRENT");
    expect(after.productionProven).toBe(false);
    expect(resolveProfileEvidence("UNREVIEWED_PROFILE", "x").levels).toEqual(
      Object.fromEntries(
        EVIDENCE_LEVELS.map((l) => [
          l,
          { status: "NONE", scope: "No reviewed evidence is recorded." },
        ]),
      ),
    );
  });

  it("states exactly the reviewed evidence per role and never production proof", () => {
    const status = (ref: string) => {
      const profile = resolveRuntimeProfile(ref)!;
      const e = resolveProfileEvidence(ref, runtimeProfileFingerprint(profile));
      return {
        local: e.levels.LOCAL_DETERMINISTIC.status,
        hosted: e.levels.HOSTED.status,
        live: e.levels.LIVE_PROVIDER.status,
        production: e.productionProven,
      };
    };
    expect(status("PROFESSOR_COMMERCIAL_V1")).toEqual({
      local: "RECORDED",
      hosted: "PARTIAL",
      live: "NONE",
      production: false,
    });
    expect(status("TUTOR_COMMERCIAL_V1")).toEqual({
      local: "RECORDED",
      hosted: "PARTIAL",
      live: "NONE",
      production: false,
    });
    expect(status("LAB_INSTRUCTOR_COMMERCIAL_V1")).toEqual({
      local: "RECORDED",
      hosted: "PARTIAL",
      live: "PARTIAL",
      production: false,
    });
    expect(status("EXAMINER_COMMERCIAL_V1")).toEqual({
      local: "RECORDED",
      hosted: "RECORDED",
      live: "PARTIAL",
      production: false,
    });
    // AC-5: local deterministic Sarah execution evidence only; never
    // hosted, live or production proof.
    expect(status("COUNSELLOR_PLATFORM_V1")).toEqual({
      local: "RECORDED",
      hosted: "NONE",
      live: "NONE",
      production: false,
    });
    expect(status("OPERATIONS_ENGINEER_PLATFORM_V1")).toEqual({
      local: "PARTIAL",
      hosted: "NONE",
      live: "PARTIAL",
      production: false,
    });
    // Synthetic smoke evidence is never presented as a governed-workflow
    // live test, and stubbed hosted runs never as live-model evidence.
    const lab = AGENT_PROFILE_EVIDENCE.LAB_INSTRUCTOR_COMMERCIAL_V1.levels;
    expect(lab.LIVE_PROVIDER.scope).toContain("synthetic");
    expect(lab.LIVE_PROVIDER.scope).toContain("was not live-tested");
    expect(lab.HOSTED.scope).toContain("stub");
    expect(
      AGENT_PROFILE_EVIDENCE.EXAMINER_COMMERCIAL_V1.levels.HOSTED.scope,
    ).toContain("not a live model");
  });
});

describe("CONFIGURED is derived from stored configuration alone", () => {
  it("distinguishes not configured, disabled, enabled and invalid", () => {
    expect(deriveAcademicConfiguration("TUTOR", undefined)).toMatchObject({
      state: "NOT_CONFIGURED",
      runnableByConfiguration: false,
      effectiveProfileRef: "TUTOR_COMMERCIAL_V1",
    });
    expect(
      deriveAcademicConfiguration("TUTOR", config({ enabled: false })).state,
    ).toBe("DISABLED");
    expect(deriveAcademicConfiguration("TUTOR", config())).toMatchObject({
      state: "ENABLED",
      runnableByConfiguration: true,
      storedProfileRef: null,
      effectiveProfileRef: "TUTOR_COMMERCIAL_V1",
    });
    expect(
      deriveAcademicConfiguration(
        "TUTOR",
        config({ modelProfileRef: "PROFESSOR_COMMERCIAL_V1" }),
      ),
    ).toMatchObject({ state: "INVALID", runnableByConfiguration: false });
    expect(
      deriveAcademicConfiguration(
        "PROFESSOR",
        config({ role: "PROFESSOR", modelProfileRef: null }),
      ).state,
    ).toBe("INVALID");
  });

  it("never widens capabilities beyond the code-owned catalogue and reports missing required ones", () => {
    const derived = deriveAcademicConfiguration(
      "LAB_INSTRUCTOR",
      config({
        role: "LAB_INSTRUCTOR",
        capabilities: ["get_lesson_context", "get_learning_resources"],
      }),
    );
    expect(derived.state).toBe("INVALID");
    expect(derived.effectiveCapabilities).toEqual(["get_lesson_context"]);
    expect(derived.missingRequiredCapabilities).toEqual([
      "get_lesson_objectives",
    ]);
    const examiner = deriveAcademicConfiguration(
      "EXAMINER",
      config({ role: "EXAMINER", capabilities: [] }),
    );
    expect(examiner.state).toBe("ENABLED");
    expect(examiner.runnableByConfiguration).toBe(false);
  });

  it("shows the academic COUNSELLOR as non-executable even when its stored row is enabled", () => {
    expect(
      deriveAcademicConfiguration(
        "COUNSELLOR",
        config({
          role: "COUNSELLOR",
          capabilities: ["get_current_learner_context"],
        }),
      ),
    ).toMatchObject({
      state: "ENABLED",
      executable: false,
      runnableByConfiguration: false,
      effectiveProfileRef: null,
    });
  });
});

describe("getAgentControlPlane", () => {
  it("requires ACADEMIC_ADMIN or PLATFORM_ADMIN before any read", async () => {
    mocks.requireAnyRole.mockRejectedValue(new AccessDenied());
    await expect(getAgentControlPlane(null)).rejects.toBeInstanceOf(
      AccessDenied,
    );
    expect(mocks.requireAnyRole).toHaveBeenCalledWith([
      "ACADEMIC_ADMIN",
      "PLATFORM_ADMIN",
    ]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps a database FORBIDDEN refusal to access denied", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "FORBIDDEN" },
    });
    await expect(getAgentControlPlane(null)).rejects.toBeInstanceOf(
      AccessDenied,
    );
  });

  it("calls only the admin scope read, with the typed cursor, and makes no provider request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("OPENAI_API_KEY", OPENAI_SECRET);
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_SECRET);
    mocks.rpc.mockResolvedValue({
      data: scopePage([
        config({
          role: "PROFESSOR",
          modelProfileRef: "PROFESSOR_COMMERCIAL_V1",
          hasInstructionalNotes: true,
          capabilities: ["get_lesson_context"],
        }),
        config(),
        config({ role: "COUNSELLOR", enabled: true, capabilities: [] }),
      ]),
      error: null,
    });
    const cursor = {
      createdAt: "2026-10-01T10:00:00.123456+00:00",
      id: VERSION,
    };
    const { plane } = await getAgentControlPlane(cursor);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "admin_list_agent_configuration_scopes",
      { p_cursor_created_at: cursor.createdAt, p_cursor_id: VERSION },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expectNoSecretMaterial(plane);

    const roles = new Map(plane.page.versions[0].roles.map((r) => [r.role, r]));
    expect(roles.get("PROFESSOR")).toMatchObject({
      state: "ENABLED",
      executable: true,
      readiness: "CREDENTIAL_PRESENT",
      hasInstructionalNotes: true,
    });
    expect(roles.get("LAB_INSTRUCTOR")).toMatchObject({
      state: "NOT_CONFIGURED",
      enabled: null,
    });
    expect(roles.get("COUNSELLOR")).toMatchObject({
      executable: false,
      readiness: "NOT_APPLICABLE",
    });
    expect(roles.get("EXAMINER")!.escalationSemantics).toContain(
      "academic-review worklist",
    );
    expect(roles.get("PROFESSOR")!.escalationSemantics).toContain(
      "No academic-review case",
    );
    expect(plane.platformRoles).toEqual([
      expect.objectContaining({
        role: "COUNSELLOR",
        displayName: "Sarah Mitchell (learner-success AI)",
        executable: true,
        profileRef: "COUNSELLOR_PLATFORM_V1",
      }),
      expect.objectContaining({
        role: "OPERATIONS_ENGINEER",
        executable: false,
      }),
    ]);
    for (const p of plane.profiles)
      expect(p.evidence.productionProven).toBe(false);
  });

  it("fails closed on an unexpected database payload, including note text", async () => {
    mocks.rpc.mockResolvedValue({
      data: scopePage([
        { ...config(), instructionalNotes: "Leaked note" } as AgentConfigScope,
      ]),
      error: null,
    });
    await expect(getAgentControlPlane(null)).rejects.toBeInstanceOf(
      AgentControlPlaneUnavailable,
    );
  });
});

describe("cursor parsing", () => {
  it("accepts only a complete, well-formed cursor", () => {
    expect(
      parseAgentControlCursor({
        after: "2026-10-01T10:00:00.123456+00:00",
        afterId: VERSION,
      }),
    ).toEqual({ createdAt: "2026-10-01T10:00:00.123456+00:00", id: VERSION });
    expect(
      parseAgentControlCursor({ after: "2026-10-01T10:00:00Z" }),
    ).toBeNull();
    expect(
      parseAgentControlCursor({ after: "yesterday", afterId: VERSION }),
    ).toBeNull();
    expect(
      parseAgentControlCursor({
        after: "2026-10-01T10:00:00Z",
        afterId: "'; drop table x; --",
      }),
    ).toBeNull();
  });
});
