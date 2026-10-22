import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPlanUnits,
  validateAcademyCoursePackage,
} from "@/domain/academy-course-package";
import {
  ACADEMY_FORMAT_IDS,
  planSchedule,
  suggestStudyDays,
  formatEndDate,
  type PlanUnit,
} from "@/domain/academy-scheduler";
import { validateCoursePackage } from "@/domain/course-package";
import { academyPackage } from "./academy-fixture";

const codes = (input: unknown) => {
  const r = validateAcademyCoursePackage(input);
  return r.valid ? [] : r.errors.map((e) => e.code);
};
const errors = (input: unknown) => {
  const r = validateAcademyCoursePackage(input);
  return r.valid ? [] : r.errors;
};

describe("ACADEMY_COURSE_PACKAGE_V1 Security+ conversion artefact", () => {
  it("is valid and recognises every lab and assessment automatically", () => {
    const r = validateAcademyCoursePackage(academyPackage());
    if (!r.valid) throw new Error(JSON.stringify(r.errors.slice(0, 5)));
    expect(r.review.totals).toMatchObject({
      modules: 5,
      lessons: 28,
      objectives: 28,
    });
    expect(r.review.labs).toHaveLength(14);
    expect(
      r.review.assessments.map((a) => [
        a.componentKey,
        a.questionCount,
        a.durationMinutes,
      ]),
    ).toEqual([
      ["QUIZ_1", 20, 25],
      ["QUIZ_2", 20, 25],
      ["MIDTERM", 50, 60],
      ["QUIZ_3", 20, 25],
      ["QUIZ_4", 20, 25],
      ["FINAL", 90, 90],
    ]);
    expect(r.review.grading.reduce((n, g) => n + g.weightBp, 0)).toBe(10000);
    // The published Security+ course's 20% lab contribution is preserved,
    // with the missing rubrics declared pending rather than invented.
    expect(r.review.grading.find((g) => g.source === "LABS")?.weightBp).toBe(
      2000,
    );
    expect(r.review.labs.filter((l) => l.graded)).toHaveLength(10);
    expect(
      r.package.labs.every(
        (l) => l.rubric.length === 0 && l.markingGuidance === null,
      ),
    ).toBe(true);
    expect(r.review.pendingDecisions.map((d) => d.key)).toEqual(
      expect.arrayContaining([
        "LAB_RUBRICS",
        "COURSE_PASS_MARK",
        "LESSON_WORKLOAD",
        "PREPARATION_AND_SITTING_WINDOWS",
        "DELIVERY_FORMATS",
        "MISSED_SITTING_POLICY",
      ]),
    );
    expect(r.review.formats.map((f) => f.formatId)).toEqual([
      ...ACADEMY_FORMAT_IDS,
    ]);
    expect(JSON.stringify(r.review)).not.toMatch(
      /answerKey|expectedAnswer|markingGuidance|correctOptionId/,
    );
  });

  it("embeds the revision 6 academic content unchanged", () => {
    const rev6 = JSON.parse(
      readFileSync(
        "content/courses/security-plus-sy0-701/ducelio-upload-rev6-six-assessments.json",
        "utf8",
      ),
    );
    const { curriculum } = academyPackage();
    for (const field of [
      "programme",
      "modules",
      "assignmentTemplates",
      "assessmentTemplates",
      "schedulingDefaults",
      "agentConfiguration",
    ])
      expect(curriculum[field]).toEqual(rev6[field]);
    expect(curriculum.packageKey).toBe("security-plus-sy0-701-academy");
    expect(validateCoursePackage(curriculum).valid).toBe(true);
  });

  it("is reproducible from its committed builder", () => {
    expect(() =>
      execFileSync(
        "node",
        ["scripts/academy/build-security-plus-academy.mjs", "--check"],
        { stdio: "pipe" },
      ),
    ).not.toThrow();
  });
});

