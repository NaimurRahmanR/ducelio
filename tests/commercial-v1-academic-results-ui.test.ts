import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Page, Server Actions and server layer for academic results operations run
// through the REAL src/server/commercial-v1-academic-results.ts and the REAL
// progress/completion wrappers; only the session identity, the Supabase
// transport and the provider-backed regrade orchestration are stubbed, so
// every governed RPC call is observed at the transport boundary and every
// regrade request at the existing regrade authority's entry point.
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  requireAnyRole: vi.fn(),
  rpc: vi.fn(),
  refresh: vi.fn(),
  regradeAssessment: vi.fn(),
  regradeLab: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: mocks.actor,
  requireAnyRole: mocks.requireAnyRole,
  requireActor: async () => mocks.actor(),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/server/commercial-v1-examiner-regrade", () => ({
  regradeControlledAssessment: mocks.regradeAssessment,
  regradePracticalLab: mocks.regradeLab,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.refresh }));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));

import ResultsPage from "@/app/admin/academic-results/page";
import {
  completeAcademicEnrolmentAction,
  regradeAcademicResultAction,
} from "@/app/admin/academic-results/actions";
import { adminControlRoutesForRoles } from "@/components/staff-shell";
import {
  academicResultsRefusalMessages,
  completionOutcomeMessages,
  regradeOutcomeMessages,
} from "@/domain/commercial-v1-academic-results";

