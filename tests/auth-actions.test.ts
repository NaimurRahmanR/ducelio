import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  signup: vi.fn(),
  signOut: vi.fn(),
  exchange: vi.fn(),
  reset: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  config: () => ({
    configured: true,
    appUrl: "http://127.0.0.1:3000",
    google: false,
    linkedin: false,
  }),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({
    auth: {
      signUp: mocks.signup,
      signOut: mocks.signOut,
      exchangeCodeForSession: mocks.exchange,
      resetPasswordForEmail: mocks.reset,
      getUser: mocks.getUser,
      updateUser: mocks.updateUser,
    },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
import { signup, forgotPassword, resetPassword } from "@/app/auth/actions";
import { GET } from "@/app/auth/callback/route";
import { NextRequest } from "next/server";
describe("authentication flow regressions", () => {
  beforeEach(() => vi.resetAllMocks());
  it("preserves the signup PKCE verifier while awaiting email confirmation", async () => {
    mocks.signup.mockResolvedValue({ data: { session: null }, error: null });
    const form = new FormData();
    form.set("displayName", "Learner");
    form.set("email", "learner@example.com");
    form.set("password", "A fictional long password");
    await expect(signup({}, form)).rejects.toThrow("REDIRECT:/verify-email");
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
  it("forwards a PKCE flow selector and rejects arbitrary callback destinations", async () => {
    mocks.exchange.mockResolvedValue({ error: null });
    const response = await GET(
      new NextRequest(
        "http://127.0.0.1:3000/auth/callback?code=test-code&sb_flow_id=test-flow&next=https://outside.example",
      ),
    );
    expect(mocks.exchange).toHaveBeenCalledWith("test-code", {
      flowId: "test-flow",
    });
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:3000/student",
    );
  });
  it("keeps password-recovery responses independent of account existence", async () => {
    const form = new FormData();
    form.set("email", "learner@example.com");
    mocks.reset.mockResolvedValue({ error: null });
    const existing = await forgotPassword({}, form);
    mocks.reset.mockResolvedValue({ error: { message: "Unknown address" } });
    expect(await forgotPassword({}, form)).toEqual(existing);
  });
  it("requires verified backend identity before updating a password", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const form = new FormData();
    form.set("password", "A fictional long password");
    form.set("confirmPassword", "A fictional long password");
    expect(await resetPassword({}, form)).toHaveProperty("error");
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
