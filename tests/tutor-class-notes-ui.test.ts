import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AC-4: learner UI for supplementary Tutor notes. Presentation only; the
// database and server decide what exists (tutor-class-notes-db.test.ts).
const mocks = vi.hoisted(() => ({
  actionState: {} as Record<string, unknown>,
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useActionState: () => [mocks.actionState, () => undefined, false],
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
vi.mock("@/app/student/practicals/actions", () => ({
  requestTutorLabSupportAction: vi.fn(),
  requestPracticalSupportAction: vi.fn(),
  submitPracticalLabWorkAction: vi.fn(),
}));

import { TutorLabSupportPanel } from "@/components/practical-support";
import { TutorClassNotes } from "@/components/tutor-class-notes";
import {
  TUTOR_CLASS_NOTE_ACTIVITY_BLOCKED,
  TUTOR_CLASS_NOTE_DISCLOSURE,
  TUTOR_CLASS_NOTE_OPT_IN_LABEL,
  TUTOR_CLASS_NOTE_UNAVAILABLE,
  tutorClassNoteOutcomeMessage,
  type LearnerTutorClassNote,
} from "@/domain/tutor-class-notes";

const HANDOFF = "40000000-0000-4000-8000-000000000009";
const POSITIVE_CLAIMS =
  /\b(mastered|passed|verified|attended|completed|graded|official curriculum update)\b/i;

beforeEach(() => {
  mocks.actionState = {};
});

function panel(lab: boolean) {
  return renderToStaticMarkup(
    createElement(TutorLabSupportPanel, { handoffId: HANDOFF, lab }),
  );
}
const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

describe("Tutor support panel (AC-4 opt-in)", () => {
  it("offers the Tutor-only, pre-request choice to keep the answer, labelled as not course material", () => {
    const html = decode(panel(false));
    expect(html).toContain('name="saveAsClassNote"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain(TUTOR_CLASS_NOTE_OPT_IN_LABEL);
    expect(html).toContain("not course material");
    // The only learner-supplied fields: no note text, source or provenance.
    const names = [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(
      ["handoffId", "idempotencyKey", "message", "saveAsClassNote"].sort(),
    );
  });

  it("never offers note keeping for the Lab Instructor", () => {
    const html = panel(true);
    expect(html).not.toContain("saveAsClassNote");
    expect(html).not.toContain("Tutor note");
  });

  it("confirms a kept note with its revision and a link to the learner's notes", () => {
    mocks.actionState = {
      status: "SUCCEEDED",
      text: "Least privilege means minimum access.",
      role: "TUTOR",
      classNote: { state: "SAVED", revisionNumber: 3 },
    };
    const html = decode(panel(false));
    expect(html).toContain("Tutor: Least privilege means minimum access.");
    expect(html).toContain(
      "Kept as a supplementary Tutor note (revision 3). It is not published course material.",
    );
    expect(html).toContain('href="/student/tutor-notes"');
    expect(html).not.toMatch(POSITIVE_CLAIMS);
  });

  it.each([
    ["LIMIT_REACHED", "maximum of 10 note revisions"],
    ["TOO_LONG", "8,000-character note limit"],
    ["ACTIVITY_BLOCKED", "a controlled assessment is active"],
    ["UNAVAILABLE", "could not be kept as a Tutor note right now"],
  ] as const)(
    "explains a %s note outcome without hiding the answer",
    (reason, text) => {
      mocks.actionState = {
        status: "SUCCEEDED",
        text: "Answer still shown",
        role: "TUTOR",
        classNote: { state: "NOT_SAVED", reason },
      };
      const html = decode(panel(false));
      expect(html).toContain("Answer still shown");
      expect(html).toContain(text);
      expect(html).not.toContain('href="/student/tutor-notes"');
      expect(
        tutorClassNoteOutcomeMessage({ state: "NOT_SAVED", reason }),
      ).toContain(text);
    },
  );
});

function sampleNote(
  overrides: Partial<LearnerTutorClassNote> = {},
): LearnerTutorClassNote {
  return {
    lessonTitle: "Access Control Fundamentals",
    objectiveDescription: "Explain least privilege",
    reasonCode: "OBJECTIVE_REINFORCEMENT",
    createdAt: "2026-10-06T10:00:00Z",
    revisionCount: 2,
    revisions: [
      {
        revisionNumber: 2,
        current: true,
        body: "Current Tutor explanation <script>alert(1)</script>",
        createdAt: "2026-10-06T11:00:00Z",
      },
      {
        revisionNumber: 1,
        current: false,
        body: "Earlier Tutor explanation",
        createdAt: "2026-10-06T10:00:00Z",
      },
    ],
    ...overrides,
  };
}

describe("Supplementary Tutor notes page", () => {
  it("labels notes as supplementary Tutor support, distinct from published course material, with current and earlier revisions", () => {
    const html = decode(
      renderToStaticMarkup(
        createElement(TutorClassNotes, {
          page: {
            status: "OK",
            page: 0,
            hasMore: false,
            notes: [sampleNote()],
          },
        }),
      ),
    );
    expect(html).toContain("Supplementary Tutor notes");
    expect(html).toContain("SUPPLEMENTARY TUTOR NOTE");
    expect(html).toContain("NOT COURSE MATERIAL");
    expect(html).toContain(TUTOR_CLASS_NOTE_DISCLOSURE);
    expect(html).toContain("Access Control Fundamentals");
    expect(html).toContain("Objective: Explain least privilege");
    expect(html).toContain("Revision 2 (current)");
    expect(html).toContain("Revision 1 (earlier)");
    expect(html).toContain(
      "Earlier revisions (1). Each is an earlier Tutor answer, kept unchanged.",
    );
    expect(html.indexOf("Revision 2 (current)")).toBeLessThan(
      html.indexOf("Revision 1 (earlier)"),
    );
    expect(html).not.toMatch(POSITIVE_CLAIMS);
  });

  it("renders note text as text, never as HTML", () => {
    const html = renderToStaticMarkup(
      createElement(TutorClassNotes, {
        page: { status: "OK", page: 0, hasMore: false, notes: [sampleNote()] },
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows no execution, provenance, handoff, behaviour or runtime internals", () => {
    const html = renderToStaticMarkup(
      createElement(TutorClassNotes, {
        page: { status: "OK", page: 0, hasMore: false, notes: [sampleNote()] },
      }),
    );
    expect(html).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(html).not.toMatch(
      /provenance|execution|fingerprint|TUTOR_BEHAVIOUR|COMMERCIAL_V1|hmac|OBJECTIVE_REINFORCEMENT/i,
    );
  });

  it("presents the firewall, unavailability and the empty state", () => {
    const render = (page: Parameters<typeof TutorClassNotes>[0]["page"]) =>
      decode(renderToStaticMarkup(createElement(TutorClassNotes, { page })));
    expect(render({ status: "ACTIVITY_BLOCKED" })).toContain(
      TUTOR_CLASS_NOTE_ACTIVITY_BLOCKED,
    );
    expect(render({ status: "ACTIVITY_BLOCKED" })).not.toContain("Revision");
    expect(render({ status: "UNAVAILABLE" })).toContain(
      TUTOR_CLASS_NOTE_UNAVAILABLE,
    );
    expect(
      render({ status: "OK", page: 0, hasMore: false, notes: [] }),
    ).toContain("No Tutor notes kept yet");
  });
});
