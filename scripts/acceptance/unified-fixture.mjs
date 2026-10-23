// A completely new, labelled synthetic course. No AWS/Security+ package is
// read, copied or adopted. Reuse only the existing acceptance constructor and
// reviewed agent configurations; never call its retired cohort seeding path.
import { buildAcceptancePackage } from "./fixtures.mjs";

export function buildUnifiedAcceptancePackage(runId) {
  const curriculum = buildAcceptancePackage(`unified-${runId}`, {
    journeyAgents: true,
    assessmentDurationMinutes: 1,
  });
  curriculum.programme.title = `TEST ONLY Unified ${runId}`;
  curriculum.programme.qualificationName = "Synthetic test; no qualification";
  for (const assessment of curriculum.assessmentTemplates) {
    Object.assign(assessment.questions[0], {
      questionType: "SINGLE_SELECT",
      interaction: {
        options: [
          { id: "a", label: "Synthetic choice A" },
          { id: "b", label: "Synthetic choice B" },
        ],
      },
      answerKey: { correctOptionId: "a" },
    });
  }
  return {
    schemaVersion: "ACADEMY_COURSE_PACKAGE_V1",
    packageKey: curriculum.packageKey,
    packageRevision: 1,
    course: {
      description:
        "TEST ONLY: synthetic acceptance course, not a real qualification.",
      qualificationPreparation: null,
      sourceReferences: [
        {
          key: "synthetic-source",
          title: "Synthetic acceptance specification",
          publisher: "Ducelio acceptance tooling",
          version: "1",
          url: null,
          note: "Invented test content only; no official examination content.",
        },
      ],
      academicPolicies: [],
      demoContent: true,
    },
    curriculum,
    workload: {
      lessons: [
        {
          lessonRef: "lesson-1",
          teachingMinutes: 10,
          prerequisiteLessonRefs: [],
        },
      ],
    },
    labs: [
      {
        activityRef: "lab-1",
        durationMinutes: 10,
        graded: false,
        rubric: [],
        markingGuidance: null,
      },
    ],
    assessments: curriculum.assessmentTemplates.map((a) => ({
      templateRef: a.key,
      componentKey: a.key.toUpperCase(),
      kind:
        a.key === "midterm" ? "MIDTERM" : a.key === "final" ? "FINAL" : "QUIZ",
      afterLessonRef: "lesson-1",
      requiredLessonRefs: ["lesson-1"],
      preparation: {
        revisionMinutes: ["midterm", "final"].includes(a.key) ? 1 : 0,
        minimumDaysAfterTeaching: 0,
      },
      sittingWindowHours: 24,
      passMarkBp: 5000,
      attemptScoring: "HIGHEST",
    })),
    grading: {
      components: curriculum.assessmentTemplates.map((a) => ({
        componentKey: a.key.toUpperCase(),
        source: "ASSESSMENT",
        weightBp: a.key === "final" ? 5000 : a.key === "midterm" ? 3000 : 500,
      })),
    },
    completion: { coursePassMarkBp: 5000, requireEveryComponentPassMark: true },
    deliveryFormats: [
      "ACCELERATED_2W",
      "INTENSIVE_4W",
      "STANDARD_6W",
      "EXTENDED_8W",
      "FLEXIBLE_12W",
    ].map((formatId) => ({
      formatId,
      sessionMinutes: 120,
      minStudyDaysPerWeek: 1,
      maxStudyDaysPerWeek: 7,
    })),
    pendingDecisions: [],
    reason: `TEST ONLY unified acceptance ${runId}`,
  };
}
