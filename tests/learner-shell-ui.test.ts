import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The learner shell (docs/61 §2): six main navigation items in order, the
// active item marked, Support & Feedback in the footer, and staff links
// still derived from the signed-in roles.
const mocks = vi.hoisted(() => ({ pathname: "/student" }));
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
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));

import { AcademyShell, LEARNER_NAV } from "@/components/academy-shell";
import type { Role } from "@/domain/academy";

const render = (props: { roles?: Role[]; demo?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(
      AcademyShell,
      { name: "Alex Morgan", ...props } as Parameters<typeof AcademyShell>[0],
      "content",
    ),
  );
const section = (html: string, start: string, end: string) => {
  const from = html.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  return html.slice(from + start.length, html.indexOf(end, from));
};
const mainNav = (html: string) =>
  section(html, 'aria-label="Academy navigation">', "</nav>");
const mobileNav = (html: string) =>
  section(html, 'aria-label="Mobile academy navigation"', "</details>");
const hrefs = (html: string) =>
  [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const MAIN = [
  ["Dashboard", "/student"],
  ["My Learning", "/student/learning"],
  ["My Timetable", "/student/timetable"],
  ["Leaderboards", "/student/leaderboards"],
  ["Browse Courses", "/courses"],
  ["Profile", "/student/profile"],
];

beforeEach(() => {
  mocks.pathname = "/student";
});

describe("learner sidebar", () => {
  it("lists exactly the six main items, in order", () => {
    const nav = mainNav(render());
    expect(hrefs(nav)).toEqual(MAIN.map(([, href]) => href));
    expect(text(nav)).toBe(MAIN.map(([label]) => label).join(" "));
    expect(LEARNER_NAV.map((i) => [i.label, i.href])).toEqual(MAIN);
  });

  it("drops Historical programmes and the standalone Sarah entry from the main navigation", () => {
    const html = render();
    const nav = mainNav(html);
    expect(nav).not.toContain("Historical programmes");
    expect(nav).not.toContain("/student/sarah");
    expect(nav).not.toContain("/student/programme");
    expect(html).not.toContain("Historical programmes");
    // Both stay reachable through quiet secondary links.
    const secondary = section(
      html,
      'aria-label="More academy links"',
      "</nav>",
    );
    expect(hrefs(secondary)).toEqual(["/student/sarah", "/student/programme"]);
  });

  it("offers the same main items in the mobile menu", () => {
    const mobile = mobileNav(render());
    for (const [, href] of MAIN) expect(hrefs(mobile)).toContain(href);
    expect(hrefs(mobile)).toContain("/student/notifications");
  });

  it.each([
    ["/student", "Dashboard"],
    ["/student/learning", "My Learning"],
    ["/student/courses/e-1", "My Learning"],
    ["/student/courses/e-1/progression", "My Learning"],
    ["/student/timetable", "My Timetable"],
    ["/student/leaderboards", "Leaderboards"],
    ["/student/profile", "Profile"],
  ])("marks %s as the current page (%s)", (pathname, label) => {
    mocks.pathname = pathname;
    const html = render();
    const current = [
      ...mainNav(html).matchAll(/<a [^>]*aria-current="page"[^>]*>(.*?)<\/a>/g),
    ];
    expect(current).toHaveLength(1);
    expect(text(current[0][1])).toBe(label);
    expect(html).toContain(`<strong>${label}</strong>`);
  });

  it("marks nothing in the main navigation on a page outside it", () => {
    mocks.pathname = "/student/support";
    const html = render();
    expect(mainNav(html)).not.toContain("aria-current");
    expect(html).toContain("<strong>Support &amp; Feedback</strong>");
  });
});

describe("learner shell chrome", () => {
  it("links Support & Feedback from the footer", () => {
    const footer = section(
      render(),
      '<footer class="workspace-footer"',
      "</footer>",
    );
    expect(footer).toContain('href="/student/support"');
    expect(text(footer)).toContain("Support & Feedback");
    expect(text(footer)).toContain(
      "Preparing you for external qualifications.",
    );
  });

  it("keeps the notifications bell, profile avatar, sign out and the #main landmark", () => {
    const html = render();
    expect(html).toContain('aria-label="Academy notifications"');
    expect(html).toContain('href="/student/notifications"');
    expect(html).toMatch(
      /<a href="\/student\/profile" class="avatar small" aria-label="Your profile">AM<\/a>/,
    );
    expect(html).toContain('aria-label="Sign out"');
    expect(html).toContain('<main id="main" tabindex="-1" class="workspace">');
    expect(html).toContain('class="academy ln-shell"');
  });
});

describe("staff links from roles", () => {
  it("shows no staff links to a learner", () => {
    const html = render({ roles: ["STUDENT"] });
    expect(html).not.toContain('href="/admin"');
    expect(html).not.toContain("Counsellor workspace");
  });

  it.each(["ACADEMIC_ADMIN", "REGISTRAR", "PLATFORM_ADMIN"] as const)(
    "shows Administration to %s",
    (role) => {
      const html = render({ roles: ["STUDENT", role] });
      expect(html).toContain('<a href="/admin" class="staff-link">');
      expect(text(html)).toContain("Administration");
    },
  );

  it("shows the counsellor workspace to a counsellor", () => {
    const html = render({ roles: ["STUDENT", "COUNSELLOR"] });
    expect(html).toContain('<a href="/support" class="staff-link">');
    expect(text(html)).toContain("Counsellor workspace");
  });
});

describe("credential-free demo shell", () => {
  it("keeps its fictional sections and never links to Sarah", () => {
    mocks.pathname = "/demo";
    const html = render({ demo: true });
    const nav = hrefs(mainNav(html));
    expect(nav[0]).toBe("/demo");
    expect(nav).toContain("/courses");
    expect(nav.every((h) => h === "/courses" || h.startsWith("/demo"))).toBe(
      true,
    );
    expect(html).not.toContain("sarah");
    expect(html).toContain('href="/demo/support"');
    expect(html).not.toContain('aria-label="Sign out"');
  });
});
