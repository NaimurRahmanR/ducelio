import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Local behavioural coverage for scripts/acceptance/commerce-revocation.mjs.
// No hosted service is contacted: identities, PostgREST and read-only SQL are
// fakes. This proves the harness's gating, sequencing and verdict logic only;
// the hosted evidence itself comes from an operator-run hosted execution.

const ENV_ID = "a0000000-0000-4000-8000-00000000e045";
const OTHER_ENV_ID = "b0000000-0000-4000-8000-00000000e045";
const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ENV_KEYS = [
  "ACCEPTANCE_WRITE_ENABLED",
  "ACCEPTANCE_ENVIRONMENT_ID",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "ACCEPTANCE_DATABASE_URL",
  "ACCEPTANCE_ADMIN_EMAIL",
  "ACCEPTANCE_ADMIN_PASSWORD",
  "ACCEPTANCE_LEARNER_EMAIL",
  "ACCEPTANCE_LEARNER_PASSWORD",
  "ACCEPTANCE_FOREIGN_LEARNER_EMAIL",
  "ACCEPTANCE_FOREIGN_LEARNER_PASSWORD",
  "ACCEPTANCE_UNRELATED_STAFF_EMAIL",
  "ACCEPTANCE_UNRELATED_STAFF_PASSWORD",
];
const saved: Record<string, string | undefined> = {};
function configureEnv(write = true) {
  process.env.ACCEPTANCE_ENVIRONMENT_ID = ENV_ID;
  process.env.NEXT_PUBLIC_SUPABASE_URL =
    "https://acceptance.example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_acceptance";
  process.env.ACCEPTANCE_DATABASE_URL =
    "postgresql://acceptance:acceptance@localhost:5432/acceptance";
  for (const who of [
    "ADMIN",
    "LEARNER",
    "FOREIGN_LEARNER",
    "UNRELATED_STAFF",
  ]) {
    process.env[`ACCEPTANCE_${who}_EMAIL`] =
      `${who.toLowerCase()}@acceptance.example`;
    process.env[`ACCEPTANCE_${who}_PASSWORD`] = "not-a-real-password";
  }
  if (write) process.env.ACCEPTANCE_WRITE_ENABLED = "true";
  else delete process.env.ACCEPTANCE_WRITE_ENABLED;
}
beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  vi.doUnmock("pg");
  vi.resetModules();
});

async function load() {
  return import("../scripts/acceptance/commerce-revocation.mjs");
}

const LESSON = { id: ID(10), title: "Acceptance lesson" };
const OBJECTIVE = {
  id: ID(11),
  description: "Explain least privilege",
  position: 1,
};
const SEGMENT = { id: ID(12), title: "Acceptance segment", position: 1 };
const IDS = {
  entitlement: ID(20),
  enrolment: ID(21),
  foreignEnrolment: ID(22),
  session: ID(23),
  evidence: ID(24),
  foreignEvidence: ID(25),
  progress: ID(26),
  mastery: ID(27),
  version: ID(28),
};
const evidenceRow = (id: string) => ({
  id,
  objective_id: OBJECTIVE.id,
  evidence_kind: "CLASS_RESPONSE",
  result: "CORRECT",
  evidence_reference: "acceptance-revocation-run-learner",
  recorded_at: "2026-10-02T10:00:00+00:00",
  lesson_objectives: { description: OBJECTIVE.description, position: 1 },
  lessons: { title: LESSON.title },
});
const masteryRow = {
  id: IDS.mastery,
  objective_id: OBJECTIVE.id,
  lesson_id: LESSON.id,
  state: "DEVELOPING",
  evidence_count: 1,
  correct_evidence_count: 1,
  correct_session_count: 1,
  correct_kind_count: 1,
  policy_version: "MASTERY_V1",
  evaluated_at: "2026-10-02T10:00:00+00:00",
  lesson_objectives: {
    description: OBJECTIVE.description,
    position: 1,
    lessons: { title: LESSON.title },
  },
};
const progressRow = {
  id: IDS.progress,
  lesson_id: LESSON.id,
  segment_id: SEGMENT.id,
  status: "COMPLETED",
  updated_at: "2026-10-02T10:00:00+00:00",
  lesson_segments: {
    title: SEGMENT.title,
    position: 1,
    lessons: { title: LESSON.title },
  },
};

