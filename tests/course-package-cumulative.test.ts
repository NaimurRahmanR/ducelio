import { describe, expect, it } from "vitest";
import {
  validateCoursePackage,
  type CoursePackage,
} from "@/domain/course-package";
import { buildPackage } from "./activation-fixture";
export function cumulativeFixture(): CoursePackage {
  const p = buildPackage();
  const lesson = structuredClone(p.modules[0].lessons[0]);
  lesson.key = "lesson-2";
  lesson.position = 2;
  // Reuse obj-1 deliberately: keys are scoped to a lesson, not the package.
  lesson.objectives[0].description = "Second lesson objective";
  lesson.objectives.push({
    key: "only-second",
    description: "Distinct second objective",
    position: 2,
  });
  p.modules[0].lessons.push(lesson);
  return p;
}
describe("cumulative V1 domain contract", () => {
  it("keeps old single-lesson packages unchanged", () => {
    const p = buildPackage();
    const result = validateCoursePackage(p);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.package).toEqual(p);
  });
  it("accepts explicit source lesson and reused local objective keys", () => {
    const p = cumulativeFixture();
    p.assessmentTemplates[0].questions[0].lessonRef = "lesson-2";
    expect(validateCoursePackage(p).valid).toBe(true);
  });
  it.each([
    "missing-source",
    "unknown-source",
    "wrong-objective",
    "duplicate",
    "null",
    "unknown-field",
  ])("rejects %s", (kind) => {
    const p = cumulativeFixture();
    const q = p.assessmentTemplates[0].questions[0];
    if (kind === "missing-source") q.objectiveRefs = ["only-second"];
    if (kind === "unknown-source") q.lessonRef = "missing";
    if (kind === "wrong-objective") {
      q.lessonRef = "lesson-1";
      q.objectiveRefs = ["only-second"];
    }
    if (kind === "duplicate") {
      q.lessonRef = "lesson-2";
      q.objectiveRefs = ["obj-1", "obj-1"];
    }
    if (kind === "null") Object.assign(q, { lessonRef: null });
    if (kind === "unknown-field") Object.assign(q, { arbitrary: true });
    expect(validateCoursePackage(p).valid).toBe(false);
  });
});
