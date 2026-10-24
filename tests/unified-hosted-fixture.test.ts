import { expect, it } from "vitest";
import { buildUnifiedAcceptancePackage } from "../scripts/acceptance/unified-fixture.mjs";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";

it("validates a new labelled synthetic course with all five feasible durations", () => {
  const raw = buildUnifiedAcceptancePackage("fixture-contract");
  const checked = validateAcademyCoursePackage(raw);
  expect(checked.valid ? [] : checked.errors).toEqual([]);
  if (!checked.valid) throw new Error("Synthetic fixture invalid");
  expect(checked.review.formats.map((f) => f.weeks)).toEqual([2, 4, 6, 8, 12]);
  expect(checked.review.demoContent).toBe(true);
  expect(checked.review.pendingDecisions).toEqual([]);
  expect(checked.review.totals.lessons).toBe(1);
  expect(checked.review.totals.labMinutes).toBe(10);
  expect(checked.review.totals.revisionMinutes).toBe(2);
  expect(checked.review.totals.assessmentMinutes).toBe(6);
});
