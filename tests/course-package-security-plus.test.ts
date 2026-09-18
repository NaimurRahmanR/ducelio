import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  coursePackageSchema,
  validateCoursePackage,
  type CoursePackage,
} from "@/domain/course-package";
import { agentRoleSchema } from "@/domain/academic-capability-policy";
import {
  MAX_COURSE_UPLOAD_BYTES,
  operatorPreviewSchema,
} from "@/domain/course-engineering-admin";
import { validateRoleModelProfileRef } from "@/domain/academic-runtime-profile";

// SEC701-A: the first real commercial course package foundation --
// CompTIA Security+ SY0-701 exam preparation. This file exercises the
// package purely through the existing domain layer (validateCoursePackage,
// operatorPreviewSchema); it never touches the database, mirroring
// tests/course-package.test.ts's own pure-domain style. See
// content/courses/security-plus-sy0-701/README.md for the OFFICIAL FACT /
// DUCELIO DESIGN provenance boundary this package follows.

const PACKAGE_DIR = resolve("content/courses/security-plus-sy0-701");

const rawPackageText = readFileSync(
  resolve(PACKAGE_DIR, "package.json"),
  "utf8",
);
const rawCoverageText = readFileSync(
  resolve(PACKAGE_DIR, "objective-coverage.json"),
  "utf8",
);
const rawSourcesText = readFileSync(
  resolve(PACKAGE_DIR, "sources.json"),
  "utf8",
);
const rawBreadthAuditText = readFileSync(
  resolve(PACKAGE_DIR, "objective-breadth-audit.json"),
  "utf8",
);

type ObjectiveCoverage = {
  schemaVersion: string;
  packageKey: string;
  packageRevision: number;
  source: { publisher: string; examCode: string; documentVersion: string };
  totalDomains: number;
  totalOfficialObjectives: number;
  totalWeightPercent: number;
  domains: {
    domainId: string;
    weightPercent: number;
    ducelioModuleRef: string;
  }[];
  objectives: {
    officialObjectiveId: string;
    domainId: string;
    ducelioModuleRef: string;
    ducelioLessonRef: string;
  }[];
};

type SourcesRegistry = {
  schemaVersion: string;
  packageKey: string;
  sources: {
    sourceId: string;
    publisher: string;
    title: string;
    examCode: string;
    documentVersion: string;
    sourceType: string;
    url: string;
    retrievedAt: string;
    notes: string;
  }[];
};

// Official, independently verified exam blueprint facts (checkpoint brief),
// reproduced here only as small identifiers/numbers for test assertions --
// never as copied objective prose.
const OFFICIAL_DOMAIN_WEIGHTS: Record<string, number> = {
  "1": 12,
  "2": 22,
  "3": 18,
  "4": 28,
  "5": 20,
};
const OFFICIAL_OBJECTIVE_RANGES: Record<string, number> = {
  "1": 4,
  "2": 5,
  "3": 4,
  "4": 9,
  "5": 6,
};
function expectedOfficialObjectiveIds(): Set<string> {
  const ids = new Set<string>();
  for (const [domainId, count] of Object.entries(OFFICIAL_OBJECTIVE_RANGES)) {
    for (let n = 1; n <= count; n++) ids.add(`${domainId}.${n}`);
  }
  return ids;
}

describe("Security+ SY0-701 package: parsing and schema identity", () => {
  it("1. package.json parses as JSON", () => {
    expect(() => JSON.parse(rawPackageText)).not.toThrow();
  });

  it("2. validateCoursePackage returns valid=true", () => {
    const parsed = JSON.parse(rawPackageText);
    const result = validateCoursePackage(parsed);
    if (!result.valid) {
      throw new Error(
        `Security+ package failed validation: ${JSON.stringify(result.errors, null, 2)}`,
      );
    }
    expect(result.valid).toBe(true);
  });

  it("3. schemaVersion is COURSE_PACKAGE_V1", () => {
    const parsed = JSON.parse(rawPackageText) as CoursePackage;
    expect(parsed.schemaVersion).toBe("COURSE_PACKAGE_V1");
  });

  it("4. packageKey is security-plus-sy0-701", () => {
    const parsed = JSON.parse(rawPackageText) as CoursePackage;
    expect(parsed.packageKey).toBe("security-plus-sy0-701");
  });
});

