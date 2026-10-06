import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AC-4: the domain contract, the trusted note recorder, the learner-safe
// read and the Server Action. Identity and Supabase are stubbed; database
// authority is proven in tutor-class-notes-db.test.ts.
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getAuthenticatedActor: vi.fn(),
  requireStudentPrincipal: vi.fn(),
  executeTutorLabSupport: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: mocks.getAuthenticatedActor,
  requireStudentPrincipal: mocks.requireStudentPrincipal,
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/server/tutor-lab-execution", () => ({
  executeTutorLabSupport: mocks.executeTutorLabSupport,
}));
vi.mock("@/server/course-activation", () => ({
  requestPracticalSupport: vi.fn(),
}));

import {
  TutorClassNoteRefused,
  listMyTutorClassNotes,
  recordTutorClassNote,
} from "@/server/tutor-class-notes";
import {
  TUTOR_CLASS_NOTE_BODY_MAX,
  isStorableTutorClassNoteBody,
  learnerTutorClassNoteListSchema,
  tutorClassNoteOutcomeForRefusal,
  tutorClassNoteRefusalCodes,
} from "@/domain/tutor-class-notes";
import { tutorLabSupportRequestSchema } from "@/domain/tutor-lab-execution";
import { requestTutorLabSupportAction } from "@/app/student/practicals/actions";

const STUDENT = "10000000-0000-4000-8000-0000000000aa";
const EXECUTION = "aaaaaaaa-0000-4000-8000-000000000001";
const ENROLMENT = "cccccccc-0000-4000-8000-000000000001";
const HANDOFF = "40000000-0000-4000-8000-000000000009";
const KEY_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const KEY_HEX = "ab".repeat(32);

const previousEnv = { ...process.env };
beforeEach(() => {
  vi.resetAllMocks();
  process.env.ACADEMIC_EXECUTION_KEY_ID = KEY_ID;
  process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX = KEY_HEX;
  mocks.getAuthenticatedActor.mockResolvedValue({
    id: STUDENT,
    roles: ["STUDENT"],
  });
  mocks.requireStudentPrincipal.mockResolvedValue({
    id: STUDENT,
    roles: ["STUDENT"],
  });
});
afterEach(() => {
  process.env = { ...previousEnv };
});

function note(overrides: Record<string, unknown> = {}) {
  return {
    lessonTitle: "Access Control",
    objectiveDescription: null,
    reasonCode: "MISSED_LESSON_PRACTICE",
    createdAt: "2026-10-06T10:00:00Z",
    revisionCount: 2,
    revisions: [
      {
        revisionNumber: 2,
        current: true,
        body: "Second answer",
        createdAt: "2026-10-06T11:00:00Z",
      },
      {
        revisionNumber: 1,
        current: false,
        body: "First answer",
        createdAt: "2026-10-06T10:00:00Z",
      },
    ],
    ...overrides,
  };
}
const page = (notes: unknown[], extra: Record<string, unknown> = {}) => ({
  ok: true,
  page: 0,
  pageSize: 5,
  hasMore: false,
  notes,
  ...extra,
});