type Call = { who: string; name: string; args?: Record<string, unknown> };

// A fake hosted world: four signed-in identities over one shared state.
function world(
  opts: {
    staffIsStudent?: boolean;
    adminIsStudent?: boolean;
    refuse?: string;
    envId?: string;
    embedError?: boolean;
    no046?: boolean;
  } = {},
) {
  const events: Call[] = [];
  const state = { revoked: false };
  const forbidden = {
    data: null,
    error: { code: "42501", message: "FORBIDDEN" },
  };
  const roles: Record<string, string[]> = {
    admin: [
      "ACADEMIC_ADMIN",
      "INSTRUCTOR",
      ...(opts.adminIsStudent === false ? [] : ["STUDENT"]),
    ],
    learner: ["STUDENT"],
    foreign: ["STUDENT"],
    staff: [
      "INSTRUCTOR",
      ...(opts.staffIsStudent === false ? [] : ["STUDENT"]),
    ],
  };
  const writes: Record<string, () => unknown> = {
    publish_commercial_v1_offer: () => ID(30),
    create_commercial_v1_campaign: () => ID(31),
    redeem_commercial_v1_campaign: () => ({
      ok: true,
      path: "ACCESS_GRANTED",
      entitlementId: IDS.entitlement,
      enrolmentId: IDS.enrolment,
    }),
    create_class_session: () => IDS.session,
    record_learning_evidence: () => IDS.evidence,
    record_lesson_progress: () => IDS.progress,
    admin_revoke_commercial_v1_entitlement: () => {
      state.revoked = true;
      return { ok: true, code: "ACCESS_REVOKED" };
    },
  };
  let evidenceCalls = 0;
  function client(who: string, authId: string) {
    return {
      auth: {
        getUser: async () => ({ data: { user: { id: authId } }, error: null }),
      },
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        if (name === "has_role")
          return {
            data: roles[who].includes(args.wanted as string),
            error: null,
          };
        if (name === "get_ducelio_acceptance_environment_id")
          return { data: opts.envId ?? ENV_ID, error: null };
        events.push({ who, name, args });
        if (name === "get_student_retained_learning_history") {
          if (!roles[who].includes("STUDENT")) return forbidden;
          const kind = args.p_kind as string;
          if (who === "learner")
            return {
              data:
                kind === "evidence"
                  ? [evidenceRow(IDS.evidence)]
                  : kind === "mastery"
                    ? [masteryRow]
                    : [progressRow],
              error: null,
            };
          return {
            data: kind === "evidence" ? [evidenceRow(IDS.foreignEvidence)] : [],
            error: null,
          };
        }
        if (opts.refuse === name)
          return {
            data: null,
            error: {
              code: "P0001",
              message: "Instructor already has an overlapping class session",
            },
          };
        const handler = writes[name];
        if (!handler) throw new Error(`Unexpected RPC ${name}`);
        if (name === "record_learning_evidence")
          return {
            data: evidenceCalls++ === 0 ? IDS.evidence : IDS.foreignEvidence,
            error: null,
          };
        return { data: handler(), error: null };
      },
      from: (table: string) => {
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.eq = () => builder;
        builder.limit = () => builder;
        builder.then = (
          ok: (v: unknown) => unknown,
          ko: (e: unknown) => unknown,
        ) => {
          let data: unknown[] = [];
          if (who === "learner" && table === "lessons" && !state.revoked)
            data = [{ id: LESSON.id }];
          if (who === "learner" && table === "learning_evidence") {
            if (opts.embedError)
              return Promise.resolve({
                data: null,
                error: { code: "PGRST200", message: "no relationship" },
              }).then(ok, ko);
            data = [
              { id: IDS.evidence, lessons: null, lesson_objectives: null },
            ];
          }
          if (who === "learner" && table === "lesson_progress")
            data = [{ id: IDS.progress, lesson_segments: null }];
          return Promise.resolve({ data, error: null }).then(ok, ko);
        };
        return builder;
      },
    };
  }
  const clients = {
    admin: client("admin", ID(1)),
    learner: client("learner", ID(2)),
    foreign: client("foreign", ID(3)),
    staff: client("staff", ID(4)),
  };
  const query = async (sql: string) => {
    if (sql.includes("schema_migrations"))
      return opts.no046 ? [] : [{ version: "202610020046" }];
    if (sql.includes("clock_timestamp")) return [{ ms: String(Date.now()) }];
    if (sql.includes("from lessons")) return [{ title: LESSON.title }];
    if (sql.includes("from lesson_objectives")) return [OBJECTIVE];
    if (sql.includes("from lesson_segments"))
      return [{ title: SEGMENT.title, position: 1 }];
    if (sql.includes("from objective_mastery")) return [{ id: IDS.mastery }];
    if (sql.includes("from enrolments"))
      return [{ status: state.revoked ? "WITHDRAWN" : "ACTIVE" }];
    if (sql.includes("from commercial_v1_entitlements"))
      return [
        {
          id: IDS.entitlement,
          enrolment_id: IDS.enrolment,
          source: "REVIEWER",
          enrolment_origin: "COMMERCE",
          state: state.revoked ? "REVOKED" : "ACTIVE",
          revoked_at: state.revoked ? "2026-10-02T10:05:00+00:00" : null,
        },
      ];
    if (sql.includes("from audit_events"))
      return state.revoked
        ? [
            {
              after_state: {
                enrolment_origin: "COMMERCE",
                previous_enrolment_status: "ACTIVE",
                state: "REVOKED",
              },
            },
          ]
        : [];
    throw new Error(`Unexpected SQL ${sql}`);
  };
  return { events, clients, query, state };
}