describe("Security+ SY0-701 package: structure counts", () => {
  const pkg = JSON.parse(rawPackageText) as CoursePackage;

  it("5. exactly five modules exist", () => {
    expect(pkg.modules).toHaveLength(5);
  });

  it("6. exactly 28 principal lessons exist", () => {
    const lessonCount = pkg.modules.reduce((n, m) => n + m.lessons.length, 0);
    expect(lessonCount).toBe(28);
  });

  it("module lesson counts match the official per-domain objective counts (4/5/4/9/6)", () => {
    const counts = pkg.modules.map((m) => m.lessons.length);
    expect(counts).toEqual([4, 5, 4, 9, 6]);
  });
});

describe("Security+ SY0-701 package: official objective coverage", () => {
  const coverage = JSON.parse(rawCoverageText) as ObjectiveCoverage;

  it("7. official domain weight map is exactly 12/22/18/28/20", () => {
    const weightsByDomain = Object.fromEntries(
      coverage.domains.map((d) => [d.domainId, d.weightPercent]),
    );
    expect(weightsByDomain).toEqual(OFFICIAL_DOMAIN_WEIGHTS);
  });

  it("8. official weights sum to 100", () => {
    const total = coverage.domains.reduce((n, d) => n + d.weightPercent, 0);
    expect(total).toBe(100);
    expect(coverage.totalWeightPercent).toBe(100);
  });

  it("coverage metadata is bound to the current package revision", () => {
    const pkg = JSON.parse(rawPackageText) as CoursePackage;
    expect(coverage.packageKey).toBe(pkg.packageKey);
    expect(coverage.packageRevision).toBe(pkg.packageRevision);
  });

  it("9. all 28 official objective IDs are present exactly once", () => {
    const ids = coverage.objectives.map((o) => o.officialObjectiveId);
    expect(ids).toHaveLength(28);
    expect(new Set(ids).size).toBe(28);
    expect(new Set(ids)).toEqual(expectedOfficialObjectiveIds());
  });

  it("10. no unexpected objective ID exists", () => {
    const expected = expectedOfficialObjectiveIds();
    for (const o of coverage.objectives) {
      expect(expected.has(o.officialObjectiveId)).toBe(true);
    }
  });

  it("11. every objective-coverage Ducelio lesson ref resolves to a real package lesson", () => {
    const pkg = JSON.parse(rawPackageText) as CoursePackage;
    const realLessonKeys = new Set(
      pkg.modules.flatMap((m) => m.lessons.map((l) => l.key)),
    );
    const realModuleKeys = new Set(pkg.modules.map((m) => m.key));
    for (const o of coverage.objectives) {
      expect(realLessonKeys.has(o.ducelioLessonRef)).toBe(true);
      expect(realModuleKeys.has(o.ducelioModuleRef)).toBe(true);
    }
  });

  it("each official domain maps to a real package module, and each objective's module matches its lesson's owning module", () => {
    const pkg = JSON.parse(rawPackageText) as CoursePackage;
    const realModuleKeys = new Set(pkg.modules.map((m) => m.key));
    for (const d of coverage.domains) {
      expect(realModuleKeys.has(d.ducelioModuleRef)).toBe(true);
    }
    const moduleByLesson = new Map<string, string>();
    for (const m of pkg.modules)
      for (const l of m.lessons) moduleByLesson.set(l.key, m.key);
    for (const o of coverage.objectives) {
      expect(moduleByLesson.get(o.ducelioLessonRef)).toBe(o.ducelioModuleRef);
    }
  });
});

describe("Security+ SY0-701 package: five-role configuration", () => {
  const pkg = JSON.parse(rawPackageText) as CoursePackage;

  it("12. all exact five agent roles exist", () => {
    expect(Object.keys(pkg.agentConfiguration).sort()).toEqual(
      [...agentRoleSchema.options].sort(),
    );
  });

  it("13. role modelProfileRef policy remains valid for every role", () => {
    for (const role of agentRoleSchema.options) {
      const config = pkg.agentConfiguration[role];
      const result = validateRoleModelProfileRef(
        role,
        config.modelProfileRef,
        config.enabled,
      );
      expect(result.ok).toBe(true);
    }
  });

  it("COUNSELLOR remains non-provider-backed (modelProfileRef is null)", () => {
    expect(pkg.agentConfiguration.COUNSELLOR.modelProfileRef).toBeNull();
  });

  it("PROFESSOR is enabled with the exact PROFESSOR_COMMERCIAL_V1 profile", () => {
    expect(pkg.agentConfiguration.PROFESSOR.enabled).toBe(true);
    expect(pkg.agentConfiguration.PROFESSOR.modelProfileRef).toBe(
      "PROFESSOR_COMMERCIAL_V1",
    );
  });

  it("EXAMINER requests exactly its two real grading capabilities", () => {
    expect([...pkg.agentConfiguration.EXAMINER.capabilities].sort()).toEqual(
      ["grade_controlled_assessment", "grade_practical_lab"].sort(),
    );
  });
});