const OPERATOR = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Ada Academic",
  roles: ["ACADEMIC_ADMIN"],
};
const REV1 = "22222222-2222-4222-8222-222222222222";
const REV2 = "33333333-3333-4333-8333-333333333333";
const LAB = "44444444-4444-4444-8444-444444444444";
const ENROLMENT = "55555555-5555-4555-8555-555555555555";
const ACTIVATION = "66666666-6666-4666-8666-666666666666";
const EXECUTION = "77777777-7777-4777-8777-777777777777";
const QUESTION = "88888888-8888-4888-8888-888888888888";
const OBJECTIVE = "99999999-9999-4999-8999-999999999999";
const PRACTICAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ATTEMPT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSESSMENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COHORT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RECEIPT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const summary = (over: Record<string, unknown> = {}) => ({
  resultId: REV2,
  kind: "ASSESSMENT",
  revisionNumber: 2,
  isCurrent: true,
  isValid: true,
  origin: "EXAMINER_REGRADE",
  earnedMarks: 7,
  maxMarks: 10,
  scoreBp: 7000,
  weightBp: 1000,
  weightedContributionBp: 700,
  finalizedAt: "2026-10-02T10:00:00+00:00",
  component: "QUIZ_1",
  practicalId: null,
  targetTitle: "Quiz one",
  enrolmentId: ENROLMENT,
  enrolmentStatus: "ACTIVE",
  completed: false,
  learnerName: "Lee Learner",
  studentNumber: "DUC-0001",
  cohortTitle: "November cohort",
  programmeTitle: "Security+",
  versionLabel: "v1",
  ...over,
});
const history = [
  {
    resultId: REV1,
    revisionNumber: 1,
    isCurrent: false,
    isValid: true,
    origin: "EXAMINER_INITIAL",
    earnedMarks: 4,
    maxMarks: 10,
    scoreBp: 4000,
    weightedContributionBp: 400,
    finalizedAt: "2026-10-01T10:00:00+00:00",
  },
  {
    resultId: REV2,
    revisionNumber: 2,
    isCurrent: true,
    isValid: true,
    origin: "EXAMINER_REGRADE",
    earnedMarks: 7,
    maxMarks: 10,
    scoreBp: 7000,
    weightedContributionBp: 700,
    finalizedAt: "2026-10-02T10:00:00+00:00",
  },
];
const detail = (over: Record<string, unknown> = {}) => ({
  ...summary(),
  activationId: ACTIVATION,
  assessmentId: ASSESSMENT,
  attemptId: ATTEMPT,
  attemptSubmittedAt: "2026-10-01T09:00:00+00:00",
  provenance: {
    origin: "EXAMINER_REGRADE",
    executionId: EXECUTION,
    sourceResultRevisionId: REV1,
    sourceRevisionNumber: 1,
    actorName: "Ada Academic",
    reason: "Learner query upheld",
    decidedAt: "2026-10-02T10:00:00+00:00",
  },
  history,
  historyHasMore: false,
  historyLimit: 100,
  regradeClaim: null,
  questionMarks: [
    { questionId: QUESTION, position: 1, marksAwarded: 7, maxMarks: 10 },
  ],
  objectiveOutcomes: [
    {
      objectiveId: OBJECTIVE,
      description: "Apply least privilege",
      earnedMarks: 7,
      maxMarks: 10,
      outcome: "PARTIAL",
      remediationOpen: true,
    },
  ],
  ...over,
});
const labDetail = {
  ...summary({
    resultId: LAB,
    kind: "LAB",
    revisionNumber: 1,
    origin: "HUMAN_ACADEMIC_REVIEW",
    scoreBp: null,
    weightBp: 2000,
    weightedContributionBp: 1000,
    earnedMarks: 5,
    component: null,
    practicalId: PRACTICAL,
    targetTitle: "Firewall lab",
  }),
  activationId: ACTIVATION,
  submissionId: QUESTION,
  submissionSubmittedAt: null,
  provenance: {
    origin: "HUMAN_ACADEMIC_REVIEW",
    decisionId: EXECUTION,
    caseKind: "INITIAL_ESCALATION",
    actorName: "Ada Academic",
    reason: "Escalated lab graded",
    decidedAt: "2026-10-02T10:00:00+00:00",
  },
  history: [
    {
      ...history[0],
      resultId: LAB,
      isCurrent: true,
      origin: "HUMAN_ACADEMIC_REVIEW",
    },
  ],
  historyHasMore: false,
  historyLimit: 100,
  regradeClaim: null,
  objectiveOutcomes: [],
};
const record = (over: Record<string, unknown> = {}) => ({
  enrolmentId: ENROLMENT,
  enrolmentStatus: "ACTIVE",
  learnerName: "Lee Learner",
  studentNumber: "DUC-0001",
  cohortTitle: "November cohort",
  programmeTitle: "Security+",
  versionLabel: "v1",
  receipt: null,
  ...over,
});
const progress = (over: Record<string, unknown> = {}) => ({
  ok: true,
  activationId: ACTIVATION,
  gradingPolicyPublished: true,
  resultPolicyPublished: true,
  passMarkBp: 6000,
  requireRemediationClearForCompletion: false,
  components: {
    QUIZ_1: { status: "FINALIZED", scoreBp: 7000, weightedContributionBp: 700 },
    QUIZ_2: { status: "PENDING" },
  },
  labs: { [PRACTICAL]: { status: "PENDING" } },
  courseScoreBp: null,
  pending: [{ kind: "ASSESSMENT", component: "QUIZ_2" }],
  openRemediationCount: 1,
  enrolmentStatus: "ACTIVE",
  completed: false,
  ...over,
});

