import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AC-3: the server boundary, Server Action and learner UI of the
// minimum-data Professor academic handoff. Only identity, Supabase, the
// classroom runtime and Next cache are stubbed; database authority is in
// professor-academic-handoff-db.test.ts.
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireStudentPrincipal: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireStudentPrincipal: mocks.requireStudentPrincipal,
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/professor-classroom", () => ({
  openProfessorClassroom: vi.fn(),
  recordProfessorClassroomInteraction: vi.fn(),
}));
vi.mock("@/server/academic-runtime", () => ({
  executeRoleCapability: vi.fn(),
}));
vi.mock("@/app/student/practicals/actions", () => ({
  requestTutorLabSupportAction: vi.fn(),
  requestPracticalSupportAction: vi.fn(),
  submitPracticalLabWorkAction: vi.fn(),
}));

import {
  ProfessorHandoffRefused,
  getProfessorTeachingRecordForRelease,
  listMyProfessorAcademicHandoffs,
  requestProfessorAcademicHandoff,
} from "@/server/professor-academic-handoff";
import { requestProfessorFollowUpAction } from "@/app/student/classroom/actions";
import {
  FOLLOW_UP_DISCLOSURE,
  ProfessorFollowUp,
} from "@/components/professor-follow-up";
import { PROFESSOR_HANDOFF_SUMMARY } from "@/domain/professor-academic-handoff";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OBJECTIVE = "22222222-2222-4222-8222-222222222222";
const PRACTICAL = "33333333-3333-4333-8333-333333333333";
const HANDOFF = "44444444-4444-4444-8444-444444444444";
const RELEASE = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireStudentPrincipal.mockResolvedValue({
    id: "student",
    roles: ["STUDENT"],
  });
});

