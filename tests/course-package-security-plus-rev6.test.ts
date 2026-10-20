import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCoursePackage } from "@/domain/course-package";

const path = resolve(
  "content/courses/security-plus-sy0-701/ducelio-upload-rev6-six-assessments.json",
);
const bytes = readFileSync(path);
const pkg = JSON.parse(bytes.toString("utf8"));

describe("Security+ revision 6 upload contract", () => {
  it("passes the real Course Engineering domain validator", () => {
    const result = validateCoursePackage(pkg);
    if (!result.valid) {
      throw new Error(
        `Invalid revision 6 paths: ${JSON.stringify(result.errors.map(({ path, code, message }) => ({ path, code, message })).slice(0, 60))}`,
      );
    }
    expect(result.valid).toBe(true);
  });

  it("preserves the six-assessment 220-question contract and upload size", () => {
    expect(pkg.schemaVersion).toBe("COURSE_PACKAGE_V1");
    expect(pkg.packageKey).toBe("security-plus-sy0-701");
    expect(pkg.packageRevision).toBe(6);
    expect(pkg.modules).toHaveLength(5);
    expect(
      pkg.modules.flatMap((m: { lessons: unknown[] }) => m.lessons),
    ).toHaveLength(28);
    expect(
      pkg.assessmentTemplates.map(
        (a: { questions: unknown[] }) => a.questions.length,
      ),
    ).toEqual([20, 20, 50, 20, 20, 90]);
    expect(pkg.reason.length).toBeLessThanOrEqual(300);
    expect(bytes.length).toBeLessThanOrEqual(512 * 1024);
  });
});
