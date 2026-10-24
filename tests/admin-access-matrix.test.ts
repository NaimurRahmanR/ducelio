import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Access regression matrix for every admin page: the five control-centre
// workspaces and the sensitive legacy routes. Only the Supabase client is
// stubbed; the real identity guard (requireActor/canEnter), the real
// page-level guards and the real services run. The stub answers the two
// identity reads and records every other table or RPC read, so "refused"
// can be asserted as "nothing was loaded", not merely "nothing was shown".
const m = vi.hoisted(() => ({
  roles: null as string[] | null,
  reads: [] as string[],
  organisationMember: false,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  unstable_rethrow: () => {},
  usePathname: () => "/admin",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/env", async (original) => {
  const actual = await original<typeof import("@/lib/env")>();
  return {
    ...actual,
    config: () => ({ ...actual.config(), configured: true }),
  };
});
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => client(),
}));

type Result = { data: unknown; error: unknown; count?: number | null };
const stubbed: Result = {
  data: null,
  error: { message: "stubbed read" },
  count: null,
};
// A chainable, awaitable query builder that resolves to `result`.
function query(result: Result): unknown {
  const target = {};
  const proxy: unknown = new Proxy(target, {
    get: (_t, prop) =>
      prop === "then"
        ? (resolve: (r: Result) => unknown) => resolve(result)
        : () => proxy,
  });
  return proxy;
}
function client() {
  return {
    auth: {
      getUser: async () => ({
        data: {
          user:
            m.roles === null
              ? null
              : { id: "auth-1", email_confirmed_at: "2026-10-01T00:00:00Z" },
        },
        error: null,
      }),
    },
    from: (table: string) => {
      if (table === "app_users")
        return query({
          data: { id: "user-1", display_name: "Matrix User" },
          error: null,
        });
      if (table === "role_grants")
        return query({
          data: (m.roles ?? []).map((role) => ({ role })),
          error: null,
        });
      m.reads.push(`table:${table}`);
      return query(stubbed);
    },
    rpc: (name: string) => {
      if (name === "list_my_course_organisations") {
        m.reads.push(`rpc:${name}`);
        return query({
          data: m.organisationMember
            ? [
                {
                  id: "00000000-0000-4000-8000-000000000002",
                  name: "External organisation",
                  slug: "external-org",
                  canManage: true,
                  canReview: false,
                  canOwn: false,
                },
              ]
            : [],
          error: null,
        });
      }
      if (name === "current_account_status")
        return query({ data: "ACTIVE", error: null });
      m.reads.push(`rpc:${name}`);
      return query(stubbed);
    },
  };
}

type Access =
  | "ANY_ADMIN"
  | "COURSE_ADMIN"
  | "PLATFORM_ADMIN"
  | "RETIRED"
  | "ROUTER"
  | "COURSE_ENGINE";
const PAGES: [string, Access, () => Promise<{ default: unknown }>][] = [
  ["/admin", "ROUTER", () => import("@/app/admin/page")],
  ["/admin/academy", "ANY_ADMIN", () => import("@/app/admin/academy/page")],
  ["/admin/courses", "RETIRED", () => import("@/app/admin/courses/page")],
  [
    "/admin/courses/[packageKey]",
    "RETIRED",
    () => import("@/app/admin/courses/[packageKey]/page"),
  ],
  [
    "/admin/operations-engineer",
    "RETIRED",
    () => import("@/app/admin/operations-engineer/page"),
  ],
  ["/admin/sales", "COURSE_ADMIN", () => import("@/app/admin/sales/page")],
  ["/admin/people", "PLATFORM_ADMIN", () => import("@/app/admin/people/page")],
  [
    "/admin/commerce",
    "COURSE_ADMIN",
    () => import("@/app/admin/commerce/page"),
  ],
  ["/admin/cohorts", "COURSE_ADMIN", () => import("@/app/admin/cohorts/page")],
  // The old Academy route is a parameter-validated redirect; covered in unified UI tests.
  [
    "/admin/course-engineering",
    "COURSE_ENGINE",
    () => import("@/app/admin/course-engineering/page"),
  ],
  ["/admin/agents", "COURSE_ADMIN", () => import("@/app/admin/agents/page")],
  ["/admin/activation", "RETIRED", () => import("@/app/admin/activation/page")],
  [
    "/admin/activation/policy",
    "COURSE_ADMIN",
    () => import("@/app/admin/activation/policy/page"),
  ],
  [
    "/admin/activation/recovery",
    "COURSE_ADMIN",
    () => import("@/app/admin/activation/recovery/page"),
  ],
  [
    "/admin/academic-review",
    "COURSE_ADMIN",
    () => import("@/app/admin/academic-review/page"),
  ],
  [
    "/admin/academic-results",
    "COURSE_ADMIN",
    () => import("@/app/admin/academic-results/page"),
  ],
];

