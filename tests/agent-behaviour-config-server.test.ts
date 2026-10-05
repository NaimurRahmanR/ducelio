import { beforeEach, describe, expect, it, vi } from "vitest";

// AC-2 historical default drift: the server's learner-scoped behaviour read
// returns exactly the binding the database froze at publication (pinned
// role behaviour version and actual values, also for a default). It never
// substitutes the current code default, and it fails closed on a missing or
// invalid binding, an unreviewed pinned version, a cross-role version, a
// frozen default whose values disagree with its version, or the legacy
// pre-binding response shape. Only the Supabase transport is stubbed.
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/server/identity", () => ({ requireActor: vi.fn() }));

import {
  AgentBehaviourUnavailable,
  getAgentBehaviourForEnrolment,
} from "@/server/agent-behaviour-config";

const ENROLMENT = "11111111-1111-4111-8111-111111111111";
const V1_DEFAULT = {
  responseDepth: "STANDARD",
  teachingApproach: "CONCEPT_FIRST",
  understandingCheckFrequency: "STANDARD",
  challengeLevel: "STANDARD",
  courseContextNotes: null,
};
const binding = (over: Record<string, unknown> = {}) => ({
  ok: true,
  source: "DEFAULT",
  configVersion: "AGENT_BEHAVIOUR_DEFAULT_V1",
  behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
  config: V1_DEFAULT,
  institutionalBaselineVersion: "DUCELIO_INSTITUTIONAL_BASELINE_V1",
  ...over,
});
const read = (data: unknown, role: "PROFESSOR" | "TUTOR" = "PROFESSOR") => {
  mocks.rpc.mockResolvedValue({ data, error: null });
  return getAgentBehaviourForEnrolment(ENROLMENT, role);
};

beforeEach(() => vi.resetAllMocks());

describe("getAgentBehaviourForEnrolment (frozen behaviour binding)", () => {
  it("returns a frozen default binding's own values and pinned version", async () => {
    await expect(read(binding())).resolves.toEqual({
      behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
      source: "DEFAULT",
      configVersion: "AGENT_BEHAVIOUR_DEFAULT_V1",
      config: V1_DEFAULT,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "get_agent_behaviour_for_enrolment",
      { p_enrolment_id: ENROLMENT, p_role: "PROFESSOR" },
    );
  });

  it("returns an explicit binding exactly as frozen", async () => {
    const config = {
      responseDepth: "DETAILED",
      teachingApproach: "GUIDED_QUESTIONING",
      understandingCheckFrequency: "HIGH",
      challengeLevel: "FOUNDATION",
      courseContextNotes: "Use plain English.",
    };
    await expect(
      read(
        binding({
          source: "EXPLICIT",
          configVersion: "AGENT_BEHAVIOUR_CONFIG_V1",
          behaviourVersion: "TUTOR_BEHAVIOUR_V1",
          config,
        }),
        "TUTOR",
      ),
    ).resolves.toEqual({
      behaviourVersion: "TUTOR_BEHAVIOUR_V1",
      source: "EXPLICIT",
      configVersion: "AGENT_BEHAVIOUR_CONFIG_V1",
      config,
    });
  });

  it.each([
    ["a missing binding", { ok: false, code: "BEHAVIOUR_BINDING_MISSING" }],
    ["an invalid binding", { ok: false, code: "BEHAVIOUR_BINDING_INVALID" }],
    [
      "the legacy pre-binding default shape (no frozen values)",
      {
        ok: true,
        source: "DEFAULT",
        configVersion: "AGENT_BEHAVIOUR_DEFAULT_V1",
        behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
        institutionalBaselineVersion: "DUCELIO_INSTITUTIONAL_BASELINE_V1",
      },
    ],
    [
      "an unreviewed pinned role version",
      binding({ behaviourVersion: "PROFESSOR_BEHAVIOUR_V2" }),
    ],
    [
      "another role's pinned version",
      binding({ behaviourVersion: "TUTOR_BEHAVIOUR_V1" }),
    ],
    [
      "an unknown default version",
      binding({ configVersion: "AGENT_BEHAVIOUR_DEFAULT_V2" }),
    ],
    [
      "frozen default values that disagree with their version",
      binding({ config: { ...V1_DEFAULT, responseDepth: "DETAILED" } }),
    ],
    [
      "default notes",
      binding({ config: { ...V1_DEFAULT, courseContextNotes: "Injected" } }),
    ],
    ["extra fields", { ...binding(), configId: "x" }],
    [
      "a database institutional baseline that differs from the applied one",
      binding({
        institutionalBaselineVersion: "DUCELIO_INSTITUTIONAL_BASELINE_V2",
      }),
    ],
    [
      "a missing institutional baseline",
      {
        ok: true,
        source: "DEFAULT",
        configVersion: "AGENT_BEHAVIOUR_DEFAULT_V1",
        behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
        config: V1_DEFAULT,
      },
    ],
  ])("fails closed on %s", async (_label, data) => {
    await expect(read(data)).rejects.toBeInstanceOf(AgentBehaviourUnavailable);
  });

  it("fails closed on a transport error", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(
      getAgentBehaviourForEnrolment(ENROLMENT, "PROFESSOR"),
    ).rejects.toBeInstanceOf(AgentBehaviourUnavailable);
  });
});
