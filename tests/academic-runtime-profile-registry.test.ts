import { describe, expect, it } from "vitest";
import {
  resolveAdapterForProfile,
  resolveRoleBoundRuntimeProfile,
  resolveRuntimeProfile,
} from "@/server/academic-runtime/profile-registry";
import { DEFAULT_RUNTIME_BUDGET_POLICY } from "@/domain/academic-runtime";
import { PROVIDER_EXECUTION_DB_CEILING } from "@/domain/academic-provider-execution";
import { TUTOR_LAB_EXECUTION_DB_CEILING } from "@/domain/tutor-lab-execution";
import { EXAMINER_EXECUTION_DB_CEILING } from "@/domain/commercial-v1-examiner-grading";
import {
  runtimeProfileSchema,
  type RuntimeProfile,
} from "@/domain/academic-runtime-profile";

describe("production native routing registry", () => {
  it("routes each academic role only through its reviewed provider/model profile", () => {
    expect(resolveRuntimeProfile("PROFESSOR_COMMERCIAL_V1")).toMatchObject({
      adapterKind: "OPENAI_RESPONSES",
      providerConfig: { model: "gpt-5.6-terra" },
    });
    expect(resolveRuntimeProfile("TUTOR_COMMERCIAL_V1")).toMatchObject({
      adapterKind: "OPENAI_RESPONSES",
      providerConfig: { model: "gpt-5.6-luna" },
    });
    expect(resolveRuntimeProfile("LAB_INSTRUCTOR_COMMERCIAL_V1")).toMatchObject(
      {
        adapterKind: "ANTHROPIC_MESSAGES",
        providerConfig: { model: "claude-sonnet-5" },
      },
    );
    expect(resolveRuntimeProfile("EXAMINER_COMMERCIAL_V1")).toMatchObject({
      adapterKind: "OPENAI_RESPONSES",
      providerConfig: { model: "gpt-5.6-luna" },
    });
  });

  it("routes the platform roles: Counsellor to OpenAI Luna, Operations Engineer to Claude Opus 5.5", () => {
    expect(resolveRuntimeProfile("COUNSELLOR_PLATFORM_V1")).toMatchObject({
      adapterKind: "OPENAI_RESPONSES",
      providerConfig: { model: "gpt-5.6-luna", reasoningEffort: "low" },
    });
    expect(
      resolveRuntimeProfile("OPERATIONS_ENGINEER_PLATFORM_V1"),
    ).toMatchObject({
      adapterKind: "ANTHROPIC_MESSAGES",
      providerConfig: { model: "claude-opus-5-5" },
    });
  });

  it("every production registry entry satisfies the full runtime-profile schema", () => {
    for (const ref of [
      "PROFESSOR_COMMERCIAL_V1",
      "TUTOR_COMMERCIAL_V1",
      "LAB_INSTRUCTOR_COMMERCIAL_V1",
      "EXAMINER_COMMERCIAL_V1",
      "COUNSELLOR_PLATFORM_V1",
      "OPERATIONS_ENGINEER_PLATFORM_V1",
    ]) {
      expect(() =>
        runtimeProfileSchema.parse(resolveRuntimeProfile(ref)),
      ).not.toThrow();
    }
  });

  it("keeps reviewed tariff snapshots code-owned and dated", () => {
    const professor = resolveRuntimeProfile("PROFESSOR_COMMERCIAL_V1");
    const lab = resolveRuntimeProfile("LAB_INSTRUCTOR_COMMERCIAL_V1");
    expect(professor?.adapterKind).toBe("OPENAI_RESPONSES");
    if (professor?.adapterKind === "OPENAI_RESPONSES") {
      expect(professor.providerConfig.tariff).toEqual({
        inputMicrousdPerMillionTokens: 2_000_000,
        outputMicrousdPerMillionTokens: 12_000_000,
        reviewedAt: "2026-09-18",
      });
    }
    expect(lab?.adapterKind).toBe("ANTHROPIC_MESSAGES");
    if (lab?.adapterKind === "ANTHROPIC_MESSAGES") {
      expect(lab.providerConfig.tariff).toEqual({
        inputMicrousdPerMillionTokens: 2_000_000,
        outputMicrousdPerMillionTokens: 10_000_000,
        reviewedAt: "2026-09-18",
      });
    }
    const ops = resolveRuntimeProfile("OPERATIONS_ENGINEER_PLATFORM_V1");
    expect(ops?.adapterKind).toBe("ANTHROPIC_MESSAGES");
    if (ops?.adapterKind === "ANTHROPIC_MESSAGES") {
      expect(ops.providerConfig.tariff).toEqual({
        inputMicrousdPerMillionTokens: 4_000_000,
        outputMicrousdPerMillionTokens: 20_000_000,
        reviewedAt: "2026-09-27",
      });
    }
  });

  it("keeps every role profile within its existing database ceiling", () => {
    const professor = resolveRuntimeProfile("PROFESSOR_COMMERCIAL_V1")!;
    const tutor = resolveRuntimeProfile("TUTOR_COMMERCIAL_V1")!;
    const lab = resolveRuntimeProfile("LAB_INSTRUCTOR_COMMERCIAL_V1")!;
    const examiner = resolveRuntimeProfile("EXAMINER_COMMERCIAL_V1")!;

    for (const profile of [professor, tutor, lab, examiner]) {
      expect(profile.budgetPolicy.maxAttempts).toBe(1);
    }

    expect(professor.budgetPolicy.maxProviderCalls).toBeLessThanOrEqual(
      PROVIDER_EXECUTION_DB_CEILING.maxProviderCalls,
    );
    expect(professor.budgetPolicy.maxOutputTokens).toBeLessThanOrEqual(
      PROVIDER_EXECUTION_DB_CEILING.maxOutputTokens,
    );
    expect(professor.budgetPolicy.maxEstimatedCostMicrousd).toBeLessThanOrEqual(
      PROVIDER_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd,
    );

    for (const profile of [tutor, lab]) {
      expect(profile.budgetPolicy.maxProviderCalls).toBe(
        TUTOR_LAB_EXECUTION_DB_CEILING.maxProviderCalls,
      );
      expect(profile.budgetPolicy.maxOutputTokens).toBeLessThanOrEqual(
        TUTOR_LAB_EXECUTION_DB_CEILING.maxOutputTokens,
      );
      expect(profile.budgetPolicy.maxEstimatedCostMicrousd).toBeLessThanOrEqual(
        TUTOR_LAB_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd,
      );
    }

    expect(examiner.budgetPolicy.maxProviderCalls).toBe(
      EXAMINER_EXECUTION_DB_CEILING.maxProviderCalls,
    );
    expect(examiner.budgetPolicy.maxOutputTokens).toBeLessThanOrEqual(
      EXAMINER_EXECUTION_DB_CEILING.maxOutputTokens,
    );
    expect(examiner.budgetPolicy.maxEstimatedCostMicrousd).toBeLessThanOrEqual(
      EXAMINER_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd,
    );
  });

  it("fails closed for null, unknown and case-changed refs", () => {
    expect(resolveRuntimeProfile(null)).toBeNull();
    expect(resolveRuntimeProfile("anything-at-all")).toBeNull();
    expect(resolveRuntimeProfile("professor_commercial_v1")).toBeNull();
    expect(resolveRuntimeProfile("PROFESSOR_COMMERCIAL_V2")).toBeNull();
  });

  it("resolves custom profiles only through an explicit test registry", () => {
    const profile: RuntimeProfile = {
      ref: "explicit-test-profile",
      adapterKind: "TEST_DETERMINISTIC",
      budgetPolicy: DEFAULT_RUNTIME_BUDGET_POLICY,
    };
    const customRegistry = { "explicit-test-profile": profile };
    expect(resolveRuntimeProfile("explicit-test-profile")).toBeNull();
    expect(resolveRuntimeProfile("explicit-test-profile", customRegistry)).toBe(
      profile,
    );
  });
});

