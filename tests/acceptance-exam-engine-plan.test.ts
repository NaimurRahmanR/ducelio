import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import { validateCoursePackage } from "@/domain/course-package";
import {
  canonicalResponseBody,
  scoreObjectiveResponse,
  type ObjectiveQuestionType,
} from "@/domain/assessment-question-types";
import {
  buildExamEnginePackage,
  canonicalBody,
  COMPONENT_PLAN,
  containment,
  examEngineQuestions,
  OBJECTIVE_TYPES,
  plannedHostedWrites,
  protectedMarkerHits,
  questionsFor,
  RATIONALE_SENTINEL,
  TIMED_COMPONENT,
} from "../scripts/acceptance/exam-engine-plan.mjs";

// LOCAL verification of the CP2 hosted exam-engine journey's pure plan. This
// proves the synthetic packages are valid for the CP2 application AND the
// migration 059 database validator, that every planned answer is saved in
// the canonical form and scored exactly as planned by both scorers, and that
// the hosted-write plan matches the packages. It is not hosted acceptance.

let db: PGlite;
beforeAll(async () => {
  db = await testDatabase();
}, 120000);
afterAll(async () => {
  await db?.close();
});

const courses = ["main", "review"] as const;

describe("exam-engine acceptance plan", () => {
  it.each(courses)(
    "the %s package is valid for the CP2 TypeScript validator",
    (course) => {
      const result = validateCoursePackage(
        buildExamEnginePackage(`plan-${course}`, course),
      );
      expect(result.valid).toBe(true);
    },
  );

  it.each(courses)(
    "the %s package passes migration 059's database validator",
    async (course) => {
      const pkg = buildExamEnginePackage(`plan-${course}`, course);
      await db.query(
        "select course_engineering_private.assert_full_package_valid($1,$2,$3,$4::jsonb)",
        [
          pkg.packageKey,
          pkg.packageRevision,
          pkg.schemaVersion,
          JSON.stringify(pkg),
        ],
      );
    },
  );

  it("keeps synthetic assessment durations within hosted windows", () => {
    for (const [course, windowMinutes] of [
      ["main", 6],
      ["review", 30],
    ] as const) {
      const pkg = buildExamEnginePackage(`window-${course}`, course);
      expect(
        pkg.assessmentTemplates.every(
          (template: { durationMinutes: number }) =>
            template.durationMinutes <= windowMinutes,
        ),
      ).toBe(true);
    }
  });
  it("covers all six question types, an objective-only and a timed component, and leaves legacy free text untouched", () => {
    const pkg = buildExamEnginePackage("plan-main", "main");
    const types = (key: string) =>
      pkg.assessmentTemplates
        .find((t: { key: string }) => t.key === key)!
        .questions.map(
          (q: { questionType?: string }) => q.questionType ?? "FREE_TEXT",
        );
    expect(new Set(types("quiz_1"))).toEqual(
      new Set([...OBJECTIVE_TYPES, "FREE_TEXT"]),
    );
    expect(types("quiz_2")).toEqual([...OBJECTIVE_TYPES]);
    expect(types("midterm")).toEqual(["FREE_TEXT"]);
    const midterm = pkg.assessmentTemplates.find(
      (t: { key: string }) => t.key === "midterm",
    )!;
    expect(Object.keys(midterm.questions[0]).sort()).not.toContain(
      "questionType",
    );
    expect(
      pkg.assessmentTemplates.find(
        (t: { key: string }) => t.key === TIMED_COMPONENT.toLowerCase(),
      )!.durationMinutes,
    ).toBe(1);
    expect(
      buildExamEnginePackage("plan-review", "review").agentConfiguration
        .EXAMINER.escalationPolicy,
    ).toBe("ACADEMIC_REVIEW");
    expect(pkg.agentConfiguration.EXAMINER.escalationPolicy).toBe("NONE");
  });

  // The plan module is plain JavaScript (allowJs is off), so its shape is
  // stated here.
  type PlanQuestion = {
    questionType: string;
    maxMarks: number;
    interaction: unknown;
    answerKey: unknown;
    answers: { best: unknown; partial: unknown; partialMarks: number };
  };
  const objective = (examEngineQuestions() as PlanQuestion[]).filter(
    (q) => q.questionType !== "FREE_TEXT",
  );
  it.each(objective.map((q): [string, PlanQuestion] => [q.questionType, q]))(
    "%s: canonical bodies match the application, and both scorers award exactly the planned marks",
    async (_type: string, q: PlanQuestion) => {
      const type = q.questionType as ObjectiveQuestionType;
      for (const [choice, expected] of [
        ["best", q.maxMarks],
        ["partial", q.answers.partialMarks],
      ] as const) {
        const response = q.answers[choice];
        const body = canonicalBody(type, response);
        expect(body).toBe(canonicalResponseBody(type, response));
        expect(
          scoreObjectiveResponse(
            type,
            q.interaction,
            q.answerKey,
            q.maxMarks,
            response,
          ),
        ).toBe(expected);
        const [{ v }] = (
          await db.query<{ v: number }>(
            "select assessment_interaction_private.score_response($1,$2::jsonb,$3::jsonb,$4,$5) as v",
            [
              type,
              JSON.stringify(q.interaction),
              JSON.stringify(q.answerKey),
              q.maxMarks,
              body,
            ],
          )
        ).rows;
        expect(v).toBe(expected);
      }
      expect(q.answers.partialMarks).toBeLessThan(q.maxMarks);
    },
  );

  it("protected markers: absent from learner-visible definitions, present in protected fields", () => {
    for (const q of objective)
      expect(protectedMarkerHits(JSON.stringify(q.interaction))).toEqual([]);
    expect(protectedMarkerHits(JSON.stringify(objective[0].answerKey))).toEqual(
      ["correctOptionId"],
    );
    expect(
      protectedMarkerHits(
        JSON.stringify(buildExamEnginePackage("plan-main", "main")),
      ),
    ).toEqual(expect.arrayContaining([RATIONALE_SENTINEL, "answerKey"]));
  });

  it("the hosted-write plan matches the packages exactly", () => {
    const plan = plannedHostedWrites();
    for (const course of courses) {
      const pkg = buildExamEnginePackage(`plan-${course}`, course);
      const questions: { questionType?: string }[] =
        pkg.assessmentTemplates.flatMap(
          (t: { questions: { questionType?: string }[] }) => t.questions,
        );
      expect(plan.exact[course].assessments).toBe(
        pkg.assessmentTemplates.length,
      );
      expect(plan.exact[course].assessment_questions).toBe(questions.length);
      const objectiveCount = questions.filter((q) => q.questionType).length;
      expect(plan.exact[course].assessment_question_interactions).toBe(
        objectiveCount,
      );
      expect(plan.exact[course].assessment_question_objective_keys).toBe(
        objectiveCount,
      );
    }
    const attempted = Object.keys(COMPONENT_PLAN.main).length + 1;
    expect(plan.run.assessment_attempts).toBe(
      attempted + Object.keys(COMPONENT_PLAN.review).length,
    );
    expect(plan.run.auth_users_created).toBe(0);
    expect(questionsFor("main", "QUIZ_4")).toBeNull();
    expect(containment().join(" ")).not.toMatch(/\bdelete\b/i);
  });
});