type Responses = Record<string, unknown>;
function serve(responses: Responses) {
  mocks.rpc.mockImplementation(async (name: string) => {
    const value = responses[name];
    if (value instanceof Error)
      return { data: null, error: { message: value.message } };
    if (value === undefined)
      return { data: null, error: { message: "unexpected" } };
    return { data: value, error: null };
  });
}
const base = {
  list_commercial_v1_academic_results: {
    results: [summary()],
    hasMore: true,
    offset: 0,
  },
  get_commercial_v1_academic_results_filters: {
    cohorts: [{ id: COHORT, title: "November cohort" }],
    programmeVersions: [{ id: ACTIVATION, title: "Security+", label: "v1" }],
    practicals: [{ id: PRACTICAL, title: "Firewall lab" }],
  },
};
async function render(params: Record<string, string> = {}) {
  return renderToStaticMarkup(
    await ResultsPage({ searchParams: Promise.resolve(params) }),
  );
}
function form(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}
const callsTo = (name: string) =>
  mocks.rpc.mock.calls.filter(([n]) => n === name).map(([, args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue(OPERATOR);
  mocks.requireAnyRole.mockResolvedValue(OPERATOR);
});

describe("navigation", () => {
  it("adds Academic results for ACADEMIC_ADMIN and PLATFORM_ADMIN only", () => {
    for (const role of ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"] as const)
      expect(adminControlRoutesForRoles([role]).map((r) => r.href)).toContain(
        "/admin/academic-results",
      );
    for (const role of [
      "INSTRUCTOR",
      "COUNSELLOR",
      "REGISTRAR",
      "STUDENT",
    ] as const)
      expect(
        adminControlRoutesForRoles([role]).map((r) => r.href),
      ).not.toContain("/admin/academic-results");
  });
});

describe("page", () => {
  it("is refused without an operator role before any database read", async () => {
    mocks.requireAnyRole.mockRejectedValue(new Error("Access denied"));
    await expect(render()).rejects.toThrow("Access denied");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes only parsed, bounded filters to the database and pages server-side", async () => {
    serve(base);
    const html = await render({
      q: "  DUC-0001 ",
      kind: "BOGUS",
      component: "QUIZ_1",
      cohort: "not-a-uuid",
      history: "1",
      completion: "NOT_COMPLETED",
      offset: "50",
    });
    expect(callsTo("list_commercial_v1_academic_results")).toEqual([
      {
        p_query: "DUC-0001",
        p_kind: null,
        p_cohort_id: null,
        p_programme_version_id: null,
        p_component: "QUIZ_1",
        p_practical_id: null,
        p_current_only: false,
        p_completion: "NOT_COMPLETED",
        p_offset: 50,
      },
    ]);
    expect(html).toContain("Lee Learner");
    expect(html).toContain("Institutional regrade");
    expect(html).toContain("Previous 50");
    expect(html).toContain("Next 50");
    expect(html).not.toContain("Request institutional regrade");
  });

  it("renders a current revision with provenance, history, marks and the regrade control", async () => {
    serve({
      ...base,
      get_commercial_v1_academic_result: detail(),
      get_commercial_v1_academic_enrolment_record: record(),
      get_commercial_v1_course_progress: progress(),
    });
    const html = await render({ result: REV2 });
    expect(callsTo("get_commercial_v1_academic_result")).toEqual([
      { p_result_id: REV2 },
    ]);
    expect(callsTo("get_commercial_v1_course_progress")).toEqual([
      { p_enrolment_id: ENROLMENT },
    ]);
    for (const text of [
      "Learner query upheld",
      "Revision 1",
      "HISTORICAL",
      "CURRENT",
      "Question 1",
      "Apply least privilege",
      "remediation open",
      "70.00%",
      "Request institutional regrade",
      `name="resultId" value="${REV2}"`,
      "Attempt course completion",
      "Not yet available (1 pending)",
      "60.00%",
      "Firewall lab",
    ])
      expect(html).toContain(text);
    // The regrade form posts only an id and a reason: no kind, revision,
    // learner, enrolment or policy value.
    const regradeForm = html
      .split("<form")
      .find((part) => part.includes('name="resultId"'))!
      .split("</form>")[0];
    expect(
      [...regradeForm.matchAll(/name="([^"]+)"/g)].map((m) => m[1]).sort(),
    ).toEqual(["reason", "resultId"]);
    // Viewing never completes or regrades.
    expect(callsTo("attempt_commercial_v1_course_completion")).toEqual([]);
    expect(mocks.regradeAssessment).not.toHaveBeenCalled();
  });

  it("a historical revision links to the current one and offers no regrade", async () => {
    serve({
      ...base,
      get_commercial_v1_academic_result: detail({
        resultId: REV1,
        revisionNumber: 1,
        isCurrent: false,
        origin: "EXAMINER_INITIAL",
        provenance: {
          origin: "EXAMINER_INITIAL",
          executionId: EXECUTION,
          decidedAt: null,
        },
      }),
      get_commercial_v1_academic_enrolment_record: record(),
      get_commercial_v1_course_progress: progress(),
    });
    const html = await render({ result: REV1 });
    expect(html).toContain("This is a historical revision.");
    expect(html).toContain("Open the current revision 2");
    expect(html).not.toContain("Request institutional regrade");
  });

  it("an invalid current revision is shown truthfully without a regrade control", async () => {
    serve({
      ...base,
      get_commercial_v1_academic_result: detail({
        isValid: false,
        questionMarks: [],
      }),
      get_commercial_v1_academic_enrolment_record: record(),
      get_commercial_v1_course_progress: progress(),
    });
    const html = await render({ result: REV2 });
    expect(html).toContain("FAILS INTEGRITY CHECK");
    expect(html).toContain("never falls back to an earlier revision");
    expect(html).not.toContain("Request institutional regrade");
  });

  it("a PAUSED enrolment is shown truthfully with no regrade or completion control", async () => {
    serve({
      ...base,
      get_commercial_v1_academic_result: detail({ enrolmentStatus: "PAUSED" }),
      get_commercial_v1_academic_enrolment_record: record({
        enrolmentStatus: "PAUSED",
      }),
      get_commercial_v1_course_progress: progress({
        enrolmentStatus: "PAUSED",
      }),
    });
    const html = await render({ result: REV2 });
    expect(html).toContain("ENROLMENT PAUSED");
    expect(html).toContain("This enrolment is PAUSED");
    expect(html).toContain("Completion requires an ACTIVE enrolment");
    expect(html).not.toContain("Request institutional regrade");
    expect(html).not.toContain("Attempt course completion");
  });

  it("shows the completion receipt and no completion control once completed", async () => {
    serve({
      ...base,
      get_commercial_v1_academic_result: labDetail,
      get_commercial_v1_academic_enrolment_record: record({
        enrolmentStatus: "COMPLETED",
        receipt: {
          receiptId: RECEIPT,
          finalCourseScoreBp: 7250,
          passMarkBp: 6000,
          completedAt: "2026-10-02T11:00:00+00:00",
          completedByName: "Ada Academic",
        },
      }),
      get_commercial_v1_course_progress: progress({
        enrolmentStatus: "COMPLETED",
        completed: true,
      }),
    });
    const html = await render({ result: LAB });
    for (const text of [
      "72.50%",
      RECEIPT,
      "Human academic review",
      "Escalated lab graded",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Attempt course completion");
  });

  it("refuses a learner-admin's own record and rejects any payload carrying protected fields", async () => {
    serve({
      ...base,
      get_commercial_v1_academic_result: new Error("SELF_RECORD_FORBIDDEN"),
    });
    expect(await render({ result: REV2 })).toContain(
      academicResultsRefusalMessages.SELF_RECORD_FORBIDDEN,
    );
    expect(callsTo("get_commercial_v1_course_progress")).toEqual([]);
    for (const leak of [
      { prompt: "Explain least privilege" },
      { expectedAnswer: "Grant only what is needed" },
      { gradeDigest: "a".repeat(64) },
    ]) {
      mocks.rpc.mockReset();
      serve({ ...base, get_commercial_v1_academic_result: detail(leak) });
      const html = await render({ result: REV2 });
      expect(html).toContain(
        academicResultsRefusalMessages.SERVICE_UNAVAILABLE,
      );
      expect(html).not.toContain(Object.values(leak)[0]);
    }
  });
});

describe("regrade action", () => {
  it("delegates a current valid assessment revision with only the id and reason", async () => {
    serve({ get_commercial_v1_academic_result: detail() });
    mocks.regradeAssessment.mockResolvedValue({
      status: "REGRADED",
      executionId: EXECUTION,
      resultRevisionId: REV1,
    });
    const state = await regradeAcademicResultAction(
      {},
      form({
        resultId: REV2,
        reason: "Learner query upheld",
        kind: "LAB",
        revisionNumber: "9",
        studentId: OPERATOR.id,
        maxMarks: "999",
      }),
    );
    expect(mocks.regradeAssessment).toHaveBeenCalledWith({
      resultRevisionId: REV2,
      reason: "Learner query upheld",
    });
    expect(mocks.regradeLab).not.toHaveBeenCalled();
    expect(state).toEqual({
      message: regradeOutcomeMessages.REGRADED,
      resultRevisionId: REV1,
    });
    expect(mocks.refresh).toHaveBeenCalledWith("/admin/academic-results");
  });

  it("routes a lab revision to the existing lab regrade authority", async () => {
    serve({ get_commercial_v1_academic_result: labDetail });
    mocks.regradeLab.mockResolvedValue({ status: "ESCALATED" });
    expect(
      await regradeAcademicResultAction(
        {},
        form({ resultId: LAB, reason: "Lab regrade requested" }),
      ),
    ).toEqual({ error: regradeOutcomeMessages.ESCALATED });
    expect(mocks.regradeLab).toHaveBeenCalledWith({
      resultRevisionId: LAB,
      reason: "Lab regrade requested",
    });
    expect(mocks.regradeAssessment).not.toHaveBeenCalled();
  });

  it("never regrades a historical or invalid revision", async () => {
    serve({ get_commercial_v1_academic_result: detail({ isCurrent: false }) });
    expect(
      await regradeAcademicResultAction(
        {},
        form({ resultId: REV2, reason: "Regrade old one" }),
      ),
    ).toEqual({ error: regradeOutcomeMessages.NOT_CURRENT_RESULT });
    serve({ get_commercial_v1_academic_result: detail({ isValid: false }) });
    expect(
      await regradeAcademicResultAction(
        {},
        form({ resultId: REV2, reason: "Regrade invalid" }),
      ),
    ).toEqual({ error: regradeOutcomeMessages.CURRENT_RESULT_INVALID });
    expect(mocks.regradeAssessment).not.toHaveBeenCalled();
  });

  it("refuses non-operators, malformed input and the operator's own record", async () => {
    mocks.actor.mockResolvedValue({
      ...OPERATOR,
      roles: ["INSTRUCTOR", "REGISTRAR"],
    });
    expect(
      await regradeAcademicResultAction(
        {},
        form({ resultId: REV2, reason: "Not my role" }),
      ),
    ).toEqual({ error: academicResultsRefusalMessages.FORBIDDEN });
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.actor.mockResolvedValue(OPERATOR);
    for (const bad of [
      { resultId: "not-a-uuid", reason: "Valid reason" },
      { resultId: REV2, reason: "no" },
      { resultId: REV2, reason: "x".repeat(301) },
    ])
      expect(await regradeAcademicResultAction({}, form(bad))).toEqual({
        error: academicResultsRefusalMessages.INVALID_INPUT,
      });
    serve({
      get_commercial_v1_academic_result: new Error("SELF_RECORD_FORBIDDEN"),
    });
    expect(
      await regradeAcademicResultAction(
        {},
        form({ resultId: REV2, reason: "Regrade my own" }),
      ),
    ).toEqual({ error: academicResultsRefusalMessages.SELF_RECORD_FORBIDDEN });
    expect(mocks.regradeAssessment).not.toHaveBeenCalled();
    expect(mocks.regradeLab).not.toHaveBeenCalled();
  });
});

describe("completion action", () => {
  it("uses the existing completion authority and reports its refusal reason", async () => {
    serve({
      get_commercial_v1_academic_enrolment_record: record(),
      attempt_commercial_v1_course_completion: {
        ok: false,
        code: "COMPONENTS_INCOMPLETE",
        pending: [{ kind: "ASSESSMENT", component: "QUIZ_2" }],
      },
    });
    expect(
      await completeAcademicEnrolmentAction(
        {},
        form({
          enrolmentId: ENROLMENT,
          reason: "Completion check",
          studentId: OPERATOR.id,
        }),
      ),
    ).toEqual({ error: completionOutcomeMessages.COMPONENTS_INCOMPLETE });
    expect(callsTo("attempt_commercial_v1_course_completion")).toEqual([
      { p_enrolment_id: ENROLMENT, p_reason: "Completion check" },
    ]);
  });

  it("reports success and refuses a non-operator before any call", async () => {
    serve({
      get_commercial_v1_academic_enrolment_record: record(),
      attempt_commercial_v1_course_completion: {
        ok: true,
        code: "COMPLETED",
        receiptId: RECEIPT,
        courseScoreBp: 7250,
      },
    });
    expect(
      await completeAcademicEnrolmentAction(
        {},
        form({ enrolmentId: ENROLMENT, reason: "All graded" }),
      ),
    ).toEqual({ message: completionOutcomeMessages.COMPLETED });
    mocks.rpc.mockClear();
    mocks.actor.mockResolvedValue({ ...OPERATOR, roles: ["COUNSELLOR"] });
    expect(
      await completeAcademicEnrolmentAction(
        {},
        form({ enrolmentId: ENROLMENT, reason: "All graded" }),
      ),
    ).toEqual({ error: academicResultsRefusalMessages.FORBIDDEN });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("revision history bound and outgoing regrade claim", () => {
  const claim = (over: Record<string, unknown> = {}) => ({
    executionId: EXECUTION,
    state: "FAILED",
    reasonCode: "NO_PROVIDER_CONFIGURED",
    requestReason: "Learner query upheld",
    actorName: "Ada Academic",
    createdAt: "2026-10-02T10:00:00+00:00",
    terminalAt: "2026-10-02T10:00:05+00:00",
    producedResultRevisionId: null,
    expired: false,
    ...over,
  });
  const withDetail = (over: Record<string, unknown>) => ({
    ...base,
    get_commercial_v1_academic_result: detail(over),
    get_commercial_v1_academic_enrolment_record: record(),
    get_commercial_v1_course_progress: progress(),
  });
  const longHistory = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...history[0],
      resultId: `00000000-0000-4000-8000-${String(i + 3).padStart(12, "0")}`,
      revisionNumber: i + 3,
      isCurrent: i === n - 1,
    }));

  it("says when history is truncated and where older revisions are listed", async () => {
    serve(
      withDetail({
        revisionNumber: 102,
        history: longHistory(100),
        historyHasMore: true,
      }),
    );
    const html = await render({ result: REV2 });
    expect(html).toContain("Showing the newest 100 revisions of this work.");
    expect(html).toContain("Include historical (superseded) revisions");
    expect(html).toContain("Revision 102");
  });

  it("rejects a detail payload whose history exceeds the read bound", async () => {
    serve(withDetail({ history: longHistory(101), historyHasMore: true }));
    const html = await render({ result: REV2 });
    expect(html).toContain(academicResultsRefusalMessages.SERVICE_UNAVAILABLE);
    expect(html).not.toContain("Request institutional regrade");
  });

  it("no claim: the regrade form is offered", async () => {
    serve(withDetail({}));
    const html = await render({ result: REV2 });
    expect(html).toContain("Request institutional regrade");
    expect(html).not.toContain("Regrade claim for this revision");
  });

  it.each([
    [
      "RUNNING",
      { state: "RUNNING", reasonCode: null, terminalAt: null },
      "already in progress",
    ],
    [
      "expired RUNNING",
      { state: "RUNNING", reasonCode: null, terminalAt: null, expired: true },
      "records it as TIMEOUT on its next check",
    ],
    ["FAILED", {}, "does not permit another regrade claim"],
    [
      "ESCALATED",
      { state: "ESCALATED", reasonCode: "HUMAN_REVIEW_REQUIRED" },
      "No authority currently resolves an escalated regrade",
    ],
    [
      "BUDGET_BLOCKED",
      { state: "BUDGET_BLOCKED", reasonCode: "BUDGET_BLOCKED" },
      "does not permit another regrade claim",
    ],
  ])(
    "%s claim on the current revision: durable state shown, no regrade form",
    async (_label, over, text) => {
      serve(withDetail({ regradeClaim: claim(over) }));
      const html = await render({ result: REV2 });
      expect(html).toContain("Regrade claim for this revision");
      expect(html).toContain(text);
      expect(html).toContain("Learner query upheld");
      expect(html).not.toContain("Request institutional regrade");
      expect(html).not.toContain('name="resultId"');
      // No false human-resolution path for a regrade escalation.
      expect(html).not.toContain("/admin/academic-review?case=");
    },
  );

  it("a successful claim on a historical revision links the produced revision", async () => {
    serve(
      withDetail({
        resultId: REV1,
        revisionNumber: 1,
        isCurrent: false,
        origin: "EXAMINER_INITIAL",
        provenance: {
          origin: "EXAMINER_INITIAL",
          executionId: EXECUTION,
          decidedAt: null,
        },
        regradeClaim: claim({
          state: "SUCCEEDED",
          reasonCode: "GRADED",
          producedResultRevisionId: REV2,
        }),
      }),
    );
    const html = await render({ result: REV1 });
    expect(html).toContain("Open the revision this regrade produced");
    expect(html).toContain(`/admin/academic-results?result=${REV2}`);
    expect(html).not.toContain("Request institutional regrade");
  });

  it("the regrade action reports an existing claim without re-entering regrade", async () => {
    for (const state of ["RUNNING", "FAILED", "ESCALATED"]) {
      serve({
        get_commercial_v1_academic_result: detail({
          regradeClaim: claim({ state }),
        }),
      });
      expect(
        await regradeAcademicResultAction(
          {},
          form({ resultId: REV2, reason: "Try the regrade again" }),
        ),
      ).toEqual({
        error: academicResultsRefusalMessages.REGRADE_CLAIM_EXISTS,
      });
    }
    expect(mocks.regradeAssessment).not.toHaveBeenCalled();
    expect(mocks.regradeLab).not.toHaveBeenCalled();
  });

  it("labels the console as governed operations, not read-only", async () => {
    serve(base);
    const html = await render();
    expect(html).toContain("APPEND-ONLY RESULTS · GOVERNED OPERATIONS");
    expect(html).not.toContain("READ-ONLY");
  });
});

describe("migration 048 static boundaries", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../supabase/migrations/202610020048_commercial_v1_academic_results_operations.sql",
    ),
    "utf8",
  );
  it("never writes, deletes or updates result data", () => {
    expect(sql).not.toMatch(
      /\b(delete\s+from|update\s+public\.|insert\s+into)\b/i,
    );
    expect(sql).not.toMatch(/\btruncate\b|\bdrop\b/i);
  });
  it("every function is SECURITY DEFINER with an empty search_path", () => {
    const fns = sql.match(/create function[\s\S]*?\$\$;/g) ?? [];
    expect(fns.length).toBeGreaterThanOrEqual(8);
    for (const fn of fns) {
      expect(fn).toContain("security definer");
      expect(fn).toContain("set search_path=''");
    }
  });
  it("grants execute only to authenticated and never weakens RLS", () => {
    expect(sql).not.toMatch(/grant[^;]*\b(anon|service_role|public)\b/i);
    expect(sql).not.toMatch(/disable row level security|create policy/i);
  });
});
