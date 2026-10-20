import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { assessmentCardSelector } from "../scripts/acceptance/exam-engine-browser.mjs";
import {
  reviewPageContainsLockedMark,
  classifyExamEngineSurfaceFailure,
  surface,
} from "../scripts/acceptance/exam-engine.mjs";

const MAIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVIEW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TITLE = "QUIZ_1 acceptance checkpoint";

function syntheticCard(id: string) {
  return {
    querySelector(selector: string) {
      if (selector === 'input[name="assessmentId"]') return { value: id };
      if (selector === "h3") return { textContent: TITLE };
      return null;
    },
  };
}

describe("A2S root-cause guards: distinct synthetic assessments", () => {
  it("selects the exact main assessment UUID even when the review card has the same title and appears first", () => {
    const review = syntheticCard(REVIEW);
    const main = syntheticCard(MAIN);
    const expression = assessmentCardSelector(MAIN, TITLE);
    const selected = runInNewContext(expression, {
      document: { querySelectorAll: () => [review, main] },
    });
    expect(selected).toBe(main);
  });

  it("fails closed when only the identically titled review assessment is visible", () => {
    const review = syntheticCard(REVIEW);
    const expression = assessmentCardSelector(MAIN, TITLE);
    expect(
      runInNewContext(expression, {
        document: { querySelectorAll: () => [review] },
      }),
    ).toBeUndefined();
  });

  it("the real browser execution path is pinned to the main assessment and uses the implicit-submit form button", () => {
    const source = readFileSync("scripts/acceptance/exam-engine.mjs", "utf8");
    expect(source).toContain("assessmentCardSelector(ids.QUIZ_1, title)");
    expect(source).toContain(
      "page.click(`${card}.querySelector('form button')`)",
    );
    expect(source).not.toContain(
      "const card = `[...document.querySelectorAll('.support-record')].find",
    );
  });
});

describe("A2S review rendering and safe diagnostics", () => {
  it("accepts React SSR comment boundaries between JSX text fragments", () => {
    const html =
      '<p class="muted">Deterministic mark: <!-- -->2<!-- --> of <!-- -->2<!-- -->. Scored by rule.</p>';
    expect(reviewPageContainsLockedMark(html, 2, 2)).toBe(true);
    expect(reviewPageContainsLockedMark(html, 0, 2)).toBe(false);
    expect(reviewPageContainsLockedMark(html, 2, 3)).toBe(false);
    expect(
      reviewPageContainsLockedMark("<p>Other review field</p>", 2, 2),
    ).toBe(false);
  });

  it("never serializes upstream error text in a failed surface", async () => {
    const classified = classifyExamEngineSurfaceFailure(
      new Error("start_assessment_attempt was refused."),
    );
    expect(classified).toBe("ATTEMPT_START_REFUSED");
    const result = await surface("CP2:BROWSER_EXAM", async () => {
      throw new Error("private-token=never-emit-this");
    });
    expect(result.status).toBe("FAIL");
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(result.details).toEqual(["Failure class: SURFACE_EXCEPTION"]);
  });
});