function deps(
  w: ReturnType<typeof world>,
  overrides: Record<string, unknown> = {},
) {
  return {
    runId: "1790000000000-abc123",
    missingPrerequisites: () => [],
    signIn: {
      admin: async () => w.clients.admin,
      learner: async () => w.clients.learner,
      foreignLearner: async () => w.clients.foreign,
      unrelatedStaff: async () => w.clients.staff,
    },
    assertWriteGates: async (client: unknown) => {
      w.events.push({
        who: client === w.clients.learner ? "learner" : "admin",
        name: "GATE",
      });
    },
    seedCourse: async () => ({
      activationId: ID(40),
      cohortId: ID(41),
      programmeVersionId: IDS.version,
      enrolmentId: IDS.foreignEnrolment,
      instructorId: ID(1),
      lessonSegment: { lessonId: LESSON.id, segmentId: SEGMENT.id },
    }),
    query: w.query,
    resolveAppUserId: async (authId: string) => `app-${authId}`,
    anonRpc: async () => ({
      data: null,
      error: { code: "42501", message: "permission denied for function" },
    }),
    log: () => {},
    ...overrides,
  };
}

const WRITES = [
  "publish_commercial_v1_offer",
  "create_commercial_v1_campaign",
  "redeem_commercial_v1_campaign",
  "create_class_session",
  "record_learning_evidence",
  "record_lesson_progress",
  "admin_revoke_commercial_v1_entitlement",
];

