"use client";
import { useActionState } from "react";
import Link from "next/link";
import { ArrowRight, LoaderCircle } from "lucide-react";
import {
  login,
  signup,
  forgotPassword,
  resetPassword,
  resendVerification,
} from "@/app/auth/actions";
import type { AuthState } from "@/domain/auth";
export type AuthMode =
  "login" | "signup" | "forgot-password" | "reset-password" | "verify-email";
const actions = {
  login,
  signup,
  "forgot-password": forgotPassword,
  "reset-password": resetPassword,
  "verify-email": resendVerification,
};
const labels = {
  login: "Sign in to your academy",
  signup: "Create your account",
  "forgot-password": "Send reset link",
  "reset-password": "Save new password",
  "verify-email": "Resend verification email",
};
export function AuthForm({
  mode,
  configured,
  next,
}: {
  mode: AuthMode;
  configured: boolean;
  next?: string;
}) {
  const [state, action, pending] = useActionState<AuthState, FormData>(
    actions[mode],
    {},
  );
  const password =
    mode === "login" || mode === "signup" || mode === "reset-password";
  return (
    <form action={action} className="auth-form" aria-busy={pending}>
      {next && <input type="hidden" name="next" value={next} />}
      {/* Always present, so the result of a submission is announced. */}
      <div className="auth-feedback" aria-live="polite">
        {state.error && (
          <div className="auth-notice error" role="alert">
            {state.error}
          </div>
        )}
        {state.message && (
          <div className="auth-notice success" role="status">
            {state.message}
          </div>
        )}
      </div>
      {mode === "signup" && (
        <div className="field">
          <label htmlFor="displayName">Your name</label>
          <input
            id="displayName"
            name="displayName"
            autoComplete="name"
            maxLength={100}
            required
            disabled={!configured}
          />
        </div>
      )}
      {mode !== "reset-password" && (
        <div className="field">
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            maxLength={254}
            required
            disabled={!configured}
          />
        </div>
      )}
      {password && (
        <div className="field">
          <div className="field-label">
            <label htmlFor="password">
              {mode === "reset-password" ? "New password" : "Password"}
            </label>
            {mode === "login" && (
              <Link href="/forgot-password">Forgot password?</Link>
            )}
          </div>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            minLength={mode === "login" ? 1 : 12}
            maxLength={128}
            required
            disabled={!configured}
            aria-describedby={mode !== "login" ? "password-hint" : undefined}
          />
          {mode !== "login" && (
            <small id="password-hint" className="auth-hint">
              Use at least 12 characters.
            </small>
          )}
        </div>
      )}
      {mode === "reset-password" && (
        <div className="field">
          <label htmlFor="confirmPassword">Confirm new password</label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            disabled={!configured}
          />
        </div>
      )}
      <button
        className="auth-submit"
        type="submit"
        disabled={!configured || pending}
      >
        {pending ? (
          <>
            <LoaderCircle size={18} className="auth-spin" aria-hidden="true" />
            Please wait…
          </>
        ) : (
          <>
            {labels[mode]}
            <ArrowRight size={18} aria-hidden="true" />
          </>
        )}
      </button>
    </form>
  );
}
