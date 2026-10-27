import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LearnerCourse } from "@/domain/learner-contract";

// The learner profile (docs/61 §4): one scrolling page of plain forms that
// post to server action props. Fixtures only.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => createElement("a", { href, ...rest }, children),
}));

import {
  ProfileFormView,
  type LearnerProfile,
} from "@/components/learner/profile-form";

const FIXTURE_PROFILE: LearnerProfile = {
  firstName: "Fixture",
  lastName: "Learner",
  email: "fixture.learner@example.test",
  pendingEmail: null,
  photoUrl: null,
  education: [
    {
      institution: "Fixture University",
      qualification: "BSc",
      fieldOfStudy: "Computing",
      startDate: "2019-09-01",
      endDate: "2022-06-30",
      current: false,
    },
  ],
  experience: [
    {
      organisation: "Fixture Ltd",
      title: "Analyst",
      startDate: "2023-01-09",
      endDate: null,
      current: true,
    },
  ],
};
const FIXTURE_COURSE: LearnerCourse = {
  enrolmentId: "e-1",
  courseId: "c-1",
  title: "Fixture Networking Course",
  provider: "Fixture Provider",
  status: "COMPLETED",
  scheduled: true,
  accessRevoked: false,
};

const action = vi.fn(async () => ({}));
const render = (
  profile: LearnerProfile | null = FIXTURE_PROFILE,
  enrolled = [
    {
      course: FIXTURE_COURSE,
      completion: { completed: true, completedAt: "2026-10-01T12:00:00Z" },
    },
  ],
) =>
  renderToStaticMarkup(
    createElement(ProfileFormView, {
      profile,
      enrolled,
      saveProfileAction: action,
      uploadPhotoAction: action,
      removePhotoAction: action,
      requestEmailChangeAction: action,
    }),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const input = (html: string, name: string) =>
  html.match(
    new RegExp(`<input[^>]*name="${name.replace(/\./g, "\\.")}"[^>]*>`),
  )?.[0];

describe("profile page", () => {
  it("is one page with photo, name, education, experience, email and enrolled courses", () => {
    const plain = text(render());
    const order = [
      "Photo",
      "Name",
      "Education",
      "Experience",
      "Save profile",
      "Email",
      "Enrolled courses",
    ].map((h) => plain.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("prefills required first and last name fields", () => {
    const html = render();
    expect(input(html, "firstName")).toMatch(/required/);
    expect(input(html, "firstName")).toContain('value="Fixture"');
    expect(input(html, "lastName")).toContain('value="Learner"');
    expect(html).toContain('autoComplete="given-name"');
  });

  it("renders repeatable education and experience rows with indexed, required fields", () => {
    const html = render();
    expect(html).toContain('name="educationCount" value="1"');
    expect(html).toContain('name="experienceCount" value="1"');
    // Required and bounded exactly as the profile service validates them:
    // field of study is optional there, so it is optional here.
    for (const f of ["institution", "qualification"])
      expect(input(html, `education.0.${f}`)).toMatch(/required/);
    expect(input(html, "education.0.fieldOfStudy")).not.toMatch(/required/);
    for (const f of ["institution", "qualification", "fieldOfStudy"])
      expect(input(html, `education.0.${f}`)).toContain('maxLength="150"');
    for (const f of ["firstName", "lastName"])
      expect(input(html, f)).toContain('maxLength="60"');
    expect(input(html, "education.0.institution")).toContain(
      'value="Fixture University"',
    );
    expect(input(html, "education.0.startDate")).toMatch(/type="date"/);
    expect(input(html, "education.0.endDate")).toContain('value="2022-06-30"');
    expect(input(html, "education.0.endDate")).toMatch(/required/);
    expect(input(html, "experience.0.organisation")).toContain(
      'value="Fixture Ltd"',
    );
    expect(input(html, "experience.0.title")).toMatch(/required/);
    const plain = text(html);
    expect(plain).toContain("Add education");
    expect(plain).toContain("Add experience");
    expect(plain).toContain("Remove education 1");
    expect(plain).toContain("Remove experience 1");
  });

  it("disables the end date while an entry is current", () => {
    const html = render();
    const current = input(html, "experience.0.current")!;
    expect(current).toMatch(/type="checkbox"/);
    expect(current).toMatch(/checked/);
    const end = input(html, "experience.0.endDate")!;
    expect(end).toMatch(/disabled/);
    expect(end).not.toMatch(/required/);
    expect(input(html, "education.0.current")).not.toMatch(/checked/);
  });

  it("offers an upload without a photo, and change and remove with one", () => {
    const none = render();
    expect(none).toMatch(/<input[^>]*type="file"[^>]*name="photo"/);
    expect(none).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(text(none)).toContain("Upload photo");
    expect(text(none)).not.toContain("Remove photo");
    const withPhoto = render({
      ...FIXTURE_PROFILE,
      photoUrl: "/api/learner/profile/photo",
    });
    expect(withPhoto).toMatch(
      /<img src="\/api\/learner\/profile\/photo" alt="Your profile photo"/,
    );
    expect(text(withPhoto)).toContain("Change photo");
    expect(text(withPhoto)).toContain("Remove photo");
  });

  it("changes email only through the verified flow and shows a pending change", () => {
    const html = render({
      ...FIXTURE_PROFILE,
      pendingEmail: "new.address@example.test",
    });
    const plain = text(html);
    expect(plain).toContain("Current email: fixture.learner@example.test");
    expect(plain).toContain(
      "new.address@example.test is waiting for confirmation",
    );
    expect(plain).toContain("Nothing changes until you confirm it.");
    expect(input(html, "email")).toMatch(/type="email"/);
    expect(input(html, "email")).toMatch(/required/);
  });

  it("lists enrolled courses read-only, with completion and a results link", () => {
    const html = render();
    const table = html.slice(
      html.indexOf('aria-labelledby="ln-enrolled-heading"'),
    );
    expect(table).toContain("<caption>");
    expect(table).not.toContain("<input");
    const plain = text(table);
    expect(plain).toContain("Fixture Networking Course");
    expect(plain).toContain("Fixture Provider");
    expect(plain).toContain("Completed");
    expect(plain).toMatch(/Completed .*1 Oct 2026/);
    expect(table).toContain('href="/student/courses/e-1#ln-results-heading"');
  });

  it("explains a profile that could not be loaded and an empty course list", () => {
    const plain = text(render(null, []));
    expect(plain).toContain("Your profile could not be loaded");
    expect(plain).toContain("No courses yet.");
    expect(plain).not.toContain("Save profile");
  });
});