describe("SEC701-C official-objective breadth audit", () => {
  const pkg = JSON.parse(rawPackageText) as CoursePackage;
  const audit = JSON.parse(rawBreadthAuditText) as {
    schemaVersion: string;
    packageKey: string;
    packageRevision: number;
    source: { publisher: string; examCode: string; documentVersion: string };
    objectives: {
      officialObjectiveId: string;
      ducelioLessonRef: string;
      terms: string[];
    }[];
  };

  it("binds all 28 official objective ids exactly once to the current package revision", () => {
    expect(audit.schemaVersion).toBe("SECURITY_PLUS_BREADTH_AUDIT_V1");
    expect(audit.packageKey).toBe(pkg.packageKey);
    expect(audit.packageRevision).toBe(pkg.packageRevision);
    expect(audit.source).toEqual({
      publisher: "CompTIA",
      examCode: "SY0-701",
      documentVersion: "5.0",
    });
    expect(audit.objectives).toHaveLength(28);
    expect(new Set(audit.objectives.map((o) => o.officialObjectiveId))).toEqual(
      expectedOfficialObjectiveIds(),
    );
  });

  it("requires representative v5.0 breadth terms to be present in each learner study guide", () => {
    const lessonByKey = new Map(
      pkg.modules.flatMap((module) =>
        module.lessons.map((lesson) => [lesson.key, lesson] as const),
      ),
    );
    for (const objective of audit.objectives) {
      expect(
        objective.terms.length,
        objective.officialObjectiveId,
      ).toBeGreaterThanOrEqual(8);
      const lesson = lessonByKey.get(objective.ducelioLessonRef);
      expect(lesson, objective.ducelioLessonRef).toBeDefined();
      const body = lesson!.resources
        .filter((resource) => resource.kind === "LECTURE_NOTE" && resource.body)
        .map((resource) => resource.body)
        .join("\n")
        .toLowerCase();
      for (const term of objective.terms)
        expect(body, `${objective.officialObjectiveId}: ${term}`).toContain(
          term.toLowerCase(),
        );
    }
  });
});

describe("SEC701-C customer-grade teaching depth", () => {
  const pkg = JSON.parse(rawPackageText) as CoursePackage;
  const wordCount = (value: string) =>
    value.trim().split(/\\s+/).filter(Boolean).length;

  it("every principal lesson has at least one substantial embedded lecture note", () => {
    for (const module of pkg.modules) {
      for (const lesson of module.lessons) {
        const bodies = lesson.resources
          .filter((resource) => resource.kind === "LECTURE_NOTE")
          .map((resource) => resource.body ?? "")
          .filter(Boolean);
        expect(bodies.length, lesson.key).toBeGreaterThan(0);
        expect(
          bodies.reduce((sum, body) => sum + wordCount(body), 0),
          lesson.key,
        ).toBeGreaterThanOrEqual(300);
      }
    }
  });

  it("ships at least ten thousand words of embedded learner-facing teaching material", () => {
    const total = pkg.modules
      .flatMap((module) => module.lessons)
      .flatMap((lesson) => lesson.resources)
      .filter((resource) => resource.kind === "LECTURE_NOTE" && resource.body)
      .reduce((sum, resource) => sum + wordCount(resource.body!), 0);
    expect(total).toBeGreaterThanOrEqual(10_000);
  });

  it("no lesson depends on an external reference as its only teaching material", () => {
    for (const module of pkg.modules)
      for (const lesson of module.lessons)
        expect(
          lesson.resources.some(
            (resource) => resource.kind === "LECTURE_NOTE" && resource.body,
          ),
          lesson.key,
        ).toBe(true);
  });
});

