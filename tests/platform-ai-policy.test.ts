import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COUNSELLOR_PROHIBITED_SCOPES,
  OPERATIONS_ENGINEER_PROHIBITED_SCOPES,
  PLATFORM_ROLE_PROFILE_REF,
  counsellorCapabilityByMode,
  isCounsellorCapabilityAllowed,
  isOperationsEngineerCapabilityAllowed,
} from "@/domain/platform-ai-policy";
import {
  resolveAdapterForProfile,
  resolvePlatformRuntimeProfile,
  resolveRoleBoundRuntimeProfile,
} from "@/server/academic-runtime/profile-registry";
import { runtimeProfileSchema } from "@/domain/academic-runtime-profile";
import { runGovernedProviderExecution } from "@/server/academic-runtime/runtime";

describe("platform AI role definitions", () => {
  it("defines one continuing Counsellor persona with lifecycle modes", () => {
    expect(Object.keys(counsellorCapabilityByMode).sort()).toEqual([
      "ACTIVE_COURSE",
      "POST_COURSE",
      "PROSPECT",
    ]);
    expect(
      isCounsellorCapabilityAllowed("PROSPECT", "help_choose_course"),
    ).toBe(true);
    expect(
      isCounsellorCapabilityAllowed(
        "ACTIVE_COURSE",
        "coordinate_academic_handoff",
      ),
    ).toBe(true);
    expect(
      isCounsellorCapabilityAllowed(
        "POST_COURSE",
        "explain_next_course_options",
      ),
    ).toBe(true);
    expect(
      isCounsellorCapabilityAllowed("PROSPECT", "coordinate_academic_handoff"),
    ).toBe(false);
    expect(COUNSELLOR_PROHIBITED_SCOPES).toContain(
      "answer_controlled_assessment",
    );
    expect(COUNSELLOR_PROHIBITED_SCOPES).toContain("teach_course_content");
  });

  it("defines Operations Engineer as observation/proposal only", () => {
    for (const capability of [
      "read_system_health",
      "read_provider_failures",
      "read_usage_and_costs",
      "read_jobs_and_ci",
      "read_migration_status",
      "read_error_summary",
      "propose_fix",
      "propose_pull_request",
      "draft_release_notes",
    ]) {
      expect(isOperationsEngineerCapabilityAllowed(capability)).toBe(true);
    }
    for (const prohibited of [
      "raw_database_access",
      "raw_shell_access",
      "service_role_access",
      "read_or_write_secrets",
      "merge_pull_request",
      "deploy_production",
      "unbounded_github_mutation",
    ]) {
      expect(OPERATIONS_ENGINEER_PROHIBITED_SCOPES).toContain(prohibited);
      expect(isOperationsEngineerCapabilityAllowed(prohibited)).toBe(false);
    }
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("platform AI native routing", () => {
  it("routes Counsellor to the economy OpenAI profile and Operations Engineer to Claude Opus 5.5 via Anthropic Messages", () => {
    expect(resolvePlatformRuntimeProfile("COUNSELLOR")).toMatchObject({
      ref: "COUNSELLOR_PLATFORM_V1",
      adapterKind: "OPENAI_RESPONSES",
      providerConfig: {
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
      },
    });
    const ops = resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER");
    expect(ops).toMatchObject({
      ref: "OPERATIONS_ENGINEER_PLATFORM_V1",
      adapterKind: "ANTHROPIC_MESSAGES",
      providerConfig: { model: "claude-opus-5-5" },
    });
    expect(ops?.adapterKind).toBe("ANTHROPIC_MESSAGES");
    if (ops?.adapterKind === "ANTHROPIC_MESSAGES") {
      // Anthropic profiles carry no OpenAI reasoningEffort.
      expect(ops.providerConfig).not.toHaveProperty("reasoningEffort");
      expect(ops.providerConfig.tariff).toEqual({
        inputMicrousdPerMillionTokens: 4_000_000,
        outputMicrousdPerMillionTokens: 20_000_000,
        reviewedAt: "2026-09-27",
      });
    }
  });

  it("keeps the Operations Engineer execution budget unchanged by the routing correction", () => {
    expect(
      resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER")?.budgetPolicy,
    ).toEqual({
      maxProviderCalls: 1,
      maxAttempts: 1,
      maxInputContextBytes: 64_000,
      maxOutputTokens: 1200,
      totalDeadlineMs: 20_000,
      maxEstimatedCostMicrousd: 100_000,
    });
  });

  it("keeps both platform profiles inside the runtime schema", () => {
    expect(() =>
      runtimeProfileSchema.parse(resolvePlatformRuntimeProfile("COUNSELLOR")),
    ).not.toThrow();
    expect(() =>
      runtimeProfileSchema.parse(
        resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER"),
      ),
    ).not.toThrow();
  });

  it("resolves Operations Engineer only with ANTHROPIC_API_KEY; OPENAI_API_KEY no longer gates it", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-routing-test");
    expect(
      resolveAdapterForProfile(
        resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER")!,
      )?.name,
    ).toBe("anthropic-messages");
    // Counsellor still needs the OpenAI key and fails closed without it.
    expect(
      resolveAdapterForProfile(resolvePlatformRuntimeProfile("COUNSELLOR")!),
    ).toBeNull();
  });

  it("fails Operations Engineer closed without ANTHROPIC_API_KEY, even when OPENAI_API_KEY is present", () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-routing-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(
      resolveAdapterForProfile(
        resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER")!,
      ),
    ).toBeNull();
    expect(
      resolveAdapterForProfile(resolvePlatformRuntimeProfile("COUNSELLOR")!)
        ?.name,
    ).toBe("openai-responses");
  });

  it("fails both platform profiles closed with no provider key at all", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(
      resolveAdapterForProfile(resolvePlatformRuntimeProfile("COUNSELLOR")!),
    ).toBeNull();
    expect(
      resolveAdapterForProfile(
        resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER")!,
      ),
    ).toBeNull();
  });

  it("keeps platform routing server-owned: the role maps to one fixed profile ref and the model reaches only the fixed Anthropic endpoint", async () => {
    expect(PLATFORM_ROLE_PROFILE_REF.OPERATIONS_ENGINEER).toBe(
      "OPERATIONS_ENGINEER_PLATFORM_V1",
    );
    expect(Object.isFrozen(PLATFORM_ROLE_PROFILE_REF)).toBe(true);
    // Not an academic role: the academic role-bound resolver cannot reach it.
    expect(
      resolveRoleBoundRuntimeProfile(
        "PROFESSOR",
        "OPERATIONS_ENGINEER_PLATFORM_V1",
      ),
    ).toBeNull();

    // Mocked HTTP only: no network request is made.
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-routing-test");
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({
            type: "message",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Proposal" }],
            usage: { input_tokens: 1000, output_tokens: 100 },
          }),
          { status: 200 },
        );
      }),
    );
    const profile = resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER")!;
    const result = await runGovernedProviderExecution(
      resolveAdapterForProfile(profile),
      {
        role: "OPERATIONS_ENGINEER",
        capability: "read_system_health",
        context: { summary: "synthetic" },
      },
      profile.budgetPolicy,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 1200,
    });
    expect(calls[0].body).not.toHaveProperty("reasoning");
    expect(result.outcome).toBe("SUCCEEDED");
    // ceil((1000 * 4000000 + 100 * 20000000) / 1e6) = 6000
    expect(result.usage.estimatedCostMicrousd).toBe(6000);
  });
});
