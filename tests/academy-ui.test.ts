import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";
import { academyPackage } from "./academy-fixture";

// Rendering and action-boundary tests for the Academy (B2C) surfaces. The
// Supabase client is stubbed; the real server modules, schemas and actions
// run, so these prove what reaches the database and what is shown.
const m = vi.hoisted(() => ({
  roles: ["STUDENT"] as string[],
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
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
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: async () => ({
    id: "u1",
    displayName: "Lee",
    roles: m.roles,
  }),
  requireActor: async () => ({ id: "u1", displayName: "Lee", roles: m.roles }),
  requireStudentPrincipal: async () => ({
    id: "u1",
    displayName: "Lee",
    roles: m.roles,
  }),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: m.rpc }),
}));

import { SchedulePlanner } from "@/components/academy-schedule-planner";
import { AcademyOfferCard } from "@/components/academy-offer-card";
import {
  confirmScheduleAction,
  saveAcademyResponseAction,
  startAssessmentAction,
} from "@/app/student/academy/actions";
import {
  publishAction,
  uploadAndValidateAction,
} from "@/app/admin/academy-course-engineering/actions";

const enrolmentId = "5e0e1c4e-6b1a-4c55-9f3a-1f3b0c7d2a11";
const formats = [
  {
    formatId: "ACCELERATED_2W" as const,
    weeks: 2,
    sessionMinutes: 360,
    minStudyDays: 6,
    maxStudyDays: 7,
  },
  {
    formatId: "STANDARD_6W" as const,
    weeks: 6,
    sessionMinutes: 180,
    minStudyDays: 4,
    maxStudyDays: 6,
  },
];
const form = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

beforeEach(() => {
  m.rpc.mockReset();
  m.roles = ["STUDENT"];
});

describe("learner schedule planner", () => {
  it("offers the available formats and every learner choice, with no preselected confirmation", () => {
    const html = renderToStaticMarkup(
      createElement(SchedulePlanner, {
        enrolmentId,
        formats,
        fixedFormatId: null,
        today: "2026-11-02",
      }),
    );
    expect(html).toContain("Accelerated");
    expect(html).toContain("Standard");
    expect(html).toContain('type="date"');
    expect(html).toContain('type="time"');
    expect(html).toContain('name="timezone"');
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
      expect(html).toContain(day);
    // Confirmation is disabled until a feasible preview exists.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirm this timetable/);
  });

  it("shows only the purchased format when the terms fix it", () => {
    const html = renderToStaticMarkup(
      createElement(SchedulePlanner, {
        enrolmentId,
        formats,
        fixedFormatId: "STANDARD_6W",
        today: "2026-11-02",
      }),
    );
    expect(html).toContain("Standard");
    expect(html).not.toContain("Accelerated");
  });
});

