import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Behavioural coverage for the People / Cohorts control plane: pages,
// client controls and Server Actions run through the REAL server layer
// (src/server/people.ts, cohorts.ts, admin-control-rpc.ts); only the
// session identity and the Supabase transport are stubbed, so every
// assertion about "which governed RPC was called with what" is observed at
// the transport boundary.
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  requireAnyRole: vi.fn(),
  rpc: vi.fn(),
  tables: {} as Record<string, unknown>,
  refresh: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: mocks.actor,
  requireAnyRole: mocks.requireAnyRole,
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const result = mocks.tables[table] ?? { data: [], error: null };
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "in", "order", "limit", "eq"])
        builder[method] = () => builder;
      builder.then = (
        onFulfilled: (value: unknown) => unknown,
        onRejected: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(onFulfilled, onRejected);
      return builder;
    },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.refresh }));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));

import PeoplePage from "@/app/admin/people/page";
import CohortsPage from "@/app/admin/cohorts/page";
import {
  grantRoleAction,
  revokeRoleAction,
  saveStaffProfileAction,
  setAccountStatusAction,
} from "@/app/admin/people/actions";
import {
  changeCohortStatusAction,
  createCohortAction,
  updateCohortAction,
} from "@/app/admin/cohorts/actions";
import { grantStaffRole } from "@/server/people";
import { PersonControls } from "@/components/admin-people-forms";
import {
  adminControlRoutes,
  adminControlRoutesForRoles,
  adminSections,
  adminSectionsForRoles,
} from "@/components/staff-shell";
import {
  AdminControlError,
  adminRefusalMessages,
  type Person,
} from "@/domain/admin-control-plane";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";
const NEWCOMER = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const COHORT = "55555555-5555-4555-8555-555555555555";
const DONE = "66666666-6666-4666-8666-666666666666";
const platformAdmin = {
  id: ADMIN,
  displayName: "Pat Admin",
  roles: ["STUDENT", "PLATFORM_ADMIN"],
};

function person(overrides: Partial<Person>): Person {
  return {
    id: STAFF,
    displayName: "Ira Instructor",
    email: "ira@example.com",
    emailConfirmed: true,
    accountStatus: "ACTIVE",
    staffTitle: "Instructor",
    isStudent: true,
    roles: ["STUDENT", "INSTRUCTOR"],
    liveTeaching: 0,
    activeCounselling: 0,
    createdAt: "2026-09-01T10:00:00+00:00",
    ...overrides,
  };
}
function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}
const rpcOk = (data: unknown) => ({ data, error: null });
const rpcRefused = (message: string) => ({ data: null, error: { message } });
const cohort = (overrides: Record<string, unknown> = {}) => ({
  id: COHORT,
  title: "November 2026 cohort",
  startsOn: "2026-11-02",
  endsOn: "2027-01-29",
  capacity: 30,
  status: "OPEN",
  programmeVersionId: VERSION,
  programmeTitle: "Security+ SY0-701",
  versionLabel: "2026 edition",
  isDemo: false,
  enrolments: { active: 2, paused: 0, completed: 0, withdrawn: 1 },
  activationId: null,
  publishedOfferSlug: null,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tables = {};
  mocks.actor.mockResolvedValue(platformAdmin);
  mocks.requireAnyRole.mockResolvedValue(platformAdmin);
});

