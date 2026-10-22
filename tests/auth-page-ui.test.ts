import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared sign-in, sign-up, recovery, reset and verification screens,
// rendered through the real AuthPage and AuthForm. Only configuration and
// the server actions are stubbed: nothing here signs in or sends email.
const m = vi.hoisted(() => ({
  env: { configured: true, google: true, linkedin: true },
}));
vi.mock("@/lib/env", () => ({
  config: () => ({
    url: "",
    key: "",
    appUrl: "http://127.0.0.1:3000",
    ...m.env,
  }),
}));
vi.mock("@/app/auth/actions", () => ({
  login: vi.fn(),
  signup: vi.fn(),
  forgotPassword: vi.fn(),
  resetPassword: vi.fn(),
  resendVerification: vi.fn(),
  oauth: vi.fn(),
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

import { AuthPage } from "@/components/auth-page";
import type { AuthMode } from "@/components/auth-form";

const render = (props: {
  mode: AuthMode;
  error?: string;
  message?: string;
  next?: string;
}) => renderToStaticMarkup(createElement(AuthPage, props));
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const story = (html: string) =>
  text(html.slice(html.indexOf('<aside class="auth-story"')));
const MODES: AuthMode[] = [
  "login",
  "signup",
  "forgot-password",
  "reset-password",
  "verify-email",
];

beforeEach(() => {
  m.env = { configured: true, google: true, linkedin: true };
});

describe("the academy story", () => {
  it("carries the approved copy, in order, on every authentication screen", () => {
    for (const mode of MODES) {
      const s = story(render({ mode }));
      const expected = [
        "DUCELIO",
        "THE DIGITAL ACADEMY",
        "More than an online course",
        "Your own AI-powered learning academy.",
        "Built around you.",
        "Choose your course, plan your schedule and learn with your AI teaching team. Practise what you've learned, take structured assessments and see how you're progressing—all in one place.",
        "01",
        "Learn on your schedule",
        "Follow a structured curriculum with guided lessons and a study plan that works for you.",
        "02",
        "Your AI learning team",
        "Learn with your AI Professor, get tutoring support and build practical skills through guided exercises and labs.",
        "03",
        "Prepare. Practise. Prove it.",
        "Build confidence through quizzes, timed assessments and exams, with results and progress tracked in your academy.",
        "From your first lesson to your final assessment.",
      ];
      let at = 0;
      for (const line of expected) {
        const found = s.indexOf(line, at);
        expect(found, `${mode}: ${line}`).toBeGreaterThanOrEqual(0);
        at = found + line.length;
      }
    }
  });

  it("makes no unsupported claims", () => {
    const s = story(render({ mode: "signup" })).replace(/\b0[123]\b/g, "");
    expect(s).not.toMatch(
      /\d|guarantee|accredit|endorse|official|rated|testimonial|★/i,
    );
  });

  it("keeps one h1 (the form) and marks decoration as hidden", () => {
    for (const mode of MODES) {
      const html = render({ mode });
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toMatch(/<h2 id="auth-story-title"/);
      expect(html.match(/<h3/g)).toHaveLength(3);
      expect(html).toContain('aria-labelledby="auth-story-title"');
      expect(html).toMatch(/class="auth-feature-mark" aria-hidden="true"/);
      // The form precedes the story, so it is reached first.
      expect(html.indexOf('<main id="main"')).toBeLessThan(
        html.indexOf('<aside class="auth-story"'),
      );
    }
  });
});

describe("sign in", () => {
  it("keeps the email and password contract and its navigation", () => {
    const html = render({ mode: "login" });
    expect(html).toMatch(
      /<input[^>]*id="email"[^>]*type="email"[^>]*autoComplete="email"[^>]*required=""/,
    );
    expect(html).toMatch(
      /<input[^>]*id="password"[^>]*autoComplete="current-password"[^>]*minLength="1"[^>]*maxLength="128"[^>]*required=""/,
    );
    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain('href="/signup"');
    expect(html).toContain('href="/demo"');
    expect(text(html)).toContain("Sign in to your academy");
    expect(text(html)).toContain(
      "Qualifications are awarded by their examination bodies.",
    );
  });

  it("offers configured providers as working buttons", () => {
    const html = render({ mode: "login" });
    expect(html.match(/class="auth-provider"(?! disabled)/g)).toHaveLength(2);
    expect(html).not.toContain("Unavailable");
    expect(html).toContain('value="google"');
    expect(html).toContain('value="linkedin_oidc"');
  });

  it("never presents an unconfigured provider as working", () => {
    m.env = { configured: true, google: false, linkedin: true };
    const html = render({ mode: "login" });
    expect(html).toMatch(
      /<button class="auth-provider" disabled="">[\s\S]*?Continue with Google[\s\S]*?Unavailable/,
    );
    expect(text(html)).toContain(
      "Unavailable providers are awaiting configuration.",
    );
  });

  it("disables the form, truthfully, when sign-in is not configured", () => {
    m.env = { configured: false, google: false, linkedin: false };
    const html = render({ mode: "login" });
    expect(text(html)).toContain(
      "Live sign-in is awaiting academy configuration.",
    );
    expect(html).toMatch(/<input[^>]*id="email"[^>]*disabled=""/);
    expect(html).toMatch(
      /<button class="auth-submit" type="submit" disabled=""/,
    );
  });

  it("shows its existing error and status messages accessibly", () => {
    for (const [error, message] of [
      ["forbidden", "Your account does not have access to this area."],
      ["link-expired", "This sign-in link is invalid or has expired."],
      ["account-inactive", "This academy account has been deactivated."],
      ["provider-unavailable", "This sign-in option is currently unavailable."],
    ]) {
      const html = render({ mode: "login", error });
      expect(html).toMatch(/class="auth-notice error" role="alert"/);
      expect(text(html)).toContain(message);
    }
    expect(
      text(render({ mode: "login", message: "password-updated" })),
    ).toContain("Password updated. Sign in with your new password.");
    // The form's own result region is always present and polite.
    expect(render({ mode: "login" })).toContain(
      'class="auth-feedback" aria-live="polite"',
    );
  });
});

describe("return destinations", () => {
  it("carries a validated destination through every form and the switch link", () => {
    const html = render({ mode: "login", next: "/courses/security-plus" });
    expect(
      html.match(/name="next" value="\/courses\/security-plus"/g),
    ).toHaveLength(3);
    expect(html).toContain('href="/signup?next=%2Fcourses%2Fsecurity-plus"');
  });

  it("drops an unsafe or unlisted destination", () => {
    for (const next of [
      "https://outside.example/admin",
      "/admin/people",
      "//x",
    ]) {
      const html = render({ mode: "signup", next });
      expect(html).not.toContain('name="next"');
      expect(html).toContain('href="/login"');
    }
  });
});

describe("sign up", () => {
  it("keeps its fields, password policy and the way back to sign in", () => {
    const html = render({ mode: "signup" });
    expect(html).toMatch(
      /<input[^>]*id="displayName"[^>]*autoComplete="name"[^>]*maxLength="100"[^>]*required=""/,
    );
    expect(html).toMatch(
      /<input[^>]*id="password"[^>]*autoComplete="new-password"[^>]*minLength="12"[^>]*maxLength="128"[^>]*required=""[^>]*aria-describedby="password-hint"/,
    );
    expect(html).toContain('id="password-hint"');
    expect(html.match(/<input(?![^>]*type="hidden")/g)).toHaveLength(3);
    const plain = text(html);
    expect(plain).toContain("Create your account");
    expect(plain).toContain("Already have an account? Sign in");
    expect(html).toContain('href="/login"');
  });
});

describe("recovery, reset and verification", () => {
  it("share the layout without provider sign-in or the demo invitation", () => {
    for (const mode of [
      "forgot-password",
      "reset-password",
      "verify-email",
    ] as const) {
      const html = render({ mode });
      expect(html).toContain('class="auth-layout"');
      expect(html).not.toContain("auth-provider");
      expect(html).not.toContain('href="/demo"');
      expect(text(html)).toContain("Back to sign in");
    }
  });

  it("keep their own fields", () => {
    const reset = render({ mode: "reset-password" });
    expect(reset).toContain('id="confirmPassword"');
    expect(reset).not.toContain('id="email"');
    expect(text(reset)).toContain("Save new password");
    expect(text(render({ mode: "forgot-password" }))).toContain(
      "Send reset link",
    );
    expect(text(render({ mode: "verify-email" }))).toContain(
      "Resend verification email",
    );
  });
});
