import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AC-6: domain schemas, the server boundary and the Server Action for Sarah
// post-session feedback. The database is covered by
// session-feedback-db.test.ts; the UI by session-feedback-ui.test.ts.
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireStudentPrincipal: vi.fn(),
  requireAnyRole: vi.fn(),
  // Every Sarah / provider / runtime entrypoint. AC-6 must never reach one.
  forbidden: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireStudentPrincipal: mocks.requireStudentPrincipal,
  requireAnyRole: mocks.requireAnyRole,
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/server/sarah", () => ({
  executeSarahGuide: (...args: unknown[]) => mocks.forbidden("sarah", args),
}));
vi.mock("@/server/academic-runtime/runtime", () => ({
  runGovernedProviderExecution: (...args: unknown[]) =>
    mocks.forbidden("runtime", args),
}));
vi.mock("@/server/academic-runtime/profile-registry", () => ({
  resolveAdapterForProfile: (...args: unknown[]) =>
    mocks.forbidden("adapter", args),
  resolvePlatformRuntimeProfile: (...args: unknown[]) =>
    mocks.forbidden("profile", args),
}));

import {
  RATING_FIELDS,
  RATING_QUESTION,
  SESSION_FEEDBACK_MESSAGE,
  SESSION_FEEDBACK_MIN_RESPONSES,
  feedbackOpportunitiesResultSchema,
  isFinalFeedbackOutcome,
  ratingSchema,
  sessionFeedbackFormSchema,
  sessionFeedbackOutcome,
  sessionFeedbackRefusals,
  sessionFeedbackResultSchema,
  sessionFeedbackSubmissionSchema,
  teachingQualityInputSchema,
  teachingQualitySchema,
  type SessionFeedbackOutcome,
} from "@/domain/session-feedback";
import {
  getTeachingQuality,
  listMySessionFeedbackOpportunities,
  submitMySessionFeedback,
} from "@/server/session-feedback";
import { submitSessionFeedbackAction } from "@/app/student/sarah/feedback-actions";

const SESSION = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const valid = {
  classSessionId: SESSION,
  requestId: REQUEST,
  clarityRating: 5,
  paceRating: 3,
  usefulnessRating: 4,
};
const opportunity = {
  classSessionId: SESSION,
  lessonTitle: "Access Control Fundamentals — DEMO",
  cohortTitle: "September 2026 — DEMO",
  programmeTitle: "Programme",
  instructorName: "Qualified teacher",
  scheduledStart: "2026-10-01T09:00:00+00:00",
  scheduledEnd: "2026-10-01T10:00:00+00:00",
};
const row = (over: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  lessonTitle: "Lesson",
  cohortTitle: "Cohort",
  instructorName: "Teacher",
  programmeTitle: "Programme",
  versionLabel: "2026",
  scheduledStart: "2026-10-01T09:00:00+00:00",
  scheduledEnd: "2026-10-01T10:00:00+00:00",
  status: "SCHEDULED",
  presentCount: 4,
  responseCount: 3,
  scoresAvailable: true,
  clarityAverage: 4,
  paceAverage: 3.33,
  usefulnessAverage: 2.67,
  ...over,
});
const quality = (over: Record<string, unknown> = {}) => ({
  minimumResponses: 3,
  offset: 0,
  hasMore: false,
  summary: {
    sessionCount: 2,
    responseCount: 5,
    scoredSessionCount: 1,
    scoredResponseCount: 3,
    clarityAverage: 4,
    paceAverage: 3.33,
    usefulnessAverage: 2.67,
  },
  rows: [
    row(),
    row({
      sessionId: "33333333-3333-4333-8333-333333333333",
      responseCount: 2,
      scoresAvailable: false,
      clarityAverage: null,
      paceAverage: null,
      usefulnessAverage: null,
    }),
  ],
  ...over,
});
function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.forbidden.mockReset();
  mocks.requireStudentPrincipal.mockReset();
  mocks.requireAnyRole.mockReset();
  mocks.requireStudentPrincipal.mockResolvedValue({
    id: "10000000-0000-4000-8000-000000000001",
    roles: ["STUDENT"],
  });
  mocks.requireAnyRole.mockResolvedValue({ roles: ["ACADEMIC_ADMIN"] });
});

