import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Rendering and action-boundary tests for the Academy AI Tutor and Lab
// Instructor surfaces (migration 063). The Supabase client is stubbed; the
// real server modules, schemas, pages and actions run, so these prove what
// is shown and what reaches the database.
const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error("REDIRECT:" + url);
  }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({
  redirect: m.redirect,
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  usePathname: () => "/student/academy",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const learner = { id: "u1", displayName: "Lee", roles: ["STUDENT"] };
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: async () => learner,
  requireActor: async () => learner,
  requireStudentPrincipal: async () => learner,
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: m.rpc }),
}));

import SupportPage from "@/app/student/academy/support/[requestId]/page";
import LessonPage from "@/app/student/academy/lesson/page";
import AcademyPage from "@/app/student/academy/page";
import {
  askAcademySupportAction,
  openLabSupportAction,
  openTutorSupportAction,
} from "@/app/student/academy/support/actions";

const enrolmentId = "5e0e1c4e-6b1a-4c55-9f3a-1f3b0c7d2a11";
const requestId = "6f1f2d5f-7c2b-4d66-8a4c-2a4c1d8e3b22";
const objectiveId = "7a2a3e6a-8d3c-4e77-9b5d-3b5d2e9f4c33";
const labItem = "8b3b4f7b-9e4d-4f88-8c6e-4c6e3f0a5d44";
const form = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};
const byName =
  (responses: Record<string, unknown>) =>
  async (name: string): Promise<{ data: unknown; error: null }> => ({
    data: responses[name] ?? null,
    error: null,
  });
const tutorRequest = {
  requestId,
  enrolmentId,
  role: "TUTOR",
  courseTitle: "Security+ (SY0-701)",
  lessonRef: "lesson-1-1",
  lessonTitle: "Security controls",
  objective: "Compare control categories <b>and types</b>",
  practical: null,
  graded: null,
};
const render = async (element: Promise<ReactNode>) =>
  renderToStaticMarkup(createElement("div", null, await element));

beforeEach(() => {
  m.rpc.mockReset();
  m.redirect.mockClear();
});

describe("Academy support page", () => {
  it("renders the Tutor objective and stored conversation as plain text", async () => {
    m.rpc.mockImplementation(
      byName({
        get_my_academy_support_request: { ok: true, request: tutorRequest },
        list_my_academy_support_turns: {
          ok: true,
          totalTurns: 1,
          unrecordedExchanges: 0,
          turns: [
            {
              turnNumber: 1,
              learnerMessage:
                "What is a <script>compensating</script> control?",
              agentMessage:
                "A compensating control replaces one you cannot use.",
              recordedAt: "2026-10-25T10:00:00+00:00",
            },
          ],
        },
      }),
    );
    const html = await render(
      SupportPage({ params: Promise.resolve({ requestId }) }),
    );
    expect(html).toContain("AI TUTOR");
    expect(html).toContain(
      "Compare control categories &lt;b&gt;and types&lt;/b&gt;",
    );
    expect(html).toContain("&lt;script&gt;compensating&lt;/script&gt;");
    expect(html).not.toContain("<script>compensating");
    expect(html).not.toContain("<b>and types");
    expect(html).toContain(
      "A compensating control replaces one you cannot use.",
    );
    expect(html).toContain(`name="requestId" value="${requestId}"`);
    expect(html).toContain("It is not a mark, attendance, evidence or mastery");
  });

  it("states truthfully that a graded practical is guided, not completed, and not marked", async () => {
    m.rpc.mockImplementation(
      byName({
        get_my_academy_support_request: {
          ok: true,
          request: {
            ...tutorRequest,
            role: "LAB_INSTRUCTOR",
            objective: null,
            practical: {
              kind: "PRACTICAL_LAB",
              title: "Firewall rule review",
              instructions: "Review the rule set and identify the gap.",
            },
            graded: true,
          },
        },
        list_my_academy_support_turns: {
          ok: true,
          totalTurns: 0,
          unrecordedExchanges: 1,
          turns: [],
        },
      }),
    );
    const html = await render(
      SupportPage({ params: Promise.resolve({ requestId }) }),
    );
    expect(html).toContain("AI LAB INSTRUCTOR");
    expect(html).toContain("Firewall rule review");
    expect(html).toContain("Review the rule set and identify the gap.");
    expect(html).toContain("will not complete the work for you");
    expect(html).toContain(
      "Lab marking is closed until approved rubrics exist",
    );
    expect(html).toContain("could not be saved");
  });

  it("explains a firewall refusal and hides another learner's request", async () => {
    m.rpc.mockImplementation(
      byName({
        get_my_academy_support_request: {
          ok: false,
          code: "ACTIVITY_BLOCKED",
        },
      }),
    );
    const html = await render(
      SupportPage({ params: Promise.resolve({ requestId }) }),
    );
    expect(html).toContain("closed while a controlled assessment is active");
    expect(html).not.toContain('name="message"');
    m.rpc.mockImplementation(
      byName({
        get_my_academy_support_request: {
          ok: false,
          code: "NOT_FOUND_OR_FORBIDDEN",
        },
      }),
    );
    await expect(
      render(SupportPage({ params: Promise.resolve({ requestId }) })),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      render(SupportPage({ params: Promise.resolve({ requestId: "x" }) })),
    ).rejects.toThrow("NOT_FOUND");
  });
});

