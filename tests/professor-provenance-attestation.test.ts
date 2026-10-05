import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AC-2: the controller's attested Professor provenance message must use the
// exact canonical field order record_professor_execution_provenance
// (migration 051) verifies, including the applied Level-1 institutional
// baseline version. Only identity, Supabase and the gateway are stubbed;
// the real recorder signs with the real HMAC.
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), actor: vi.fn() }));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: mocks.actor,
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/server/academic-capabilities", () => ({
  withValidatedProfessorContent: vi.fn(),
}));

import { recordProfessorExecutionProvenance } from "@/server/academic-runtime/professor-teaching";
import { INSTITUTIONAL_BASELINE_VERSION } from "@/domain/agent-behaviour";

const KEY_ID = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const KEY_HEX = "ab".repeat(32);
const STUDENT = "11111111-1111-4111-8111-111111111111";
const EXECUTION = "22222222-2222-4222-8222-222222222222";
const RELEASE = "33333333-3333-4333-8333-333333333333";
const OBJECTIVES = "44444444-4444-4444-8444-444444444444";
const CLASS = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ACADEMIC_EXECUTION_KEY_ID", KEY_ID);
  vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", KEY_HEX);
  mocks.actor.mockResolvedValue({ id: STUDENT, roles: ["STUDENT"] });
  mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("recordProfessorExecutionProvenance attestation", () => {
  it("signs the database's canonical order, including the applied institutional baseline", async () => {
    await recordProfessorExecutionProvenance({
      executionId: EXECUTION,
      release: { release_id: RELEASE, student_id: STUDENT } as never,
      classSessionId: CLASS,
      contextReleases: [
        { capability: "get_lesson_context", releaseId: RELEASE },
        { capability: "get_lesson_objectives", releaseId: OBJECTIVES },
      ],
      runtimeProfileRef: "PROFESSOR_COMMERCIAL_V1",
      institutionalBaselineVersion: INSTITUTIONAL_BASELINE_VERSION,
      behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
      behaviourConfigVersion: "AGENT_BEHAVIOUR_DEFAULT_V1",
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = mocks.rpc.mock.calls[0];
    expect(name).toBe("record_professor_execution_provenance");
    expect(args).toMatchObject({
      p_institutional_baseline_version: "DUCELIO_INSTITUTIONAL_BASELINE_V1",
      p_behaviour_version: "PROFESSOR_BEHAVIOUR_V1",
      p_behaviour_config_version: "AGENT_BEHAVIOUR_DEFAULT_V1",
    });
    // The exact concat_ws(E'\n', ...) order of migration 051.
    const canonical = [
      "DUCELIO_AGENT_PROVENANCE_HMAC_SHA256_V1",
      "PROFESSOR",
      KEY_ID,
      STUDENT,
      EXECUTION,
      RELEASE,
      CLASS,
      `get_lesson_context:${RELEASE},get_lesson_objectives:${OBJECTIVES}`,
      "PROFESSOR_COMMERCIAL_V1",
      "DUCELIO_INSTITUTIONAL_BASELINE_V1",
      "PROFESSOR_BEHAVIOUR_V1",
      "AGENT_BEHAVIOUR_DEFAULT_V1",
      String(args.p_issued_at),
      String(args.p_expires_at),
    ].join("\n");
    expect(args.p_mac).toBe(
      createHmac("sha256", Buffer.from(KEY_HEX, "hex"))
        .update(canonical, "utf8")
        .digest("hex"),
    );
    // No rule text, prompt or key material is sent.
    expect(JSON.stringify(args)).not.toMatch(/LEVEL 1|deterministic backend/);
    expect(JSON.stringify(args)).not.toContain(KEY_HEX);
  });
});
