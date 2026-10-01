import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function functionSource(source: string, name: string) {
  const start = source.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

const lessonProgress = functionSource(
  readFileSync("src/server/lesson-progress.ts", "utf8"),
  "getStudentLessonProgress",
);
const learningResources = functionSource(
  readFileSync("src/server/learning-resources.ts", "utf8"),
  "getStudentLearningResources",
);
const objectiveMastery = functionSource(
  readFileSync("src/server/objective-mastery.ts", "utf8"),
  "getStudentObjectiveMastery",
);

describe("hosted student PostgREST projection regressions", () => {
  it("traverses lesson_progress to lessons through lesson_segments", () => {
    expect(lessonProgress).toContain(
      "lesson_segments(title,position,lessons(title))",
    );
    expect(lessonProgress).not.toContain(
      "lesson_segments(title,position),lessons(title)",
    );
  });

  it("reads learning-resource programme versions separately by their visible version ids", () => {
    expect(learningResources).toContain(
      "id,lesson_id,programme_version_id,kind,title,body,url,position,lessons(title)",
    );
    expect(learningResources).not.toContain(
      "lessons(title),programme_versions(label,title_snapshot)",
    );
    expect(learningResources).toContain('.from("programme_versions")');
    expect(learningResources).toContain('.in("id", versionIds)');
  });

  it("traverses objective_mastery to lessons through lesson_objectives", () => {
    expect(objectiveMastery).toContain(
      "lesson_objectives(description,position,lessons(title))",
    );
    expect(objectiveMastery).not.toContain(
      "lesson_objectives(description,position),lessons(title)",
    );
  });
});
