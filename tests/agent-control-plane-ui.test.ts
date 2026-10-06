import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AGENT-CONTROL-1 UI: the read-only /admin/agents page through the REAL
// server layer (src/server/agent-control-plane.ts) and real registry, the
// truthful Course Engineering agent form, and the corrected learner copy.
// Only identity, the Supabase transport and unrelated Server Actions are
// stubbed.
const mocks = vi.hoisted(() => ({
  requireAnyRole: vi.fn(),
  actor: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireAnyRole: mocks.requireAnyRole,
  getAuthenticatedActor: mocks.actor,
  requireActor: async () => mocks.actor(),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/app/admin/course-engineering/actions", () => ({
  importPackageAction: vi.fn(),
  packageLifecycleAction: vi.fn(),
  saveCourseAgentAction: vi.fn(),
  runCourseTestAction: vi.fn(),
}));
vi.mock("@/app/student/classroom/actions", () => ({
  beginLessonAction: vi.fn(),
  askProfessorAction: vi.fn(),
}));
vi.mock("@/app/student/practicals/actions", () => ({
  requestPracticalSupportAction: vi.fn(),
  requestTutorLabSupportAction: vi.fn(),
  submitPracticalLabWorkAction: vi.fn(),
}));

import AgentsPage from "@/app/admin/agents/page";
import { adminControlRoutesForRoles } from "@/components/staff-shell";
import { CourseAgentForm } from "@/components/course-engineering-forms";
import {
  STATUS_MESSAGE as PROFESSOR_STATUS,
  MEMORY_DEGRADED_MESSAGE,
  MEMORY_FULL_MESSAGE,
  ProfessorClassroomPanel,
} from "@/components/professor-classroom-panel";
import { STATUS_MESSAGE as SUPPORT_STATUS } from "@/components/practical-support";
import { AccessDenied } from "@/domain/policy";
import type { AgentConfigRecord } from "@/domain/academic-agent-config";

const OPERATOR = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Ada Academic",
  roles: ["ACADEMIC_ADMIN"],
};
const VERSION = "22222222-2222-4222-8222-222222222222";
const SECRET = "sk-proj-SENTINELuiKEY0123456789";

const bound = (role: string, over: Record<string, unknown> = {}) => ({
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
  ...over,
});
function scope(
  configs: Record<string, unknown>[],
  over = {},
  version: Record<string, unknown> = {},
) {
  return {
    versions: [
      {
        programmeVersionId: VERSION,
        programmeTitle: "Security+ demo programme",
        versionLabel: "v1",
        versionStatus: "PUBLISHED",
        isDemo: false,
        createdAt: "2026-10-01T10:00:00.123456+00:00",
        hasEnrolments: true,
        semanticConfigFrozen: true,
        behaviourFingerprint:
          "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        configs,
        behaviourConfigs: [
          {
            role: "TUTOR",
            responseDepth: "DETAILED",
            teachingApproach: "WORKED_EXAMPLE_FIRST",
            understandingCheckFrequency: "HIGH",
            challengeLevel: "FOUNDATION",
            hasCourseContextNotes: true,
          },
        ],
        behaviourEffective: [
          bound("PROFESSOR"),
          bound("TUTOR", {
            source: "EXPLICIT",
            configVersion: "AGENT_BEHAVIOUR_CONFIG_V1",
            responseDepth: "DETAILED",
            teachingApproach: "WORKED_EXAMPLE_FIRST",
            understandingCheckFrequency: "HIGH",
            challengeLevel: "FOUNDATION",
            hasCourseContextNotes: true,
          }),
          bound("LAB_INSTRUCTOR"),
        ],
        ...version,
      },
    ],
    pageSize: 50,
    hasMore: false,
    nextCursor: null,
    ...over,
  };
}
const configs = [
  {
    role: "PROFESSOR",
    enabled: true,
    modelProfileRef: "PROFESSOR_COMMERCIAL_V1",
    hasInstructionalNotes: true,
    capabilities: ["get_lesson_context"],
    escalationPolicy: "ACADEMIC_REVIEW",
    updatedAt: "2026-10-01T10:00:00+00:00",
  },
  {
    role: "COUNSELLOR",
    enabled: true,
    modelProfileRef: null,
    hasInstructionalNotes: false,
    capabilities: ["get_current_learner_context"],
    escalationPolicy: "NONE",
    updatedAt: "2026-10-01T10:00:00+00:00",
  },
];