describe("AC-6 rating and submission schemas", () => {
  it("accepts only integer ratings 1-5", () => {
    for (const ok of [1, 2, 3, 4, 5])
      expect(ratingSchema.safeParse(ok).success).toBe(true);
    for (const bad of [0, 6, -1, 2.5, "3", null, Number.NaN])
      expect(ratingSchema.safeParse(bad).success).toBe(false);
  });

  it("is strict: a browser cannot supply a learner, instructor, cohort, lesson or version", () => {
    expect(sessionFeedbackSubmissionSchema.parse(valid)).toEqual(valid);
    for (const extra of [
      "studentId",
      "learnerId",
      "instructorId",
      "cohortId",
      "lessonId",
      "programmeVersionId",
      "comment",
      "sentiment",
    ])
      expect(
        sessionFeedbackSubmissionSchema.safeParse({
          ...valid,
          [extra]: SESSION,
        }).success,
      ).toBe(false);
    for (const missing of RATING_FIELDS) {
      const partial: Record<string, unknown> = { ...valid };
      delete partial[missing];
      expect(sessionFeedbackSubmissionSchema.safeParse(partial).success).toBe(
        false,
      );
    }
    expect(
      sessionFeedbackSubmissionSchema.safeParse({
        ...valid,
        classSessionId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("parses form transport as exactly one digit 1-5 per rating", () => {
    const base = {
      classSessionId: SESSION,
      requestId: REQUEST,
      clarityRating: "5",
      paceRating: "3",
      usefulnessRating: "4",
    };
    expect(sessionFeedbackFormSchema.parse(base)).toEqual(valid);
    for (const bad of ["0", "6", "3.0", " 3", "", "three", "33"])
      expect(
        sessionFeedbackFormSchema.safeParse({ ...base, paceRating: bad })
          .success,
      ).toBe(false);
  });

  it("asks three friendly, structured questions with stable stored terms", () => {
    expect(RATING_FIELDS).toEqual([
      "clarityRating",
      "paceRating",
      "usefulnessRating",
    ]);
    expect(Object.values(RATING_QUESTION)).toEqual([
      "How clear was the session?",
      "How was the pace for you?",
      "How useful was the session for your learning?",
    ]);
  });
});

describe("AC-6 safe outcome mapping", () => {
  it("maps every database result to a bounded learner outcome", () => {
    expect(sessionFeedbackOutcome({ ok: true, outcome: "RECORDED" })).toBe(
      "RECORDED",
    );
    expect(sessionFeedbackOutcome({ ok: true, outcome: "REPLAYED" })).toBe(
      "RECORDED",
    );
    const expected: Record<string, SessionFeedbackOutcome> = {
      FORBIDDEN: "UNAVAILABLE",
      INVALID_INPUT: "INVALID",
      NOT_ELIGIBLE: "NOT_ELIGIBLE",
      SESSION_CANCELLED: "SESSION_CANCELLED",
      SESSION_NOT_ENDED: "SESSION_NOT_ENDED",
      ATTENDANCE_NOT_PRESENT: "NOT_PRESENT",
      ALREADY_SUBMITTED: "ALREADY_SUBMITTED",
      REQUEST_CONFLICT: "REQUEST_CONFLICT",
    };
    expect(Object.keys(expected).sort()).toEqual(
      [...sessionFeedbackRefusals].sort(),
    );
    for (const code of sessionFeedbackRefusals)
      expect(sessionFeedbackOutcome({ ok: false, code })).toBe(expected[code]);
    expect(
      sessionFeedbackResultSchema.safeParse({ ok: false, code: "SQLSTATE" })
        .success,
    ).toBe(false);
    expect(
      sessionFeedbackResultSchema.safeParse({
        ok: true,
        outcome: "RECORDED",
        feedbackId: SESSION,
      }).success,
    ).toBe(false);
  });

  it("uses truthful copy that claims no review, instructor reading or action", () => {
    expect(SESSION_FEEDBACK_MESSAGE.RECORDED).toBe(
      "Thanks — your feedback has been recorded.",
    );
    const copy = Object.values(SESSION_FEEDBACK_MESSAGE).join(" ");
    expect(copy).not.toMatch(
      /reviewed|has seen|will (act|review|improve|change)|immediately|Sarah (read|saw|reviewed)|[0-9a-f]{8}-[0-9a-f]{4}|SQL|exception/i,
    );
    expect(isFinalFeedbackOutcome("RECORDED")).toBe(true);
    expect(isFinalFeedbackOutcome("ALREADY_SUBMITTED")).toBe(true);
    expect(isFinalFeedbackOutcome("UNAVAILABLE")).toBe(false);
    expect(isFinalFeedbackOutcome("REQUEST_CONFLICT")).toBe(false);
    expect(isFinalFeedbackOutcome("INVALID")).toBe(false);
  });
});

describe("AC-6 projections", () => {
  it("bounds learner opportunities to 10 strict, learner-safe rows", () => {
    const ok = (n: number) => ({
      ok: true,
      opportunities: Array.from({ length: n }, () => opportunity),
    });
    expect(feedbackOpportunitiesResultSchema.safeParse(ok(10)).success).toBe(
      true,
    );
    expect(feedbackOpportunitiesResultSchema.safeParse(ok(11)).success).toBe(
      false,
    );
    expect(
      feedbackOpportunitiesResultSchema.safeParse({
        ok: true,
        opportunities: [{ ...opportunity, studentId: SESSION }],
      }).success,
    ).toBe(false);
  });

  it("enforces the 3-response privacy threshold at the TypeScript boundary", () => {
    expect(SESSION_FEEDBACK_MIN_RESPONSES).toBe(3);
    expect(teachingQualitySchema.parse(quality()).rows).toHaveLength(2);
    // Scores leaking below the threshold are refused...
    expect(
      teachingQualitySchema.safeParse(
        quality({
          rows: [row({ responseCount: 2, scoresAvailable: false })],
        }),
      ).success,
    ).toBe(false);
    expect(
      teachingQualitySchema.safeParse(
        quality({ rows: [row({ responseCount: 2 })] }),
      ).success,
    ).toBe(false);
    // ...and so are missing scores at or above it.
    expect(
      teachingQualitySchema.safeParse(
        quality({ rows: [row({ paceAverage: null })] }),
      ).success,
    ).toBe(false);
    // A summary needs only threshold-meeting sessions.
    expect(
      teachingQualitySchema.safeParse(
        quality({
          summary: { ...quality().summary, scoredResponseCount: 2 },
        }),
      ).success,
    ).toBe(false);
    expect(
      teachingQualitySchema.safeParse(
        quality({
          summary: {
            sessionCount: 1,
            responseCount: 2,
            scoredSessionCount: 0,
            scoredResponseCount: 0,
            clarityAverage: 3,
            paceAverage: null,
            usefulnessAverage: null,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("refuses learner identity, raw ratings, numeric strings and unbounded pages", () => {
    for (const extra of [
      "studentId",
      "studentName",
      "studentNumber",
      "ratings",
      "submittedAt",
    ])
      expect(
        teachingQualitySchema.safeParse(
          quality({ rows: [{ ...row(), [extra]: "x" }] }),
        ).success,
      ).toBe(false);
    expect(
      teachingQualitySchema.safeParse(
        quality({ rows: [row({ clarityAverage: "4.00" })] }),
      ).success,
    ).toBe(false);
    expect(
      teachingQualitySchema.safeParse(
        quality({ rows: [row({ responseCount: "3" })] }),
      ).success,
    ).toBe(false);
    expect(
      teachingQualitySchema.safeParse(
        quality({ rows: Array.from({ length: 51 }, () => row()) }),
      ).success,
    ).toBe(false);
    expect(
      teachingQualitySchema.safeParse(
        quality({ rows: [row({ status: "CANCELLED" })] }),
      ).success,
    ).toBe(false);
  });

  it("parses bounded admin filters", () => {
    expect(teachingQualityInputSchema.parse({})).toEqual({ offset: 0 });
    expect(teachingQualityInputSchema.parse({ offset: "50" }).offset).toBe(50);
    for (const bad of [
      { offset: "-1" },
      { offset: "100001" },
      { instructorId: "x" },
      { from: "yesterday" },
      { from: "2026-10-02T00:00:00Z", until: "2026-10-01T00:00:00Z" },
      { studentId: SESSION },
    ])
      expect(teachingQualityInputSchema.safeParse(bad).success).toBe(false);
  });
});

describe("AC-6 server boundary", () => {
  it("submits exactly the session handle, request UUID and ratings, deriving the learner in the database", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, outcome: "RECORDED" },
      error: null,
    });
    expect(await submitMySessionFeedback(valid)).toBe("RECORDED");
    expect(mocks.requireStudentPrincipal).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "submit_my_session_feedback",
      {
        p_class_session_id: SESSION,
        p_request_id: REQUEST,
        p_clarity_rating: 5,
        p_pace_rating: 3,
        p_usefulness_rating: 4,
      },
    );
  });

  it("never invokes the Sarah runtime, a provider adapter or a runtime profile", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, outcome: "RECORDED" },
      error: null,
    });
    await submitMySessionFeedback(valid);
    await submitSessionFeedbackAction(
      {},
      form({
        classSessionId: SESSION,
        requestId: REQUEST,
        clarityRating: "5",
        paceRating: "3",
        usefulnessRating: "4",
      }),
    );
    mocks.rpc.mockResolvedValue({
      data: { ok: true, opportunities: [] },
      error: null,
    });
    await listMySessionFeedbackOpportunities();
    expect(mocks.forbidden).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      "submit_my_session_feedback",
      "submit_my_session_feedback",
      "list_my_session_feedback_opportunities",
    ]);
    // Statically, no AC-6 source imports an AI or Sarah execution path.
    for (const path of [
      "src/domain/session-feedback.ts",
      "src/server/session-feedback.ts",
      "src/app/student/sarah/feedback-actions.ts",
      "src/components/sarah-session-feedback.tsx",
      "src/components/teaching-quality-panel.tsx",
    ]) {
      const source = readFileSync(resolve(path), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
        (m) => m[1],
      );
      for (const specifier of imports)
        expect(specifier, `${path} imports ${specifier}`).not.toMatch(
          /^@\/server\/sarah|academic-runtime|profile-registry|provider|openai|anthropic|tutor-lab|professor|commercial/,
        );
      for (const forbidden of [
        "COUNSELLOR_PLATFORM",
        "executeSarahGuide",
        "govern_sarah_execution",
        "reserve_sarah_interaction",
        "runGovernedProviderExecution",
        "service_role",
        "dangerouslySetInnerHTML",
        "recommend",
        "pricing",
      ])
        expect(source, `${path}: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("refuses unknown fields and invalid ratings before any database call", async () => {
    expect(
      await submitMySessionFeedback({ ...valid, studentId: SESSION }),
    ).toBe("INVALID");
    expect(await submitMySessionFeedback({ ...valid, clarityRating: 6 })).toBe(
      "INVALID",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("requires a learner principal before any database call", async () => {
    mocks.requireStudentPrincipal.mockRejectedValue(new Error("denied"));
    await expect(submitMySessionFeedback(valid)).rejects.toThrow("denied");
    await expect(listMySessionFeedbackOpportunities()).rejects.toThrow(
      "denied",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps transport errors and malformed results to a safe outcome", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await submitMySessionFeedback(valid)).toBe("UNAVAILABLE");
    mocks.rpc.mockResolvedValue({ data: { ok: "yes" }, error: null });
    expect(await submitMySessionFeedback(valid)).toBe("UNAVAILABLE");
    mocks.rpc.mockResolvedValue({
      data: { ok: false, code: "ALREADY_SUBMITTED" },
      error: null,
    });
    expect(await submitMySessionFeedback(valid)).toBe("ALREADY_SUBMITTED");
  });

  it("returns opportunities only from a valid, bounded projection", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, opportunities: [opportunity] },
      error: null,
    });
    expect(await listMySessionFeedbackOpportunities()).toEqual({
      status: "OK",
      opportunities: [opportunity],
    });
    for (const data of [
      { ok: false, code: "FORBIDDEN" },
      {
        ok: true,
        opportunities: Array.from({ length: 11 }, () => opportunity),
      },
    ]) {
      mocks.rpc.mockResolvedValue({ data, error: null });
      expect(await listMySessionFeedbackOpportunities()).toEqual({
        status: "UNAVAILABLE",
      });
    }
  });

  it("limits teaching quality to Academic and Platform Admin and fails closed on unsafe data", async () => {
    mocks.rpc.mockResolvedValue({ data: quality(), error: null });
    const result = await getTeachingQuality({
      instructorId: SESSION,
      offset: "50",
    });
    expect(result.status).toBe("OK");
    expect(mocks.requireAnyRole).toHaveBeenCalledWith([
      "ACADEMIC_ADMIN",
      "PLATFORM_ADMIN",
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith("admin_session_teaching_quality", {
      p_instructor_id: SESSION,
      p_cohort_id: null,
      p_from: null,
      p_until: null,
      p_offset: 50,
    });
    mocks.rpc.mockClear();
    expect(await getTeachingQuality({ cohortId: "nope" })).toEqual({
      status: "INVALID_FILTERS",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({
      data: quality({ rows: [row({ responseCount: 2 })] }),
      error: null,
    });
    expect(await getTeachingQuality({})).toEqual({ status: "UNAVAILABLE" });
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "FORBIDDEN" },
    });
    expect(await getTeachingQuality({})).toEqual({ status: "UNAVAILABLE" });
    mocks.requireAnyRole.mockRejectedValue(new Error("Access denied"));
    mocks.rpc.mockClear();
    await expect(getTeachingQuality({})).rejects.toThrow("Access denied");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("AC-6 Server Action", () => {
  it("forwards only the reviewed fields and ignores any browser-supplied authority", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, outcome: "RECORDED" },
      error: null,
    });
    const result = await submitSessionFeedbackAction(
      {},
      form({
        classSessionId: SESSION,
        requestId: REQUEST,
        clarityRating: "5",
        paceRating: "3",
        usefulnessRating: "4",
        studentId: "10000000-0000-4000-8000-000000000003",
        instructorId: "10000000-0000-4000-8000-000000000002",
        role: "ACADEMIC_ADMIN",
      }),
    );
    expect(result).toEqual({ outcome: "RECORDED" });
    expect(mocks.rpc.mock.calls[0][1]).toEqual({
      p_class_session_id: SESSION,
      p_request_id: REQUEST,
      p_clarity_rating: 5,
      p_pace_rating: 3,
      p_usefulness_rating: 4,
    });
  });

  it("refuses a missing rating without a database call, and never leaks an exception", async () => {
    expect(
      await submitSessionFeedbackAction(
        {},
        form({
          classSessionId: SESSION,
          requestId: REQUEST,
          clarityRating: "5",
        }),
      ),
    ).toEqual({ outcome: "INVALID" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.requireStudentPrincipal.mockRejectedValue(new Error("secret detail"));
    expect(
      await submitSessionFeedbackAction(
        {},
        form({
          classSessionId: SESSION,
          requestId: REQUEST,
          clarityRating: "5",
          paceRating: "3",
          usefulnessRating: "4",
        }),
      ),
    ).toEqual({ outcome: "UNAVAILABLE" });
  });
});
