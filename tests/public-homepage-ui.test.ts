import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// LR-BASELINE-01: the public homepage and catalogue, rendered through the
// real page components. Only the published-offer projection and the
// session lookup are stubbed.
const mocks = vi.hoisted(() => ({
  offers: vi.fn(),
  actor: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => createElement("a", { href, className }, children),
}));
vi.mock("@/server/commercial-v1-commerce", () => ({
  listCommercialV1Offers: mocks.offers,
}));
vi.mock("@/server/identity", () => ({ getCurrentActor: mocks.actor }));

import Home from "@/app/page";
vi.mock("@/server/unified-course-engine", () => ({
  listUnifiedCourseCatalogue: mocks.offers,
}));
import CoursesPage from "@/app/courses/page";
import { formatCohortStartDate } from "@/domain/commercial-v1-commerce";

const offer = (n: number) => ({
  slug: `course-${n}`,
  title: `Course ${n}`,
  examinationBody: "Example Body",
  qualificationName: `Qualification ${n}`,
  offerId: "10000000-0000-4000-8000-000000000101",
  description: "Synthetic course",
  qualificationPreparation: null,
  demoContent: true,
  lessons: 2,
  labs: 1,
  assessments: 1,
  formats: [
    {
      formatId: "STANDARD_6W",
      weeks: 6,
      sessionMinutes: 60,
      minStudyDays: 2,
      maxStudyDays: 7,
      amountMinor: 10000,
    },
  ],
  currency: "GBP",
  summary: null,
  cohortStartsOn: "2036-11-02",
  deliveryPlan: "STANDARD_6_WEEK",
});
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const render = async () => renderToStaticMarkup(await Home());

beforeEach(() => {
  mocks.offers.mockReset();
  mocks.actor.mockReset();
  mocks.offers.mockResolvedValue([1, 2, 3, 4].map(offer));
  mocks.actor.mockResolvedValue(null);
});

describe("public homepage", () => {
  it("is a real landing page with one main landmark for the skip link", async () => {
    const html = await render();
    expect(html.match(/<main id="main"/g)).toHaveLength(1);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    const plain = text(html);
    expect(plain).toContain("Your ambition. Guided to mastery.");
    expect(plain).toContain("How Ducelio works");
    expect(plain).toContain("Getting started");
    expect(plain).toContain("AI Professor");
    expect(plain).toContain(
      "Ducelio prepares learners for external qualifications. It does not award them",
    );
  });

  it("leaves course listings to the /courses catalogue", async () => {
    const html = await render();
    expect(mocks.offers).not.toHaveBeenCalled();
    expect(hrefs(html).some((h) => h.startsWith("/courses/"))).toBe(false);
    const plain = text(html);
    expect(plain).not.toContain("Available courses");
    expect(plain).not.toContain("View all courses");
    expect(hrefs(html)).toContain("/courses");
  });

  it("offers sign-in and sign-up to a signed-out visitor", async () => {
    const links = hrefs(await render());
    expect(links).toContain("/login");
    expect(links).toContain("/signup");
    expect(links).toContain("/demo");
    expect(links).not.toContain("/student");
  });

  it("gives a signed-in learner a way back to their academy", async () => {
    mocks.actor.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000001",
      displayName: "Alex Morgan",
      roles: ["STUDENT"],
    });
    const html = await render();
    expect(hrefs(html)).toContain("/student");
    expect(hrefs(html)).not.toContain("/login");
    expect(text(html)).toContain("Go to your academy");
  });

  it("sends a staff-only account to its own workspace, never the learner area", async () => {
    mocks.actor.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000002",
      displayName: "Pat Admin",
      roles: ["ACADEMIC_ADMIN"],
    });
    const links = hrefs(await render());
    expect(links).toContain("/admin");
    expect(links).not.toContain("/student");
  });

  it("falls back to the signed-out page when the session cannot be resolved", async () => {
    mocks.actor.mockRejectedValue(new Error("profile unavailable"));
    const links = hrefs(await render());
    expect(links).toContain("/login");
  });
});

