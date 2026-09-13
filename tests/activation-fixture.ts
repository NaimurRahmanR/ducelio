import type { CoursePackage } from "@/domain/course-package";
function disabledRole() {
  return {
    enabled: false,
    modelProfileRef: null,
    instructionalNotes: null,
    capabilities: [],
    escalationPolicy: "NONE" as const,
  };
}

export function buildPackage(
  overrides: Partial<CoursePackage> = {},
): CoursePackage {
  return {
    schemaVersion: "COURSE_PACKAGE_V1",
    packageKey: "cyber-foundations-workflow",
    packageRevision: 1,
    programme: {
      title: "Cybersecurity Foundations",
      examinationBody: "Ducelio Academy",
      qualificationName: "Cybersecurity Foundations Certificate",
    },
    curriculumVersion: { label: "Workflow test edition" },
    modules: [
      {
        key: "module-1",
        title: "Security Principles",
        position: 1,
        lessons: [
          {
            key: "lesson-1",
            title: "Access Control",
            position: 1,
            objectives: [
              {
                key: "obj-1",
                description: "Explain authentication",
                position: 1,
              },
            ],
            resources: [
              {
                key: "res-1",
                kind: "LECTURE_NOTE",
                title: "Access control notes",
                body: "Authentication verifies identity.",
                url: null,
                position: 1,
              },
            ],
            practicalActivities: [],
          },
        ],
      },
    ],
    assignmentTemplates: [],
    assessmentTemplates: [
      {
        key: "assess-1",
        title: "Module 1 checkpoint",
        instructions: "Answer under exam conditions.",
        lessonRef: "lesson-1",
        durationMinutes: 30,
        attemptsAllowed: 1,
        questions: [
          {
            position: 1,
            prompt: "Define authentication.",
            maxMarks: 5,
            expectedAnswer: "The process of verifying identity.",
            markingGuidance: null,
            objectiveRefs: ["obj-1"],
          },
        ],
      },
    ],
    schedulingDefaults: {
      studyDays: [1, 3, 5],
      localStartTime: "19:00",
      timezone: "Europe/London",
    },
    agentConfiguration: {
      PROFESSOR: disabledRole(),
      TUTOR: disabledRole(),
      LAB_INSTRUCTOR: disabledRole(),
      EXAMINER: disabledRole(),
      COUNSELLOR: disabledRole(),
    },
    reason: "Workflow test package",
    ...overrides,
  };
}
