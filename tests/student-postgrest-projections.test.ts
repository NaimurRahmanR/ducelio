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
  it("reads retained progress labels through the bounded history RPC rather than RLS-sensitive embeds", () => {
    expect(lessonProgress).toContain('"get_student_retained_learning_history"');
    expect(lessonProgress).toContain('p_kind: "progress"');
    expect(lessonProgress).not.toContain('.from("lesson_progress")');
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

  it("reads retained mastery labels through the bounded history RPC rather than RLS-sensitive embeds", () => {
    expect(objectiveMastery).toContain(
      '"get_student_retained_learning_history"',
    );
    expect(objectiveMastery).toContain('p_kind: "mastery"');
    expect(objectiveMastery).not.toContain('.from("objective_mastery")');
  });
});