describe("commerce-revocation acceptance: fail-closed gates", () => {
  it("blocks every surface before any sign-in when ACCEPTANCE_WRITE_ENABLED is absent", async () => {
    configureEnv(false);
    const m = await load();
    expect(m.missingPrerequisites()).toContain(
      "ACCEPTANCE_WRITE_ENABLED is not exactly 'true'",
    );
    const signIn = vi.fn();
    const results = await m.runCommerceRevocationAcceptance({
      ...deps(world()),
      missingPrerequisites: m.missingPrerequisites,
      signIn: {
        admin: signIn,
        learner: signIn,
        foreignLearner: signIn,
        unrelatedStaff: signIn,
      },
    });
    expect(signIn).not.toHaveBeenCalled();
    expect(
      results.filter((r: { status: string }) => r.status === "PASS"),
    ).toEqual([]);
    expect(
      results.every((r: { status: string }) => r.status === "BLOCKED"),
    ).toBe(true);
  });

  it("the real write gate refuses when ACCEPTANCE_WRITE_ENABLED is absent, before any statement", async () => {
    configureEnv(false);
    const queries: string[] = [];
    vi.doMock("pg", () => ({
      default: {
        Client: function () {
          return {
            connect: async () => {},
            end: async () => {},
            query: async (sql: string) => {
              queries.push(sql);
              return { rows: [{ marker: 1 }] };
            },
          };
        },
      },
    }));
    vi.resetModules();
    const m = await load();
    const w = world();
    await expect(m.assertWriteGates(w.clients.admin)).rejects.toThrow(
      "ACCEPTANCE_WRITE_ENABLED is not exactly 'true'",
    );
    expect(queries).toEqual([]);
  });

  it("a hosted Supabase environment-id mismatch blocks every surface before any write", async () => {
    configureEnv(true);
    const m = await load();
    const w = world({ envId: OTHER_ENV_ID });
    const results = await m.runCommerceRevocationAcceptance(
      deps(w, {
        assertWriteGates: m.assertWriteGates,
        seedCourse: async (admin: unknown) => {
          await m.assertWriteGates(admin);
          throw new Error("unreachable");
        },
      }),
    );
    expect(
      results
        .slice(0, 5)
        .every((r: { status: string }) => r.status === "BLOCKED"),
    ).toBe(true);
    expect(results[0].reason).toMatch(
      /does not match ACCEPTANCE_ENVIRONMENT_ID/,
    );
    expect(w.events.filter((e) => WRITES.includes(e.name))).toEqual([]);
  });

  it("a direct-database marker mismatch blocks the write gate even when the hosted id matches", async () => {
    configureEnv(true);
    vi.doMock("pg", () => ({
      default: {
        Client: function () {
          return {
            connect: async () => {},
            end: async () => {},
            query: async () => ({ rows: [] }),
          };
        },
      },
    }));
    vi.resetModules();
    const m = await load();
    await expect(m.assertWriteGates(world().clients.admin)).rejects.toThrow(
      /no marker row/,
    );
  });
});

