import { describe, expect, it } from "vitest";
import {
  agentConfigInputSchema,
  isCapabilityAuthorized,
  roleCapabilityCatalogue,
} from "@/domain/academic-agent-config";

function baseInput() {
  return {
    programmeVersionId: "20000000-0000-4000-8000-000000000002",
    role: "PROFESSOR" as const,
    enabled: true,
    modelProfileRef: "professor-default",
    instructionalNotes: null,
    capabilities: ["get_lesson_context"],
    escalationPolicy: "NONE" as const,
    reason: "Configure the reference Professor for this course",
  };
}

describe("agent configuration input", () => {
  it("accepts a capability within the role's allowlist", () => {
    expect(agentConfigInputSchema.safeParse(baseInput()).success).toBe(true);
  });

  it("rejects a capability outside the role's allowlist", () => {
    const input = { ...baseInput(), capabilities: ["delete_everything"] };
    expect(agentConfigInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a capability valid for another role but not this one", () => {
    // get_permitted_learning_history is PROFESSOR-only, not COUNSELLOR.
    const input = {
      ...baseInput(),
      role: "COUNSELLOR" as const,
      capabilities: ["get_permitted_learning_history"],
    };
    expect(agentConfigInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects duplicate capabilities", () => {
    const input = {
      ...baseInput(),
      capabilities: ["get_lesson_context", "get_lesson_context"],
    };
    expect(agentConfigInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an unbounded reason", () => {
    const input = { ...baseInput(), reason: "no" };
    expect(agentConfigInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("roleCapabilityCatalogue", () => {
  it("gives PROFESSOR exactly the nine PROFESSOR_READ_V2 capabilities", () => {
    expect(roleCapabilityCatalogue.PROFESSOR).toHaveLength(9);
  });

  it("never lets a narrower role inherit PROFESSOR-only capabilities", () => {
    expect(roleCapabilityCatalogue.COUNSELLOR).not.toContain(
      "get_permitted_learning_history",
    );
    expect(roleCapabilityCatalogue.EXAMINER).not.toContain(
      "get_current_mastery_state",
    );
  });
});

describe("isCapabilityAuthorized", () => {
  it("requires both the role allowlist and the stored configuration", () => {
    expect(
      isCapabilityAuthorized("PROFESSOR", "get_lesson_context", [
        "get_lesson_context",
      ]),
    ).toBe(true);
  });

  it("denies a capability the role allowlist does not include", () => {
    expect(
      isCapabilityAuthorized("COUNSELLOR", "get_lesson_context", [
        "get_lesson_context",
      ]),
    ).toBe(false);
  });

  it("denies a capability the stored configuration did not request", () => {
    expect(isCapabilityAuthorized("PROFESSOR", "get_lesson_context", [])).toBe(
      false,
    );
  });

  it("never grants a capability from configuration alone", () => {
    // Configuration claiming a capability outside the reviewed allowlist
    // must never be treated as authorized, even if somehow stored.
    expect(
      isCapabilityAuthorized("COUNSELLOR", "get_current_mastery_state", [
        "get_current_mastery_state",
      ]),
    ).toBe(false);
  });
});