describe("requestProfessorAcademicHandoff", () => {
  it("sends only the class session, reason and one scope; the database derives the rest", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, duplicate: false, handoffId: HANDOFF },
      error: null,
    });
    await expect(
      requestProfessorAcademicHandoff({
        classSessionId: SESSION,
        reasonCode: "OBJECTIVE_REINFORCEMENT",
        objectiveId: OBJECTIVE,
      }),
    ).resolves.toEqual({ handoffId: HANDOFF, duplicate: false });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "request_professor_academic_handoff",
      {
        p_class_session_id: SESSION,
        p_reason_code: "OBJECTIVE_REINFORCEMENT",
        p_objective_id: OBJECTIVE,
        p_practical_id: null,
      },
    );
  });

  it.each([
    [
      "a free-text summary",
      {
        reasonCode: "OBJECTIVE_REINFORCEMENT",
        objectiveId: OBJECTIVE,
        summary: "x",
      },
    ],
    [
      "a chosen destination",
      {
        reasonCode: "OBJECTIVE_REINFORCEMENT",
        objectiveId: OBJECTIVE,
        destinationRole: "LAB_INSTRUCTOR",
      },
    ],
    [
      "a source execution",
      {
        reasonCode: "OBJECTIVE_REINFORCEMENT",
        objectiveId: OBJECTIVE,
        sourceExecutionId: HANDOFF,
      },
    ],
    [
      "an unreviewed reason",
      { reasonCode: "FREE_TEXT", objectiveId: OBJECTIVE },
    ],
    [
      "both scopes",
      {
        reasonCode: "PRACTICAL_HELP",
        practicalId: PRACTICAL,
        objectiveId: OBJECTIVE,
      },
    ],
    ["a missing scope", { reasonCode: "PRACTICAL_HELP" }],
  ])("refuses %s before any database call", async (_label, extra) => {
    await expect(
      requestProfessorAcademicHandoff({ classSessionId: SESSION, ...extra }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps governed refusals and malformed results, failing closed", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, code: "NO_SOURCE_EXECUTION" },
      error: null,
    });
    await expect(
      requestProfessorAcademicHandoff({
        classSessionId: SESSION,
        reasonCode: "PRACTICAL_HELP",
        practicalId: PRACTICAL,
      }),
    ).rejects.toMatchObject({ code: "NO_SOURCE_EXECUTION" });
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, handoffId: HANDOFF, transcript: "x" },
      error: null,
    });
    await expect(
      requestProfessorAcademicHandoff({
        classSessionId: SESSION,
        reasonCode: "PRACTICAL_HELP",
        practicalId: PRACTICAL,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});

describe("getProfessorTeachingRecordForRelease", () => {
  const record = {
    policy: "PROFESSOR_ACADEMIC_HANDOFF_V1",
    sourceRole: "PROFESSOR",
    destinationRole: "TUTOR",
    reasonCode: "OBJECTIVE_REINFORCEMENT",
    scope: "OBJECTIVE",
    summary: PROFESSOR_HANDOFF_SUMMARY.OBJECTIVE_REINFORCEMENT,
    recordedAt: "2026-10-06T09:30:00+00:00",
  };
  it("returns the record, or null when the handoff is not from a Professor classroom", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, available: true, record },
      error: null,
    });
    await expect(
      getProfessorTeachingRecordForRelease(RELEASE),
    ).resolves.toEqual(record);
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, available: false },
      error: null,
    });
    await expect(
      getProfessorTeachingRecordForRelease(RELEASE),
    ).resolves.toBeNull();
  });

  it.each([
    ["a refusal", { ok: false, code: "ACTIVITY_BLOCKED" }],
    [
      "a non-fixed summary",
      {
        ok: true,
        available: true,
        record: { ...record, summary: "Learner was confused" },
      },
    ],
    [
      "an extra transcript field",
      { ok: true, available: true, record: { ...record, transcript: "x" } },
    ],
    [
      "a destination that does not match the reason",
      {
        ok: true,
        available: true,
        record: { ...record, destinationRole: "LAB_INSTRUCTOR" },
      },
    ],
  ])("throws on %s, so Tutor/Lab fails closed", async (_label, data) => {
    mocks.rpc.mockResolvedValueOnce({ data, error: null });
    await expect(
      getProfessorTeachingRecordForRelease(RELEASE),
    ).rejects.toThrow();
  });
});

describe("listMyProfessorAcademicHandoffs", () => {
  it("returns null on refusal or on any field outside the approved projection", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, code: "ACTIVITY_BLOCKED" },
      error: null,
    });
    await expect(listMyProfessorAcademicHandoffs(SESSION)).resolves.toBeNull();
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        handoffs: [
          {
            handoffId: HANDOFF,
            destinationRole: "TUTOR",
            reasonCode: "OBJECTIVE_REINFORCEMENT",
            lessonTitle: "Access control",
            objectiveDescription: "Explain MFA",
            practicalTitle: null,
            summary: PROFESSOR_HANDOFF_SUMMARY.OBJECTIVE_REINFORCEMENT,
            createdAt: "2026-10-06T09:30:00+00:00",
            sourceExecutionId: RELEASE,
          },
        ],
      },
      error: null,
    });
    await expect(listMyProfessorAcademicHandoffs(SESSION)).resolves.toBeNull();
  });
});