describe("governed People server layer", () => {
  it("calls admin_grant_role with exactly the operator's typed change", async () => {
    mocks.rpc.mockResolvedValue(
      rpcOk({ userId: STAFF, role: "INSTRUCTOR", changed: true }),
    );
    await grantStaffRole({
      userId: STAFF,
      role: "INSTRUCTOR",
      reason: "Teaching appointment",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("admin_grant_role", {
      p_user_id: STAFF,
      p_role: "INSTRUCTOR",
      p_reason: "Teaching appointment",
    });
  });

  it("refuses non-PLATFORM_ADMIN actors before reaching the database", async () => {
    mocks.actor.mockResolvedValue({
      ...platformAdmin,
      roles: ["ACADEMIC_ADMIN", "REGISTRAR"],
    });
    await expect(
      grantStaffRole({ userId: STAFF, role: "INSTRUCTOR", reason: "Attempt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("never sends STUDENT or an invented role, and never forwards raw database text", async () => {
    await expect(
      grantStaffRole({ userId: STAFF, role: "STUDENT", reason: "Provisioned" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue(
      rpcRefused('permission denied for table role_grants at "secret"'),
    );
    const failure = await grantStaffRole({
      userId: STAFF,
      role: "INSTRUCTOR",
      reason: "Teaching appointment",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminControlError);
    expect((failure as AdminControlError).code).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("People Server Actions surface governed outcomes", () => {
  it("grant reaches the governed backend and reports the change", async () => {
    mocks.rpc.mockResolvedValue(
      rpcOk({ userId: STAFF, role: "COUNSELLOR", changed: true }),
    );
    const state = await grantRoleAction(
      {},
      form({
        userId: STAFF,
        role: "COUNSELLOR",
        reason: "Support appointment",
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("admin_grant_role", {
      p_user_id: STAFF,
      p_role: "COUNSELLOR",
      p_reason: "Support appointment",
    });
    expect(state).toEqual({ message: "Counsellor granted." });
    expect(mocks.refresh).toHaveBeenCalledWith("/admin/people");
  });

  it("explains a last-administrator refusal", async () => {
    mocks.rpc.mockResolvedValue(rpcRefused("LAST_PLATFORM_ADMIN"));
    const state = await revokeRoleAction(
      {},
      form({ userId: ADMIN, role: "PLATFORM_ADMIN", reason: "Stepping down" }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("admin_revoke_role", {
      p_user_id: ADMIN,
      p_role: "PLATFORM_ADMIN",
      p_reason: "Stepping down",
    });
    expect(state).toEqual({ error: adminRefusalMessages.LAST_PLATFORM_ADMIN });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("explains an INSTRUCTOR revocation refused for live delivery", async () => {
    mocks.rpc.mockResolvedValue(rpcRefused("ACTIVE_TEACHING_ASSIGNMENTS"));
    const state = await revokeRoleAction(
      {},
      form({ userId: STAFF, role: "INSTRUCTOR", reason: "Leaving teaching" }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("admin_revoke_role", {
      p_user_id: STAFF,
      p_role: "INSTRUCTOR",
      p_reason: "Leaving teaching",
    });
    expect(state).toEqual({
      error: adminRefusalMessages.ACTIVE_TEACHING_ASSIGNMENTS,
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("explains a self-lockout refusal on deactivation", async () => {
    mocks.rpc.mockResolvedValue(rpcRefused("SELF_LOCKOUT"));
    const state = await setAccountStatusAction(
      {},
      form({ userId: ADMIN, status: "DEACTIVATED", reason: "Leaving" }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("admin_set_account_status", {
      p_user_id: ADMIN,
      p_status: "DEACTIVATED",
      p_reason: "Leaving",
    });
    expect(state.error).toBe(adminRefusalMessages.SELF_LOCKOUT);
  });

  it("creates a staff profile through admin_set_staff_profile", async () => {
    mocks.rpc.mockResolvedValue(
      rpcOk({
        userId: NEWCOMER,
        title: "Counsellor",
        created: true,
        changed: true,
      }),
    );
    const state = await saveStaffProfileAction(
      {},
      form({ userId: NEWCOMER, title: "Counsellor", reason: "Appointed" }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("admin_set_staff_profile", {
      p_user_id: NEWCOMER,
      p_title: "Counsellor",
      p_reason: "Appointed",
    });
    expect(state).toEqual({ message: "Staff profile created." });
  });
});

describe("People page and controls", () => {
  function directory() {
    return {
      usablePlatformAdmins: 1,
      people: [
        person({
          id: ADMIN,
          displayName: "Pat Admin",
          email: "pat@example.com",
          staffTitle: "Platform administrator",
          roles: ["STUDENT", "PLATFORM_ADMIN"],
        }),
        person({}),
        person({
          id: NEWCOMER,
          displayName: "Nia Newcomer",
          email: "nia@example.com",
          staffTitle: null,
          roles: ["STUDENT"],
        }),
      ],
    };
  }

  it("renders people, their roles and governed audit for a PLATFORM_ADMIN", async () => {
    mocks.rpc.mockResolvedValue(rpcOk(directory()));
    mocks.tables.audit_events = {
      data: [
        {
          id: "77777777-7777-4777-8777-777777777771",
          actor_id: ADMIN,
          action: "INSERT",
          target_type: "role_grants",
          target_id: STAFF,
          reason: "Teaching appointment",
          occurred_at: "2026-10-01T09:00:00+00:00",
          before_state: null,
          after_state: { user_id: STAFF, role: "INSTRUCTOR" },
        },
        {
          id: "77777777-7777-4777-8777-777777777772",
          actor_id: null,
          action: "INSERT",
          target_type: "role_grants",
          target_id: NEWCOMER,
          reason: "Institutional service or database provisioning",
          occurred_at: "2026-09-30T09:00:00+00:00",
          before_state: null,
          after_state: { user_id: NEWCOMER, role: "STUDENT" },
        },
      ],
      error: null,
    };
    mocks.tables.app_users = {
      data: [
        { id: ADMIN, display_name: "Pat Admin" },
        { id: STAFF, display_name: "Ira Instructor" },
      ],
      error: null,
    };
    const html = renderToStaticMarkup(
      await PeoplePage({ searchParams: Promise.resolve({}) }),
    );
    expect(mocks.requireAnyRole).toHaveBeenCalledWith(["PLATFORM_ADMIN"]);
    expect(mocks.rpc).toHaveBeenCalledWith("admin_list_people", {
      p_query: null,
    });
    for (const text of [
      "Pat Admin",
      "Ira Instructor",
      "Nia Newcomer",
      "Usable platform administrators: 1",
      "Accounts are never created from this page",
      "Role granted · Instructor",
      "Teaching appointment",
    ])
      expect(html).toContain(text);
    // Sign-up provisioning noise and raw audit state stay off the page.
    expect(html).not.toContain("database provisioning");
    expect(html).not.toContain("user_id");
  });

  it("passes a search through the bounded projection", async () => {
    mocks.rpc.mockResolvedValue(rpcOk({ usablePlatformAdmins: 1, people: [] }));
    const html = renderToStaticMarkup(
      await PeoplePage({
        searchParams: Promise.resolve({ q: " nobody@example.com " }),
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("admin_list_people", {
      p_query: "nobody@example.com",
    });
    expect(html).toContain("No matching account");
    expect(html).toContain("create a Ducelio account first");
  });

  it("offers staff-profile creation before any role grant", () => {
    const html = renderToStaticMarkup(
      createElement(PersonControls, {
        person: person({ id: NEWCOMER, staffTitle: null, roles: ["STUDENT"] }),
        isSelf: false,
      }),
    );
    expect(html).toContain("Create staff profile");
    expect(html).toContain("A staff profile is required");
    expect(html).not.toContain("Grant role");
    expect(html).not.toContain("Revoke role");
    expect(html).toContain("Deactivate account");
  });

  it("offers grant of unheld staff roles, revoke of held ones, and never STUDENT", () => {
    const html = renderToStaticMarkup(
      createElement(PersonControls, { person: person({}), isSelf: false }),
    );
    expect(html).toContain("Grant role");
    expect(html).toContain('value="COUNSELLOR"');
    expect(html).toContain('value="PLATFORM_ADMIN"');
    expect(html).toContain("Revoke role");
    expect(html).not.toContain('value="STUDENT"');
    // INSTRUCTOR appears exactly once: in the revoke list, not the grant list.
    expect(html.match(/value="INSTRUCTOR"/g)).toHaveLength(1);
  });

  it("never offers self-deactivation or self-revocation of platform administration", () => {
    const html = renderToStaticMarkup(
      createElement(PersonControls, {
        person: person({
          id: ADMIN,
          roles: ["STUDENT", "PLATFORM_ADMIN", "INSTRUCTOR"],
        }),
        isSelf: true,
      }),
    );
    expect(html).not.toContain("Deactivate account");
    expect(html).toContain("You cannot deactivate your own account.");
    expect(html).toContain("cannot remove your own platform administration");
    const revoke = html.slice(html.indexOf("Revoke a staff role"));
    expect(revoke).toContain('value="INSTRUCTOR"');
    expect(revoke).not.toContain('value="PLATFORM_ADMIN"');
  });

  it("surfaces a deactivated account's kept relationships for reassignment", () => {
    const html = renderToStaticMarkup(
      createElement(PersonControls, {
        person: person({
          accountStatus: "DEACTIVATED",
          liveTeaching: 2,
          activeCounselling: 1,
        }),
        isSelf: false,
      }),
    );
    expect(html).toContain("2 live");
    expect(html).toContain("1 active counselling");
    expect(html).toContain("reassign them");
    const active = renderToStaticMarkup(
      createElement(PersonControls, {
        person: person({ liveTeaching: 2 }),
        isSelf: false,
      }),
    );
    expect(active).not.toContain("reassign them");
  });

  it("offers reactivation, and nothing else, for a deactivated account", () => {
    const html = renderToStaticMarkup(
      createElement(PersonControls, {
        person: person({ accountStatus: "DEACTIVATED" }),
        isSelf: false,
      }),
    );
    expect(html).toContain("Reactivate account");
    expect(html).toContain('value="ACTIVE"');
    expect(html).not.toContain("Grant role");
    expect(html).not.toContain("Update staff title");
  });
});

describe("Cohorts page and workflows", () => {
  function workspace() {
    return {
      cohorts: [
        cohort(),
        cohort({
          id: DONE,
          title: "September 2026 cohort",
          status: "COMPLETED",
          activationId: "88888888-8888-4888-8888-888888888888",
        }),
      ],
      versions: [
        {
          id: VERSION,
          programmeTitle: "Security+ SY0-701",
          label: "2026 edition",
        },
      ],
    };
  }

  it("replaces the placeholder with a real register and create form", async () => {
    mocks.rpc.mockResolvedValue(rpcOk(workspace()));
    const html = renderToStaticMarkup(
      await CohortsPage({ searchParams: Promise.resolve({}) }),
    );
    expect(mocks.requireAnyRole).toHaveBeenCalledWith([
      "ACADEMIC_ADMIN",
      "PLATFORM_ADMIN",
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith("admin_cohort_workspace", {});
    expect(html).not.toContain("Cohort operations will preserve");
    for (const text of [
      "Create cohort",
      "Security+ SY0-701 · 2026 edition",
      "November 2026 cohort",
      "2026-11-02 → 2027-01-29",
      "2 / 30",
      "1 withdrawn",
      "Open",
      "Completed",
      `/admin/cohorts?cohort=${COHORT}`,
    ])
      expect(html).toContain(text);
  });

  it("shows the roster and only the lifecycle changes the cohort can make", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "admin_cohort_roster"
        ? rpcOk({
            cohortId: COHORT,
            title: "November 2026 cohort",
            status: "OPEN",
            capacity: 30,
            total: 1,
            enrolments: [
              {
                enrolmentId: "99999999-9999-4999-8999-999999999999",
                studentId: STAFF,
                displayName: "Lee Learner",
                studentNumber: "DUC-0001",
                status: "ACTIVE",
                enrolledAt: "2026-10-01T09:00:00+00:00",
              },
            ],
          })
        : rpcOk(workspace()),
    );
    const html = renderToStaticMarkup(
      await CohortsPage({ searchParams: Promise.resolve({ cohort: COHORT }) }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("admin_cohort_roster", {
      p_cohort_id: COHORT,
    });
    expect(html).toContain("Lee Learner");
    expect(html).toContain("DUC-0001");
    expect(html).toContain("Close to new enrolment");
    expect(html).not.toContain("Mark completed");
    expect(html).not.toContain("Reopen for enrolment");
    // Enrolled learners lock the start date in the edit form.
    expect(html).toContain("Locked: learners are enrolled");
  });

  it("offers no edit or lifecycle control for a completed cohort", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "admin_cohort_roster"
        ? rpcOk({
            cohortId: DONE,
            title: "September 2026 cohort",
            status: "COMPLETED",
            capacity: 30,
            total: 0,
            enrolments: [],
          })
        : rpcOk(workspace()),
    );
    const html = renderToStaticMarkup(
      await CohortsPage({ searchParams: Promise.resolve({ cohort: DONE }) }),
    );
    expect(html).toContain("This cohort is completed");
    expect(html).not.toContain("Apply lifecycle change");
    expect(html).not.toContain("Save details");
  });

  it("create reaches admin_create_cohort with typed optional fields", async () => {
    mocks.rpc.mockResolvedValue(rpcOk(COHORT));
    const state = await createCohortAction(
      {},
      form({
        programmeVersionId: VERSION,
        title: "January 2027 cohort",
        startsOn: "2027-01-11",
        endsOn: "",
        capacity: "25",
        reason: "Launch the January intake",
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("admin_create_cohort", {
      p_programme_version_id: VERSION,
      p_title: "January 2027 cohort",
      p_starts_on: "2027-01-11",
      p_ends_on: null,
      p_capacity: 25,
      p_reason: "Launch the January intake",
    });
    expect(state).toEqual({
      message: "Cohort created and open for enrolment.",
    });
  });

  it("explains a refused create without calling the database for invalid input", async () => {
    const invalid = await createCohortAction(
      {},
      form({
        programmeVersionId: VERSION,
        title: "Backwards",
        startsOn: "2027-01-11",
        endsOn: "2027-01-01",
        capacity: "",
        reason: "Bad dates here",
      }),
    );
    expect(invalid.error).toBe(adminRefusalMessages.INVALID_INPUT);
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue(rpcRefused("VERSION_NOT_PUBLISHED"));
    const refused = await createCohortAction(
      {},
      form({
        programmeVersionId: VERSION,
        title: "Draft intake",
        startsOn: "2027-01-11",
        endsOn: "",
        capacity: "",
        reason: "Draft version attempt",
      }),
    );
    expect(refused.error).toBe(adminRefusalMessages.VERSION_NOT_PUBLISHED);
  });

  it("close and complete reach admin_change_cohort_status and report archived offers", async () => {
    mocks.rpc.mockResolvedValue(
      rpcOk({
        cohortId: COHORT,
        status: "CLOSED",
        changed: true,
        archivedOfferIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      }),
    );
    const closed = await changeCohortStatusAction(
      {},
      form({ cohortId: COHORT, status: "CLOSED", reason: "Intake closed" }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("admin_change_cohort_status", {
      p_cohort_id: COHORT,
      p_status: "CLOSED",
      p_reason: "Intake closed",
    });
    expect(closed.message).toContain("1 published offer was archived");
    mocks.rpc.mockResolvedValue(rpcRefused("INVALID_TRANSITION"));
    const refused = await changeCohortStatusAction(
      {},
      form({ cohortId: COHORT, status: "COMPLETED", reason: "Skip closing" }),
    );
    expect(refused.error).toBe(adminRefusalMessages.INVALID_TRANSITION);
  });

  it("edit reaches admin_update_cohort and explains a locked start date", async () => {
    mocks.rpc.mockResolvedValue(rpcRefused("STARTS_ON_LOCKED"));
    const state = await updateCohortAction(
      {},
      form({
        cohortId: COHORT,
        title: "November 2026 cohort",
        startsOn: "2026-11-09",
        endsOn: "2027-01-29",
        capacity: "30",
        reason: "Move the start",
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("admin_update_cohort", {
      p_cohort_id: COHORT,
      p_title: "November 2026 cohort",
      p_starts_on: "2026-11-09",
      p_ends_on: "2027-01-29",
      p_capacity: 30,
      p_reason: "Move the start",
    });
    expect(state.error).toBe(adminRefusalMessages.STARTS_ON_LOCKED);
  });
});

describe("Commercial V1 admin navigation", () => {
  it("links only to routes that exist, and drops the placeholder sections", () => {
    for (const route of adminControlRoutes)
      expect(
        existsSync(resolve("src/app", `.${route.href}`, "page.tsx")),
        route.href,
      ).toBe(true);
    expect(adminSections).not.toContain("Cohorts" as never);
    expect(adminSections).not.toContain("Announcements" as never);
    expect(adminSections).toContain("Registry");
  });

  it("exposes each control-plane route only to roles its page admits", () => {
    expect(
      adminControlRoutesForRoles(["PLATFORM_ADMIN"]).map((r) => r.label),
    ).toEqual([
      "People",
      "Cohorts",
      "Course Engineering",
      "Activation",
      "Policy setup",
      "Grade recovery",
      "Academic review",
      "Commerce",
    ]);
    expect(
      adminControlRoutesForRoles(["ACADEMIC_ADMIN"]).map((r) => r.label),
    ).not.toContain("People");
    expect(adminControlRoutesForRoles(["REGISTRAR"])).toEqual([]);
    expect(adminSectionsForRoles(["REGISTRAR"])).toEqual([
      "Overview",
      "Registry",
    ]);
  });

  it("renders the control-plane menu with the current page marked", async () => {
    mocks.rpc.mockResolvedValue(rpcOk({ cohorts: [], versions: [] }));
    const html = renderToStaticMarkup(
      await CohortsPage({ searchParams: Promise.resolve({}) }),
    );
    for (const href of [
      "/admin/people",
      "/admin/cohorts",
      "/admin/course-engineering",
      "/admin/activation",
      "/admin/commerce",
      "/admin?section=registry",
    ])
      expect(html).toContain(`href="${href}"`);
    expect(html).toMatch(
      /<a class="selected" aria-current="page" href="\/admin\/cohorts">Cohorts<\/a>/,
    );
    expect(html).not.toContain("section=cohorts");
    expect(html).not.toContain("Announcements");
    // No version to create against: an honest prerequisite, not a dead form.
    expect(html).toContain("No published institutional programme version");
    expect(html).not.toContain(">Create cohort</button>");
  });
});
