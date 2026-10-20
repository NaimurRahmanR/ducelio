import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/student/actions", () => ({
  beginControlledAssessment: vi.fn(),
  finishControlledAssessment: vi.fn(),
  saveControlledAssessmentResponse: vi.fn(),
}));

import { StudentAssessments } from "@/components/student-assessments";

const assessment = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Synthetic assessment",
  instructions: "Synthetic instructions",
  opens_at: "2026-10-01T00:00:00Z",
  closes_at: "2026-10-30T00:00:00Z",
  duration_minutes: 30,
  attempts_allowed: 1,
  status: "PUBLISHED" as const,
  lessons: { title: "Synthetic lesson" },
  programme_versions: { label: "Synthetic edition", title_snapshot: null },
};

function render(
  pagination: {
    page: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  },
  assessments = [assessment],
) {
  return renderToStaticMarkup(
    createElement(StudentAssessments, {
      assessments,
      attempts: [],
      activityState: "NORMAL",
      activeQuestions: [],
      serverNow: "2026-10-15T00:00:00Z",
      pagination,
    }),
  );
}

describe("learner assessment page links", () => {
  it("a single page renders no navigation", () => {
    expect(
      render({ page: 1, hasPreviousPage: false, hasNextPage: false }),
    ).not.toContain("Assessment pages");
  });

  it("the first page links only to older assessments", () => {
    const html = render({ page: 1, hasPreviousPage: false, hasNextPage: true });
    expect(html).toContain('<nav aria-label="Assessment pages"');
    expect(html).toContain('href="/student/assessments?page=2"');
    expect(html).toContain("Older assessments");
    expect(html).not.toContain("Newer assessments");
  });

  it("a middle page links both ways, and page 1 has the canonical URL", () => {
    const html = render({ page: 2, hasPreviousPage: true, hasNextPage: true });
    expect(html).toContain('href="/student/assessments"');
    expect(html).toContain('href="/student/assessments?page=3"');
    expect(html).toContain("Newer assessments");
    expect(html).toContain("Older assessments");
  });

  it("an empty later page says so and links back", () => {
    const html = render(
      { page: 4, hasPreviousPage: true, hasNextPage: false },
      [],
    );
    expect(html).toContain("No older assessments");
    expect(html).not.toContain("No controlled assessments available");
    expect(html).toContain('href="/student/assessments?page=3"');
  });

  it("a live attempt whose assessment is on another page still renders its exam workspace", () => {
    const html = renderToStaticMarkup(
      createElement(StudentAssessments, {
        assessments: [],
        activeAssessment: assessment,
        attempts: [
          {
            id: "00000000-0000-4000-8000-0000000000a1",
            assessment_id: assessment.id,
            attempt_number: 1,
            state: "ACTIVE",
            started_at: "2026-10-15T00:00:00Z",
            expires_at: "2026-10-15T00:30:00Z",
            submitted_at: null,
          },
        ],
        activityState: "CONTROLLED_ASSESSMENT_ACTIVE",
        activeQuestions: [
          {
            id: "00000000-0000-4000-8000-0000000000b1",
            position: 1,
            prompt: "Synthetic question",
            max_marks: 1,
            question_type: "SINGLE_SELECT",
            interaction: {
              options: [
                { id: "a", label: "Synthetic A" },
                { id: "b", label: "Synthetic B" },
              ],
            },
            saved_body: null,
            revision_count: 0,
          },
        ],
        serverNow: "2026-10-15T00:05:00Z",
        pagination: { page: 5, hasPreviousPage: true, hasNextPage: true },
      }),
    );
    expect(html).toContain("Synthetic assessment");
    expect(html).toContain("Synthetic instructions");
    expect(html).toContain("Synthetic question");
  });

  // Ported from the CP2F worktree.
  it("never opens a workspace for an active-assessment row that does not match the active attempt", () => {
    const html = renderToStaticMarkup(
      createElement(StudentAssessments, {
        assessments: [],
        activeAssessment: assessment,
        attempts: [
          {
            id: "00000000-0000-4000-8000-0000000000a1",
            assessment_id: "00000000-0000-4000-8000-0000000000ff",
            attempt_number: 1,
            state: "ACTIVE",
            started_at: "2026-10-15T00:00:00Z",
            expires_at: "2026-10-15T00:30:00Z",
            submitted_at: null,
          },
        ],
        activityState: "CONTROLLED_ASSESSMENT_ACTIVE",
        activeQuestions: [],
        serverNow: "2026-10-15T00:05:00Z",
        pagination: { page: 1, hasPreviousPage: false, hasNextPage: false },
      }),
    );
    expect(html).not.toContain("Synthetic assessment");
    expect(html).not.toContain("Synthetic instructions");
  });
});