describe("requestProfessorFollowUpAction", () => {
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(entries)) data.set(k, v);
    return data;
  };
  it("forwards only the allowed fields, ignoring anything else in the form", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, duplicate: false, handoffId: HANDOFF },
      error: null,
    });
    await expect(
      requestProfessorFollowUpAction(
        {},
        form({
          classSessionId: SESSION,
          reasonCode: "OBJECTIVE_REINFORCEMENT",
          objectiveId: OBJECTIVE,
          summary: "Learner seems anxious",
          destinationRole: "LAB_INSTRUCTOR",
        }),
      ),
    ).resolves.toEqual({ status: "REQUESTED" });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "request_professor_academic_handoff",
      {
        p_class_session_id: SESSION,
        p_reason_code: "OBJECTIVE_REINFORCEMENT",
        p_objective_id: OBJECTIVE,
        p_practical_id: null,
      },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/student/classroom/${SESSION}`,
    );
  });

  it("reports duplicates and refusals in bounded learner copy", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, duplicate: true, handoffId: HANDOFF },
      error: null,
    });
    await expect(
      requestProfessorFollowUpAction(
        {},
        form({
          classSessionId: SESSION,
          reasonCode: "PRACTICAL_HELP",
          practicalId: PRACTICAL,
        }),
      ),
    ).resolves.toEqual({ status: "ALREADY_REQUESTED" });
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, code: "NO_SOURCE_EXECUTION" },
      error: null,
    });
    const refused = await requestProfessorFollowUpAction(
      {},
      form({
        classSessionId: SESSION,
        reasonCode: "PRACTICAL_HELP",
        practicalId: PRACTICAL,
      }),
    );
    expect(refused.error).toMatch(
      /Ask the Professor something in this class first/,
    );
    expect(refused.error).not.toMatch(/NO_SOURCE_EXECUTION/);
  });

  it("is a ProfessorHandoffRefused for unknown input", async () => {
    await expect(
      requestProfessorAcademicHandoff({ classSessionId: "nope" }),
    ).rejects.toBeInstanceOf(ProfessorHandoffRefused);
  });
});

describe("ProfessorFollowUp (learner UI)", () => {
  const render = (
    handoffs: Parameters<typeof ProfessorFollowUp>[0]["handoffs"],
  ) =>
    renderToStaticMarkup(
      createElement(ProfessorFollowUp, {
        classSessionId: SESSION,
        objectives: [{ id: OBJECTIVE, text: "Explain MFA" }],
        labPracticals: [{ id: PRACTICAL, text: "Configure MFA" }],
        handoffs,
        disabled: false,
      }),
    );

  it("states exactly what is shared and offers no free-form or role field", () => {
    const html = render([]);
    expect(html).toContain(FOLLOW_UP_DISCLOSURE);
    expect(FOLLOW_UP_DISCLOSURE).toMatch(
      /Your conversation with the Professor is not shared/,
    );
    const names = [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(
      new Set(["classSessionId", "reasonCode", "objectiveId", "practicalId"]),
    );
    expect(html).not.toMatch(/<textarea/);
    expect(html).toContain("You have not requested a follow-up yet.");
  });

  it("lists the learner's follow-ups with only the approved fields", () => {
    const html = render([
      {
        handoffId: HANDOFF,
        destinationRole: "TUTOR",
        reasonCode: "OBJECTIVE_REINFORCEMENT",
        lessonTitle: "Access control",
        objectiveDescription: "Explain MFA",
        practicalTitle: null,
        summary: PROFESSOR_HANDOFF_SUMMARY.OBJECTIVE_REINFORCEMENT,
        createdAt: "2026-10-06T09:30:00+00:00",
      },
    ]);
    const visible = html.replace(/<[^>]+>/g, " ");
    expect(visible).toContain("Tutor : Explain MFA".replace(" :", ":"));
    expect(visible).toContain(
      PROFESSOR_HANDOFF_SUMMARY.OBJECTIVE_REINFORCEMENT,
    );
    expect(visible).toContain("Lesson: Access control");
    // The handoff id is only a hidden form value for the Tutor panel.
    expect(visible).not.toContain(HANDOFF);
    // The disclosure itself says this is not a mark, progress or mastery
    // record; the listed follow-up makes no such claim.
    const listed = visible.slice(
      visible.indexOf("Your follow-ups from this class"),
    );
    expect(listed).not.toMatch(/mastery|grade|progress|complet/i);
  });

  it("says when follow-ups cannot be read", () => {
    expect(render(null)).toContain(
      "Your follow-ups are not available right now.",
    );
  });
});
