import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Page, Server Actions and server layer for human academic review run
// through the REAL src/server/commercial-v1-academic-review.ts; only the
// session identity and the Supabase transport are stubbed, so every
// assertion about which governed RPC is called with what is observed at the
// transport boundary.
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  requireAnyRole: vi.fn(),
  rpc: vi.fn(),
  refresh: vi.fn(),
  recoveryTargets: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: mocks.actor,
  requireActor: mocks.actor,
  requireAnyRole: mocks.requireAnyRole,
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/server/commercial-v1-examiner-recovery/operations", () => ({
  listRecoverableExaminerTargets: mocks.recoveryTargets,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.refresh }));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));

import ReviewPage from "@/app/admin/academic-review/results/page";
import RecoveryPage from "@/app/admin/activation/recovery/page";
import {
  submitAssessmentReviewAction,
  submitLabReviewAction,
} from "@/app/admin/academic-review/actions";
import { adminControlRoutesForRoles } from "@/components/staff-shell";
import {
  academicReviewAssessmentGradeInput,
  academicReviewCaseSchema,
  academicReviewRefusalMessages,
} from "@/domain/commercial-v1-academic-review";

const REVIEWER = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Ada Academic",
  roles: ["ACADEMIC_ADMIN"],
};
const CASE = "22222222-2222-4222-8222-222222222222";
const LAB_CASE = "33333333-3333-4333-8333-333333333333";
const Q1 = "44444444-4444-4444-8444-444444444444";
const Q2 = "55555555-5555-4555-8555-555555555555";
const RESULT = "66666666-6666-4666-8666-666666666666";
const DECISION = "77777777-7777-4777-8777-777777777777";

const summary = (over: Record<string, unknown> = {}) => ({
  caseId: CASE,
  caseKind: "INITIAL_ESCALATION",
  caseState: "ESCALATED",
  caseReasonCode: "HUMAN_REVIEW_REQUIRED",
  caseOpenedAt: "2026-10-02T09:00:00+00:00",
  targetKind: "ASSESSMENT_ATTEMPT",
  component: "QUIZ_1",
  targetTitle: "QUIZ_1 assessment",
  programmeTitle: "Security+",
  cohortTitle: "November cohort",
  learnerName: "Lee Learner",
  studentNumber: "DUC-0001",
  submittedAt: "2026-10-02T08:55:00+00:00",
  ...over,
});
const assessmentCase = {
  ...summary(),
  assessment: {
    title: "QUIZ_1 assessment",
    instructions: "Answer independently.",
    componentWeightBp: 1000,
    maxMarksTotal: 20,
    questions: [
      {
        questionId: Q1,
        position: 1,
        prompt: "Explain least privilege",
        maxMarks: 10,
        expectedAnswer: "Grant only what is needed",
        markingGuidance: "Award full marks for scope limitation",
        answered: true,
        responseBody: "Only the access a role needs",
      },
      {
        questionId: Q2,
        position: 2,
        prompt: "Explain MFA",
        maxMarks: 10,
        expectedAnswer: "Two factors",
        markingGuidance: null,
        answered: false,
        responseBody: null,
      },
    ],
  },
};
const labCase = (maxMarks: number | null) => ({
  ...summary({
    caseId: LAB_CASE,
    targetKind: "LAB_SUBMISSION",
    component: null,
    caseKind: "RECOVERY_EXHAUSTED",
    caseState: "TIMEOUT",
    caseReasonCode: "EXECUTION_TIMEOUT",
  }),
  lab: {
    title: "Hands-on lab",
    instructions: "Configure the control.",
    maxMarks,
    contributionBp: maxMarks === null ? null : 2000,
    gradingGuidance: "Award for a working control",
    submissionBody: "I configured the firewall",
    objectives: [{ description: "Apply authentication controls" }],
  },
});
function form(values: [string, string][]) {
  const data = new FormData();
  for (const [key, value] of values) data.append(key, value);
  return data;
}
const ok = (data: unknown) => ({ data, error: null });
const refusal = (message: string) => ({ data: null, error: { message } });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue(REVIEWER);
  mocks.requireAnyRole.mockResolvedValue(REVIEWER);
});

