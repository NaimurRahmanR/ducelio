import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  enrolments: vi.fn(),
  timetable: vi.fn(),
  recoveries: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/student/academy",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/server/identity", () => ({
  requireActor: async () => ({
    id: "learner",
    displayName: "Learner",
    roles: ["STUDENT"],
  }),
  requireStudentPrincipal: async () => ({
    id: "learner",
    displayName: "Learner",
    roles: ["STUDENT"],
  }),
}));
vi.mock("@/server/academy-delivery", () => ({
  listMyAcademyEnrolments: m.enrolments,
  getMyAcademyTimetable: m.timetable,
  getMyAcademyProgress: async () => null,
  getMyAcademyResults: async () => null,
}));
vi.mock("@/server/unified-course-activation", () => ({
  listMyRecoveries: m.recoveries,
}));
import Page from "@/app/student/academy/page";
const id = "10000000-0000-4000-8000-000000000101";
const formats = [
  {
    formatId: "STANDARD_6W",
    weeks: 6,
    sessionMinutes: 180,
    minStudyDays: 4,
    maxStudyDays: 6,
  },
];
const enrolment = {
  enrolmentId: id,
  title: "Synthetic Course",
  status: "ACTIVE",
  formatId: null,
  fixedFormatId: null,
  formats,
  schedule: null,
  accessRevoked: false,
};
beforeEach(() => {
  vi.resetAllMocks();
  m.enrolments.mockResolvedValue([enrolment]);
  m.recoveries.mockResolvedValue([]);
  m.timetable.mockResolvedValue(null);
});
describe("purchase -> Activate Course -> timetable", () => {
  it("shows Activate Course for purchased access without prematurely displaying an active schedule", async () => {
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain("My Learning");
    expect(html).toContain("Activate Course");
    expect(html).toContain("Purchased - awaiting activation");
    expect(html).not.toContain('name="startOn"');
  });
  it("opens the existing personalised preview/confirmation engine only after activation is selected", async () => {
    const html = renderToStaticMarkup(
      await Page({
        searchParams: Promise.resolve({ enrolmentId: id, activate: "true" }),
      }),
    );
    for (const name of [
      "formatId",
      "startOn",
      "studyDays",
      "localTime",
      "timezone",
      "requestKey",
    ])
      expect(html).toContain(`name="${name}"`);
    expect(html).toContain("Preview");
    expect(html).toContain("Confirm this timetable");
  });
  it("does not offer activation when access was revoked", async () => {
    m.enrolments.mockResolvedValue([{ ...enrolment, accessRevoked: true }]);
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ activate: "true" }) }),
    );
    expect(html).toContain("Access has ended");
    expect(html).not.toContain('name="startOn"');
    expect(html).not.toContain("Activate Course");
  });
  it("does not re-offer activation after timetable confirmation", async () => {
    m.enrolments.mockResolvedValue([
      {
        ...enrolment,
        formatId: "STANDARD_6W",
        schedule: {
          revision: 1,
          startOn: "2030-01-01",
          endOn: "2030-02-11",
          studyDays: [1, 2, 3, 4],
          localTime: "09:00",
          timezone: "Europe/London",
        },
      },
    ]);
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ activate: "true" }) }),
    );
    expect(html).not.toContain("Activate Course");
    expect(html).not.toContain('name="startOn"');
  });
});