describe("learner actions defer every decision to the database", () => {
  it("passes the learner's own choices and surfaces refusals verbatim", async () => {
    m.rpc.mockResolvedValue({
      data: {
        ok: false,
        code: "INSUFFICIENT_AVAILABILITY",
        message: "Your selected days give 6 class sessions.",
      },
      error: null,
    });
    const state = await confirmScheduleAction(
      {},
      form([
        ["enrolmentId", enrolmentId],
        ["formatId", "STANDARD_6W"],
        ["startOn", "2026-11-02"],
        ["studyDays", "1"],
        ["studyDays", "3"],
        ["localTime", "19:00"],
        ["timezone", "Europe/London"],
        ["requestKey", "0b3c3f8e-8f7a-4b8e-9c5d-2e1f0a9b8c7d"],
      ]),
    );
    expect(state.error).toBe("Your selected days give 6 class sessions.");
    expect(m.rpc).toHaveBeenCalledWith(
      "confirm_my_academy_schedule",
      expect.objectContaining({
        p_study_days: [1, 3],
        p_format_id: "STANDARD_6W",
      }),
    );
  });

  it("refuses non-learners before any database call", async () => {
    m.roles = ["INSTRUCTOR"];
    const state = await startAssessmentAction(
      {},
      form([
        ["enrolmentId", enrolmentId],
        ["assessmentRef", "quiz-1"],
      ]),
    );
    expect(state.error).toBeTruthy();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("reports an early sitting as not open and never redirects into it", async () => {
    m.rpc.mockResolvedValue({
      data: {
        ok: false,
        code: "SITTING_NOT_OPEN",
        opensAt: "2026-11-09T19:00:00Z",
      },
      error: null,
    });
    const state = await startAssessmentAction(
      {},
      form([
        ["enrolmentId", enrolmentId],
        ["assessmentRef", "quiz-1"],
      ]),
    );
    expect(state.error).toMatch(/not opened yet/);
    expect(m.redirect).not.toHaveBeenCalled();
  });

  it("derives a SHA-256 idempotency key per revision slot and body", async () => {
    m.rpc.mockResolvedValue({
      data: { ok: true, replayed: false },
      error: null,
    });
    const attemptId = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const save = (slot: string, body: string) =>
      saveAcademyResponseAction(
        {},
        form([
          ["attemptId", attemptId],
          ["questionId", "q-3"],
          ["revisionSlot", slot],
          ["body", body],
        ]),
      );
    await save("1", '{"optionId":"a"}');
    await save("1", '{"optionId":"a"}');
    await save("2", '{"optionId":"a"}');
    const keys = m.rpc.mock.calls.map((c) => c[1].p_idempotency_key as string);
    expect(keys[0]).toMatch(/^a[0-9a-f]{64}$/);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(m.rpc.mock.calls[0][1].p_question_position).toBe(3);
  });
});

describe("admin actions", () => {
  it("rejects a non-JSON upload before contacting the database", async () => {
    m.roles = ["ACADEMIC_ADMIN"];
    const f = form([["reason", "Upload test package"]]);
    f.append(
      "package",
      new File(["not json"], "course.json", { type: "application/json" }),
    );
    const state = await uploadAndValidateAction({}, f);
    expect(state.error).toMatch(/not valid UTF-8 JSON/);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("returns actionable validation issues for an invalid package", async () => {
    m.roles = ["ACADEMIC_ADMIN"];
    const pkg = academyPackage();
    pkg.grading.components[0].weightBp = 100;
    m.rpc.mockImplementation(async (name: string) =>
      name === "get_academy_course_package_content"
        ? { data: pkg, error: null }
        : { data: "6b2f9c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e", error: null },
    );
    const f = form([["reason", "Upload test package"]]);
    f.append(
      "package",
      new File([JSON.stringify(pkg)], "course.json", {
        type: "application/json",
      }),
    );
    const state = await uploadAndValidateAction({}, f);
    expect(state.issues!.join("\n")).toMatch(
      /grading\.components — Component weights total 96%/,
    );
    expect(m.rpc).toHaveBeenCalledWith(
      "reject_academy_course_package",
      expect.anything(),
    );
    expect(m.rpc).not.toHaveBeenCalledWith(
      "mark_academy_course_package_validated",
      expect.anything(),
    );
  });

  it("publishes only explicitly priced, confirmed formats", async () => {
    m.roles = ["ACADEMIC_ADMIN"];
    m.rpc.mockResolvedValue({
      data: "6b2f9c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e",
      error: null,
    });
    const base: [string, string][] = [
      ["packageId", "6b2f9c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e"],
      ["slug", "security-plus"],
      ["currency", "gbp"],
      ["reason", "Publish approved course"],
      ["offer_STANDARD_6W", "on"],
      ["price_STANDARD_6W", "499.00"],
    ];
    expect((await publishAction({}, form(base))).error).toMatch(
      /approved commercial terms/,
    );
    expect(m.rpc).not.toHaveBeenCalled();
    await publishAction({}, form([...base, ["confirm", "on"]]));
    expect(m.rpc).toHaveBeenCalledWith(
      "publish_academy_course",
      expect.objectContaining({
        p_currency: "GBP",
        p_prices: [{ formatId: "STANDARD_6W", amountMinor: 49900 }],
      }),
    );
  });
});

describe("catalogue card", () => {
  it("shows real formats and prices without any cohort date", () => {
    const html = renderToStaticMarkup(
      createElement(AcademyOfferCard, {
        offer: {
          offerId: "6b2f9c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e",
          slug: "security-plus",
          title: "CompTIA Security+ SY0-701 Preparation",
          summary: null,
          currency: "GBP",
          description: "Self-paced preparation.",
          qualificationPreparation: null,
          demoContent: false,
          lessons: 28,
          labs: 14,
          assessments: 6,
          formats: [
            {
              formatId: "ACCELERATED_2W",
              weeks: 2,
              sessionMinutes: 360,
              minStudyDays: 6,
              maxStudyDays: 7,
              amountMinor: 59900,
            },
            {
              formatId: "FLEXIBLE_12W",
              weeks: 12,
              sessionMinutes: 120,
              minStudyDays: 3,
              maxStudyDays: 5,
              amountMinor: 39900,
            },
          ],
        },
      }),
    );
    expect(html).toContain("£399.00");
    expect(html).not.toContain("From ");
    expect(html).toContain("2 wk · 12 wk");
    expect(html).not.toMatch(/cohort/i);
  });

  it("review summary for the Security+ package contains no protected content", () => {
    const r = validateAcademyCoursePackage(academyPackage());
    expect(r.valid && JSON.stringify(r.review)).not.toMatch(
      /correctOptionId|expectedAnswer|answerKey/,
    );
  });
});