describe("resolveRoleBoundRuntimeProfile", () => {
  it("PROFESSOR accepts only its exact non-null profile", () => {
    expect(
      resolveRoleBoundRuntimeProfile("PROFESSOR", "PROFESSOR_COMMERCIAL_V1"),
    ).toMatchObject({ ref: "PROFESSOR_COMMERCIAL_V1" });
    expect(resolveRoleBoundRuntimeProfile("PROFESSOR", null)).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("PROFESSOR", "TUTOR_COMMERCIAL_V1"),
    ).toBeNull();
  });

  it("TUTOR/LAB/EXAMINER default null only to their own fixed profile", () => {
    expect(resolveRoleBoundRuntimeProfile("TUTOR", null)).toMatchObject({
      ref: "TUTOR_COMMERCIAL_V1",
    });
    expect(
      resolveRoleBoundRuntimeProfile("LAB_INSTRUCTOR", null),
    ).toMatchObject({ ref: "LAB_INSTRUCTOR_COMMERCIAL_V1" });
    expect(resolveRoleBoundRuntimeProfile("EXAMINER", null)).toMatchObject({
      ref: "EXAMINER_COMMERCIAL_V1",
    });
    expect(
      resolveRoleBoundRuntimeProfile("EXAMINER", "TUTOR_COMMERCIAL_V1"),
    ).toBeNull();
  });

  it("COUNSELLOR remains non-provider-backed in the academic role plane", () => {
    expect(resolveRoleBoundRuntimeProfile("COUNSELLOR", null)).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("COUNSELLOR", "EXAMINER_COMMERCIAL_V1"),
    ).toBeNull();
  });

  it("validates role/ref before consulting an injected registry", () => {
    const calls: string[] = [];
    const profile: RuntimeProfile = {
      ref: "TUTOR_COMMERCIAL_V1",
      adapterKind: "TEST_DETERMINISTIC",
      budgetPolicy: DEFAULT_RUNTIME_BUDGET_POLICY,
    };
    const injected = (ref: string) => {
      calls.push(ref);
      return ref === "TUTOR_COMMERCIAL_V1" ? profile : null;
    };
    expect(
      resolveRoleBoundRuntimeProfile(
        "TUTOR",
        "PROFESSOR_COMMERCIAL_V1",
        injected,
      ),
    ).toBeNull();
    expect(calls).toEqual([]);
    expect(resolveRoleBoundRuntimeProfile("TUTOR", null, injected)).toBe(
      profile,
    );
    expect(calls).toEqual(["TUTOR_COMMERCIAL_V1"]);
  });
});