describe("domain contract", () => {
  it("the Tutor support request accepts only a boolean note choice and never note text, source or provenance", () => {
    const base = {
      handoffId: HANDOFF,
      message: "Help",
      idempotencyKey: EXECUTION,
    };
    expect(
      tutorLabSupportRequestSchema.safeParse({ ...base, saveAsClassNote: true })
        .success,
    ).toBe(true);
    expect(tutorLabSupportRequestSchema.safeParse(base).success).toBe(true);
    for (const extra of [
      { saveAsClassNote: "on" },
      { noteBody: "Forged Tutor note" },
      { sourceExecutionId: EXECUTION },
      { provenanceId: EXECUTION },
      { role: "TUTOR" },
      { studentId: STUDENT },
      { enrolmentId: ENROLMENT },
      { runtimeProfileRef: "TUTOR_COMMERCIAL_V1" },
      { behaviourVersion: "TUTOR_BEHAVIOUR_V2" },
    ])
      expect(
        tutorLabSupportRequestSchema.safeParse({ ...base, ...extra }).success,
      ).toBe(false);
  });

  it("bounds the body by code points, exactly as PostgreSQL counts it", () => {
    expect(
      isStorableTutorClassNoteBody("x".repeat(TUTOR_CLASS_NOTE_BODY_MAX)),
    ).toBe(true);
    expect(
      isStorableTutorClassNoteBody("x".repeat(TUTOR_CLASS_NOTE_BODY_MAX + 1)),
    ).toBe(false);
    // 8,000 astral characters are 16,000 UTF-16 units but 8,000 characters.
    expect(
      isStorableTutorClassNoteBody("𝔸".repeat(TUTOR_CLASS_NOTE_BODY_MAX)),
    ).toBe(true);
    expect(
      isStorableTutorClassNoteBody("𝔸".repeat(TUTOR_CLASS_NOTE_BODY_MAX + 1)),
    ).toBe(false);
    expect(isStorableTutorClassNoteBody("")).toBe(false);
    expect(isStorableTutorClassNoteBody("  \n ")).toBe(false);
    expect(isStorableTutorClassNoteBody("a\u0000b")).toBe(false);
  });

  it("the learner projection refuses internal identifiers and inconsistent history", () => {
    expect(
      learnerTutorClassNoteListSchema.safeParse(page([note()])).success,
    ).toBe(true);
    for (const forged of [
      note({ sourceTutorExecutionId: EXECUTION }),
      note({ seriesId: EXECUTION }),
      note({ handoffId: HANDOFF }),
      note({
        revisions: [
          { ...note().revisions[0], provenanceId: EXECUTION },
          note().revisions[1],
        ],
      }),
      note({
        revisions: [
          { ...note().revisions[0], behaviourFingerprint: "a".repeat(64) },
          note().revisions[1],
        ],
      }),
      note({ revisionCount: 3 }),
      note({ revisions: [note().revisions[1], note().revisions[0]] }),
      note({
        revisions: [
          { ...note().revisions[0], current: false },
          note().revisions[1],
        ],
      }),
      note({
        revisions: [
          note().revisions[0],
          { ...note().revisions[1], current: true },
        ],
      }),
      note({
        reasonCode: "OBJECTIVE_REINFORCEMENT",
        objectiveDescription: null,
      }),
      note({ reasonCode: "PRACTICAL_HELP" }),
    ])
      expect(
        learnerTutorClassNoteListSchema.safeParse(page([forged])).success,
      ).toBe(false);
    expect(
      learnerTutorClassNoteListSchema.safeParse(
        page([note()], { runtimeProfileRef: "X" }),
      ).success,
    ).toBe(false);
    expect(
      learnerTutorClassNoteListSchema.safeParse(page(Array(6).fill(note())))
        .success,
    ).toBe(false);
  });

  it("maps every refusal to a bounded learner outcome", () => {
    for (const code of [
      ...tutorClassNoteRefusalCodes,
      "SERVICE_UNAVAILABLE" as const,
    ]) {
      const outcome = tutorClassNoteOutcomeForRefusal(code);
      expect(outcome.state).toBe("NOT_SAVED");
      expect(
        code === "REVISION_LIMIT_REACHED"
          ? "LIMIT_REACHED"
          : code === "ACTIVITY_BLOCKED"
            ? "ACTIVITY_BLOCKED"
            : "UNAVAILABLE",
      ).toBe(outcome.state === "NOT_SAVED" ? outcome.reason : null);
    }
  });
});