describe("academic review page", () => {
  it("lists cases with their kind and a review link, without protected content", async () => {
    mocks.rpc.mockResolvedValue(ok({ cases: [summary()] }));
    const html = renderToStaticMarkup(
      await ReviewPage({ searchParams: Promise.resolve({}) }),
    );
    expect(mocks.requireAnyRole).toHaveBeenCalledWith([
      "ACADEMIC_ADMIN",
      "PLATFORM_ADMIN",
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "list_commercial_v1_academic_review_cases",
      {},
    );
    expect(html).toContain("Initial grading escalated to human review");
    expect(html).toContain("Lee Learner");
    expect(html).toContain(`/admin/academic-review/results?case=${CASE}`);
    expect(html).not.toContain("Grant only what is needed");
  });

  it("renders the protected assessment context and only human-judgment inputs", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "get_commercial_v1_academic_review_case"
        ? ok(assessmentCase)
        : ok({ cases: [summary()] }),
    );
    const html = renderToStaticMarkup(
      await ReviewPage({ searchParams: Promise.resolve({ case: CASE }) }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "get_commercial_v1_academic_review_case",
      { p_case_id: CASE },
    );
    for (const text of [
      "Explain least privilege",
      "Only the access a role needs",
      "Grant only what is needed",
      "Award full marks for scope limitation",
      "Recorded as 0: no response was submitted.",
      "Record first grade",
    ])
      expect(html).toContain(text);
    expect(html).toContain(`name="mark:${Q1}"`);
    expect(html).toMatch(
      new RegExp(`type="hidden" name="mark:${Q2}" value="0"`),
    );
    expect(html).toContain('name="reason"');
    // The browser never submits authoritative values.
    expect(html).not.toMatch(
      /name="(maxMarks|component|weight|studentId|enrolmentId|revision|targetKind)"/,
    );
  });

  it("renders the lab context, and no form when the lab policy is missing", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "get_commercial_v1_academic_review_case"
        ? ok(labCase(10))
        : ok({ cases: [] }),
    );
    const html = renderToStaticMarkup(
      await ReviewPage({ searchParams: Promise.resolve({ case: LAB_CASE }) }),
    );
    expect(html).toContain("I configured the firewall");
    expect(html).toContain("Grade recovery used and still ungraded");
    expect(html).toContain('name="marksAwarded"');
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "get_commercial_v1_academic_review_case"
        ? ok(labCase(null))
        : ok({ cases: [] }),
    );
    const blocked = renderToStaticMarkup(
      await ReviewPage({ searchParams: Promise.resolve({ case: LAB_CASE }) }),
    );
    expect(blocked).toContain("no published lab policy");
    expect(blocked).not.toContain('name="marksAwarded"');
  });

  it("explains a case that is no longer open", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "get_commercial_v1_academic_review_case"
        ? refusal("CASE_NOT_OPEN")
        : ok({ cases: [] }),
    );
    const html = renderToStaticMarkup(
      await ReviewPage({ searchParams: Promise.resolve({ case: CASE }) }),
    );
    expect(html).toContain(
      academicReviewRefusalMessages.CASE_NOT_OPEN.slice(0, 40),
    );
  });
});

