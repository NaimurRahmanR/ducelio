import Link from "next/link";
import { Brand, Badge, ButtonLink } from "@/components/ui";
import { AuthForm, type AuthMode } from "@/components/auth-form";
import { config } from "@/lib/env";
import { oauth } from "@/app/auth/actions";
import { safeAuthDestination } from "@/domain/auth";
const copy = {
  login: ["Welcome back.", "Your next chapter is waiting."],
  signup: ["Begin your next chapter.", "A little ambition. A clear direction."],
  "forgot-password": [
    "Let’s get you back in.",
    "We’ll email you a link to reset your password.",
  ],
  "reset-password": [
    "A fresh start.",
    "Choose a new password for your academy account.",
  ],
  "verify-email": [
    "Check your inbox.",
    "Verify your email address to open your academy.",
  ],
};
export function AuthPage({
  mode,
  error,
  message,
  next: rawNext,
}: {
  mode: AuthMode;
  error?: string;
  message?: string;
  next?: string;
}) {
  const env = config();
  const [title, subtitle] = copy[mode];
  const social = mode === "login" || mode === "signup";
  // Only ever a validated same-origin local path (never /student itself,
  // so the hidden field/links stay absent when there is no real commercial
  // return target to preserve).
  const next = rawNext
    ? safeAuthDestination(rawNext, "") || undefined
    : undefined;
  const switchHref =
    (mode === "login" ? "/signup" : "/login") +
    (next ? "?next=" + encodeURIComponent(next) : "");
  return (
    <div className="auth-layout">
      <aside className="auth-story">
        <Brand />
        <div>
          <span className="eyebrow">YOUR AMBITION, WITH DIRECTION</span>
          <h1>
            The next chapter
            <br />
            is <em>yours to write.</em>
          </h1>
          <p>
            Structured programmes. Meaningful progress.
            <br />A counsellor by your side.
          </p>
          <div className="auth-promise">
            <span>01</span>
            <div>
              <strong>A clear path to mastery</strong>
              <p>Build understanding, one objective at a time.</p>
            </div>
          </div>
          <div className="auth-promise">
            <span>02</span>
            <div>
              <strong>Support that stays with you</strong>
              <p>A continuous relationship throughout your academy journey.</p>
            </div>
          </div>
        </div>
        <p className="auth-footer">Your ambition. Guided to mastery.</p>
      </aside>
      <main id="main" className="auth-main">
        <div className="auth-mobile-brand">
          <Brand />
        </div>
        <div className="auth-panel">
          <Badge tone="gold">WELCOME TO DUCELIO</Badge>
          <h1>{title}</h1>
          <p className="muted">{subtitle}</p>
          {!env.configured && (
            <div className="notice">
              Live sign-in is awaiting academy configuration. The complete demo
              is open to explore.
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error === "link-expired"
                ? "This sign-in link is invalid or has expired. Request a fresh link."
                : error === "forbidden"
                  ? "Your account does not have access to this area."
                  : error === "account-inactive"
                    ? "This academy account has been deactivated. Contact your academy administrator."
                    : "This sign-in option is currently unavailable."}
            </div>
          )}
          {message === "password-updated" && (
            <div className="notice" role="status">
              Password updated. Sign in with your new password.
            </div>
          )}
          {social && (
            <>
              <div className="social-buttons">
                <form action={oauth}>
                  <input type="hidden" name="provider" value="google" />
                  {next && <input type="hidden" name="next" value={next} />}
                  <button
                    className="button secondary full"
                    disabled={!env.google}
                  >
                    <span aria-hidden="true">G</span>Continue with Google
                  </button>
                </form>
                <form action={oauth}>
                  <input type="hidden" name="provider" value="linkedin_oidc" />
                  {next && <input type="hidden" name="next" value={next} />}
                  <button
                    className="button secondary full"
                    disabled={!env.linkedin}
                  >
                    <span aria-hidden="true">in</span>Continue with LinkedIn
                  </button>
                </form>
              </div>
              {(!env.google || !env.linkedin) && (
                <p className="config-caption">
                  Unavailable providers are awaiting configuration.
                </p>
              )}
              <div className="divider">
                <span>or use your email</span>
              </div>
            </>
          )}
          <AuthForm mode={mode} configured={env.configured} next={next} />
          <p className="auth-switch">
            {mode === "login" ? (
              <>
                New to Ducelio? <Link href={switchHref}>Create an account</Link>
              </>
            ) : (
              <Link href={switchHref}>Back to sign in</Link>
            )}
          </p>
          <div className="demo-invite">
            <span>Take a look around first</span>
            <ButtonLink href="/demo" secondary>
              Explore the demo academy <span aria-hidden="true">↗</span>
            </ButtonLink>
            <small>Fictional learner records. No account needed.</small>
          </div>
          <p className="auth-legal">
            Ducelio prepares learners for external examinations. Qualifications
            are awarded by their examination bodies.
          </p>
        </div>
      </main>
    </div>
  );
}
