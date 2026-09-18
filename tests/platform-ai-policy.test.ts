import { describe, expect, it } from "vitest";
import {
  COUNSELLOR_PROHIBITED_SCOPES,
  OPERATIONS_ENGINEER_PROHIBITED_SCOPES,
  counsellorCapabilityByMode,
  isCounsellorCapabilityAllowed,
  isOperationsEngineerCapabilityAllowed,
} from "@/domain/platform-ai-policy";
import {
  resolveAdapterForProfile,
  resolvePlatformRuntimeProfile,
} from "@/server/academic-runtime/profile-registry";
import { runtimeProfileSchema } from "@/domain/academic-runtime-profile";

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

describe("platform AI native routing", () => {
  it("routes Counsellor to the economy OpenAI profile and Operations Engineer to the stronger OpenAI profile", () => {
    expect(resolvePlatformRuntimeProfile("COUNSELLOR")).toMatchObject({
      ref: "COUNSELLOR_PLATFORM_V1",
      adapterKind: "OPENAI_RESPONSES",
      providerConfig: {
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
      },
    });
    expect(resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER")).toMatchObject({
      ref: "OPERATIONS_ENGINEER_PLATFORM_V1",
      adapterKind: "OPENAI_RESPONSES",
      providerConfig: {
        model: "gpt-5.6-terra",
        reasoningEffort: "high",
      },
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

  it("fails native adapter resolution closed without the OpenAI key", () => {
    const old = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(
        resolveAdapterForProfile(resolvePlatformRuntimeProfile("COUNSELLOR")!),
      ).toBeNull();
      expect(
        resolveAdapterForProfile(
          resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER")!,
        ),
      ).toBeNull();
    } finally {
      if (old === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old;
    }
  });
});