describe("Security+ SY0-701 package: practical/lab and assessment content", () => {
  const pkg = JSON.parse(rawPackageText) as CoursePackage;
  const allActivities = pkg.modules.flatMap((m) =>
    m.lessons.flatMap((l) => l.practicalActivities),
  );

  it("14. package contains at least one PRACTICAL_LAB", () => {
    const labs = allActivities.filter((a) => a.kind === "PRACTICAL_LAB");
    expect(labs.length).toBeGreaterThan(0);
  });

  it("15. package contains controlled assessments", () => {
    expect(pkg.assessmentTemplates.length).toBeGreaterThan(0);
    const totalQuestions = pkg.assessmentTemplates.reduce(
      (n, a) => n + a.questions.length,
      0,
    );
    expect(totalQuestions).toBeGreaterThan(0);
  });

  it("controlled assessments cover the six existing Commercial V1 formal components one-for-one", () => {
    // src/domain/commercial-v1-assessment-policy.ts's six formal components
    // (QUIZ_1/QUIZ_2/MIDTERM/QUIZ_3/QUIZ_4/FINAL) -- this package proposes
    // exactly one assessment template per component so a later admin can
    // bind them 1:1 via bind_commercial_v1_assessment_component. Binding
    // itself remains a separate, governed, post-activation action this
    // package does not perform.
    expect(pkg.assessmentTemplates).toHaveLength(6);
  });
});

describe("Security+ SY0-701 package: full cross-reference validation", () => {
  it("16. every assignment/assessment/practical objective reference is valid through normal package validation", () => {
    const parsed = JSON.parse(rawPackageText);
    const result = validateCoursePackage(parsed);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.report.assignmentTemplateCount).toBe(3);
      expect(result.report.assessmentTemplateCount).toBe(6);
      expect(result.report.practicalActivityCount).toBeGreaterThan(0);
    }
  });
});

describe("Security+ SY0-701 package: protected content stays behind the assessment firewall", () => {
  it("17. protected expectedAnswer/markingGuidance are not present in the operator preview projection", () => {
    const parsed = coursePackageSchema.parse(JSON.parse(rawPackageText));
    const preview = operatorPreviewSchema.parse(parsed);
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain("expectedAnswer");
    expect(serialized).not.toContain("markingGuidance");
    // Spot-check one real, distinctive answer string from this package's own
    // content never leaks through the preview projection.
    expect(serialized).not.toContain(
      "Integrity protects against unauthorised or accidental modification",
    );
    for (const template of preview.assessmentTemplates) {
      expect(template).not.toHaveProperty("questions");
      expect(template).toHaveProperty("questionCount");
      expect(template).toHaveProperty("totalMarks");
    }
  });
});

describe("Security+ SY0-701 package: size bound", () => {
  it("18. serialized package size is strictly <= 512 KiB", () => {
    const byteLength = Buffer.byteLength(rawPackageText, "utf8");
    expect(byteLength).toBeLessThanOrEqual(MAX_COURSE_UPLOAD_BYTES);
    expect(MAX_COURSE_UPLOAD_BYTES).toBe(512 * 1024);
  });
});

describe("Security+ SY0-701 package: source provenance registry", () => {
  const sources = JSON.parse(rawSourcesText) as SourcesRegistry;

  // The exact, independently verified CompTIA-hosted objectives PDF this
  // package's provenance record must point to (review correction pass) --
  // not a generic certification landing page and not an unofficial mirror.
  const OFFICIAL_OBJECTIVES_PDF_URL =
    "https://assets.ctfassets.net/82ripq7fjls2/6TYWUym0Nudqa8nGEnegjG/0f9b974d3b1837fe85ab8e6553f4d623/CompTIA-Security-Plus-SY0-701-Exam-Objectives.pdf";

  it("19. source registry contains CompTIA + SY0-701 + document version 5.0 metadata", () => {
    expect(sources.sources.length).toBeGreaterThan(0);
    const official = sources.sources.find(
      (s) => s.publisher === "CompTIA" && s.examCode === "SY0-701",
    );
    expect(official).toBeDefined();
    expect(official?.documentVersion).toBe("5.0");
    expect(official?.url.startsWith("https://")).toBe(true);
    expect(official?.retrievedAt).toBe("2026-09-17");
  });

  it("19b. the official source record is the exact versioned CompTIA-hosted objectives PDF, not a generic page or mirror", () => {
    const official = sources.sources.find(
      (s) => s.publisher === "CompTIA" && s.examCode === "SY0-701",
    );
    expect(official?.sourceType).toBe("OFFICIAL_EXAM_OBJECTIVES");
    expect(official?.url).toBe(OFFICIAL_OBJECTIVES_PDF_URL);
  });

  it("20. source registry does not contain large copied objective/source bodies", () => {
    // A provenance record, not a mirror of the source document: every field
    // stays well under any plausible copied-paragraph length, and the whole
    // registry file itself stays small.
    for (const s of sources.sources) {
      for (const [field, value] of Object.entries(s)) {
        if (typeof value === "string") {
          expect(value.length, `${field} is unexpectedly long`).toBeLessThan(
            1000,
          );
        }
      }
    }
    expect(Buffer.byteLength(rawSourcesText, "utf8")).toBeLessThan(10 * 1024);
  });
});