const ALLOWED: Record<Access, string[]> = {
  RETIRED: [],
  ROUTER: [],
  COURSE_ENGINE: ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"],
  ANY_ADMIN: ["ACADEMIC_ADMIN", "REGISTRAR", "PLATFORM_ADMIN"],
  COURSE_ADMIN: ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"],
  PLATFORM_ADMIN: ["PLATFORM_ADMIN"],
};

type Outcome =
  | { kind: "redirect"; to: string }
  | { kind: "forbidden" }
  | { kind: "entered" };

async function visit(load: () => Promise<{ default: unknown }>) {
  const Page = (await load()).default as (props: unknown) => Promise<unknown>;
  let element: unknown;
  try {
    element = await Page({
      searchParams: Promise.resolve({}),
      params: Promise.resolve({ packageKey: "security-plus-sy0-701" }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("REDIRECT:"))
      return { kind: "redirect", to: message.slice(9) } as Outcome;
    // A service reached past the guard and failed on the stubbed read.
    return { kind: "entered" } as Outcome;
  }
  let html = "";
  try {
    html = renderToStaticMarkup(element as never);
  } catch {
    return { kind: "entered" } as Outcome;
  }
  return (
    html.includes("You do not have access to this workspace")
      ? { kind: "forbidden" }
      : { kind: "entered" }
  ) as Outcome;
}

beforeEach(() => {
  m.reads = [];
});

const ACTORS: [string, string[] | null, boolean?][] = [
  ["an external organisation course manager", ["STUDENT"], true],
  ["an anonymous visitor", null],
  ["a learner", ["STUDENT"]],
  ["an instructor", ["INSTRUCTOR"]],
  ["a counsellor", ["COUNSELLOR"]],
  ["a registrar", ["REGISTRAR"]],
  ["an academic administrator", ["ACADEMIC_ADMIN"]],
  ["a platform administrator", ["PLATFORM_ADMIN"]],
];

describe.each(ACTORS)("admin access for %s", (_who, roles, member = false) => {
  it.each(PAGES)("%s", async (_path, access, load) => {
    m.roles = roles;
    m.organisationMember = member;
    const outcome = await visit(load);
    const membershipRead = ["rpc:list_my_course_organisations"];
    if (roles !== null && access === "RETIRED") {
      expect(outcome).toEqual({
        kind: "redirect",
        to: "/admin/course-engineering",
      });
      expect(m.reads).toEqual([]);
      return;
    }
    if (roles !== null && access === "ROUTER") {
      const destination =
        member ||
        roles.some((r) => ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"].includes(r))
          ? "/admin/course-engineering"
          : roles.includes("REGISTRAR")
            ? "/admin/academy"
            : "/student/academy";
      expect(outcome).toEqual({ kind: "redirect", to: destination });
      expect(m.reads).toEqual(membershipRead);
      return;
    }
    if (roles !== null && access === "COURSE_ENGINE") {
      if (member || roles.some((r) => ALLOWED.COURSE_ENGINE.includes(r))) {
        expect(outcome).toEqual({ kind: "entered" });
        expect(m.reads).toContain("rpc:list_unified_course_packages");
      } else {
        expect(outcome).toEqual({ kind: "forbidden" });
        expect(m.reads).toEqual(membershipRead);
      }
      return;
    }
    if (roles === null) {
      expect(outcome).toEqual({ kind: "redirect", to: "/login" });
      expect(m.reads).toEqual([]);
    } else if (
      !roles.some((r) =>
        ["ACADEMIC_ADMIN", "REGISTRAR", "PLATFORM_ADMIN"].includes(r),
      )
    ) {
      expect(outcome).toEqual({
        kind: "redirect",
        to: "/login?error=forbidden",
      });
      expect(m.reads).toEqual([]);
    } else if (roles.some((r) => ALLOWED[access].includes(r))) {
      expect(outcome).toEqual({ kind: "entered" });
      expect(m.reads.length).toBeGreaterThan(0);
    } else {
      // Refused inside the control centre, with nothing loaded.
      expect(outcome).toEqual({ kind: "forbidden" });
      expect(m.reads).toEqual([]);
    }
  });
});