describe("resolveAdapterForProfile", () => {
  it("never resolves TEST_DETERMINISTIC through production code", () => {
    const profile: RuntimeProfile = {
      ref: "test-profile",
      adapterKind: "TEST_DETERMINISTIC",
      budgetPolicy: DEFAULT_RUNTIME_BUDGET_POLICY,
    };
    expect(resolveAdapterForProfile(profile)).toBeNull();
  });

  it("resolves each production profile to the intended native adapter when only server keys are present", () => {
    const oldOpenAI = process.env.OPENAI_API_KEY;
    const oldAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "openai-routing-test";
    process.env.ANTHROPIC_API_KEY = "anthropic-routing-test";
    try {
      expect(
        resolveAdapterForProfile(
          resolveRuntimeProfile("PROFESSOR_COMMERCIAL_V1")!,
        )?.name,
      ).toBe("openai-responses");
      expect(
        resolveAdapterForProfile(resolveRuntimeProfile("TUTOR_COMMERCIAL_V1")!)
          ?.name,
      ).toBe("openai-responses");
      expect(
        resolveAdapterForProfile(
          resolveRuntimeProfile("LAB_INSTRUCTOR_COMMERCIAL_V1")!,
        )?.name,
      ).toBe("anthropic-messages");
      expect(
        resolveAdapterForProfile(
          resolveRuntimeProfile("EXAMINER_COMMERCIAL_V1")!,
        )?.name,
      ).toBe("openai-responses");
      expect(
        resolveAdapterForProfile(
          resolveRuntimeProfile("COUNSELLOR_PLATFORM_V1")!,
        )?.name,
      ).toBe("openai-responses");
      expect(
        resolveAdapterForProfile(
          resolveRuntimeProfile("OPERATIONS_ENGINEER_PLATFORM_V1")!,
        )?.name,
      ).toBe("anthropic-messages");
    } finally {
      if (oldOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenAI;
      if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = oldAnthropic;
    }
  });

  it("fails closed when the role's native provider key is absent", () => {
    const oldOpenAI = process.env.OPENAI_API_KEY;
    const oldAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(
        resolveAdapterForProfile(
          resolveRuntimeProfile("PROFESSOR_COMMERCIAL_V1")!,
        ),
      ).toBeNull();
      expect(
        resolveAdapterForProfile(
          resolveRuntimeProfile("LAB_INSTRUCTOR_COMMERCIAL_V1")!,
        ),
      ).toBeNull();
      expect(
        resolveAdapterForProfile(
          resolveRuntimeProfile("OPERATIONS_ENGINEER_PLATFORM_V1")!,
        ),
      ).toBeNull();
    } finally {
      if (oldOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenAI;
      if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = oldAnthropic;
    }
  });
});
