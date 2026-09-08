"use server";
import { redirect } from "next/navigation";
import { config } from "@/lib/env";
import { createSupabase } from "@/server/supabase";
import {
  emailSchema,
  passwordSchema,
  signInSchema,
  signUpSchema,
  type AuthState,
} from "@/domain/auth";
const unavailable = {
  error:
    "Sign-in is awaiting academy configuration. You can explore the demo below.",
};
const callback = (next = "/student") =>
  config().appUrl + "/auth/callback?next=" + encodeURIComponent(next);
export async function login(
  _state: AuthState,
  data: FormData,
): Promise<AuthState> {
  if (!config().configured) return unavailable;
  const parsed = signInSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success)
    return { error: "Enter a valid email address and password." };
  const client = await createSupabase();
  const { data: session, error } = await client.auth.signInWithPassword(
    parsed.data,
  );
  if (error || !session.user)
    return {
      error: "Unable to sign in. Check your details and verify your email.",
    };
  if (!session.user.email_confirmed_at) {
    await client.auth.signOut();
    return { error: "Please verify your email before signing in." };
  }
  redirect("/student");
}
export async function signup(
  _state: AuthState,
  data: FormData,
): Promise<AuthState> {
  if (!config().configured) return unavailable;
  const parsed = signUpSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success)
    return {
      error:
        "Enter your name, a valid email and a password of 12–128 characters.",
    };
  const client = await createSupabase();
  const { data: signupData, error } = await client.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: callback(),
      data: { display_name: parsed.data.displayName },
    },
  });
  if (error)
    return {
      error: "Registration could not be completed. Please try again later.",
    };
  // Keep PKCE verifier cookies until the verification callback exchanges its code.
  if (signupData.session) {
    await client.auth.signOut({ scope: "local" });
    return {
      error:
        "Email confirmation must be enabled by your academy before registration is available.",
    };
  }
  redirect("/verify-email");
}
export async function forgotPassword(
  _state: AuthState,
  data: FormData,
): Promise<AuthState> {
  if (!config().configured) return unavailable;
  const parsed = emailSchema.safeParse(data.get("email"));
  if (!parsed.success) return { error: "Enter a valid email address." };
  const client = await createSupabase();
  await client.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: callback("/reset-password"),
  });
  return {
    message:
      "If this address has an account, a password reset link will arrive shortly.",
  };
}
export async function resendVerification(
  _state: AuthState,
  data: FormData,
): Promise<AuthState> {
  if (!config().configured) return unavailable;
  const parsed = emailSchema.safeParse(data.get("email"));
  if (!parsed.success) return { error: "Enter a valid email address." };
  const client = await createSupabase();
  await client.auth.resend({
    type: "signup",
    email: parsed.data,
    options: { emailRedirectTo: callback() },
  });
  return {
    message:
      "If verification is needed, a new link will arrive shortly. Check your spam folder too.",
  };
}
export async function resetPassword(
  _state: AuthState,
  data: FormData,
): Promise<AuthState> {
  if (!config().configured) return unavailable;
  const parsed = passwordSchema.safeParse(data.get("password"));
  if (!parsed.success) return { error: "Use a password of 12–128 characters." };
  if (parsed.data !== data.get("confirmPassword"))
    return { error: "The passwords do not match." };
  const client = await createSupabase();
  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser();
  if (authError || !user || !user.email_confirmed_at)
    return {
      error: "This link has expired. Request a new password reset link.",
    };
  const { error } = await client.auth.updateUser({ password: parsed.data });
  if (error)
    return {
      error: "Unable to update the password. Request a new link and try again.",
    };
  await client.auth.signOut({ scope: "global" });
  redirect("/login?message=password-updated");
}
export async function oauth(data: FormData) {
  const provider = data.get("provider");
  const env = config();
  if (
    (provider !== "google" && provider !== "linkedin_oidc") ||
    (provider === "google" ? !env.google : !env.linkedin)
  )
    redirect("/login?error=provider-unavailable");
  const client = await createSupabase();
  const { data: result, error } = await client.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: callback(),
      ...(provider === "linkedin_oidc"
        ? { scopes: "openid profile email" }
        : {}),
    },
  });
  if (error || !result.url) redirect("/login?error=auth-failed");
  redirect(result.url);
}
export async function logout() {
  if (config().configured) {
    const client = await createSupabase();
    await client.auth.signOut();
  }
  redirect("/login");
}