describe("Security+ SY0-701 package: institutional design constraints", () => {
  const pkg = JSON.parse(rawPackageText) as CoursePackage;

  it("does not invent a Counsellor provider-execution path", () => {
    expect(pkg.agentConfiguration.COUNSELLOR.modelProfileRef).toBeNull();
  });

  it("selects capabilities only from the existing reviewed per-role allowlist (enforced by validateCoursePackage)", () => {
    // isCapabilityAuthorized/roleCapabilityCatalogue membership is already
    // proven by validateCoursePackage's own superRefine over
    // agentConfigurationSchema (src/domain/course-package.ts); this is a
    // direct regression should that wiring ever be removed.
    const result = validateCoursePackage(JSON.parse(rawPackageText));
    expect(result.valid).toBe(true);
  });

  it("scheduling defaults are descriptive metadata within the existing schema bounds", () => {
    expect(pkg.schedulingDefaults.studyDays.length).toBeGreaterThanOrEqual(1);
    expect(pkg.schedulingDefaults.localStartTime).toMatch(/^\d{2}:\d{2}$/);
  });

  it("curriculum version label identifies the exact exam/objectives version, not an unbounded 'latest'", () => {
    expect(pkg.curriculumVersion.label.toLowerCase()).not.toContain("latest");
    expect(pkg.curriculumVersion.label.toLowerCase()).not.toContain("current");
    expect(pkg.curriculumVersion.label).toContain("SY0-701");
  });

  it("qualification name makes clear this is preparation, not a Ducelio-issued CompTIA certification", () => {
    const q = pkg.programme.qualificationName.toLowerCase();
    expect(q).toContain("preparation");
  });
});

describe("SEC701-C revision 3 cumulative final", () => {
  const pkg = coursePackageSchema.parse(JSON.parse(rawPackageText));
  const final = pkg.assessmentTemplates.find((t) => t.key === "final")!;
  it("is revision 3 with a comprehensive ten-question final and end-of-course anchor", () => {
    expect(pkg.packageRevision).toBe(3);
    expect(final.title).toBe(
      "Final Assessment: Comprehensive Security+ Preparation Checkpoint",
    );
    expect(final.lessonRef).toBe("lesson-5-6");
    expect(final.questions).toHaveLength(10);
  });
  it("explicitly maps two questions per module across ten actual lessons", () => {
    const domains: Record<string, number> = {};
    for (const q of final.questions) {
      expect(q.lessonRef).toBeDefined();
      const courseModule = pkg.modules.find((m) =>
        m.lessons.some((l) => l.key === q.lessonRef),
      );
      expect(courseModule).toBeDefined();
      const lesson = courseModule!.lessons.find((l) => l.key === q.lessonRef)!;
      domains[courseModule!.key] = (domains[courseModule!.key] ?? 0) + 1;
      for (const ref of q.objectiveRefs)
        expect(lesson.objectives.some((o) => o.key === ref)).toBe(true);
    }
    expect(Object.values(domains)).toEqual([2, 2, 2, 2, 2]);
    expect(new Set(final.questions.map((q) => q.lessonRef)).size).toBe(10);
  });
  it("removes every final protected field and prompt from operator projection", () => {
    const safe = JSON.stringify(operatorPreviewSchema.parse(pkg));
    for (const q of final.questions) {
      expect(safe).not.toContain(q.expectedAnswer);
      expect(safe).not.toContain(q.markingGuidance!);
      expect(safe).not.toContain(q.prompt);
    }
  });
});