describe("homepage footer", () => {
  const footer = async () => {
    const html = await render();
    expect(html.match(/<footer[ >]/g)).toHaveLength(1);
    return html.slice(html.indexOf('<footer class="site-footer"'));
  };
  const column = (html: string, id: string) => {
    const start = html.indexOf(`id="${id}"`);
    return html.slice(start, html.indexOf("</section>", start));
  };

  it("is one footer with the four expected columns", async () => {
    const html = await footer();
    for (const heading of ["Quick links", "Help & Support", "Contact"])
      expect(text(html)).toContain(heading);
    expect(html).toContain(
      '<h2 id="footer-brand" class="sr-only">Ducelio</h2>',
    );
    expect(text(html)).toContain("An intelligent academy designed for you.");
  });

  it("links only to public pages that exist, without duplicates", async () => {
    const links = hrefs(await footer());
    expect(links).toEqual([
      "/",
      "/courses",
      "/login",
      "/signup",
      "/demo",
      "/forgot-password",
    ]);
    // /support is the protected counsellor workspace, never public support.
    expect(links).not.toContain("/support");
    expect(links.some((h) => h.startsWith("/student"))).toBe(false);
  });

  it("swaps sign-in links for the visitor's own workspace when signed in", async () => {
    mocks.actor.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000001",
      displayName: "Alex Morgan",
      roles: ["STUDENT"],
    });
    const links = hrefs(await footer());
    expect(links).toContain("/student");
    expect(links).not.toContain("/login");
    expect(links).not.toContain("/signup");
  });

  it("invents no contact details", async () => {
    const html = await footer();
    expect(html).not.toMatch(/mailto:|tel:|@[a-z0-9-]+\.[a-z]/i);
    expect(text(column(html, "footer-contact"))).toContain(
      "Official contact details are being finalised",
    );
    expect(html).not.toMatch(/privacy|terms|cookie/i);
  });

  it("keeps copyright and the external-certification disclaimer", async () => {
    const plain = text(await footer());
    expect(plain).toMatch(/© \d{4} Ducelio/);
    expect(plain).toContain(
      "It does not award them: qualifications and certifications are awarded only by the relevant examination body.",
    );
  });
});

describe("homepage opening intro", () => {
  const intro = (html: string) => {
    const match = html.match(/<div id="ducelio-opening"[^>]*>/);
    expect(match).not.toBeNull();
    return match![0];
  };
  const decideScript = (html: string) => {
    const match = html.match(
      /<div id="ducelio-opening"[\s\S]*?<script[^>]*>([\s\S]*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    return match![1];
  };
  // Runs the real pre-paint script against a minimal browser surface.
  const runDecide = (
    script: string,
    {
      reducedMotion = false,
      stored = {} as Record<string, string>,
      storageThrows = false,
    } = {},
  ) => {
    const attributes: Record<string, string> = {};
    const element = {
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
    };
    const sessionStorage = {
      getItem: (key: string) => {
        if (storageThrows) throw new Error("SecurityError");
        return stored[key] ?? null;
      },
      setItem: (key: string, value: string) => {
        if (storageThrows) throw new Error("SecurityError");
        stored[key] = value;
      },
    };
    const window = {
      matchMedia: (query: string) => ({
        matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
      }),
      sessionStorage,
    };
    runInNewContext(script, {
      window,
      document: {
        getElementById: (id: string) =>
          id === "ducelio-opening" ? element : null,
      },
    });
    return { intro: attributes["data-intro"], stored };
  };

  it("shows the exact tagline and an accessible skip control", async () => {
    const html = await render();
    const plain = text(html);
    expect(plain).toContain("An intelligent academy designed for you.");
    expect(plain).toContain("DUCELIO");
    expect(html).toMatch(
      /<button type="button" class="opening-skip">Skip intro<\/button>/,
    );
    // The decorative scene is hidden from assistive technology; the page keeps
    // exactly one h1 and one main landmark.
    expect(html).toContain('<div class="opening-stage" aria-hidden="true">');
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html.match(/<main id="main"/g)).toHaveLength(1);
  });

  it("is server-rendered inert, so the page works without JavaScript", async () => {
    expect(intro(await render())).not.toContain("data-intro");
  });

  it("plays once per tab session", async () => {
    const script = decideScript(await render());
    const first = runDecide(script);
    expect(first.intro).toBe("play");
    expect(runDecide(script, { stored: first.stored }).intro).toBe("skip");
  });

  it("never plays with reduced motion or without session storage", async () => {
    const script = decideScript(await render());
    const reduced = runDecide(script, { reducedMotion: true });
    expect(reduced.intro).toBe("skip");
    expect(reduced.stored).toEqual({});
    expect(runDecide(script, { storageThrows: true }).intro).toBe("skip");
  });
});

describe("homepage opening timing", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../src/app/globals.css", import.meta.url)),
    "utf8",
  );
  const ms = (rule: RegExp) => {
    const match = css.match(rule);
    expect(match).not.toBeNull();
    return Number(match![1]) + Number(match![2]);
  };

  it("holds the scene for about 3.25 seconds before it has dissolved", () => {
    // duration + delay of the overlay's own dissolve, and of the stage.
    expect(
      ms(/animation: opening-dissolve (\d+)ms cubic-bezier\([^)]*\) (\d+)ms/),
    ).toBe(3250);
    expect(
      ms(/animation: opening-stage-out (\d+)ms cubic-bezier\([^)]*\) (\d+)ms/),
    ).toBe(3250);
  });
});