describe("validation produces actionable errors and never fills gaps", () => {
  it("rejects non-JSON-object input and missing fields", () => {
    expect(codes(null)).toEqual(["SCHEMA_INVALID"]);
    const pkg = academyPackage();
    delete pkg.workload;
    expect(errors(pkg)).toContainEqual(
      expect.objectContaining({ path: "workload", code: "SCHEMA_INVALID" }),
    );
  });

  it("reports curriculum errors with a curriculum path", () => {
    const pkg = academyPackage();
    pkg.curriculum.modules[0].lessons[0].objectives = [];
    expect(errors(pkg)[0].path).toMatch(
      /^curriculum\.modules\.0\.lessons\.0\.objectives/,
    );
  });

  it("requires a workload for every lesson", () => {
    const pkg = academyPackage();
    pkg.workload.lessons.pop();
    expect(errors(pkg)).toContainEqual(
      expect.objectContaining({
        code: "MISSING_WORKLOAD",
        message: expect.stringContaining("lesson-5-6"),
      }),
    );
  });

  it("requires every practical activity and assessment to be scheduled", () => {
    const pkg = academyPackage();
    pkg.labs = pkg.labs.slice(1);
    pkg.assessments = pkg.assessments.slice(0, 5);
    expect(codes(pkg)).toEqual(
      expect.arrayContaining(["MISSING_LAB", "MISSING_ASSESSMENT"]),
    );
  });

  it("refuses an assessment placed before the teaching it assesses", () => {
    const pkg = academyPackage();
    pkg.assessments[0].afterLessonRef = "lesson-1-2";
    expect(codes(pkg)).toEqual(
      expect.arrayContaining(["PLACEMENT_BEFORE_TEACHING"]),
    );
    const gap = academyPackage();
    gap.assessments[0].requiredLessonRefs = ["lesson-1-1"];
    expect(codes(gap)).toContain("COVERAGE_GAP");
  });

  it("validates the grading distribution", () => {
    const pkg = academyPackage();
    pkg.grading.components[5].weightBp = 3000;
    expect(errors(pkg)).toContainEqual(
      expect.objectContaining({
        code: "WEIGHTS_NOT_100",
        message: expect.stringContaining("90%"),
      }),
    );
    const unweighted = academyPackage();
    unweighted.grading.components = unweighted.grading.components.filter(
      (c: { componentKey: string }) => c.componentKey !== "QUIZ_1",
    );
    unweighted.grading.components[0].weightBp += 500;
    expect(codes(unweighted)).toContain("UNWEIGHTED_COMPONENT");
    // Graded labs without a rubric are valid only while LAB_RUBRICS is a
    // declared pending decision; nothing is filled in.
    const labs = academyPackage();
    labs.pendingDecisions = labs.pendingDecisions.filter(
      (d: { key: string }) => d.key !== "LAB_RUBRICS",
    );
    labs.grading.components = labs.grading.components.filter(
      (c: { source: string }) => c.source !== "LABS",
    );
    labs.grading.components[5].weightBp += 2000;
    expect(codes(labs)).toEqual(
      expect.arrayContaining([
        "MISSING_RUBRIC",
        "MISSING_MARKING_GUIDANCE",
        "UNWEIGHTED_COMPONENT",
      ]),
    );
    const duplicate = academyPackage();
    duplicate.pendingDecisions.push(duplicate.pendingDecisions[0]);
    expect(codes(duplicate)).toContain("DUPLICATE_KEY");
  });

  it("refuses free-text questions Academy delivery cannot grade deterministically", () => {
    const pkg = academyPackage();
    const q = pkg.curriculum.assessmentTemplates[0].questions[0];
    delete q.questionType;
    delete q.interaction;
    delete q.answerKey;
    expect(codes(pkg)).toContain("UNSUPPORTED_QUESTION_TYPE");
  });

  it("rejects infeasible formats and impossible minimum study days", () => {
    const pkg = academyPackage();
    pkg.deliveryFormats[0] = {
      formatId: "ACCELERATED_2W",
      sessionMinutes: 120,
      minStudyDaysPerWeek: 6,
      maxStudyDaysPerWeek: 7,
    };
    expect(errors(pkg)).toContainEqual(
      expect.objectContaining({
        code: "FORMAT_INFEASIBLE",
        path: "deliveryFormats[0]",
      }),
    );
    const min = academyPackage();
    min.deliveryFormats[4].minStudyDaysPerWeek = 1;
    expect(errors(min)).toContainEqual(
      expect.objectContaining({
        code: "FORMAT_INFEASIBLE",
        path: "deliveryFormats[4].minStudyDaysPerWeek",
      }),
    );
    const short = academyPackage();
    short.deliveryFormats[4].sessionMinutes = 60;
    expect(codes(short)).toContain("SESSION_TOO_SHORT");
  });

  it("requires matching embedded identity and a qualification disclaimer", () => {
    const pkg = academyPackage();
    pkg.curriculum.packageRevision = 9;
    expect(codes(pkg)).toContain("IDENTITY_MISMATCH");
    const d = academyPackage();
    d.course.qualificationPreparation.disclaimer = "short";
    expect(codes(d)).toContain("SCHEMA_INVALID");
  });
});