async function render(params: Record<string, string> = {}) {
  return renderToStaticMarkup(
    await AgentsPage({ searchParams: Promise.resolve(params) }),
  );
}
function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAnyRole.mockResolvedValue(OPERATOR);
  mocks.actor.mockResolvedValue(OPERATOR);
  mocks.rpc.mockResolvedValue({ data: scope(configs), error: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/admin/agents", () => {
  it("is gated to ACADEMIC_ADMIN / PLATFORM_ADMIN before any read", async () => {
    mocks.requireAnyRole.mockRejectedValue(new AccessDenied());
    await expect(render()).rejects.toBeInstanceOf(AccessDenied);
    expect(mocks.requireAnyRole).toHaveBeenCalledWith([
      "ACADEMIC_ADMIN",
      "PLATFORM_ADMIN",
    ]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("is listed in admin navigation only for academic and platform admins", () => {
    for (const roles of [["ACADEMIC_ADMIN"], ["PLATFORM_ADMIN"]] as const)
      expect(
        adminControlRoutesForRoles([...roles]).map((r) => r.href),
      ).toContain("/admin/agents");
    for (const role of [
      "REGISTRAR",
      "INSTRUCTOR",
      "COUNSELLOR",
      "STUDENT",
    ] as const)
      expect(
        adminControlRoutesForRoles([role]).map((r) => r.href),
      ).not.toContain("/admin/agents");
  });

  it("is read-only: no form, button, input or Server Action", async () => {
    // The shared staff shell's own Sign out form sits in the header; the
    // page content after it must contain no control at all.
    const content = (await render()).split("</header>")[1];
    expect(content).toBeTruthy();
    expect(content).not.toMatch(/<form|<button|<input|<select|<textarea/);
    const source = readFileSync(
      resolve("src/app/admin/agents/page.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/use server|action=|setAgentConfig|rpc\(/);
  });

  it("keeps CONFIGURED, READY, TESTED and PRODUCTION-PROVEN separate and never shows a single health flag", async () => {
    const html = text(await render());
    for (const concept of [
      "CONFIGURED",
      "READY",
      "TESTED",
      "PRODUCTION-PROVEN",
    ])
      expect(html).toContain(concept);
    expect(html).not.toMatch(/\bhealthy\b|\bHEALTHY\b|all systems/i);
    expect(html).toContain("NOT PROVEN");
    expect(html).not.toMatch(/production-proven: yes|PROVEN ✓/i);
  });

  it("reports credentials as presence only, never material, and says presence is not validity", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("OPENAI_API_KEY", SECRET);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ACADEMIC_PROVIDER_API_KEY", SECRET);
    const html = await render();
    const plain = text(html);
    expect(plain).toContain("OPENAI_API_KEY PRESENT");
    expect(plain).toContain("ANTHROPIC_API_KEY ABSENT");
    expect(plain).toContain("legacy generic HTTP_JSON gateway) NOT_USED");
    expect(plain).toContain("Presence is not validity");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(SECRET.slice(0, 8));
    expect(html).not.toContain(SECRET.slice(-8));
    expect(html).not.toContain("SENTINEL");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows each reviewed profile's exact provider, model and evidence without inflating it", async () => {
    const html = await render();
    const plain = text(html);
    for (const fact of [
      "PROFESSOR_COMMERCIAL_V1",
      "gpt-5.6-terra",
      "TUTOR_COMMERCIAL_V1",
      "LAB_INSTRUCTOR_COMMERCIAL_V1",
      "claude-sonnet-5",
      "EXAMINER_COMMERCIAL_V1",
      "COUNSELLOR_PLATFORM_V1",
      "OPERATIONS_ENGINEER_PLATFORM_V1",
      "claude-opus-5-5",
      "OPENAI_RESPONSES",
      "ANTHROPIC_MESSAGES",
    ])
      expect(plain).toContain(fact);
    expect(plain).toContain(
      "No live-provider request has ever used this profile",
    );
    expect(plain).toContain("was not live-tested");
    // Every profile's evidence matches its current definition.
    expect(html).not.toContain(">NOT CURRENT<");
  });

  it("presents Sarah Mitchell as the executable platform COUNSELLOR and the academic COUNSELLOR as not executable", async () => {
    const plain = text(await render());
    expect(plain).toContain("Sarah Mitchell (learner-success AI) EXECUTABLE");
    expect(plain).toContain("Not the academic COUNSELLOR role");
    expect(plain).toContain("not a human counsellor account");
    expect(plain).toContain("Operations Engineer (internal) NOT EXECUTABLE");
    expect(plain).toContain(
      "Academic Counsellor role (historical vocabulary) ENABLED NOT EXECUTABLE",
    );
    expect(plain).toContain("does not launch Sarah");
  });

  it("states instructional notes are stored but unused, and shows escalation semantics truthfully", async () => {
    const plain = text(await render());
    expect(plain).toContain("Stored but not used by the current runtime");
    expect(plain).toContain(
      "ACADEMIC_REVIEW ACADEMIC_REVIEW makes every Professor request return as unavailable without a provider call. No academic-review case or queue is created.",
    );
    expect(plain).toContain("academic configuration fixed");
  });

  it("offers keyset navigation only when the database reports more versions", async () => {
    mocks.rpc.mockResolvedValue({
      data: scope(configs, {
        hasMore: true,
        nextCursor: {
          createdAt: "2026-10-01T10:00:00.123456+00:00",
          id: VERSION,
        },
      }),
      error: null,
    });
    const html = await render({
      after: "2026-10-02T10:00:00Z",
      afterId: VERSION,
    });
    expect(html).toContain(
      `href="/admin/agents?after=2026-10-01T10%3A00%3A00.123456%2B00%3A00&amp;afterId=${VERSION}"`,
    );
    expect(html).toContain('href="/admin/agents"');
    expect(mocks.rpc).toHaveBeenCalledWith(
      "admin_list_agent_configuration_scopes",
      { p_cursor_created_at: "2026-10-02T10:00:00Z", p_cursor_id: VERSION },
    );
  });
});

describe("Course Engineering agent form", () => {
  const record = (
    over: Partial<AgentConfigRecord> = {},
  ): AgentConfigRecord => ({
    id: VERSION,
    programmeVersionId: VERSION,
    role: "PROFESSOR",
    policyVersion: "ACADEMIC_AGENT_CONFIG_V1",
    enabled: true,
    modelProfileRef: "PROFESSOR_COMMERCIAL_V1",
    instructionalNotes: "Stored note",
    capabilities: ["get_lesson_context"],
    escalationPolicy: "NONE",
    updatedAt: "2026-10-01T10:00:00+00:00",
    ...over,
  });
  const form = (props: Parameters<typeof CourseAgentForm>[0]) =>
    renderToStaticMarkup(createElement(CourseAgentForm, props));

  it("never renders an editable model profile reference", () => {
    const html = form({ importId: VERSION, role: "TUTOR" });
    expect(html).not.toMatch(/name="modelProfileRef"/);
    expect(text(html)).toContain(
      "Runtime profile (read-only): TUTOR_COMMERCIAL_V1",
    );
    expect(text(html)).toContain("cannot be chosen here");
  });

  it("labels instructional notes as stored but not used, and read-only once published", () => {
    const draft = form({
      importId: VERSION,
      role: "PROFESSOR",
      config: record(),
    });
    expect(text(draft)).toContain(
      "Instructional notes — stored but not used by the current runtime",
    );
    expect(text(draft)).toContain("does not change agent behaviour");
    expect(draft).not.toMatch(/<textarea[^>]*readOnly|<textarea[^>]*readonly/);
    const published = form({
      importId: VERSION,
      role: "PROFESSOR",
      config: record(),
      frozen: true,
    });
    expect(published).toMatch(
      /<textarea[^>]*name="instructionalNotes"[^>]*readOnly=""|<textarea[^>]*readOnly=""[^>]*name="instructionalNotes"/,
    );
    expect(text(published)).toContain("This programme version is published");
  });

  it("shows the role's escalation semantics next to the policy", () => {
    expect(text(form({ importId: VERSION, role: "TUTOR" }))).toContain(
      "Not read by the current Tutor runtime",
    );
  });

  it("presents the academic COUNSELLOR as a non-executable proposal record, with no editable behaviour fields", () => {
    const html = form({ importId: VERSION, role: "COUNSELLOR" });
    expect(html).not.toMatch(
      /name="(enabled|capabilities|instructionalNotes|escalationPolicy|modelProfileRef)"/,
    );
    expect(text(html)).toContain("NOT EXECUTABLE");
    expect(text(html)).toContain("does not launch Sarah");
    expect(text(html)).toContain(
      "Record COUNSELLOR package proposal (not executable)",
    );
  });
});

describe("learner escalation copy", () => {
  it("never claims an academic review was opened for Professor or Tutor/Lab support", () => {
    for (const message of [
      PROFESSOR_STATUS.ESCALATED,
      SUPPORT_STATUS.ESCALATED,
    ]) {
      expect(message).toContain("No academic review has been opened");
      expect(message).not.toMatch(
        /(routed|passed|sent) (to|for) academic review/i,
      );
    }
  });
});

describe("/admin/agents behaviour (AC-2)", () => {
  it("shows each teaching role's frozen behaviour version and whether Level 3 is explicit or a versioned default", async () => {
    const plain = text(await render());
    expect(plain).toContain("PROFESSOR_BEHAVIOUR_V1");
    expect(plain).toContain("LAB_INSTRUCTOR_BEHAVIOUR_V1");
    expect(plain).toContain(
      "Versioned default (AGENT_BEHAVIOUR_DEFAULT_V1): no programme configuration recorded · frozen at publication",
    );
    expect(plain).toContain(
      "Programme configuration (AGENT_BEHAVIOUR_CONFIG_V1)",
    );
    expect(plain).toContain(
      "DETAILED depth, WORKED_EXAMPLE_FIRST, HIGH understanding checks, FOUNDATION challenge",
    );
    expect(plain).toContain("Course context notes stored (used as data)");
    expect(plain).not.toMatch(
      /academic handoffs, class notes and Sarah are implemented/,
    );
  });
});

describe("Professor classroom memory states (AC-2 correction)", () => {
  const classSessionId = "33333333-3333-4333-8333-333333333333";
  it("states degraded continuity truthfully and keeps the controls usable", () => {
    const html = renderToStaticMarkup(
      createElement(ProfessorClassroomPanel, {
        classSessionId,
        disabled: false,
        initialTurns: [{ learnerMessage: null, professorMessage: "Welcome." }],
        memoryDegraded: true,
      }),
    );
    expect(html).toContain(MEMORY_DEGRADED_MESSAGE.replace(/'/g, "&#x27;"));
    expect(html).toContain("Begin with Professor");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*type="submit">Begin/);
  });
  it("at capacity, explains the state and offers no enabled control that cannot act", () => {
    const html = renderToStaticMarkup(
      createElement(ProfessorClassroomPanel, {
        classSessionId,
        disabled: false,
        memoryFull: true,
      }),
    );
    expect(html).toContain(MEMORY_FULL_MESSAGE.replace(/'/g, "&#x27;"));
    expect(PROFESSOR_STATUS.MEMORY_FULL).toBe(MEMORY_FULL_MESSAGE);
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    for (const message of [MEMORY_FULL_MESSAGE, MEMORY_DEGRADED_MESSAGE])
      expect(message).not.toMatch(/mastery|grade|progress record/i);
  });
});

describe("/admin/agents behaviour fingerprint (AC-2 correction)", () => {
  it("shows each version's behaviour fingerprint and states the package fingerprint does not cover it", async () => {
    mocks.requireAnyRole.mockResolvedValue(OPERATOR);
    mocks.rpc.mockResolvedValue({ data: scope([]), error: null });
    const html = await render();
    expect(html).toContain("AGENT_BEHAVIOUR_FINGERPRINT_V1");
    expect(html).toContain("f".repeat(64));
    expect(html).toContain(
      "The course package publication fingerprint does not cover behaviour.",
    );
  });

  it("shows the database-pinned role version, not the current code version", async () => {
    mocks.requireAnyRole.mockResolvedValue(OPERATOR);
    mocks.rpc.mockResolvedValue({
      data: scope(
        [],
        {},
        {
          behaviourEffective: [
            bound("PROFESSOR", { behaviourVersion: "PROFESSOR_BEHAVIOUR_V0" }),
            bound("TUTOR"),
            bound("LAB_INSTRUCTOR"),
          ],
        },
      ),
      error: null,
    });
    expect(text(await render())).toContain("PROFESSOR_BEHAVIOUR_V0");
  });

  it("states a missing or invalid binding as refused execution, with no fingerprint", async () => {
    mocks.requireAnyRole.mockResolvedValue(OPERATOR);
    mocks.rpc.mockResolvedValue({
      data: scope(
        [],
        {},
        {
          behaviourFingerprint: null,
          behaviourEffective: [
            { role: "PROFESSOR", state: "BEHAVIOUR_BINDING_MISSING" },
            { role: "TUTOR", state: "BEHAVIOUR_BINDING_INVALID" },
            bound("LAB_INSTRUCTOR"),
          ],
        },
      ),
      error: null,
    });
    const plain = text(await render());
    expect(plain).toContain("Behaviour binding missing: execution refused");
    expect(plain).toContain("Behaviour binding invalid: execution refused");
    expect(plain).toMatch(/binding is missing or does not verify/);
    expect(plain).not.toContain("Behaviour fingerprint (");
  });
});