describe("commerce-revocation acceptance: orchestration", () => {
  it("passes the five hosted surfaces only through governed writes, each behind both gates", async () => {
    const m = await load();
    const w = world({ staffIsStudent: false });
    const results = await m.runCommerceRevocationAcceptance(deps(w));
    const byName = Object.fromEntries(
      results.map((r: { surface: string; status: string }) => [
        r.surface,
        r.status,
      ]),
    );
    expect(byName).toEqual({
      "ACCESS_REVOCATION:RETAINED_HISTORY": "PASS",
      "ACCESS_REVOCATION:CONTENT_CLOSED": "PASS",
      "ACCESS_REVOCATION:FOREIGN_ISOLATION": "PASS",
      "ACCESS_REVOCATION:NON_STUDENT_DENIED": "PASS",
      "PROVENANCE:REVIEWER_COMMERCE_WITHDRAWAL": "PASS",
      "PROVENANCE:ACADEMIC_FIRST": "BLOCKED",
      "PROVENANCE:COMMERCE_FIRST": "BLOCKED",
      "PROVENANCE:UNKNOWN": "BLOCKED",
      "PROVENANCE:ENROLMENT_VS_FULFILMENT_CONTENTION": "BLOCKED",
      "STRIPE_TEST:REFUND_LIFECYCLE": "BLOCKED",
    });
    const sequence = w.events.filter(
      (e) => e.name === "GATE" || WRITES.includes(e.name),
    );
    sequence.forEach((event, index) => {
      if (event.name !== "GATE") expect(sequence[index - 1].name).toBe("GATE");
    });
    expect(
      sequence.filter((e) => e.name !== "GATE").map((e) => e.name),
    ).toEqual([
      "publish_commercial_v1_offer",
      "create_commercial_v1_campaign",
      "redeem_commercial_v1_campaign",
      "create_class_session",
      "record_learning_evidence",
      "record_learning_evidence",
      "record_lesson_progress",
      "admin_revoke_commercial_v1_entitlement",
    ]);
    // The learner redeems with their own JWT; nothing signs or fulfils.
    expect(
      w.events.find((e) => e.name === "redeem_commercial_v1_campaign")?.who,
    ).toBe("learner");
    expect(
      w.events.some((e) => /fulfill|reconcile|commerce_operation/.test(e.name)),
    ).toBe(false);
    // Retained history is read only after the revocation.
    const revokeAt = w.events.findIndex(
      (e) => e.name === "admin_revoke_commercial_v1_entitlement",
    );
    const firstHistory = w.events.findIndex(
      (e) => e.name === "get_student_retained_learning_history",
    );
    expect(firstHistory).toBeGreaterThan(revokeAt);
  });

  it("regression: a hosted embed error can never PASS CONTENT_CLOSED", async () => {
    const m = await load();
    const results = await m.runCommerceRevocationAcceptance(
      deps(world({ staffIsStudent: false, embedError: true })),
    );
    const closed = results.find(
      (r: { surface: string }) =>
        r.surface === "ACCESS_REVOCATION:CONTENT_CLOSED",
    );
    expect(closed.status).toBe("BLOCKED");
    expect(closed.status).not.toBe("PASS");
    expect(closed.details.join(" ")).toMatch(/PGRST200/);
  });

  it("blocks before any write when migration 046 is not applied hosted", async () => {
    const m = await load();
    const w = world({ no046: true });
    const results = await m.runCommerceRevocationAcceptance(deps(w));
    expect(
      results
        .slice(0, 5)
        .every((r: { status: string }) => r.status === "BLOCKED"),
    ).toBe(true);
    expect(results[0].reason).toMatch(/202610020046/);
    expect(w.events.filter((e) => WRITES.includes(e.name))).toEqual([]);
  });

  it("reports NON_STUDENT as BLOCKED when no configured identity lacks STUDENT", async () => {
    const m = await load();
    const results = await m.runCommerceRevocationAcceptance(deps(world()));
    expect(
      results.find(
        (r: { surface: string }) =>
          r.surface === "ACCESS_REVOCATION:NON_STUDENT_DENIED",
      )?.status,
    ).toBe("BLOCKED");
  });

  it("a governed setup refusal blocks every hosted surface and never revokes", async () => {
    const m = await load();
    const w = world({ refuse: "create_class_session" });
    const results = await m.runCommerceRevocationAcceptance(deps(w));
    expect(
      results
        .slice(0, 5)
        .every((r: { status: string }) => r.status === "BLOCKED"),
    ).toBe(true);
    expect(results[0].reason).toMatch(/overlapping class session/);
    expect(
      w.events.some((e) => e.name === "admin_revoke_commercial_v1_entitlement"),
    ).toBe(false);
  });

  it("refuses to run content-closure checks for a learner with staff content authority", async () => {
    const m = await load();
    const w = world();
    const learner = w.clients.learner;
    const original = learner.rpc;
    learner.rpc = async (name: string, args: Record<string, unknown> = {}) =>
      name === "has_role" && args.wanted === "INSTRUCTOR"
        ? { data: true, error: null }
        : original(name, args);
    const results = await m.runCommerceRevocationAcceptance(deps(w));
    expect(results[0].status).toBe("BLOCKED");
    expect(w.events.filter((e) => WRITES.includes(e.name))).toEqual([]);
  });
});

