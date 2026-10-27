import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Integration seams between the learner pages and the academic and
// services backends (docs/61): the workspace check-in and Tutor actions,
// the attempt page's release firewall and answer review, and the lab
// evidence form. Server modules are mocked; the database behaviour behind
// them is covered by learner-academic-policies-db and learner-services-db.
const mocks = vi.hoisted(() => ({
  checkInToClass: vi.fn(),
  getMyAcademyLesson: vi.fn(),
  getMyAcademyAttempt: vi.fn(),
  openMyAcademyTutorSupport: vi.fn(),
  executeAcademySupport: vi.fn(),
  revalidatePath: vi.fn(),
}));

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`REDIRECT ${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("@/server/learner-academics", () => ({
  checkInToClass: mocks.checkInToClass,
}));
vi.mock("@/server/academy-delivery", () => ({
  getMyAcademyLesson: mocks.getMyAcademyLesson,
  getMyAcademyAttempt: mocks.getMyAcademyAttempt,
}));
vi.mock("@/server/academy-support", () => ({
  openMyAcademyTutorSupport: mocks.openMyAcademyTutorSupport,
}));
vi.mock("@/server/tutor-lab-execution/academy", () => ({
  executeAcademySupport: mocks.executeAcademySupport,
}));
vi.mock("@/server/identity", () => ({
  requireActor: vi.fn(async () => undefined),
  requireStudentPrincipal: vi.fn(async () => ({
    displayName: "Fixture Learner",
    roles: ["STUDENT"],
  })),
}));
vi.mock("@/components/academy-shell", () => ({
  AcademyShell: ({ children }: { children: ReactNode }) =>
    createElement("main", null, children),
}));
vi.mock("@/components/academy-exam", () => ({
  AcademyExam: () => createElement("div", null, "EXAM IN PROGRESS"),
}));

import {
  checkInMyClassAction,
  openMyTutorAction,
} from "@/app/student/courses/actions";
import AttemptPage from "@/app/student/academy/attempt/[attemptId]/page";
import { describeAnswerKey } from "@/domain/assessment-question-types";
import { LabEvidenceForm } from "@/components/learner/lab-evidence-form";

const ENROLMENT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const OBJECTIVE = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const ATTEMPT = "55555555-5555-4555-8555-555555555555";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const redirectOf = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    if (error instanceof Redirect) return error.url;
    throw error;
  }
  throw new Error("expected a redirect");
};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});

describe("Give attendance", () => {
  it("refuses malformed identifiers without calling the backend", async () => {
    const state = await checkInMyClassAction(
      {},
      form({ enrolmentId: "nope", scheduleItemId: ITEM }),
    );
    expect(state.ok).toBe(false);
    expect(mocks.checkInToClass).not.toHaveBeenCalled();
  });

  it("records attendance, reports a replay and refreshes the workspace", async () => {
    mocks.checkInToClass.mockResolvedValueOnce({ ok: true, replayed: false });
    expect(
      await checkInMyClassAction(
        {},
        form({ enrolmentId: ENROLMENT, scheduleItemId: ITEM }),
      ),
    ).toEqual({ ok: true, message: "Attendance recorded." });
    expect(mocks.checkInToClass).toHaveBeenCalledWith(ENROLMENT, ITEM);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/student/courses/${ENROLMENT}`,
    );
    mocks.checkInToClass.mockResolvedValueOnce({ ok: true, replayed: true });
    expect(
      (
        await checkInMyClassAction(
          {},
          form({ enrolmentId: ENROLMENT, scheduleItemId: ITEM }),
        )
      ).message,
    ).toBe("Your attendance was already recorded.");
  });

  it("explains a closed window and hides unknown codes", async () => {
    mocks.checkInToClass.mockResolvedValueOnce({
      ok: false,
      code: "WINDOW_CLOSED",
    });
    expect(
      (
        await checkInMyClassAction(
          {},
          form({ enrolmentId: ENROLMENT, scheduleItemId: ITEM }),
        )
      ).error,
    ).toBe("The attendance window for this class has closed.");
    mocks.checkInToClass.mockResolvedValueOnce({ ok: false, code: "XYZZY" });
    expect(
      (
        await checkInMyClassAction(
          {},
          form({ enrolmentId: ENROLMENT, scheduleItemId: ITEM }),
        )
      ).error,
    ).toBe("Attendance could not be recorded. Try again later.");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("AI Tutor from the workspace", () => {
  const lesson = {
    lessonRef: "lesson-1",
    title: "Fixture Lesson",
    objectives: [{ id: OBJECTIVE, description: "Fixture objective" }],
  };

  it("sends the fixed class-notes request through the governed Tutor and opens the conversation", async () => {
    mocks.getMyAcademyLesson.mockResolvedValueOnce(lesson);
    mocks.openMyAcademyTutorSupport.mockResolvedValueOnce(REQUEST);
    mocks.executeAcademySupport.mockResolvedValueOnce({ status: "SUCCEEDED" });
    const url = await redirectOf(
      openMyTutorAction(
        form({
          enrolmentId: ENROLMENT,
          scheduleItemId: ITEM,
          lessonRef: "lesson-1",
          request: "CLASS_NOTES",
        }),
      ),
    );
    expect(url).toBe(`/student/academy/support/${REQUEST}`);
    expect(mocks.openMyAcademyTutorSupport).toHaveBeenCalledWith(
      ENROLMENT,
      "lesson-1",
      OBJECTIVE,
    );
    const sent = mocks.executeAcademySupport.mock.calls[0][0];
    expect(sent.requestId).toBe(REQUEST);
    expect(sent.message).toBe(
      'Please give me concise class notes for "Fixture Lesson".',
    );
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends the learner's own question and reports an unanswered request", async () => {
    mocks.getMyAcademyLesson.mockResolvedValueOnce(lesson);
    mocks.openMyAcademyTutorSupport.mockResolvedValueOnce(REQUEST);
    mocks.executeAcademySupport.mockResolvedValueOnce({
      status: "ACTIVITY_BLOCKED",
    });
    const url = await redirectOf(
      openMyTutorAction(
        form({
          enrolmentId: ENROLMENT,
          lessonRef: "lesson-1",
          request: "QUESTION",
          message: "  What is a subnet?  ",
        }),
      ),
    );
    expect(url).toBe(
      `/student/academy/support/${REQUEST}?notice=ACTIVITY_BLOCKED`,
    );
    expect(mocks.executeAcademySupport.mock.calls[0][0].message).toBe(
      "What is a subnet?",
    );
  });

  it("returns to the workspace with a reason when no Tutor conversation can open", async () => {
    expect(
      await redirectOf(
        openMyTutorAction(
          form({ enrolmentId: ENROLMENT, request: "QUESTION", message: "Hi" }),
        ),
      ),
    ).toBe(`/student/courses/${ENROLMENT}?tutorNotice=NO_CLASS#tutor`);
    mocks.getMyAcademyLesson.mockRejectedValueOnce(new Error("NOT_RELEASED"));
    expect(
      await redirectOf(
        openMyTutorAction(
          form({
            enrolmentId: ENROLMENT,
            lessonRef: "lesson-1",
            request: "EXPLAIN_TOPICS",
          }),
        ),
      ),
    ).toBe(`/student/courses/${ENROLMENT}?tutorNotice=NOT_RELEASED#tutor`);
    mocks.getMyAcademyLesson.mockResolvedValueOnce(lesson);
    expect(
      await redirectOf(
        openMyTutorAction(
          form({
            enrolmentId: ENROLMENT,
            lessonRef: "lesson-1",
            request: "QUESTION",
            message: "   ",
          }),
        ),
      ),
    ).toBe(`/student/courses/${ENROLMENT}?tutorNotice=INVALID_MESSAGE#tutor`);
    expect(mocks.openMyAcademyTutorSupport).not.toHaveBeenCalled();
    expect(mocks.executeAcademySupport).not.toHaveBeenCalled();
  });
});

describe("Attempt page release firewall", () => {
  const submitted = {
    attemptId: ATTEMPT,
    enrolmentId: ENROLMENT,
    assessmentRef: "quiz-1",
    title: "Fixture Quiz",
    state: "SUBMITTED" as const,
    submission: "STUDENT_SUBMIT" as const,
    submittedAt: "2026-10-27T10:00:00.000Z",
    attemptNumber: 1,
    attemptsAllowed: 2,
  };
  const render = async () =>
    text(
      renderToStaticMarkup(
        await AttemptPage({ params: Promise.resolve({ attemptId: ATTEMPT }) }),
      ),
    );

  it("keeps the result confidential before release", async () => {
    mocks.getMyAcademyAttempt.mockResolvedValueOnce({
      ...submitted,
      released: false,
      releasedAt: null,
    });
    const page = await render();
    expect(page).toContain("Your result is confidential");
    expect(page).not.toMatch(/scored|Correct answer|Explanation|undefined/);
  });

  it("shows the score, correct answers and explanations after release", async () => {
    mocks.getMyAcademyAttempt.mockResolvedValueOnce({
      ...submitted,
      released: true,
      releasedAt: "2026-10-28T10:00:00.000Z",
      score: 3,
      maxScore: 5,
      reviewAvailable: true,
      review: [
        {
          position: 1,
          prompt: "Fixture question",
          questionType: "SINGLE_SELECT",
          interaction: {
            options: [
              { id: "a", label: "Fixture A" },
              { id: "b", label: "Fixture B" },
            ],
          },
          maxMarks: 5,
          response: JSON.stringify({ optionId: "a" }),
          marks: 0,
          correctAnswer: { correctOptionId: "b" },
          expectedAnswer: null,
          explanation: "Fixture guidance.",
        },
      ],
    });
    const page = await render();
    expect(page).toContain("This attempt scored 3 / 5.");
    expect(page).toContain("Your answer: Fixture A");
    expect(page).toContain("Correct answer: Fixture B");
    expect(page).toContain("Explanation: Fixture guidance.");
  });
});

describe("describeAnswerKey", () => {
  it("labels each answer-key shape with learner-visible labels", () => {
    const steps = [
      { id: "s1", label: "One" },
      { id: "s2", label: "Two" },
      { id: "s3", label: "Three" },
    ];
    expect(
      describeAnswerKey(
        "PBQ_ORDERING",
        { steps, scoringRule: "ALL_OR_NOTHING" },
        { correctOrder: ["s2", "s1", "s3"] },
      ),
    ).toEqual(["1. Two", "2. One", "3. Three"]);
    expect(
      describeAnswerKey(
        "MULTIPLE_SELECT",
        {
          options: steps,
          requiredSelections: null,
          scoringRule: "ALL_OR_NOTHING",
        },
        { correctOptionIds: ["s1", "s3"] },
      ),
    ).toEqual(["One", "Three"]);
    expect(
      describeAnswerKey("SINGLE_SELECT", { options: steps }, { wrong: 1 }),
    ).toEqual([]);
  });
});

describe("Lab evidence form", () => {
  const actions = {
    uploadAction: vi.fn(),
    removeAction: vi.fn(),
    submitAction: vi.fn(),
  };
  const base = {
    enrolmentId: ENROLMENT,
    labRef: "lab-1",
    canSubmit: true,
    evidence: null,
    unattached: [],
    ...actions,
  };

  it("shows submitted evidence read-only with owner file links", () => {
    const html = renderToStaticMarkup(
      createElement(LabEvidenceForm, {
        ...base,
        evidence: {
          evidenceId: REQUEST,
          createdAt: "2026-10-27T10:00:00.000Z",
          codeText: "print('TEST ONLY')",
          files: [
            {
              fileId: OBJECTIVE,
              fileName: "shot.png",
              contentType: "image/png",
              sizeBytes: 2048,
            },
          ],
        },
      }),
    );
    expect(html).toContain(`href="/api/learner/files/${OBJECTIVE}"`);
    expect(text(html)).toContain("Submitted evidence cannot be changed.");
    expect(html).not.toContain("<form");
  });

  it("offers resumable uploads and blocks submission before the practical starts", () => {
    const html = renderToStaticMarkup(
      createElement(LabEvidenceForm, {
        ...base,
        canSubmit: false,
        unattached: [
          {
            fileId: OBJECTIVE,
            fileName: "draft.pdf",
            contentType: "application/pdf",
            sizeBytes: 100,
          },
        ],
      }),
    );
    expect(text(html)).toContain("draft.pdf");
    expect(text(html)).toContain(
      "Evidence can be submitted once the practical has started.",
    );
    expect(html).toMatch(/<fieldset disabled=""/);
  });

  it("reports work submitted through the text-only path", () => {
    const html = renderToStaticMarkup(
      createElement(LabEvidenceForm, { ...base, alreadySubmitted: true }),
    );
    expect(text(html)).toContain(
      "Your work for this practical has been submitted.",
    );
    expect(html).not.toContain("<form");
  });
});
