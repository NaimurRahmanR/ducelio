import { describe, expect, it } from "vitest";
import {
  canonicalizeCoursePackage,
  canonicalizeJson,
  coursePackageSchema,
  validateCoursePackage,
  type CoursePackage,
} from "@/domain/course-package";

function disabledRole() {
  return {
    enabled: false,
    modelProfileRef: null,
    instructionalNotes: null,
    capabilities: [],
    escalationPolicy: "NONE" as const,
  };
}

function validPackage(): CoursePackage {
  return {
    schemaVersion: "COURSE_PACKAGE_V1",
    packageKey: "cyber-foundations",
    packageRevision: 1,
    programme: {
      title: "Cybersecurity Foundations",
      examinationBody: "Ducelio Academy",
      qualificationName: "Cybersecurity Foundations Certificate",
    },
    curriculumVersion: { label: "2026 Edition" },
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
              {
                key: "obj-2",
                description: "Explain authorisation",
                position: 2,
              },
            ],
            resources: [
              {
                key: "res-1",
                kind: "LECTURE_NOTE",
                title: "Access control notes",
                body: "Authentication verifies identity; authorisation grants access.",
                url: null,
                position: 1,
              },
            ],
            practicalActivities: [
              {
                key: "lab-1",
                kind: "PRACTICAL_LAB",
                title: "Configure RBAC",
                instructions:
                  "Configure role-based access control on the sample system.",
                position: 1,
                objectiveRefs: ["obj-2"],
              },
            ],
          },
        ],
      },
    ],
    assignmentTemplates: [
      {
        key: "assign-1",
        title: "Access control essay",
        instructions: "Write a short essay on access control models.",
        lessonRef: "lesson-1",
        objectiveRefs: ["obj-1"],
        rubric: [
          {
            description: "Covers authentication and authorisation",
            maxMarks: 10,
          },
        ],
      },
    ],
    assessmentTemplates: [
      {
        key: "assess-1",
        title: "Module 1 checkpoint",
        instructions: "Answer every question under exam conditions.",
        lessonRef: "lesson-1",
        durationMinutes: 30,
        attemptsAllowed: 1,
        questions: [
          {
            position: 1,
            prompt: "Define authentication.",
            maxMarks: 5,
            expectedAnswer: "The process of verifying identity.",
            markingGuidance: "Award full marks for identity verification.",
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
      PROFESSOR: {
        ...disabledRole(),
        enabled: true,
        capabilities: ["get_lesson_context", "get_lesson_objectives"],
      },
      TUTOR: disabledRole(),
      LAB_INSTRUCTOR: disabledRole(),
      EXAMINER: disabledRole(),
      COUNSELLOR: disabledRole(),
    },
    reason: "Reference cybersecurity course package for Commercial V1",
  };
}

describe("course package schema", () => {
  it("parses a well-formed package", () => {
    expect(() => coursePackageSchema.parse(validPackage())).not.toThrow();
  });

  it("rejects an unsupported schema version", () => {
    const pkg = { ...validPackage(), schemaVersion: "COURSE_PACKAGE_V2" };
    expect(coursePackageSchema.safeParse(pkg).success).toBe(false);
  });

  it("rejects a malformed package (wrong types)", () => {
    const pkg = { ...validPackage(), packageRevision: "one" };
    expect(coursePackageSchema.safeParse(pkg).success).toBe(false);
  });

  it("rejects missing required content (no modules)", () => {
    const pkg = { ...validPackage(), modules: [] };
    expect(coursePackageSchema.safeParse(pkg).success).toBe(false);
  });

  it("rejects a lesson with no objectives", () => {
    const pkg = validPackage();
    pkg.modules[0].lessons[0].objectives = [];
    expect(coursePackageSchema.safeParse(pkg).success).toBe(false);
  });
});

describe("validateCoursePackage", () => {
  it("accepts a valid package and reports counts", () => {
    const result = validateCoursePackage(validPackage());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.report.moduleCount).toBe(1);
      expect(result.report.lessonCount).toBe(1);
      expect(result.report.objectiveCount).toBe(2);
      expect(result.report.assignmentTemplateCount).toBe(1);
      expect(result.report.assessmentTemplateCount).toBe(1);
    }
  });

  it("fails closed on a malformed package", () => {
    const result = validateCoursePackage({ not: "a package" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects duplicate module keys", () => {
    const pkg = validPackage();
    pkg.modules.push({ ...pkg.modules[0], position: 2 });
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.errors.some((e) => e.code === "DUPLICATE_KEY")).toBe(true);
  });

  it("rejects duplicate objective keys within a lesson", () => {
    const pkg = validPackage();
    pkg.modules[0].lessons[0].objectives.push({
      key: "obj-1",
      description: "Duplicate key",
      position: 3,
    });
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(
        result.errors.some(
          (e) => e.code === "DUPLICATE_KEY" && e.path.includes("objectives"),
        ),
      ).toBe(true);
  });

  it("rejects an objective reference outside the referencing lesson", () => {
    const pkg = validPackage();
    pkg.modules[0].lessons[0].practicalActivities[0].objectiveRefs = [
      "does-not-exist",
    ];
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.errors.some((e) => e.code === "INVALID_REFERENCE")).toBe(
        true,
      );
  });

  it("rejects an assignment template referencing an unknown lesson", () => {
    const pkg = validPackage();
    pkg.assignmentTemplates[0].lessonRef = "unknown-lesson";
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.errors.some((e) => e.code === "INVALID_REFERENCE")).toBe(
        true,
      );
  });

  it("rejects an assessment template referencing an unknown lesson", () => {
    const pkg = validPackage();
    pkg.assessmentTemplates[0].lessonRef = "unknown-lesson";
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.errors.some((e) => e.code === "INVALID_REFERENCE")).toBe(
        true,
      );
  });

  it("rejects an assessment question objective reference outside its lesson", () => {
    const pkg = validPackage();
    pkg.assessmentTemplates[0].questions[0].objectiveRefs = ["unknown-obj"];
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.errors.some((e) => e.code === "INVALID_REFERENCE")).toBe(
        true,
      );
  });

  it("rejects duplicate assessment question positions", () => {
    const pkg = validPackage();
    pkg.assessmentTemplates[0].questions.push({
      ...pkg.assessmentTemplates[0].questions[0],
      prompt: "Another question",
    });
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.errors.some((e) => e.code === "DUPLICATE_POSITION")).toBe(
        true,
      );
  });

  it("rejects duplicate module positions", () => {
    const pkg = validPackage();
    pkg.modules.push({
      ...pkg.modules[0],
      key: "module-2",
      lessons: pkg.modules[0].lessons.map((l) => ({ ...l, key: "lesson-2" })),
    });
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(
        result.errors.some(
          (e) =>
            e.code === "DUPLICATE_POSITION" && e.path.startsWith("modules"),
        ),
      ).toBe(true);
  });

  it("rejects duplicate resource keys within a lesson", () => {
    const pkg = validPackage();
    pkg.modules[0].lessons[0].resources.push({
      ...pkg.modules[0].lessons[0].resources[0],
      position: 2,
    });
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(
        result.errors.some(
          (e) => e.code === "DUPLICATE_KEY" && e.path.includes("resources"),
        ),
      ).toBe(true);
  });

  it("rejects duplicate practical-activity keys within a lesson", () => {
    const pkg = validPackage();
    pkg.modules[0].lessons[0].practicalActivities.push({
      ...pkg.modules[0].lessons[0].practicalActivities[0],
      position: 2,
    });
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(
        result.errors.some(
          (e) =>
            e.code === "DUPLICATE_KEY" &&
            e.path.includes("practicalActivities"),
        ),
      ).toBe(true);
  });

  it("rejects a duplicate reference inside one objectiveRefs array", () => {
    const pkg = validPackage();
    pkg.modules[0].lessons[0].practicalActivities[0].objectiveRefs = [
      "obj-1",
      "obj-1",
    ];
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.errors.some((e) => e.code === "DUPLICATE_REFERENCE")).toBe(
        true,
      );
  });

  it("rejects an unrecognised IANA timezone in scheduling defaults", () => {
    const pkg = validPackage();
    pkg.schedulingDefaults.timezone = "Not/A_Real_Zone";
    expect(coursePackageSchema.safeParse(pkg).success).toBe(false);
  });

  it("rejects a capability outside a role's reviewed catalogue in agentConfiguration", () => {
    const pkg = validPackage();
    pkg.agentConfiguration.COUNSELLOR = {
      enabled: true,
      modelProfileRef: null,
      instructionalNotes: null,
      capabilities: ["get_current_mastery_state"],
      escalationPolicy: "NONE",
    };
    expect(coursePackageSchema.safeParse(pkg).success).toBe(false);
  });

  it("exposes the validated package only through a successful validation result", () => {
    const result = validateCoursePackage(validPackage());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.package.packageKey).toBe("cyber-foundations");
    }
  });

  it("no longer exports a cast-based validated-package escape hatch", async () => {
    const moduleExports = await import("@/domain/course-package");
    expect(Object.keys(moduleExports)).not.toContain(
      "asValidatedCoursePackage",
    );
  });
});

function reorderKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeysDeep);
  if (value !== null && typeof value === "object") {
    const reversedKeys = Object.keys(value as Record<string, unknown>)
      .slice()
      .reverse();
    const result: Record<string, unknown> = {};
    for (const key of reversedKeys)
      result[key] = reorderKeysDeep((value as Record<string, unknown>)[key]);
    return result;
  }
  return value;
}

describe("canonicalisation and content hashing", () => {
  it("is independent of input key order", () => {
    const pkg = validPackage();
    const reordered = reorderKeysDeep(pkg);
    expect(canonicalizeCoursePackage(pkg)).toBe(
      JSON.stringify(canonicalizeJson(reordered)),
    );
  });

  it("produces a deterministic string for the same content", () => {
    const a = canonicalizeCoursePackage(validPackage());
    const b = canonicalizeCoursePackage(validPackage());
    expect(a).toBe(b);
  });

  it("changes when content changes", () => {
    const a = canonicalizeCoursePackage(validPackage());
    const changed = validPackage();
    changed.modules[0].title = "Changed title";
    const b = canonicalizeCoursePackage(changed);
    expect(a).not.toBe(b);
  });
});
