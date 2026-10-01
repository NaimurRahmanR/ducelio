import { beforeEach, describe, expect, it, vi } from "vitest";

// Migration 044 hides a deactivated account's own app_users row (its
// current_app_user() resolves ACTIVE accounts only). The application
// identity layer must turn that into "no actor" -- never a partial actor,
// and never a crash page -- and send the person to a clear explanation.
const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  rpc: vi.fn(),
  grants: vi.fn(),
}));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            email_confirmed_at: "2026-09-01T00:00:00Z",
          },
        },
        error: null,
      }),
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () =>
          table === "role_grants" ? mocks.grants() : (chain as unknown),
        single: () => mocks.profile(),
      };
      return chain;
    },
    rpc: mocks.rpc,
  }),
}));

import {
  getAuthenticatedActor,
  getCurrentActor,
  requireActor,
} from "@/server/identity";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("account status in the application identity layer", () => {
  it("an active account resolves to its actor without an extra status lookup", async () => {
    mocks.profile.mockResolvedValue({
      data: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", display_name: "Pat" },
      error: null,
    });
    mocks.grants.mockResolvedValue({
      data: [{ role: "PLATFORM_ADMIN" }],
      error: null,
    });
    await expect(getAuthenticatedActor()).resolves.toEqual({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      displayName: "Pat",
      roles: ["PLATFORM_ADMIN"],
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a deactivated account has no actor and is redirected with an explanation", async () => {
    mocks.profile.mockResolvedValue({
      data: null,
      error: { code: "PGRST116", message: "0 rows" },
    });
    mocks.rpc.mockResolvedValue({ data: "DEACTIVATED", error: null });
    await expect(getAuthenticatedActor()).resolves.toBeNull();
    await expect(getCurrentActor()).resolves.toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith("current_account_status");
    await expect(requireActor("admin")).rejects.toThrow(
      "REDIRECT:/login?error=account-inactive",
    );
    expect(mocks.grants).not.toHaveBeenCalled();
  });

  it("a missing profile that is not deactivated still fails loudly", async () => {
    mocks.profile.mockResolvedValue({
      data: null,
      error: { code: "PGRST116", message: "0 rows" },
    });
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await expect(getAuthenticatedActor()).rejects.toThrow(
      "Your academy profile could not be loaded.",
    );
  });
});