describe("commerce-revocation acceptance: verdicts", () => {
  const expected = {
    evidenceId: IDS.evidence,
    masteryId: IDS.mastery,
    progressId: IDS.progress,
    lessonTitle: LESSON.title,
    objectiveDescription: OBJECTIVE.description,
    segmentTitle: SEGMENT.title,
  };
  const after = () => ({
    evidence: [evidenceRow(IDS.evidence)],
    mastery: [structuredClone(masteryRow)],
    progress: [structuredClone(progressRow)],
  });

  it("retained history fails on an extra field, a wrong label or leaked package text", async () => {
    const m = await load();
    expect(
      m.evaluateRetainedHistory({ after: after(), expected, sensitive: [] })
        .status,
    ).toBe("PASS");
    const extra = after();
    (extra.evidence[0] as Record<string, unknown>).body = "lesson body";
    expect(
      m.evaluateRetainedHistory({ after: extra, expected, sensitive: [] })
        .status,
    ).toBe("FAIL");
    const relabelled = after();
    relabelled.progress[0].lesson_segments.title = "Other";
    expect(
      m.evaluateRetainedHistory({ after: relabelled, expected, sensitive: [] })
        .status,
    ).toBe("FAIL");
    expect(
      m.evaluateRetainedHistory({
        after: after(),
        expected,
        sensitive: ["acceptance-revocation-run-learner"],
      }).status,
    ).toBe("FAIL");
    const missing = after();
    missing.mastery = [];
    expect(
      m.evaluateRetainedHistory({ after: missing, expected, sensitive: [] })
        .status,
    ).toBe("FAIL");
  });

  it("content closure needs pre-revocation access and zero post-revocation rows without errors", async () => {
    const m = await load();
    const closed = {
      lessons: { error: false, count: 0 },
      learning_resources: { error: false, count: 0 },
    };
    const hidden = [
      { name: "evidence", error: false, rows: 1, visibleEmbeds: 0 },
      { name: "progress", error: false, rows: 1, visibleEmbeds: 0 },
    ];
    const verdict = (over: Record<string, unknown>) =>
      m.evaluateContentClosed({
        before: { lessons: 1 },
        after: closed,
        embeds: hidden,
        historyLeaks: 0,
        ...over,
      }).status;
    expect(verdict({})).toBe("PASS");
    expect(verdict({ before: { lessons: 0 } })).toBe("FAIL");
    expect(
      verdict({ after: { ...closed, lessons: { error: false, count: 1 } } }),
    ).toBe("FAIL");
    expect(
      verdict({ after: { ...closed, lessons: { error: true, count: null } } }),
    ).toBe("FAIL");
    expect(
      verdict({ embeds: [{ ...hidden[0], visibleEmbeds: 1 }, hidden[1]] }),
    ).toBe("FAIL");
    expect(verdict({ historyLeaks: 1 })).toBe("FAIL");
  });

  it("regression: an embed error or an invisible owning row is never treated as hidden content", async () => {
    const m = await load();
    const closed = { lessons: { error: false, count: 0 } };
    const ok = { name: "progress", error: false, rows: 1, visibleEmbeds: 0 };
    const errored = m.evaluateContentClosed({
      before: { lessons: 1 },
      after: closed,
      embeds: [{ name: "evidence", error: true, code: "PGRST200" }, ok],
      historyLeaks: 0,
    });
    expect(errored.status).not.toBe("PASS");
    expect(errored.status).toBe("BLOCKED");
    const invisible = m.evaluateContentClosed({
      before: { lessons: 1 },
      after: closed,
      embeds: [
        { name: "evidence", error: false, rows: 0, visibleEmbeds: 0 },
        ok,
      ],
      historyLeaks: 0,
    });
    expect(invisible.status).toBe("BLOCKED");
    // A genuine exposure still FAILs even when another embed errored.
    expect(
      m.evaluateContentClosed({
        before: { lessons: 1 },
        after: closed,
        embeds: [
          { name: "evidence", error: true, code: "PGRST200" },
          { ...ok, visibleEmbeds: 1 },
        ],
        historyLeaks: 0,
      }).status,
    ).toBe("FAIL");
  });

  it("foreign isolation fails on any leaked id or an indistinguishable empty projection", async () => {
    const m = await load();
    const ok = (data: unknown[]) => ({ data, error: null });
    const base = {
      foreignHistory: {
        evidence: ok([{ id: IDS.foreignEvidence }]),
        mastery: ok([]),
        progress: ok([]),
      },
      foreignDirect: {
        learning_evidence: 0,
        objective_mastery: 0,
        lesson_progress: 0,
      },
      affectedIds: [IDS.evidence, IDS.mastery, IDS.progress],
      foreignOwnEvidenceId: IDS.foreignEvidence,
    };
    expect(m.evaluateForeignIsolation(base).status).toBe("PASS");
    expect(
      m.evaluateForeignIsolation({
        ...base,
        foreignHistory: {
          ...base.foreignHistory,
          mastery: ok([{ id: IDS.mastery }]),
        },
      }).status,
    ).toBe("FAIL");
    expect(
      m.evaluateForeignIsolation({
        ...base,
        foreignDirect: { ...base.foreignDirect, lesson_progress: 1 },
      }).status,
    ).toBe("FAIL");
    expect(
      m.evaluateForeignIsolation({
        ...base,
        foreignHistory: { ...base.foreignHistory, evidence: ok([]) },
      }).status,
    ).toBe("FAIL");
  });

  it("non-STUDENT denial requires a refusal for every kind and for anonymous", async () => {
    const m = await load();
    const refused = {
      data: null,
      error: { code: "42501", message: "FORBIDDEN" },
    };
    const results = { evidence: refused, mastery: refused, progress: refused };
    expect(
      m.evaluateNonStudent({ identity: "staff", results, anon: refused })
        .status,
    ).toBe("PASS");
    expect(
      m.evaluateNonStudent({ identity: null, results, anon: refused }).status,
    ).toBe("BLOCKED");
    expect(
      m.evaluateNonStudent({
        identity: "staff",
        results: { ...results, mastery: { data: [], error: null } },
        anon: refused,
      }).status,
    ).toBe("FAIL");
    expect(
      m.evaluateNonStudent({
        identity: "staff",
        results,
        anon: { data: [], error: null },
      }).status,
    ).toBe("FAIL");
  });

  it("reviewer COMMERCE provenance requires withdrawal, ACCESS_REVOKED, audit and closed content", async () => {
    const m = await load();
    const base = {
      entitlement: {
        source: "REVIEWER",
        enrolment_origin: "COMMERCE",
        state: "REVOKED",
        revoked_at: "x",
      },
      enrolmentBefore: "ACTIVE",
      enrolmentAfter: "WITHDRAWN",
      revokeResult: { ok: true, code: "ACCESS_REVOKED" },
      audit: {
        enrolment_origin: "COMMERCE",
        previous_enrolment_status: "ACTIVE",
        state: "REVOKED",
      },
      contentBefore: 1,
      contentAfter: 0,
    };
    const verdict = (over: Record<string, unknown>) =>
      m.evaluateReviewerCommerceProvenance({ ...base, ...over }).status;
    expect(verdict({})).toBe("PASS");
    // The pre-046 defect shape must FAIL, never pass as UNKNOWN.
    expect(
      verdict({
        entitlement: { ...base.entitlement, enrolment_origin: "UNKNOWN" },
        enrolmentAfter: "ACTIVE",
        revokeResult: { ok: true, code: "ENTITLEMENT_REVOKED" },
      }),
    ).toBe("FAIL");
    expect(verdict({ enrolmentAfter: "ACTIVE" })).toBe("FAIL");
    expect(
      verdict({ revokeResult: { ok: true, code: "ENTITLEMENT_REVOKED" } }),
    ).toBe("FAIL");
    expect(verdict({ contentAfter: 1 })).toBe("FAIL");
    expect(verdict({ audit: undefined })).toBe("FAIL");
  });

  it("never produces UNKNOWN provenance: it is a fixed, explained BLOCKED surface", async () => {
    const m = await load();
    const unknown = m.BLOCKED_SURFACES.find(
      ([surface]: [string]) => surface === "PROVENANCE:UNKNOWN",
    );
    expect(unknown[1]).toMatch(/privileged direct insert\/update/);
    expect(Object.values(m.SURFACES)).not.toContain("PROVENANCE:UNKNOWN");
  });

  it("collects protected package text (prompts, answers, guidance, instructions) but not labels", async () => {
    const m = await load();
    const { buildAcceptancePackage } =
      await import("../scripts/acceptance/fixtures.mjs");
    const pkg = buildAcceptancePackage("1790000000000-abc123");
    const sensitive = m.sensitivePackageStrings(pkg);
    const question = pkg.assessmentTemplates[0].questions[0];
    expect(sensitive).toContain(question.prompt.trim());
    expect(sensitive).toContain(question.expectedAnswer.trim());
    const lesson = pkg.modules[0].lessons[0];
    expect(sensitive).not.toContain(lesson.title);
    expect(sensitive).not.toContain(lesson.objectives[0].description);
  });
});
