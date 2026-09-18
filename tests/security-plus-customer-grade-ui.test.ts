import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const classroom = readFileSync(
  "src/app/student/classroom/[classSessionId]/page.tsx",
  "utf8",
);
const liveStudent = readFileSync("src/components/live-student.tsx", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");

describe("SEC701-C learner reading experience", () => {
  it("renders long-form lecture bodies with preserved paragraph structure in Classroom", () => {
    expect(classroom).toContain('className="lesson-resource-body"');
    expect(classroom).not.toContain(
      "{resource.body && <p>{resource.body}</p>}",
    );
  });

  it("renders the same long-form resource treatment in Notes", () => {
    expect(liveStudent).toContain('className="lesson-resource-body"');
    expect(liveStudent).not.toContain(
      "{resource.body && <p>{resource.body}</p>}",
    );
  });

  it("gives Classroom a governed route to applied practical work", () => {
    expect(classroom).toContain('href="/student/practicals"');
    expect(classroom).toContain("Tutor and Lab Instructor support");
  });

  it("keeps readable line breaks and a bounded reading measure", () => {
    expect(css).toContain("white-space: pre-wrap");
    expect(css).toContain("max-width: 78ch");
    expect(css).toContain(".lesson-resource-body");
  });
});