describe("entry points", () => {
  it("offers the AI Tutor for each objective of a released lesson", async () => {
    m.rpc.mockImplementation(
      byName({
        get_my_academy_lesson: {
          lessonRef: "lesson-1-1",
          sequence: 1,
          title: "Security controls",
          studied: false,
          objectives: [{ id: objectiveId, description: "Compare categories" }],
          resources: [],
          practicalActivities: [],
        },
      }),
    );
    const html = await render(
      LessonPage({
        searchParams: Promise.resolve({ enrolmentId, lesson: "lesson-1-1" }),
      }),
    );
    expect(html).toContain("Ask the AI Tutor");
    expect(html).toContain(`name="objectiveId" value="${objectiveId}"`);
    expect(html).toContain('name="lessonRef" value="lesson-1-1"');
  });

  it("offers the AI Lab Instructor only on started practicals, and never during a sitting", async () => {
    const now = Date.now();
    const iso = (offsetMinutes: number) =>
      new Date(now + offsetMinutes * 60000).toISOString();
    const item = (id: string, startOffset: number) => ({
      id,
      sequence: 1,
      kind: "LAB",
      ref: "lab-1",
      part: 1,
      parts: 1,
      sessionIndex: 0,
      localDate: iso(startOffset).slice(0, 10),
      startsAt: iso(startOffset),
      endsAt: iso(startOffset + 60),
      minutes: 60,
      opensAt: null,
      closesAt: null,
      carried: false,
      title: "Firewall rule review",
      attempts: null,
      labSubmitted: false,
      labGraded: false,
      studied: null,
      classOpened: null,
      teachingTurns: null,
    });
    const timetable = (examActive: boolean) => ({
      enrolmentId,
      title: "Security+",
      status: "ACTIVE",
      serverTime: iso(0),
      accessRevoked: false,
      examActive,
      schedule: {
        revision: 1,
        formatId: "STANDARD_6W",
        startOn: iso(-1440).slice(0, 10),
        endOn: iso(40000).slice(0, 10),
        studyDays: [1, 3, 5, 6],
        localTime: "19:00",
        timezone: "Europe/London",
        sessionMinutes: 180,
      },
      items: [
        item(labItem, -30),
        { ...item(objectiveId, 600), sequence: 2 },
        // A started but assessed practical: no AI help is offered.
        { ...item(requestId, -20), sequence: 3, labGraded: true },
      ],
    });
    const enrolments = [
      {
        enrolmentId,
        courseId: requestId,
        title: "Security+",
        status: "ACTIVE",
        formatId: "STANDARD_6W",
        fixedFormatId: null,
        offerSlug: "security-plus",
        formats: [],
        schedule: {
          revision: 1,
          startOn: iso(-1440).slice(0, 10),
          endOn: iso(40000).slice(0, 10),
          studyDays: [1, 3, 5, 6],
          localTime: "19:00",
          timezone: "Europe/London",
        },
        completedAt: null,
      },
    ];
    m.rpc.mockImplementation(
      byName({
        list_my_academy_enrolments: enrolments,
        get_my_academy_timetable: timetable(false),
      }),
    );
    const html = await render(
      AcademyPage({ searchParams: Promise.resolve({ enrolmentId }) }),
    );
    expect(html.match(/Get help from the AI Lab Instructor/g)).toHaveLength(1);
    expect(html).toContain(
      "This practical is assessed, so AI Lab Instructor help is not available for it.",
    );
    expect(html).not.toContain(`name="scheduleItemId" value="${requestId}"`);
    expect(html).toContain(`name="scheduleItemId" value="${labItem}"`);
    m.rpc.mockImplementation(
      byName({
        list_my_academy_enrolments: enrolments,
        get_my_academy_timetable: timetable(true),
      }),
    );
    const blocked = await render(
      AcademyPage({ searchParams: Promise.resolve({ enrolmentId }) }),
    );
    expect(blocked).not.toContain("Get help from the AI Lab Instructor");
  });
});

