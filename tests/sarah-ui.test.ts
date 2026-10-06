import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AC-5: Sarah Mitchell's learner UI and the truth-synced demo persona.
// Presentation only; the database and server decide what exists
// (sarah-db.test.ts, sarah.test.ts).
const mocks = vi.hoisted(() => ({
  // null: each hook renders its own initial state.
  actionState: null as Record<string, unknown> | null,
  pathname: "/student/sarah",
  mode: "ACTIVE_COURSE" as string | null,
  proposals: null as unknown,
  feedback: { status: "OK", opportunities: [] } as unknown,
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useActionState: (_action: unknown, initial: unknown) => [
      mocks.actionState ?? initial,
      () => undefined,
      false,
    ],
  };
});
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/app/student/sarah/actions", () => ({
  askSarahAction: vi.fn(),
  decideSarahProposalAction: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireActor: async () => ({
    id: "10000000-0000-4000-8000-000000000001",
    displayName: "Alex Morgan",
    roles: ["STUDENT"],
  }),
  requireStudentPrincipal: async () => ({
    id: "10000000-0000-4000-8000-000000000001",
    displayName: "Alex Morgan",
    roles: ["STUDENT"],
  }),
}));
vi.mock("@/server/sarah", () => ({
  getMySarahMode: async () => mocks.mode,
  listMySarahProposals: async () => mocks.proposals,
}));
// AC-6: the page also lists deterministic session-feedback prompts.
vi.mock("@/server/session-feedback", () => ({
  listMySessionFeedbackOpportunities: async () => mocks.feedback,
}));
vi.mock("@/app/student/sarah/feedback-actions", () => ({
  submitSessionFeedbackAction: vi.fn(),
}));

import {
  SarahAskPanel,
  SarahProposals,
  submitSarahMessage,
} from "@/components/sarah-guide";
import { AcademyShell } from "@/components/academy-shell";
import { CounsellorCard } from "@/components/student-dashboard";
import SarahPage from "@/app/student/sarah/page";
import DemoCounsellorPage from "@/app/demo/counsellor/page";
import { demo } from "@/demo/academy";
import type { LearnerSarahProposal, SupportProfileView } from "@/domain/sarah";

const Shell = AcademyShell as FunctionComponent<{
  name?: string;
  demo?: boolean;
  children?: ReactNode;
}>;
const current: SupportProfileView = {
  confirmed: true,
  studyGoal: "Build a consistent evening study routine.",
  weeklyHours: 6,
  preferredContact: "ACADEMY",
};
const pending: LearnerSarahProposal = {
  id: "22222222-2222-4222-8222-222222222222",
  state: "PENDING",
  stale: false,
  createdAt: "2026-10-06T12:00:00+00:00",
  decidedAt: null,
  studyGoal: null,
  weeklyHours: 10,
  preferredContact: "EMAIL",
};
// React's own server-rendered form-replay bootstrap, not page content.
const withoutReactRuntime = (html: string) =>
  html.replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/g, "");
const KEY = "44444444-4444-4444-8444-444444444444";
const askPanel = () =>
  renderToStaticMarkup(
    createElement(SarahAskPanel, { initialIdempotencyKey: KEY }),
  );
const panelState = (result: Record<string, unknown>) => ({
  result,
  idempotencyKey: KEY,
});
const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const text = (html: string) =>
  decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
const fieldNames = (html: string) =>
  [...new Set([...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]))].sort();