describe("deterministic planner", () => {
  const units: PlanUnit[] = [
    { kind: "LESSON", ref: "l1", minutes: 90 },
    { kind: "LAB", ref: "lab", minutes: 60 },
    { kind: "LESSON", ref: "l2", minutes: 150 },
    { kind: "REVISION", ref: "q", minutes: 30 },
    { kind: "ASSESSMENT", ref: "q", minutes: 45, minimumDaysAfterTeaching: 2 },
  ];

  it("splits lessons, keeps labs and assessments whole, and enforces preparation gaps", () => {
    const plan = planSchedule(
      units,
      { weeks: 1, sessionMinutes: 120 },
      { startDate: "2027-01-04", studyDays: [1, 2, 3, 4, 5, 6, 7] },
    );
    if (!plan.feasible) throw new Error();
    expect(
      plan.items.map((i) => [
        i.kind,
        i.part,
        i.parts,
        i.localDate,
        i.offsetMinutes,
        i.minutes,
      ]),
    ).toEqual([
      ["LESSON", 1, 1, "2027-01-04", 0, 90],
      ["LAB", 1, 1, "2027-01-05", 0, 60],
      ["LESSON", 1, 2, "2027-01-05", 60, 60],
      ["LESSON", 2, 2, "2027-01-06", 0, 90],
      ["REVISION", 1, 1, "2027-01-06", 90, 30],
      ["ASSESSMENT", 1, 1, "2027-01-08", 0, 45], // two days after the last lesson
    ]);
    expect(plan.finishDate).toBe("2027-01-08");
  });

  it("reports insufficient availability and suggests more days without applying them", () => {
    const availability = { startDate: "2027-01-04", studyDays: [1] };
    const plan = planSchedule(
      units,
      { weeks: 1, sessionMinutes: 120 },
      availability,
    );
    expect(plan).toMatchObject({
      feasible: false,
      code: "INSUFFICIENT_AVAILABILITY",
      availableSessions: 1,
    });
    const days = suggestStudyDays(
      units,
      { weeks: 1, sessionMinutes: 120, maxStudyDaysPerWeek: 7 },
      availability,
    )!;
    expect(
      planSchedule(
        units,
        { weeks: 1, sessionMinutes: 120 },
        { ...availability, studyDays: days },
      ).feasible,
    ).toBe(true);
    expect(availability.studyDays).toEqual([1]);
  });

  it("covers the full Security+ curriculum identically in every format", () => {
    const r = validateAcademyCoursePackage(academyPackage());
    if (!r.valid) throw new Error();
    const all = buildPlanUnits(r.package, r.curriculum);
    for (const f of r.review.formats) {
      const plan = planSchedule(
        all,
        { weeks: f.weeks, sessionMinutes: f.sessionMinutes },
        {
          startDate: "2027-02-01",
          studyDays: [1, 2, 3, 4, 5, 6, 7].slice(0, f.maxStudyDaysPerWeek),
        },
      );
      if (!plan.feasible) throw new Error(f.formatId);
      expect(plan.finishDate <= formatEndDate("2027-02-01", f.weeks)).toBe(
        true,
      );
      const minutes = (kind: string) =>
        plan.items
          .filter((i) => i.kind === kind)
          .reduce((n, i) => n + i.minutes, 0);
      expect([
        minutes("LESSON"),
        minutes("LAB"),
        minutes("ASSESSMENT"),
      ]).toEqual([2520, 720, 250]);
    }
  });
});
