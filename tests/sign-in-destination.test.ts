import { beforeEach, describe, expect, it, vi } from "vitest";

// Where a successful sign-in lands. An explicit, allowlisted return
// destination always wins; otherwise the account goes to its own home, read
// from its role grants through its own session. The allowlist itself is
// unchanged (tests/auth.test.ts): /admin is never accepted as a return target.
const m = vi.hoisted(() => ({
  roles: [] as string[] | null,
  profile: true,
  signIn: vi.fn(),
  exchange: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  config: () => ({
    configured: true,
    appUrl: "http://127.0.0.1:3000",
    google: false,
    linkedin: false,
  }),
}));
const result = (data: unknown) => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data, error: data ? null : { message: "none" } }),
    then: (resolve: (r: unknown) => unknown) =>
      resolve({ data, error: data ? null : { message: "none" } }),
  };
  return chain;
};
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({
    auth: {
      signInWithPassword: m.signIn,
      exchangeCodeForSession: m.exchange,
      signOut: m.signOut,
      getUser: async () => ({ data: { user: { id: "auth-1" } }, error: null }),
    },
    from: (table: string) =>
      table === "app_users"
        ? result(m.profile ? { id: "user-1" } : null)
        : result(m.roles?.map((role) => ({ role })) ?? null),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));

import { login } from "@/app/auth/actions";
import { GET } from "@/app/auth/callback/route";
import { signInHome } from "@/domain/auth";
import { NextRequest } from "next/server";

const form = (next?: string) => {
  const data = new FormData();
  data.set("email", "person@example.com");
  data.set("password", "A fictional password");
  if (next !== undefined) data.set("next", next);
  return data;
};
const callback = async (next?: string) =>
  (
    await GET(
      new NextRequest(
        "http://127.0.0.1:3000/auth/callback?code=c" +
          (next ? "&next=" + encodeURIComponent(next) : ""),
      ),
    )
  ).headers.get("location");

beforeEach(() => {
  m.roles = ["STUDENT"];
  m.profile = true;
  m.signIn.mockResolvedValue({
    data: { user: { email_confirmed_at: "2026-10-01T00:00:00Z" } },
    error: null,
  });
  m.exchange.mockResolvedValue({ error: null });
});

describe("the account's own home", () => {
  it("sends administrators to the control centre and learners to their academy", () => {
    expect(signInHome(["ACADEMIC_ADMIN"])).toBe("/admin");
    expect(signInHome(["REGISTRAR"])).toBe("/admin");
    expect(signInHome(["PLATFORM_ADMIN"])).toBe("/admin");
    expect(signInHome(["STUDENT", "PLATFORM_ADMIN"])).toBe("/admin");
    expect(signInHome(["STUDENT"])).toBe("/student");
    // A counsellor-only account cannot enter /student; it goes to /support.
    expect(signInHome(["COUNSELLOR"])).toBe("/support");
    expect(signInHome(["INSTRUCTOR"])).toBe("/student");
    expect(signInHome([])).toBe("/student");
  });
});

describe("password sign-in", () => {
  it("lands an administrator on /admin by default", async () => {
    m.roles = ["ACADEMIC_ADMIN"];
    await expect(login({}, form())).rejects.toThrow(/^REDIRECT:\/admin$/);
  });

  it("keeps learner sign-in landing on /student", async () => {
    await expect(login({}, form())).rejects.toThrow(/^REDIRECT:\/student$/);
  });

  it("preserves a safe explicit return destination for every account", async () => {
    m.roles = ["PLATFORM_ADMIN"];
    await expect(login({}, form("/courses/security-plus-oct"))).rejects.toThrow(
      "REDIRECT:/courses/security-plus-oct",
    );
    m.roles = ["STUDENT"];
    await expect(login({}, form("/courses"))).rejects.toThrow(
      /^REDIRECT:\/courses$/,
    );
  });

  it("ignores an unsafe or unlisted destination and uses the account's home", async () => {
    m.roles = ["ACADEMIC_ADMIN"];
    await expect(
      login({}, form("https://outside.example/admin")),
    ).rejects.toThrow(/^REDIRECT:\/admin$/);
    m.roles = ["STUDENT"];
    // A learner asking for an admin page is not sent there.
    await expect(login({}, form("/admin/people"))).rejects.toThrow(
      /^REDIRECT:\/student$/,
    );
  });

  it("falls back to /student when the account's roles cannot be read", async () => {
    m.profile = false;
    await expect(login({}, form())).rejects.toThrow(/^REDIRECT:\/student$/);
    m.profile = true;
    m.roles = null;
    await expect(login({}, form())).rejects.toThrow(/^REDIRECT:\/student$/);
  });
});

describe("email-link and OAuth callback", () => {
  it("lands an administrator on /admin and a learner on /student", async () => {
    m.roles = ["REGISTRAR"];
    expect(await callback()).toBe("http://127.0.0.1:3000/admin");
    m.roles = ["STUDENT"];
    expect(await callback()).toBe("http://127.0.0.1:3000/student");
  });

  it("keeps an explicit safe destination such as password reset", async () => {
    m.roles = ["PLATFORM_ADMIN"];
    expect(await callback("/reset-password")).toBe(
      "http://127.0.0.1:3000/reset-password",
    );
    expect(await callback("https://outside.example")).toBe(
      "http://127.0.0.1:3000/admin",
    );
  });

  it("never grants an expired link a destination", async () => {
    m.exchange.mockResolvedValue({ error: { message: "expired" } });
    expect(await callback("/courses")).toBe(
      "http://127.0.0.1:3000/login?error=link-expired",
    );
  });
});