// Copy that would turn Sarah into a human, teacher, therapist, seller,
// feedback collector or general chatbot.
const FORBIDDEN_CLAIMS =
  /(I am human|I'm human|your assigned counsellor Sarah|Sarah knows you|therapy session|counselling session|rate your class|how was your class|teaching quality|recommended course|best course for you|upgrade|discount|ask me anything|chat about anything|Professor Sarah|Tutor Sarah)/i;

beforeEach(() => {
  mocks.actionState = null;
  mocks.pathname = "/student/sarah";
  mocks.mode = "ACTIVE_COURSE";
  mocks.proposals = { status: "OK", current, proposals: [] };
  mocks.feedback = { status: "OK", opportunities: [] };
});

describe("Sarah ask panel", () => {
  it("offers exactly two AC-5 needs and sends only intent, message and key", () => {
    const html = askPanel();
    expect(fieldNames(html)).toEqual(["idempotencyKey", "intent", "message"]);
    expect(html).toContain('value="GUIDE"');
    expect(html).toContain('value="SUPPORT_PROFILE"');
    expect([...html.matchAll(/name="intent"/g)]).toHaveLength(2);
    const plain = text(html);
    expect(plain).toContain("Getting started, finding my way around Ducelio");
    expect(plain).toContain("does not remember earlier messages");
    expect(plain).toContain("Your message and her reply are not saved.");
    expect(plain).not.toMatch(FORBIDDEN_CLAIMS);
    expect(plain).not.toMatch(/feedback|recommend|course options|price/i);
    expect(html).not.toMatch(/gpt|openai|COUNSELLOR_PLATFORM|model/i);
  });

  it("renders Sarah's reply as text and states proposal truth", () => {
    mocks.actionState = panelState({
      status: "SUCCEEDED",
      reply: "<script>alert(1)</script>Your class is Wednesday.",
      proposal: "PENDING_CONFIRMATION",
    });
    const html = withoutReactRuntime(askPanel());
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const plain = text(html);
    expect(plain).toContain("Sarah Mitchell (AI)");
    expect(plain).toContain("Nothing has changed yet");
    for (const [proposal, expected] of [
      ["NOT_RECORDED_STALE", "was not kept. Nothing has changed."],
      ["NOT_RECORDED_LIMIT", "maximum number of suggestions"],
      ["NOT_RECORDED", "could not be kept. Nothing has changed."],
    ]) {
      mocks.actionState = panelState({
        status: "SUCCEEDED",
        reply: "Hi",
        proposal,
      });
      expect(text(askPanel())).toContain(expected);
    }
    mocks.actionState = panelState({
      status: "SUCCEEDED",
      reply: "Hi",
      proposal: "NONE",
    });
    expect(text(askPanel())).not.toContain("suggest");
  });

  it("shows calm failure states with no internal detail", () => {
    for (const [status, expected] of [
      ["UNAVAILABLE", "Sarah is not available right now."],
      ["RETRY_LATER", "Please try again in a moment."],
      ["DUPLICATE", "This message was already sent."],
    ]) {
      mocks.actionState = panelState({ status });
      const html = askPanel();
      expect(text(html)).toContain(expected);
      // The live result region: the only place an outcome is rendered.
      const region = html.slice(html.indexOf('aria-live="polite"'));
      expect(withoutReactRuntime(region)).not.toMatch(
        /execution|provider|token|MAC|UNTRUSTED|CONTEXT_CONFLICT|[0-9a-f]{8}-[0-9a-f]{4}/,
      );
    }
  });
});

describe("Sarah proposals", () => {
  const render = (proposals: LearnerSarahProposal[]) =>
    renderToStaticMarkup(createElement(SarahProposals, { current, proposals }));

  it("presents a pending proposal as an optional suggestion with current and suggested values and explicit decisions", () => {
    const html = render([pending]);
    const plain = text(html);
    expect(plain).toContain("optional suggestions from Sarah");
    expect(plain).toContain("Nothing changes unless you confirm");
    expect(plain).toContain("Sarah cannot confirm a suggestion for you");
    expect(plain).toContain(
      "Preference Confirmed now Suggested Weekly study hours 6 hours a week 10 hours a week Preferred contact In the academy Email",
    );
    // Only the changed fields are listed in the suggestion itself.
    const table = text(html.slice(html.indexOf("<table")));
    expect(table).not.toContain("Study goal");
    expect(plain).toContain("Confirm this change");
    expect(plain).toContain("Decline");
    expect(plain).toContain("Suggested by Sarah Mitchell (AI)");
    expect(fieldNames(html)).toEqual(["decision", "proposalId"]);
    expect(html).toContain('value="CONFIRM"');
    expect(html).toContain('value="DECLINE"');
    expect(plain).not.toMatch(FORBIDDEN_CLAIMS);
  });

  it("never offers confirmation of a stale proposal, and labels decided ones truthfully", () => {
    const stale = render([{ ...pending, stale: true }]);
    expect(stale).not.toContain('value="CONFIRM"');
    expect(text(stale)).toContain("can no longer be applied");
    const decided = render([
      {
        ...pending,
        state: "CONFIRMED",
        decidedAt: "2026-10-06T12:01:00+00:00",
      },
      {
        ...pending,
        id: "33333333-3333-4333-8333-333333333333",
        state: "STALE",
        decidedAt: "2026-10-06T12:01:00+00:00",
      },
    ]);
    expect(decided).not.toContain('name="decision"');
    expect(text(decided)).toContain("CONFIRMED BY YOU");
    expect(text(decided)).toContain("OUT OF DATE: NOT APPLIED");
  });

  it("reports each decision outcome truthfully", () => {
    for (const [outcome, expected] of [
      ["CONFIRMED", "Your support preferences were updated"],
      ["DECLINED", "Suggestion declined. Nothing changed."],
      ["STALE", "so it was not applied. Nothing changed."],
      ["UNAVAILABLE", "This could not be completed. Nothing changed."],
    ]) {
      mocks.actionState = { outcome };
      const html = render([pending]);
      expect(text(html)).toContain(expected);
      expect(html).not.toContain('name="decision"');
    }
  });

  it("shows the confirmed profile as confirmed data only", () => {
    const plain = text(render([]));
    expect(plain).toContain("Your confirmed support preferences");
    expect(plain).toContain("Build a consistent evening study routine.");
    expect(plain).toContain("No suggestions");
  });
});

describe("Sarah page", () => {
  it("identifies Sarah Mitchell as Ducelio's AI learner-success counsellor, with honest limits", async () => {
    const html = renderToStaticMarkup(await SarahPage());
    const plain = text(html);
    expect(plain).toContain("Sarah Mitchell");
    expect(plain).toContain("Ducelio AI learner-success counsellor");
    expect(plain).toContain("AI");
    expect(plain).toContain("not a human member of staff");
    expect(plain).toContain("not your assigned counsellor");
    expect(plain).toContain("does not teach course content");
    expect(plain).toContain("help with controlled assessments, or grade work");
    expect(plain).toContain("cannot change your records");
    expect(plain).toContain("not a therapist or a crisis service");
    expect(plain).toContain("You are on a course.");
    expect(plain).not.toMatch(FORBIDDEN_CLAIMS);
    expect(plain).not.toMatch(/recommend|next course|re-?enrol|pricing/i);
    // AC-6: feedback appears only in the deterministic session-feedback
    // card, never in Sarah's AI guide or proposals.
    const feedbackCard = plain.indexOf("How did that session go?");
    expect(feedbackCard).toBeGreaterThan(plain.indexOf("Ask Sarah"));
    expect(plain.slice(0, feedbackCard)).not.toMatch(/feedback/i);
  });

  it("degrades safely when proposals cannot be loaded", async () => {
    mocks.proposals = { status: "UNAVAILABLE" };
    mocks.mode = null;
    const plain = text(renderToStaticMarkup(await SarahPage()));
    expect(plain).toContain("could not be loaded right now");
    expect(plain).toContain("Ask Sarah");
  });
});

describe("navigation and the truth-synced demo persona", () => {
  it("links signed-in learners to Sarah, and never from the credential-free demo", () => {
    const live = renderToStaticMarkup(
      createElement(Shell, { name: "Alex Morgan" }, "x"),
    );
    expect(live).toContain('href="/student/sarah"');
    expect(text(live)).toContain("Sarah (AI guide)");
    mocks.pathname = "/demo";
    const preview = renderToStaticMarkup(
      createElement(Shell, { demo: true }, "x"),
    );
    expect(preview).not.toContain("sarah");
  });

  it("keeps Sarah Mitchell's continuity but presents her as AI, not human staff", () => {
    expect(demo.counsellor.name).toBe("Sarah Mitchell");
    expect(demo.counsellor.initials).toBe("SM");
    expect(demo.counsellor.title).toBe("Ducelio AI learner-success counsellor");
    const plain = text(renderToStaticMarkup(createElement(CounsellorCard)));
    expect(plain).toContain("Your AI learner guide");
    expect(plain).toContain("Sarah Mitchell");
    expect(plain).toContain("Sarah is AI");
    expect(plain).toContain("does not replace your human support team");
    expect(plain).not.toMatch(/Your counsellor\b|A familiar face|check-in/i);
    expect(plain).not.toMatch(FORBIDDEN_CLAIMS);
  });

  it("shows a distinct fictional human in the staff workspace preview, never Sarah", () => {
    const plain = text(renderToStaticMarkup(createElement(DemoCounsellorPage)));
    expect(plain).toContain(demo.humanCounsellor.name);
    expect(plain).not.toContain("Sarah Mitchell");
    expect(JSON.stringify(demo)).not.toMatch(/counsellor check-in/i);
  });
});

describe("Sarah ask panel idempotency key (hydration-safe, review Correction 7)", () => {
  it("renders the server-provided key, so server render and hydration agree", () => {
    const first = askPanel();
    expect(first).toContain(`name="idempotencyKey" value="${KEY}"`);
    expect(askPanel()).toBe(first);
  });

  it("rotates to a fresh key after every resolved response, including DUPLICATE, and keeps it while unresolved", async () => {
    const form = new FormData();
    const previous = { result: {}, idempotencyKey: KEY };
    for (const result of [
      { status: "DUPLICATE" as const },
      { status: "SUCCEEDED" as const, reply: "Hi", proposal: "NONE" as const },
      { status: "RETRY_LATER" as const },
      { error: "Choose what you need and enter 1 to 1,000 characters." },
    ]) {
      const next = await submitSarahMessage(
        previous,
        form,
        async () => result,
        () => "55555555-5555-4555-8555-555555555555",
      );
      expect(next).toEqual({
        result,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      });
    }
    const unresolved = await submitSarahMessage(
      previous,
      form,
      async () => {
        throw new Error("network");
      },
      () => "66666666-6666-4666-8666-666666666666",
    );
    expect(unresolved).toEqual({
      result: { status: "RETRY_LATER" },
      idempotencyKey: KEY,
    });
  });

  it("does not generate a key during render", () => {
    const source = readFileSync(
      resolve("src/components/sarah-guide.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/useState\(newIdempotencyKey\)/);
    expect(source).not.toContain("setIdempotencyKey");
    const page = readFileSync(
      resolve("src/app/student/sarah/page.tsx"),
      "utf8",
    );
    expect(page).toContain("initialIdempotencyKey={randomUUID()}");
  });
});
