import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/live-student.tsx", "utf8");
const studentSections = readFileSync(
  "src/app/student/[section]/page.tsx",
  "utf8",
);

describe("25 October learner navigation baseline", () => {
  it("uses the authorised live class-session projection for the calendar", () => {
    expect(studentSections).toContain('"calendar"');
    expect(source).toContain('{section === "calendar" && (');
    expect(source).toContain("Class calendar");
    expect(source).toContain("Date.parse(a.scheduled_start)");
    expect(source).toContain("timeZone: profile.timezone");
    expect(source).toContain('href="/student/classes"');
  });

  it("treats Calendar as an implemented learner section, not a later-milestone placeholder", () => {
    expect(source).toMatch(/"profile",\s*"calendar",\s*"classes"/);
  });

  it("separates official graded results from objective mastery", () => {
    expect(source).toContain("Formal assessment results");
    expect(source).toContain('href="/student/progress"');
    expect(source).toContain("The objective mastery");
    expect(source).toContain("Your mastery");
  });
});
