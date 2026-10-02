import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { it, expect, vi } from "vitest";
vi.mock("@/app/admin/actions", () => ({ updateClassSessionStatus: vi.fn() }));
vi.mock("@/app/admin/session-actions", () => ({
  runSessionOperation: vi.fn(),
}));
import { SessionOperationsConsole } from "@/components/session-operations-console";
import type {
  BatchOptions,
  SessionDiscovery,
} from "@/domain/session-operations";
const id = "10000000-0000-4000-8000-000000000001";
function render(
  rows: SessionDiscovery["rows"] = [],
  hasMore = false,
  completed = false,
  overrides: Partial<BatchOptions> = {},
) {
  return renderToStaticMarkup(
    createElement(SessionOperationsConsole, {
      discovery: { rows, hasMore },
      options: {
        hasMore: false,
        lessonsHasMore: false,
        activationOffset: 0,
        lessonOffset: 0,
        selectedActivation: {
          id,
          instructorId: id,
          title: "Activated course",
          status: completed ? "COMPLETED" : "CLOSED",
        },
        activations: [
          {
            id,
            instructorId: id,
            title: "Activated course",
            status: completed ? "COMPLETED" : "CLOSED",
          },
        ],
        lessons: [{ id, title: "Institutional lesson" }],
        ...overrides,
      },
      activationId: overrides.selectedActivation?.id ?? id,
      instructors: [{ user_id: id, display_name: "Qualified teacher" }],
      cohorts: [{ id, title: "Existing cohort" }],
      requestIds: { [id]: id },
      batchRequestId: id,
      filters: {
        activationId: overrides.selectedActivation?.id ?? id,
        activationOffset: String(overrides.activationOffset ?? 0),
        lessonOffset: String(overrides.lessonOffset ?? 0),
      },
    }),
  );
}
it("renders bounded discovery and explicit batch builder with qualified defaults", () => {
  const html = render();
  expect(html).toContain("Explicit batch preview");
  expect(html).toContain("Institutional lesson");
  expect(html).toContain("Qualified teacher");
  expect(html).toContain("Maximum 100 items per request");
  expect(html).toContain("No recurrence");
  expect(html).toContain('name="items"');
  expect(html).toContain("Start new batch request");
});
it("hasMore is truthful and exposes deterministic next-page navigation", () => {
  const html = render([], true);
  expect(html).toContain("More matching sessions");
  expect(html).toContain("offset=50");
  expect(html).toContain("Next page");
});
it("completed delivery does not offer batch submission", () => {
  const html = render([], false, true);
  expect(html).toContain("Batch generation is unavailable");
  expect(html).not.toContain("Generate 1 sessions atomically");
});
it("register links replacements and only eligible future rows offer rescheduling", () => {
  const row: SessionDiscovery["rows"][number] = {
    id,
    cohortTitle: "Cohort",
    cohortStatus: "CLOSED",
    lessonTitle: "Lesson",
    instructorName: "Teacher",
    programmeTitle: "Programme",
    versionLabel: "v1",
    scheduledStart: "2030-01-01T18:00:00Z",
    scheduledEnd: "2030-01-01T19:00:00Z",
    status: "SCHEDULED",
    canReschedule: true,
    originalId: null,
    replacementId: id,
  };
  const html = render([row]);
  expect(html).toContain("Reschedule with original duration");
  expect(html).toContain("Replacement session");
  expect(html).toContain("sessionId=");
  expect(
    render([{ ...row, canReschedule: false, status: "CANCELLED" }]),
  ).not.toContain("Reschedule with original duration");
});

it("first-page activation and lesson discovery offers truthful forward navigation", () => {
  const html = render([], false, false, {
    hasMore: true,
    lessonsHasMore: true,
  });
  expect(html).toContain("Next activations");
  expect(html).toContain("activationOffset=200");
  expect(html).toContain("Next lessons");
  expect(html).toContain("lessonOffset=250");
  expect(html).not.toContain("Previous activations");
  expect(html).not.toContain("Previous lessons");
});
it("later pages offer previous navigation while retaining the selected activation", () => {
  const html = render([], false, false, {
    activationOffset: 200,
    lessonOffset: 250,
    lessons: [{ id, title: "Later activation lesson" }],
  });
  expect(html).toContain("Previous activations");
  expect(html).toContain("Previous lessons");
  expect(html).toContain("activationId=" + id);
  expect(html).toContain("Later activation lesson");
  expect(html).not.toContain("Next activations");
  expect(html).not.toContain("Next lessons");
  expect(html).toContain("Generate 1 sessions atomically");
});
it("directly selected off-page activation remains selectable and usable in the batch form", () => {
  const selected = "10000000-0000-4000-8000-000000000003";
  const html = render([], false, false, {
    activations: [],
    selectedActivation: {
      id: selected,
      instructorId: id,
      title: "Off-page course",
      status: "CLOSED",
    },
  });
  expect(html).toContain("Off-page course");
  expect(html).toContain('name="activationId" value="' + selected + '"');
  expect(html).toContain("Generate 1 sessions atomically");
  expect(html).toContain('<option value="' + selected + '" selected="">');
});