describe("academic review Server Actions", () => {
  it("submits only the case id, per-question marks and reason to the governed RPC", async () => {
    mocks.rpc.mockResolvedValue(
      ok({
        ok: true,
        code: "RESULT_CREATED",
        decisionId: DECISION,
        resultRevisionId: RESULT,
        revisionNumber: 1,
        earnedMarks: 7,
        maxMarks: 20,
      }),
    );
    const state = await submitAssessmentReviewAction(
      {},
      form([
        ["caseId", CASE],
        [`mark:${Q1}`, "7"],
        [`mark:${Q2}`, "0"],
        ["maxMarks", "100"],
        ["reason", "Escalated grade reviewed"],
      ]),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "submit_commercial_v1_academic_review_assessment_grade",
      {
        p_case_id: CASE,
        p_marks: [
          { questionId: Q1, marksAwarded: 7 },
          { questionId: Q2, marksAwarded: 0 },
        ],
        p_reason: "Escalated grade reviewed",
      },
    );
    expect(state.message).toContain("First grade recorded");
    expect(mocks.refresh).toHaveBeenCalledWith("/admin/academic-review/results");
    expect(mocks.refresh).toHaveBeenCalledWith("/admin/activation/recovery");
  });

  it("surfaces bounded database refusals and hides raw database text", async () => {
    mocks.rpc.mockResolvedValue(refusal("MARKS_EXCEED_MAX"));
    const exceeded = await submitAssessmentReviewAction(
      {},
      form([
        ["caseId", CASE],
        [`mark:${Q1}`, "10"],
        ["reason", "Reviewed answer"],
      ]),
    );
    expect(exceeded.error).toBe(academicReviewRefusalMessages.MARKS_EXCEED_MAX);
    mocks.rpc.mockResolvedValue(refusal("INVALID_COMPONENT_WEIGHT"));
    const guard = await submitAssessmentReviewAction(
      {},
      form([
        ["caseId", CASE],
        [`mark:${Q1}`, "1"],
        ["reason", "Reviewed answer"],
      ]),
    );
    expect(guard.error).toBe(
      academicReviewRefusalMessages.RESULT_INTEGRITY_FAILED,
    );
    mocks.rpc.mockResolvedValue(
      refusal('relation "secret_table" does not exist'),
    );
    const raw = await submitAssessmentReviewAction(
      {},
      form([
        ["caseId", CASE],
        [`mark:${Q1}`, "1"],
        ["reason", "Reviewed answer"],
      ]),
    );
    expect(raw.error).toBe(academicReviewRefusalMessages.SERVICE_UNAVAILABLE);
    expect(raw.error).not.toContain("secret_table");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("reports an already-resolved case without claiming a new grade", async () => {
    mocks.rpc.mockResolvedValue(
      ok({
        ok: true,
        code: "ALREADY_RESOLVED",
        decisionId: DECISION,
        resultRevisionId: RESULT,
        revisionNumber: 1,
      }),
    );
    const state = await submitLabReviewAction(
      {},
      form([
        ["caseId", LAB_CASE],
        ["marksAwarded", "6"],
        ["reason", "Reviewed lab"],
      ]),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "submit_commercial_v1_academic_review_lab_grade",
      {
        p_case_id: LAB_CASE,
        p_marks_awarded: 6,
        p_reason: "Reviewed lab",
      },
    );
    expect(state.message).toContain("already resolved");
  });

  it("rejects malformed marks and non-reviewers before reaching the database", async () => {
    for (const bad of ["-1", "2.5", "", "abc"]) {
      const state = await submitLabReviewAction(
        {},
        form([
          ["caseId", LAB_CASE],
          ["marksAwarded", bad],
          ["reason", "Reviewed lab"],
        ]),
      );
      expect(state.error).toBe(academicReviewRefusalMessages.INVALID_INPUT);
    }
    mocks.actor.mockResolvedValue({
      ...REVIEWER,
      roles: ["INSTRUCTOR", "REGISTRAR"],
    });
    const forbidden = await submitLabReviewAction(
      {},
      form([
        ["caseId", LAB_CASE],
        ["marksAwarded", "5"],
        ["reason", "Reviewed lab"],
      ]),
    );
    expect(forbidden.error).toBe(academicReviewRefusalMessages.FORBIDDEN);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("no artificial question/objective ceilings (101 items)", () => {
  const uuidN = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const questions = Array.from({ length: 101 }, (_, i) => ({
    questionId: uuidN(i + 1),
    position: i + 1,
    prompt: `Question ${i + 1}`,
    maxMarks: 10,
    expectedAnswer: "Answer",
    markingGuidance: null,
    answered: i < 2,
    responseBody: i < 2 ? "Learner response" : null,
  }));
  const largeCase = {
    ...summary(),
    assessment: {
      title: "Large assessment",
      instructions: null,
      componentWeightBp: 1000,
      maxMarksTotal: 1010,
      questions,
    },
  };
  const allMarks = questions.map((q, i) => ({
    questionId: q.questionId,
    marksAwarded: i === 0 ? 7 : 0,
  }));

  it("the domain contracts accept 101 questions, 101 marks and 101 lab objectives", () => {
    expect(academicReviewCaseSchema.safeParse(largeCase).success).toBe(true);
    expect(
      academicReviewAssessmentGradeInput.safeParse({
        caseId: CASE,
        marks: allMarks,
        reason: "Large assessment reviewed",
      }).success,
    ).toBe(true);
    const lab = labCase(10);
    lab.lab.objectives = Array.from({ length: 101 }, (_, i) => ({
      description: `Objective ${i + 1}`,
    }));
    expect(academicReviewCaseSchema.safeParse(lab).success).toBe(true);
  });

  it("the real server path parses and renders a 101-question case", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "get_commercial_v1_academic_review_case"
        ? ok(largeCase)
        : ok({ cases: [summary()] }),
    );
    const html = renderToStaticMarkup(
      await ReviewPage({ searchParams: Promise.resolve({ case: CASE }) }),
    );
    expect(html).not.toContain(
      academicReviewRefusalMessages.SERVICE_UNAVAILABLE,
    );
    expect(html.match(/name="mark:/g)).toHaveLength(101);
    expect(html).toContain("Question 101");
  });

  it("the Server Action forwards the complete 101-mark set to the database writer", async () => {
    mocks.rpc.mockResolvedValue(
      ok({
        ok: true,
        code: "RESULT_CREATED",
        decisionId: DECISION,
        resultRevisionId: RESULT,
        revisionNumber: 1,
        earnedMarks: 7,
        maxMarks: 1010,
      }),
    );
    const state = await submitAssessmentReviewAction(
      {},
      form([
        ["caseId", CASE],
        ...allMarks.map(
          (m) =>
            [`mark:${m.questionId}`, String(m.marksAwarded)] as [
              string,
              string,
            ],
        ),
        ["reason", "Large assessment reviewed"],
      ]),
    );
    expect(state.message).toContain("First grade recorded");
    const sent = mocks.rpc.mock.calls[0][1] as { p_marks: unknown[] };
    expect(sent.p_marks).toEqual(allMarks);
  });
});

describe("navigation and recovery status truth", () => {
  it("exposes Academic review as a real control-plane route to reviewers only", () => {
    const route = adminControlRoutesForRoles(["ACADEMIC_ADMIN"]).find(
      (r) => r.label === "Academic review",
    );
    expect(route?.href).toBe("/admin/academic-review");
    expect(existsSync(resolve("src/app/admin/academic-review/page.tsx"))).toBe(
      true,
    );
    expect(
      adminControlRoutesForRoles(["REGISTRAR"]).map((r) => r.label),
    ).not.toContain("Academic review");
    expect(adminControlRoutesForRoles(["INSTRUCTOR"])).toEqual([]);
  });

  it("the recovery page shows resolved targets truthfully and links stranded ones to review", async () => {
    const base = {
      targetKind: "ASSESSMENT_ATTEMPT",
      capability: "grade_controlled_assessment",
      studentId: REVIEWER.id,
      enrolmentId: REVIEWER.id,
      activationId: REVIEWER.id,
      component: "QUIZ_2",
      practicalId: null,
      originalState: "FAILED",
      originalReasonCode: "PROVIDER_UNAVAILABLE",
      terminalAt: "2026-10-02T09:00:00+00:00",
      recoveryState: "ESCALATED",
    };
    mocks.recoveryTargets.mockResolvedValue([
      {
        ...base,
        sourceExecutionId: CASE,
        recoveryExecutionId: LAB_CASE,
        recoveryStatus: "RESOLVED_BY_ACADEMIC_REVIEW",
      },
      {
        ...base,
        sourceExecutionId: Q1,
        recoveryExecutionId: Q2,
        recoveryStatus: "RECOVERY_ESCALATED",
      },
    ]);
    const html = renderToStaticMarkup(await RecoveryPage());
    expect(html).toContain("Resolved by academic review");
    expect(html).toContain(`/admin/academic-review/results?case=${Q2}`);
    expect(html).not.toContain(`/admin/academic-review/results?case=${LAB_CASE}`);
  });
});