describe("homepage course discovery", () => {
  it("makes browsing courses the obvious header action", async () => {
    const html = await render();
    expect(html).toContain(
      '<a href="/courses" class="button secondary">Browse courses</a>',
    );
    expect(html).toContain(
      '<a href="/courses" class="button">Explore courses</a>',
    );
  });

  it("shows any publisher's published offers, not only Ducelio courses", async () => {
    mocks.offers.mockResolvedValue([
      {
        ...offer(1),
        qualificationPreparation: {
          examinationBody: "Partner Organisation",
          qualificationName: "External qualification",
          disclaimer: "Preparation only; no external award.",
        },
      },
    ]);
    const plain = text(renderToStaticMarkup(await CoursesPage()));
    expect(plain).toContain("Partner Organisation");
    expect(plain).toContain("Course 1");
  });

  it("gives a signed-in learner on the catalogue a way back, not a sign-in prompt", async () => {
    mocks.actor.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000001",
      displayName: "Alex Morgan",
      roles: ["STUDENT"],
    });
    const html = renderToStaticMarkup(await CoursesPage());
    expect(hrefs(html)).toContain("/student");
    expect(hrefs(html)).not.toContain("/login");
    expect(text(html)).toContain("Go to your academy");
  });

  it("keeps sign-in and sign-up on the catalogue for signed-out visitors", async () => {
    mocks.actor.mockRejectedValue(new Error("session unavailable"));
    const links = hrefs(renderToStaticMarkup(await CoursesPage()));
    expect(links).toContain("/login");
    expect(links).toContain("/signup");
  });
});

describe("meet your AI learning team", () => {
  const section = async () => {
    const html = await render();
    const start = html.indexOf('<section class="ai-team"');
    return html.slice(start, html.indexOf("</section>", start));
  };

  it("introduces the three named characters, each labelled as AI", async () => {
    const html = await section();
    const plain = text(html);
    expect(plain).toContain("Meet your AI learning team");
    expect(plain).toContain("Professor Atlas AI Professor AI");
    expect(plain).toContain("Dr. Forge AI Lab Instructor AI");
    expect(plain).toContain("Sarah Mitchell AI Learner Guide AI");
    expect(html.match(/<li class="ai-member">/g)).toHaveLength(3);
  });

  it("keeps Sarah's established limits", async () => {
    expect(text(await section())).toContain(
      "Sarah is AI. She is not a human member of staff and not your assigned counsellor.",
    );
  });

  it("explains other roles without personal names or unsupported features", async () => {
    const plain = text(await section());
    expect(plain).toContain("Q&A Tutor AI");
    expect(plain).toContain("Examiner AI");
    // The Registrar is staff, never presented as AI.
    expect(plain).toContain("Registrar Staff");
    expect(plain).not.toMatch(/Practice Coach/);
  });

  it("uses monogram portraits, never stock photography", async () => {
    const html = await section();
    expect(html).not.toContain("<img");
    expect(html.match(/class="ai-portrait" aria-hidden="true"/g)).toHaveLength(
      3,
    );
    // The page keeps one h1; the section uses h2/h3.
    expect((await render()).match(/<h1[ >]/g)).toHaveLength(1);
  });
});

describe("public catalogue", () => {
  it("has the skip-link target and the shared offer card", async () => {
    const html = renderToStaticMarkup(await CoursesPage());
    expect(html.match(/<main id="main"/g)).toHaveLength(1);
    expect(hrefs(html).filter((h) => h.startsWith("/courses/"))).toHaveLength(
      4,
    );
    expect(text(html)).toContain("your own timetable");
    expect(text(html)).not.toContain("Cohort start date");
  });

  it("says when no course is open", async () => {
    mocks.offers.mockResolvedValue([]);
    const html = renderToStaticMarkup(await CoursesPage());
    expect(html).toContain('role="status"');
    expect(text(html)).toContain("No courses are published yet.");
  });

  it("reports an outage distinctly from an empty catalogue", async () => {
    mocks.offers.mockRejectedValue(new Error("Courses could not be loaded."));
    const html = renderToStaticMarkup(await CoursesPage());
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("The catalogue is temporarily unavailable.");
    expect(text(html)).not.toContain("No courses are open");
  });
});

describe("cohort start date", () => {
  it("is the stored calendar date, unambiguous and independent of the host zone", () => {
    expect(formatCohortStartDate("2026-11-02")).toBe("2 November 2026");
    expect(formatCohortStartDate("2026-01-01")).toBe("1 January 2026");
  });

  it("passes through a value that is not a calendar date", () => {
    expect(formatCohortStartDate("soon")).toBe("soon");
    expect(formatCohortStartDate("2026-13-40")).toBe("2026-13-40");
  });

  it("states the stored day without a past/future claim that depends on the viewer's zone", async () => {
    mocks.offers.mockResolvedValue([
      { ...offer(1), cohortStartsOn: "2020-01-01" },
    ]);
    const html = renderToStaticMarkup(await CoursesPage());
    const plain = text(html);
    expect(plain).not.toContain("Cohort start date");
    expect(html).not.toContain('dateTime="2020-01-01"');
    expect(plain).not.toMatch(/next cohort|cohort started|starts soon/i);
  });
});