describe("support actions defer every decision to the database", () => {
  it("opens a Tutor thread from identifiers only and reports refusals", async () => {
    m.rpc.mockResolvedValue({
      data: { ok: true, requestId, resumed: false },
      error: null,
    });
    await expect(
      openTutorSupportAction(
        form([
          ["enrolmentId", enrolmentId],
          ["lessonRef", "lesson-1-1"],
          ["objectiveId", objectiveId],
          ["role", "LAB_INSTRUCTOR"],
        ]),
      ),
    ).rejects.toThrow(`REDIRECT:/student/academy/support/${requestId}`);
    expect(m.rpc).toHaveBeenCalledWith("open_my_academy_tutor_support", {
      p_enrolment_id: enrolmentId,
      p_lesson_ref: "lesson-1-1",
      p_objective_id: objectiveId,
    });
    m.rpc.mockResolvedValue({
      data: { ok: false, code: "NOT_YET_STARTED" },
      error: null,
    });
    await expect(
      openLabSupportAction(
        form([
          ["enrolmentId", enrolmentId],
          ["scheduleItemId", labItem],
        ]),
      ),
    ).rejects.toThrow(
      `REDIRECT:/student/academy?enrolmentId=${enrolmentId}&supportNotice=NOT_YET_STARTED`,
    );
  });

  it("validates the question before any database call", async () => {
    expect(
      await askAcademySupportAction(
        {},
        form([
          ["requestId", requestId],
          ["idempotencyKey", objectiveId],
          ["message", "   "],
        ]),
      ),
    ).toEqual({ error: "Enter a question between 1 and 2,000 characters." });
    expect(
      await askAcademySupportAction(
        {},
        form([
          ["requestId", requestId],
          ["idempotencyKey", "not-a-uuid"],
          ["message", "Hello"],
        ]),
      ),
    ).toMatchObject({ error: expect.any(String) });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("maps a refused reservation to a safe status, with no provider work", async () => {
    m.rpc.mockImplementation(
      byName({
        reserve_my_academy_support_interaction: {
          ok: false,
          code: "ACTIVITY_BLOCKED",
        },
      }),
    );
    expect(
      await askAcademySupportAction(
        {},
        form([
          ["requestId", requestId],
          ["idempotencyKey", objectiveId],
          ["message", "How do I start?"],
        ]),
      ),
    ).toEqual({ status: "ACTIVITY_BLOCKED" });
    expect(m.rpc.mock.calls.map((c) => c[0])).toEqual([
      "reserve_my_academy_support_interaction",
    ]);
  });
});
