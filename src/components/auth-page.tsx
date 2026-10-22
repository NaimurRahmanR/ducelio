import Link from "next/link";
import type { ReactNode } from "react";
import { CalendarCheck, ClipboardCheck, GraduationCap } from "lucide-react";
import { Brand, ButtonLink } from "@/components/ui";
import { AuthForm, type AuthMode } from "@/components/auth-form";
import { config } from "@/lib/env";
import { oauth } from "@/app/auth/actions";
import { safeAuthDestination } from "@/domain/auth";
const copy = {
  login: ["Welcome back.", "Sign in to continue learning in your academy."],
  signup: [
    "Create your account.",
    "Join Ducelio and start learning with your AI teaching team.",
  ],
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
// The advertisement for what the academy offers. Approved copy: every line
// describes a capability Ducelio has; no figures, ratings or endorsements.
const FEATURES = [
  {
    icon: CalendarCheck,
    title: "Learn on your schedule",
    text: "Follow a structured curriculum with guided lessons and a study plan that works for you.",
  },
  {
    icon: GraduationCap,
    title: "Your AI learning team",
    text: "Learn with your AI Professor, get tutoring support and build practical skills through guided exercises and labs.",
  },
  {
    icon: ClipboardCheck,
    title: "Prepare. Practise. Prove it.",
    text: "Build confidence through quizzes, timed assessments and exams, with results and progress tracked in your academy.",
  },
] as const;

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.17 3.57-8.65Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.87-3c-1.07.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.95h-4v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.76 0 3.34.6 4.59 1.8l3.43-3.43A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.27 6.6l4 3.1C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}

function LinkedInMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect width="24" height="24" rx="4" fill="#0A66C2" />
      <path
        fill="#fff"
        d="M7.1 9.4H4.6V19h2.5V9.4ZM5.85 5a1.45 1.45 0 1 0 0 2.9 1.45 1.45 0 0 0 0-2.9ZM19.4 13.5c0-2.6-1.4-4.3-3.7-4.3-1.15 0-2 .6-2.4 1.2V9.4h-2.4V19h2.5v-5c0-1.3.5-2.2 1.7-2.2 1.1 0 1.6.8 1.6 2.2v5h2.7v-5.5Z"
      />
    </svg>
  );
}

function ProviderButton({
  provider,
  label,
  mark,
  available,
  next,
}: {
  provider: "google" | "linkedin_oidc";
  label: string;
  mark: ReactNode;
  available: boolean;
  next?: string;
}) {
  return (
    <form action={oauth}>
      <input type="hidden" name="provider" value={provider} />
      {next && <input type="hidden" name="next" value={next} />}
      <button className="auth-provider" disabled={!available}>
        {mark}
        <span>Continue with {label}</span>
        {!available && <span className="auth-provider-state">Unavailable</span>}
      </button>
    </form>
  );
}

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
  // The form comes first in the document, so keyboard, screen-reader and
  // small-screen users reach it immediately; on wide screens the grid places
  // the academy story in the left column.
  return (
    <div className="auth-layout">
      <main id="main" tabIndex={-1} className="auth-main">
        <div className="auth-intro">
          <Brand />
          <p>
            Your own AI-powered learning academy. <em>Built around you.</em>
          </p>
          <ul aria-label="What the academy includes">
            <li>Structured courses</li>
            <li>AI teaching team</li>
            <li>Assessments and progress</li>
          </ul>
        </div>
        <div className="auth-panel">
          <p className="auth-kicker">Welcome to Ducelio</p>
          <h1>{title}</h1>
          <p className="auth-lede">{subtitle}</p>
          {!env.configured && (
            <div className="auth-notice">
              Live sign-in is awaiting academy configuration. The complete demo
              is open to explore.
            </div>
          )}
          {error && (
            <div className="auth-notice error" role="alert">
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
            <div className="auth-notice success" role="status">
              Password updated. Sign in with your new password.
            </div>
          )}
          {social && (
            <>
              <div className="auth-providers">
                <ProviderButton
                  provider="google"
                  label="Google"
                  mark={<GoogleMark />}
                  available={env.google}
                  next={next}
                />
                <ProviderButton
                  provider="linkedin_oidc"
                  label="LinkedIn"
                  mark={<LinkedInMark />}
                  available={env.linkedin}
                  next={next}
                />
              </div>
              {(!env.google || !env.linkedin) && (
                <p className="auth-caption">
                  Unavailable providers are awaiting configuration.
                </p>
              )}
              <div className="auth-divider">
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
            ) : mode === "signup" ? (
              <>
                Already have an account? <Link href={switchHref}>Sign in</Link>
              </>
            ) : (
              <Link href={switchHref}>Back to sign in</Link>
            )}
          </p>
          {social && (
            <div className="auth-demo">
              <div>
                <strong>Take a look around first</strong>
                <span>Fictional learner records. No account needed.</span>
              </div>
              <ButtonLink href="/demo" secondary>
                Explore the demo academy <span aria-hidden="true">↗</span>
              </ButtonLink>
            </div>
          )}
          <p className="auth-legal">
            Ducelio prepares learners for external examinations. Qualifications
            are awarded by their examination bodies.
          </p>
        </div>
      </main>
      <aside className="auth-story" aria-labelledby="auth-story-title">
        <Brand />
        <div className="auth-story-body">
          <p className="auth-story-eyebrow">More than an online course</p>
          <h2 id="auth-story-title">
            Your own AI-powered learning academy.
            <em>Built around you.</em>
          </h2>
          <p className="auth-story-lede">
            Choose your course, plan your schedule and learn with your AI
            teaching team. Practise what you&apos;ve learned, take structured
            assessments and see how you&apos;re progressing—all in one place.
          </p>
          <ol className="auth-features">
            {FEATURES.map(({ icon: Icon, title: feature, text }, i) => (
              <li key={feature}>
                <span className="auth-feature-mark" aria-hidden="true">
                  <Icon size={18} strokeWidth={1.75} />
                  <span>{String(i + 1).padStart(2, "0")}</span>
                </span>
                <div>
                  <h3>{feature}</h3>
                  <p>{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <p className="auth-story-close">
          From your first lesson to your final assessment.
        </p>
      </aside>
    </div>
  );
}