describe("recordTutorClassNote (trusted controller write)", () => {
  it("sends only the execution id, body and a MAC over the new protocol tag and the body digest", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, duplicate: false, revisionNumber: 1 },
      error: null,
    });
    const body = "Access control limits who may use a resource.";
    await expect(
      recordTutorClassNote({ executionId: EXECUTION.toUpperCase(), body }),
    ).resolves.toEqual({ revisionNumber: 1, duplicate: false });
    const [name, args] = mocks.rpc.mock.calls[0];
    expect(name).toBe("record_tutor_class_note");
    expect(Object.keys(args).sort()).toEqual(
      [
        "p_body",
        "p_execution_id",
        "p_expires_at",
        "p_issued_at",
        "p_key_id",
        "p_mac",
      ].sort(),
    );
    expect(args.p_execution_id).toBe(EXECUTION);
    expect(args.p_body).toBe(body);
    expect(args.p_expires_at).toBe(args.p_issued_at + 10);
    // The exact canonical message migration 053 verifies.
    const canonical = [
      "DUCELIO_TUTOR_CLASS_NOTE_HMAC_SHA256_V1",
      "TUTOR",
      KEY_ID,
      STUDENT,
      EXECUTION,
      createHash("sha256").update(body, "utf8").digest("hex"),
      String(args.p_issued_at),
      String(args.p_expires_at),
    ].join("\n");
    expect(args.p_mac).toBe(
      createHmac("sha256", Buffer.from(KEY_HEX, "hex"))
        .update(canonical)
        .digest("hex"),
    );
  });

  it("requires a STUDENT actor, a storable body and controller key material before any call", async () => {
    mocks.getAuthenticatedActor.mockResolvedValueOnce({
      id: STUDENT,
      roles: ["ACADEMIC_ADMIN"],
    });
    await expect(
      recordTutorClassNote({ executionId: EXECUTION, body: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      recordTutorClassNote({
        executionId: EXECUTION,
        body: "x".repeat(TUTOR_CLASS_NOTE_BODY_MAX + 1),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    delete process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX;
    await expect(
      recordTutorClassNote({ executionId: EXECUTION, body: "x" }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps database refusals to typed codes and fails closed on malformed results", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, code: "REVISION_LIMIT_REACHED" },
      error: null,
    });
    await expect(
      recordTutorClassNote({ executionId: EXECUTION, body: "x" }),
    ).rejects.toEqual(new TutorClassNoteRefused("REVISION_LIMIT_REACHED"));
    for (const data of [
      { ok: false, code: "SOMETHING_NEW" },
      { ok: true, duplicate: false, revisionNumber: 11 },
      { ok: true, duplicate: false, revisionNumber: 1, body: "leak" },
      null,
    ]) {
      mocks.rpc.mockResolvedValueOnce({ data, error: null });
      await expect(
        recordTutorClassNote({ executionId: EXECUTION, body: "x" }),
      ).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
    }
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(
      recordTutorClassNote({ executionId: EXECUTION, body: "x" }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});

describe("listMyTutorClassNotes (learner-safe read)", () => {
  it("passes only the enrolment and page, and returns the strict projection", async () => {
    mocks.rpc.mockResolvedValue({ data: page([note()]), error: null });
    const result = await listMyTutorClassNotes({
      enrolmentId: ENROLMENT,
      page: 0,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("list_my_tutor_class_notes", {
      p_enrolment_id: ENROLMENT,
      p_page: 0,
    });
    expect(result).toEqual({
      status: "OK",
      page: 0,
      hasMore: false,
      notes: [note()],
    });
  });

  it("reports the firewall, and is UNAVAILABLE on any other refusal, malformed data or invalid input", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, code: "ACTIVITY_BLOCKED" },
      error: null,
    });
    expect(
      await listMyTutorClassNotes({ enrolmentId: ENROLMENT, page: 0 }),
    ).toEqual({ status: "ACTIVITY_BLOCKED" });
    for (const data of [
      { ok: false, code: "NOT_FOUND_OR_FORBIDDEN" },
      page([note({ sourceTutorExecutionId: EXECUTION })]),
      page([note()], { page: 1 }),
    ]) {
      mocks.rpc.mockResolvedValueOnce({ data, error: null });
      expect(
        await listMyTutorClassNotes({ enrolmentId: ENROLMENT, page: 0 }),
      ).toEqual({ status: "UNAVAILABLE" });
    }
    mocks.rpc.mockClear();
    for (const input of [
      { enrolmentId: "nope", page: 0 },
      { enrolmentId: ENROLMENT, page: 50 },
      { enrolmentId: ENROLMENT, page: 0, studentId: STUDENT },
    ])
      expect(await listMyTutorClassNotes(input)).toEqual({
        status: "UNAVAILABLE",
      });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("requestTutorLabSupportAction (AC-4)", () => {
  function form(fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.append(key, value);
    return data;
  }

  it("reads only the checkbox; forged note text, source, provenance or role fields never reach the runtime", async () => {
    mocks.executeTutorLabSupport.mockResolvedValue({
      status: "SUCCEEDED",
      text: "Tutor answer",
      role: "TUTOR",
      classNote: { state: "SAVED", revisionNumber: 1 },
    });
    const result = await requestTutorLabSupportAction(
      {},
      form({
        handoffId: HANDOFF,
        message: "Help",
        idempotencyKey: EXECUTION,
        saveAsClassNote: "on",
        noteBody: "Forged Tutor note",
        sourceExecutionId: EXECUTION,
        provenanceId: EXECUTION,
        role: "TUTOR",
      }),
    );
    expect(mocks.executeTutorLabSupport).toHaveBeenCalledExactlyOnceWith({
      handoffId: HANDOFF,
      message: "Help",
      idempotencyKey: EXECUTION,
      saveAsClassNote: true,
    });
    expect(result).toEqual({
      status: "SUCCEEDED",
      text: "Tutor answer",
      role: "TUTOR",
      classNote: { state: "SAVED", revisionNumber: 1 },
    });
  });

  it("without the checkbox, or with any other value, no note is requested", async () => {
    mocks.executeTutorLabSupport.mockResolvedValue({ status: "RETRY_LATER" });
    const extras: Record<string, string>[] = [
      {},
      { saveAsClassNote: "true" },
      { saveAsClassNote: "" },
    ];
    for (const extra of extras) {
      await requestTutorLabSupportAction(
        {},
        form({
          handoffId: HANDOFF,
          message: "Help",
          idempotencyKey: EXECUTION,
          ...extra,
        }),
      );
    }
    for (const [args] of mocks.executeTutorLabSupport.mock.calls)
      expect(args).not.toHaveProperty("saveAsClassNote");
  });
});

describe("static boundaries (AC-4)", () => {
  it("keeps the Tutor behaviour contract at V2: class notes need no new Level-2 version", async () => {
    const behaviour = await import("@/domain/agent-behaviour");
    expect(behaviour.ROLE_BEHAVIOUR_VERSION.TUTOR).toBe("TUTOR_BEHAVIOUR_V2");
    expect(behaviour.roleBaselineFor("TUTOR", "TUTOR_BEHAVIOUR_V3")).toBeNull();
    const { readFileSync } = await import("node:fs");
    const migration = readFileSync(
      "supabase/migrations/202610060053_tutor_class_notes.sql",
      "utf8",
    );
    expect(migration).not.toMatch(/role_behaviour_version\s*\(/);
    expect(migration).not.toContain("TUTOR_BEHAVIOUR_V3");
  });

  it("migration 053 never writes curriculum or learning_resources, and adds no CLASS_NOTE resource kind", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      "supabase/migrations/202610060053_tutor_class_notes.sql",
      "utf8",
    )
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(
      /(insert\s+into|update|delete\s+from|alter\s+table)\s+public\.(learning_resources|programme_versions|modules|lessons|lesson_objectives|course_practicals|course_package_imports|learning_evidence|objective_mastery|lesson_progress|attendance_records|enrolments)\b/i,
    );
    expect(sql).not.toContain("CLASS_NOTE'");
    expect(sql).not.toMatch(
      /assessment_answer_keys|expected_answer|marking_guidance/,
    );
  });

  it("the note modules never reference protected assessment content or a service role", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "src/server/tutor-class-notes.ts",
      "src/domain/tutor-class-notes.ts",
      "src/components/tutor-class-notes.tsx",
      "src/app/student/tutor-notes/page.tsx",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(
        /assessment_answer_keys|expectedAnswer|expected_answer|markingGuidance|marking_guidance|SERVICE_ROLE|service_role|dangerouslySetInnerHTML/,
      );
    }
  });
});

describe("independent-review corrections (AC-4)", () => {
  it("fingerprint material: omitted/false is the historical no-note material, true is domain-separated", async () => {
    const { tutorLabInteractionFingerprintMaterial } =
      await import("@/domain/tutor-lab-execution");
    expect(tutorLabInteractionFingerprintMaterial(HANDOFF, "Help", false)).toBe(
      `${HANDOFF}\nHelp`,
    );
    expect(tutorLabInteractionFingerprintMaterial(HANDOFF, "Help", true)).toBe(
      `AC4_SAVE_AS_CLASS_NOTE\n${HANDOFF}\nHelp`,
    );
    // No learner message can make a no-note request collide with a note
    // request: no-note material always starts with the handoff UUID, which
    // can never start with the separator tag (a suffix would collide here).
    for (const message of [
      "Help\nAC4_SAVE_AS_CLASS_NOTE",
      "AC4_SAVE_AS_CLASS_NOTE\nHelp",
      `Help\n${HANDOFF}`,
    ]) {
      const noNote = tutorLabInteractionFingerprintMaterial(
        HANDOFF,
        message,
        false,
      );
      expect(noNote.startsWith(HANDOFF)).toBe(true);
      expect(noNote.startsWith("AC4_SAVE_AS_CLASS_NOTE")).toBe(false);
      for (const other of ["Help", message])
        expect(noNote).not.toBe(
          tutorLabInteractionFingerprintMaterial(HANDOFF, other, true),
        );
    }
  });

  it.each([
    [
      "series",
      (n: ReturnType<typeof note>) => ({ ...n, createdAt: "yesterday" }),
    ],
    [
      "series (no offset)",
      (n: ReturnType<typeof note>) => ({
        ...n,
        createdAt: "2026-10-06 10:00:00",
      }),
    ],
    [
      "revision",
      (n: ReturnType<typeof note>) => ({
        ...n,
        revisions: [
          { ...n.revisions[0], createdAt: "not-a-time" },
          n.revisions[1],
        ],
      }),
    ],
  ])(
    "malformed %s timestamps fail closed before rendering",
    async (_label, corrupt) => {
      const forged = corrupt(note());
      expect(
        learnerTutorClassNoteListSchema.safeParse(page([forged])).success,
      ).toBe(false);
      mocks.rpc.mockResolvedValueOnce({ data: page([forged]), error: null });
      expect(
        await listMyTutorClassNotes({ enrolmentId: ENROLMENT, page: 0 }),
      ).toEqual({ status: "UNAVAILABLE" });
    },
  );

  it("accepts the database's real timestamptz JSON form", () => {
    expect(
      learnerTutorClassNoteListSchema.safeParse(
        page([note({ createdAt: "2026-10-06T10:00:00.123456+00:00" })]),
      ).success,
    ).toBe(true);
  });
});
