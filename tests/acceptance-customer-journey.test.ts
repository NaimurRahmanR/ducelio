import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ============================================================================
// scripts/acceptance/customer-journey.mjs (`npm run acceptance:journey`),
// the journey mode of the shared loopback provider stub/redirect, and the
// journey fixture options. No hosted infrastructure: prerequisite BLOCKING,
// child-environment safety, stub/redirect contracts, the PASS/FAIL/BLOCKED
// semantics of every sub-surface and the aggregate, session separation, and
// the static guarantees (no HMAC, no result/entitlement/enrolment
// fabrication, no coupling to the concurrency harness).
// ============================================================================

const ORIGINAL_ENV = { ...process.env };
function resetEnv() {
  for (const key of Object.keys(process.env))
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
}
function clearAcceptanceVars() {
  for (const key of Object.keys(process.env))
    if (
      key.startsWith("ACCEPTANCE_") ||
      key.startsWith("ACADEMIC_") ||
      key.startsWith("NEXT_PUBLIC_SUPABASE_")
    )
      delete process.env[key];
}
beforeEach(resetEnv);
afterEach(() => {
  resetEnv();
  vi.resetModules();
});

const SECRETS = {
  ACCEPTANCE_ADMIN_PASSWORD: "admin-password-sentinel-123",
  ACCEPTANCE_LEARNER_PASSWORD: "learner-password-sentinel-123",
  ACCEPTANCE_FOREIGN_LEARNER_PASSWORD: "foreign-password-sentinel-123",
  ACADEMIC_EXECUTION_HMAC_KEY_HEX: "0123456789abcdef".repeat(4),
};

const journeyModule = () =>
  import("../scripts/acceptance/customer-journey.mjs");
type Result = {
  surface: string;
  status: string;
  reason: string;
  details?: string[];
};

async function readRepo(path: string) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
describe("customer journey: prerequisites and environment safety gates", () => {
  it("with nothing configured every FULL_JOURNEY surface and the aggregate are BLOCKED -- never PASS -- naming only missing variables", async () => {
    clearAcceptanceVars();
    Object.assign(process.env, SECRETS);
    const { runCustomerJourney, JOURNEY_SURFACES, AGGREGATE_SURFACE } =
      await journeyModule();
    const results: Result[] = await runCustomerJourney({ log: () => {} });
    expect(results.map((r) => r.surface)).toEqual([
      ...Object.values(JOURNEY_SURFACES),
      AGGREGATE_SURFACE,
    ]);
    for (const r of results) expect(r.status).toBe("BLOCKED");
    const text = JSON.stringify(results);
    expect(text).toContain("ACCEPTANCE_WRITE_ENABLED");
    expect(text).toContain("ACCEPTANCE_FOREIGN_LEARNER_EMAIL/PASSWORD");
    expect(text).toContain("ACADEMIC_EXECUTION_KEY_ID");
    for (const secret of Object.values(SECRETS))
      expect(text).not.toContain(secret);
  });

  it("a session refusal (e.g. no active hosted controller key) BLOCKS everything before any fixture write", async () => {
    const { runCustomerJourney } = await journeyModule();
    const open = vi.fn(async () => ({
      refusal: {
        reason:
          "No active hosted controller key matches ACADEMIC_EXECUTION_KEY_ID.",
        details: [],
      },
      close: async () => {},
    }));
    const results: Result[] = await runCustomerJourney({ open, log: () => {} });
    expect(open).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.status).toBe("BLOCKED");
    expect(results[0].reason).toContain("controller key");
  });

  it("a journey route that does not admit the driver (404: gate refused) BLOCKS every surface", async () => {
    const { runCustomerJourney } = await journeyModule();
    const close = vi.fn(async () => {});
    const results: Result[] = await runCustomerJourney({
      open: async () => ({
        session: {
          routeClient: () => ({
            call: async () => ({ status: 404, body: null, text: "" }),
          }),
        },
        close,
      }),
      log: () => {},
    });
    for (const r of results) expect(r.status).toBe("BLOCKED");
    expect(results[0].reason).toContain("did not admit this driver");
    expect(close).toHaveBeenCalled();
  });

  it("the journey child environment gets the stub key for BOTH vendors, the journey marker and the Anthropic stub URL; real keys and acceptance credentials are withheld", async () => {
    const { buildAppChildEnv } =
      await import("../scripts/acceptance/examiner-app.mjs");
    const stub = {
      url: "http://127.0.0.1:5555/v1/responses",
      anthropicUrl: "http://127.0.0.1:5555/v1/messages",
      apiKey: "stub-key",
    };
    const parent = {
      ...SECRETS,
      ACCEPTANCE_FOREIGN_LEARNER_EMAIL: "foreign@acceptance.test",
      ACCEPTANCE_DATABASE_URL: "postgresql://u:db-secret@localhost/db",
      OPENAI_API_KEY: "sk-real-openai-sentinel",
      ANTHROPIC_API_KEY: "sk-ant-real-sentinel",
      STRIPE_SECRET_KEY: "sk_test_sentinel",
      COMMERCE_CONTROLLER_HMAC_KEY_HEX: "e".repeat(64),
    };
    const env = buildAppChildEnv(parent, {
      port: 4123,
      token: "f".repeat(64),
      redirectToken: "1".repeat(64),
      stub,
      journey: true,
    });
    expect(env.ACCEPTANCE_JOURNEY_DRIVER_ENABLED).toBe("true");
    expect(env.ACCEPTANCE_PROVIDER_ANTHROPIC_STUB_URL).toBe(stub.anthropicUrl);
    expect(env.ANTHROPIC_API_KEY).toBe("stub-key");
    expect(env.OPENAI_API_KEY).toBe("stub-key");
    for (const name of [
      "ACCEPTANCE_DATABASE_URL",
      "ACCEPTANCE_FOREIGN_LEARNER_EMAIL",
      "ACCEPTANCE_FOREIGN_LEARNER_PASSWORD",
      "ACCEPTANCE_LEARNER_PASSWORD",
      "STRIPE_SECRET_KEY",
      "COMMERCE_CONTROLLER_HMAC_KEY_HEX",
    ])
      expect(env[name]).toBe("");
    expect(JSON.stringify(env)).not.toContain("sk-ant-real-sentinel");

    // Every other driver: the journey settings are forced empty even when a
    // stray parent value is present.
    const other = buildAppChildEnv(
      {
        ...parent,
        ACCEPTANCE_JOURNEY_DRIVER_ENABLED: "true",
        ACCEPTANCE_PROVIDER_ANTHROPIC_STUB_URL: stub.anthropicUrl,
      },
      {
        port: 4123,
        token: "f".repeat(64),
        redirectToken: "1".repeat(64),
        stub,
      },
    );
    expect(other.ACCEPTANCE_JOURNEY_DRIVER_ENABLED).toBe("");
    expect(other.ACCEPTANCE_PROVIDER_ANTHROPIC_STUB_URL).toBe("");
    expect(other.ANTHROPIC_API_KEY).toBe("");

    expect(() =>
      buildAppChildEnv(parent, {
        port: 1,
        token: "f".repeat(64),
        redirectToken: "1".repeat(64),
        stub: { url: stub.url, apiKey: "k", anthropicUrl: null },
        journey: true,
      }),
    ).toThrow();
  });

  it("package.json exposes the dedicated command and the broad hosted matrix never runs the journey", async () => {
    const pkg = JSON.parse(await readRepo("package.json"));
    expect(pkg.scripts["acceptance:journey"]).toContain(
      "scripts/acceptance/customer-journey.mjs",
    );
    expect(pkg.scripts["acceptance:hosted"]).not.toContain("customer-journey");
    const hosted = await readRepo("scripts/acceptance/hosted.mjs");
    expect(hosted).not.toMatch(/customer-journey|runCustomerJourney/);
  });
});

// ---------------------------------------------------------------------------
describe("customer journey: PASS / FAIL / BLOCKED semantics", () => {
  it("the aggregate PASSes only when every sub-surface PASSed; any FAIL is FAIL; otherwise BLOCKED; a missing sub-surface is never PASS", async () => {
    const { aggregateJourney, JOURNEY_SURFACES } = await journeyModule();
    const { pass, fail, blocked } =
      await import("../scripts/acceptance/report.mjs");
    const all = Object.values(JOURNEY_SURFACES) as string[];
    const allPass = all.map((s) => pass(s, "ok"));
    const agg = aggregateJourney(allPass);
    expect(agg.status).toBe("PASS");
    expect(agg.reason).toContain("not PRODUCTION-PROVEN");

    const oneBlocked = allPass.map((r, i) =>
      i === 3 ? blocked(r.surface, "x") : r,
    );
    expect(aggregateJourney(oneBlocked).status).toBe("BLOCKED");

    const blockedAndFailed = oneBlocked.map((r, i) =>
      i === 5 ? fail(r.surface, "x") : r,
    );
    expect(aggregateJourney(blockedAndFailed).status).toBe("FAIL");

    expect(aggregateJourney(allPass.slice(1)).status).toBe("BLOCKED");
  });

  it("stages whose prerequisites did not PASS are BLOCKED without executing; JourneyBlocked and write-gate refusals are BLOCKED; unexpected errors are FAIL", async () => {
    const { runJourneyStages, JourneyBlocked, JOURNEY_SURFACES } =
      await journeyModule();
    const { pass } = await import("../scripts/acceptance/report.mjs");
    const { AcceptanceWriteNotAuthorizedError } =
      await import("../scripts/acceptance/db.mjs");
    const neverRun = vi.fn();
    const results: Result[] = await runJourneyStages([
      {
        key: "ACCESS",
        surface: JOURNEY_SURFACES.ACCESS,
        needs: [],
        run: async () => {
          throw new JourneyBlocked("Admission window exhausted.");
        },
      },
      {
        key: "DELIVERY",
        surface: JOURNEY_SURFACES.DELIVERY,
        needs: ["ACCESS"],
        run: neverRun,
      },
      {
        key: "LAB",
        surface: JOURNEY_SURFACES.LAB,
        needs: [],
        run: async () => {
          throw new Error("boom");
        },
      },
      {
        key: "RECOVERY",
        surface: JOURNEY_SURFACES.RECOVERY,
        needs: [],
        run: async () => {
          throw new AcceptanceWriteNotAuthorizedError("gate refused");
        },
      },
      {
        key: "CLASSROOM",
        surface: JOURNEY_SURFACES.CLASSROOM,
        needs: [],
        run: async () => pass(JOURNEY_SURFACES.CLASSROOM, "ok"),
      },
      {
        key: "TUTOR_LAB",
        surface: JOURNEY_SURFACES.TUTOR_LAB,
        needs: [],
        run: async () => pass(JOURNEY_SURFACES.ACCESS, "wrong surface"),
      },
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "BLOCKED",
      "BLOCKED",
      "FAIL",
      "BLOCKED",
      "PASS",
      "FAIL",
    ]);
    expect(neverRun).not.toHaveBeenCalled();
  });

  it("the negative/replay ledger is PASS only when every required check executed and held; a missing check is BLOCKED, a violated one FAIL; payment/webhook replay is only referenced as separate Stripe evidence", async () => {
    const {
      createNegativeLedger,
      evaluateNegativeLedger,
      REQUIRED_NEGATIVE_CHECKS,
    } = await journeyModule();
    const ledger = createNegativeLedger();
    expect(evaluateNegativeLedger(ledger).status).toBe("BLOCKED");
    for (const name of REQUIRED_NEGATIVE_CHECKS) ledger.record(name, []);
    const passed = evaluateNegativeLedger(ledger);
    expect(passed.status).toBe("PASS");
    expect(passed.details.join("\n")).toContain("npm run acceptance:stripe");
    expect(passed.details.join("\n")).toMatch(
      /PAYMENT_WEBHOOK_REPLAY: not executed/,
    );
    ledger.record("COMPLETION_REPLAY_IDEMPOTENT", ["second receipt"]);
    expect(evaluateNegativeLedger(ledger).status).toBe("FAIL");
    expect(() => ledger.record("UNKNOWN_CHECK", [])).toThrow();
    for (const required of [
      "ACCESS_REPLAY_IDEMPOTENT",
      "RESPONSE_REPLAY_IDEMPOTENT",
      "SUBMISSION_REPLAY_IDEMPOTENT",
      "FOREIGN_RESPONSE_DENIED",
      "FOREIGN_COMPLETION_DENIED",
      "INCOMPLETE_RESULT_COMPLETION_REFUSED",
      "BELOW_PASS_MARK_COMPLETION_REFUSED",
      "COMPLETION_REPLAY_IDEMPOTENT",
      "PROVIDER_UNAVAILABLE_FAIL_CLOSED",
      "TERMINAL_INITIAL_GRADE_REQUIRES_RECOVERY",
    ])
      expect(REQUIRED_NEGATIVE_CHECKS).toContain(required);
  });

  it("access verification FAILs on a duplicate entitlement, a direct/foreign enrolment, a paid order or a non-reviewer source", async () => {
    const { accessProblems } = await journeyModule();
    const expected = {
      learnerId: "L",
      offerId: "O",
      activationId: "A",
      campaignId: "C",
      programmeVersionId: "PV",
    };
    const granted = {
      kind: "ACCESS_GRANTED",
      entitlementId: "E",
      enrolmentId: "N",
    };
    const good = {
      entitlements: [
        {
          id: "E",
          learner_id: "L",
          offer_id: "O",
          activation_id: "A",
          order_id: null,
          enrolment_id: "N",
          source: "REVIEWER",
          campaign_redemption_id: "R",
          state: "ACTIVE",
        },
      ],
      enrolments: [
        {
          id: "N",
          status: "ACTIVE",
          student_id: "L",
          programme_version_id: "PV",
        },
      ],
      redemptions: [
        {
          id: "R",
          campaign_id: "C",
          entitlement_source: "REVIEWER",
          effective_price_amount_minor: 0,
        },
      ],
      orders: 0,
      paymentEvents: 0,
    };
    expect(accessProblems(good, granted, expected, "x")).toEqual([]);
    expect(
      accessProblems(
        { ...good, entitlements: [...good.entitlements, good.entitlements[0]] },
        granted,
        expected,
        "x",
      ),
    ).not.toEqual([]);
    expect(
      accessProblems(
        {
          ...good,
          enrolments: [{ ...good.enrolments[0], student_id: "FOREIGN" }],
        },
        granted,
        expected,
        "x",
      ),
    ).not.toEqual([]);
    expect(
      accessProblems({ ...good, orders: 1 }, granted, expected, "x"),
    ).not.toEqual([]);
    expect(
      accessProblems(
        {
          ...good,
          entitlements: [{ ...good.entitlements[0], source: "PURCHASE" }],
        },
        granted,
        expected,
        "x",
      ),
    ).not.toEqual([]);
    expect(
      accessProblems(good, { kind: "CHECKOUT" }, expected, "x"),
    ).not.toEqual([]);
  });

  it("completion verification requires exactly one learner receipt, exactly one audit event and a COMPLETED enrolment", async () => {
    const { completionProblems } = await journeyModule();
    const expected = {
      receiptId: "R",
      learnerId: "L",
      courseScoreBp: 10000,
      passMarkBp: 5000,
    };
    const receipt = {
      id: "R",
      student_id: "L",
      completed_by: "L",
      final_course_score_bp: 10000,
      pass_mark_bp: 5000,
    };
    const good = {
      receipts: [receipt],
      audits: 1,
      enrolmentStatus: "COMPLETED",
    };
    expect(completionProblems(good, expected, "x")).toEqual([]);
    expect(
      completionProblems(
        { ...good, receipts: [receipt, receipt] },
        expected,
        "x",
      ),
    ).not.toEqual([]);
    expect(
      completionProblems({ ...good, audits: 2 }, expected, "x"),
    ).not.toEqual([]);
    expect(
      completionProblems({ ...good, enrolmentStatus: "ACTIVE" }, expected, "x"),
    ).not.toEqual([]);
    expect(
      completionProblems(
        { ...good, receipts: [{ ...receipt, final_course_score_bp: 9000 }] },
        expected,
        "x",
      ),
    ).not.toEqual([]);
  });

  it("assessment windows are strictly sequential, satisfy window >= duration, and leave a start margin", async () => {
    const { componentWindows, COMPONENTS, JOURNEY_SCHEDULE } =
      await journeyModule();
    const windows = componentWindows(1_000_000);
    const opens = COMPONENTS.map((c: string) => windows[c].opensAt);
    for (let i = 1; i < opens.length; i++)
      expect(opens[i] - opens[i - 1]).toBe(
        JOURNEY_SCHEDULE.windowMinutes * 60_000,
      );
    expect(JOURNEY_SCHEDULE.windowMinutes).toBeGreaterThanOrEqual(
      JOURNEY_SCHEDULE.durationMinutes,
    );
    for (const c of COMPONENTS)
      expect(windows[c].latestStartAt - windows[c].opensAt).toBeGreaterThan(
        JOURNEY_SCHEDULE.startMarginMs + JOURNEY_SCHEDULE.latestStartSafetyMs,
      );
  });
});

// ---------------------------------------------------------------------------
// Stage behaviour against small in-memory stand-ins for the app and DB.
// ---------------------------------------------------------------------------
type Call = { jar: unknown; payload: Record<string, unknown> };
function fakeCtx(
  handler: (jar: unknown, payload: Record<string, unknown>) => unknown,
  queries:
    | Record<string, unknown[]>
    | ((sql: string, params: unknown[]) => unknown[]) = {},
) {
  const jars = {
    learner: { id: "learner" },
    foreign: { id: "foreign" },
    admin: { id: "admin" },
  };
  const calls: Call[] = [];
  const client = {
    call: async (jar: unknown, payload: Record<string, unknown>) => {
      calls.push({ jar, payload });
      const body = handler(jar, payload);
      return { status: 200, body, text: JSON.stringify(body ?? null) };
    },
  };
  const stub = {
    calls: [] as Record<string, unknown>[],
    clearPlans: vi.fn(),
    planZeroMarks: vi.fn(),
    planFailure: vi.fn(),
  };
  return {
    calls,
    jars,
    stub,
    ctx: {
      runId: "1790000000000-abcdef",
      jars,
      stub,
      journey: client,
      app: client,
      negatives: null as unknown,
      query: async (sql: string, params: unknown[] = []) => {
        if (typeof queries === "function") return queries(sql, params);
        for (const [needle, rows] of Object.entries(queries))
          if (sql.includes(needle)) return rows;
        return [];
      },
      log: () => {},
      sleep: async () => {},
      dbNowMs: async () => 0,
    },
  };
}

describe("customer journey: stage behaviour, session separation and fail-closed classification", () => {
  it("delivery: the foreign learner's probe is sent with the FOREIGN session, and a foreign read that is not denied FAILS both the negative ledger and FULL_JOURNEY:DELIVERY itself", async () => {
    const { stageDelivery, createNegativeLedger, JOURNEY_SURFACES } =
      await journeyModule();
    const planId = "10000000-0000-4000-8000-000000000001";
    const s = {
      enrolmentId: "E",
      learnerId: "L",
      lessonId: "LS",
      course: { programmeVersionId: "PV" },
    };
    const { ctx, calls, jars } = fakeCtx(
      (jar, payload) => {
        switch (payload.operation) {
          case "SAVE_STUDY_PLAN":
          case "CONFIRM_STUDY_PLAN":
            return { ok: true, result: { planId } };
          case "GET_DELIVERY_CONTEXT":
            // Fault: the foreign learner is NOT refused.
            return {
              ok: true,
              result: {
                enrolmentId: "E",
                enrolmentStatus: "ACTIVE",
                academicEligibility: "SUBJECT_TO_ACTIVITY",
                planId,
                planState: "CONFIRMED",
                planProgrammeVersionId: "PV",
                occurrenceCount: 1,
                occurrenceLessonIds: ["LS"],
              },
            };
          case "GET_AGENT_ACCESS":
            return {
              ok: true,
              result: {
                PROFESSOR: "AVAILABLE",
                TUTOR: "AVAILABLE",
                LAB_INSTRUCTOR: "AVAILABLE",
              },
            };
        }
        return null;
      },
      {
        delivery_study_plans: [
          {
            id: planId,
            state: "CONFIRMED",
            student_id: "L",
            programme_version_id: "PV",
          },
        ],
        scheduled_learning_occurrences: [{ n: 1 }],
      },
    );
    ctx.negatives = createNegativeLedger();
    const result = await stageDelivery(ctx, s);
    expect(result.surface).toBe(JOURNEY_SURFACES.DELIVERY);
    // The stage's own PASS claims the foreign learner was refused.
    expect(result.status).toBe("FAIL");
    const foreignCalls = calls.filter((c) => c.jar === jars.foreign);
    expect(foreignCalls.map((c) => c.payload.operation)).toEqual([
      "GET_DELIVERY_CONTEXT",
    ]);
    expect(calls.filter((c) => c.jar === jars.learner).length).toBe(5);
    expect(
      (ctx.negatives as { get: (n: string) => { problems: string[] } }).get(
        "FOREIGN_DELIVERY_CONTEXT_DENIED",
      ).problems.length,
    ).toBe(1);
  });

  it("lab: a production Examiner admission refusal (GRADING_PENDING, no claim row) is BLOCKED -- never FAIL, never PASS -- and disarms any armed stub control", async () => {
    const { stageLab, guardStage, createNegativeLedger, JOURNEY_SURFACES } =
      await journeyModule();
    const submissionId = "10000000-0000-4000-8000-0000000000dd";
    const s = {
      enrolmentId: "E",
      learnerId: "L",
      foreign: { enrolmentId: "FE" },
      course: { practicalId: "P" },
    };
    const { ctx, stub } = fakeCtx((jar, payload) =>
      payload.operation === "SUBMIT_LAB_AND_GRADE" &&
      (jar as { id: string }).id === "learner"
        ? { ok: true, result: { submissionId, grading: "GRADING_PENDING" } }
        : { error: "OPERATION_FAILED" },
    );
    ctx.negatives = createNegativeLedger();
    const result = await guardStage(JOURNEY_SURFACES.LAB, () =>
      stageLab(ctx, s),
    );
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("admission");
    expect(stub.clearPlans).toHaveBeenCalled();
  });

  it("an HTTP response carrying protected assessment content turns a stage into FAIL", async () => {
    const { stageDelivery, createNegativeLedger } = await journeyModule();
    const planId = "10000000-0000-4000-8000-000000000001";
    const s = {
      enrolmentId: "E",
      learnerId: "L",
      lessonId: "LS",
      course: { programmeVersionId: "PV" },
    };
    const { ctx } = fakeCtx(
      (jar, payload) => {
        if ((jar as { id: string }).id === "foreign")
          return {
            ok: false,
            error: "DELIVERY_DENIED",
            code: "NOT_FOUND_OR_FORBIDDEN",
          };
        if (payload.operation === "GET_DELIVERY_CONTEXT")
          return {
            ok: true,
            result: {
              enrolmentId: "E",
              enrolmentStatus: "ACTIVE",
              academicEligibility: "SUBJECT_TO_ACTIVITY",
              planId,
              planState: "CONFIRMED",
              planProgrammeVersionId: "PV",
              occurrenceCount: 1,
              occurrenceLessonIds: ["LS"],
              leaked: "Acceptance answer.",
            },
          };
        if (payload.operation === "GET_AGENT_ACCESS")
          return {
            ok: true,
            result: {
              PROFESSOR: "AVAILABLE",
              TUTOR: "AVAILABLE",
              LAB_INSTRUCTOR: "AVAILABLE",
            },
          };
        return { ok: true, result: { planId } };
      },
      {
        delivery_study_plans: [
          {
            id: planId,
            state: "CONFIRMED",
            student_id: "L",
            programme_version_id: "PV",
          },
        ],
        scheduled_learning_occurrences: [{ n: 1 }],
      },
    );
    ctx.negatives = createNegativeLedger();
    const result = await stageDelivery(ctx, s);
    expect(result.status).toBe("FAIL");
    expect(result.details.join(" ")).toContain("protected assessment content");
  });
});

// ---------------------------------------------------------------------------
describe("customer journey: static guarantees", () => {
  it("the driver, route and gate never sign, digest or name a protocol tag / MAC parameter / controller key", async () => {
    for (const file of [
      "scripts/acceptance/customer-journey.mjs",
      "src/app/api/acceptance/customer-journey/route.ts",
      "src/server/acceptance-journey-driver.ts",
    ]) {
      const text = await readRepo(file);
      expect(text).not.toMatch(/createHmac|subtle\.sign|\.digest\(|hmac\(/i);
      expect(text).not.toMatch(
        /HMAC_SHA256|p_mac\b|COMMERCIAL_V1_EXAMINER_V1|ACADEMIC_EXECUTION_(KEY_ID|HMAC_KEY_HEX)|COMMERCE_CONTROLLER/,
      );
    }
  });

  it("the positive journey never fabricates results, entitlements or enrolments: no result seeding helper, no direct institutional write SQL, and the only fixture enrolment is the foreign learner's", async () => {
    const text = await readRepo("scripts/acceptance/customer-journey.mjs");
    const code = text.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(
      /seedAcceptanceResults|seedResults|seedAcceptanceAttempt|seedAcceptanceLabSubmission|enrolAcceptanceLearner/,
    );
    expect(code).not.toMatch(
      /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\btruncate\b/i,
    );
    expect(code).not.toMatch(
      /create_enrolment|redeem_commercial_v1_campaign|fulfill_commercial_v1_order|withAcceptanceWriteConnection\(async \(c/,
    );
    // seedAcceptanceCourse's one create_enrolment is for the FOREIGN learner.
    expect(code).toMatch(
      /seedAcceptanceCourse\(\s*ctx\.adminClient,\s*`\$\{ctx\.runId\}-journey`,\s*ctx\.foreignAuthUserId,/,
    );
    // Access for the journey learner comes only from the production checkout.
    expect(code).toContain('operation: "CREATE_CHECKOUT"');
  });

  it("the journey has no coupling to the evidence-frozen concurrency harness", async () => {
    const text = await readRepo("scripts/acceptance/customer-journey.mjs");
    expect(text).not.toMatch(
      /concurrency-app-races|concurrency\.mjs|admissionWindowSql|ADMISSION_LIMITS/,
    );
  });

  it("the route exposes a finite strict operation union with no SQL, no provider selection and no sign-in/grading/recovery of its own; prompts are never relayed", async () => {
    const routeSource = await readRepo(
      "src/app/api/acceptance/customer-journey/route.ts",
    );
    // Code only: the route's own comments legitimately name what it never does.
    const route = routeSource.replace(/^\s*\/\/.*$/gm, "");
    const operations = [
      ...route.matchAll(/operation: z\.literal\("([A-Z_]+)"\)/g),
    ].map((m) => m[1]);
    expect(operations.sort()).toEqual(
      [
        "ATTEMPT_COMPLETION",
        "CONFIRM_STUDY_PLAN",
        "CREATE_CHECKOUT",
        "GET_ACTIVE_QUESTIONS",
        "GET_AGENT_ACCESS",
        "GET_DELIVERY_CONTEXT",
        "GET_PROGRESS",
        "OPEN_CLASSROOM",
        "PROFESSOR_ASK",
        "PROFESSOR_BEGIN_LESSON",
        "RECORD_RESPONSE",
        "REQUEST_PRACTICAL_SUPPORT",
        "REQUEST_TUTOR_HANDOFF",
        "SAVE_STUDY_PLAN",
        "START_ASSESSMENT",
        "SUBMIT_LAB_AND_GRADE",
        "TUTOR_LAB_SUPPORT",
      ].sort(),
    );
    expect(route.match(/z\.object\(/g) ?? []).toHaveLength(0);
    expect(route).not.toMatch(
      /\.from\(|\.rpc\("(?!get_ducelio)|select |insert |signInWithPassword/,
    );
    expect(route).not.toMatch(
      /OPENAI|ANTHROPIC|modelProfileRef|runtimeProfile|capability:/,
    );
    expect(route).not.toMatch(
      /prompt|expectedAnswer|markingGuidance|gradingGuidance/,
    );
    expect(route).toContain("customerJourneyRequestAllowed(request)");
    const gate = await readRepo("src/server/acceptance-journey-driver.ts");
    expect(gate).toContain('env.ACCEPTANCE_JOURNEY_DRIVER_ENABLED !== "true"');
    expect(gate).toContain(
      "return acceptanceAppDriverRequestAllowed(request, env);",
    );
  });
});

// ---------------------------------------------------------------------------
describe("customer journey: deterministic provider stub (journey mode) and redirect", () => {
  const responsesBody = (
    capability: string,
    context: Record<string, unknown>,
    model = "gpt-5.6-terra",
  ) => ({
    model,
    instructions: "governed",
    max_output_tokens: 700,
    store: false,
    input: JSON.stringify({ capability, context }),
  });
  async function post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("default mode is unchanged: no Anthropic path, no lab grading, no conversational capability, no zero-marks control", async () => {
    const { startProviderStub } =
      await import("../scripts/acceptance/examiner-provider-stub.mjs");
    const stub = await startProviderStub();
    try {
      expect(stub.anthropicUrl).toBeNull();
      const auth = { authorization: `Bearer ${stub.apiKey}` };
      expect(
        (await post(stub.url, responsesBody("get_lesson_context", {}), auth))
          .status,
      ).toBe(400);
      expect(
        (
          await post(
            stub.url,
            responsesBody("grade_practical_lab", {
              submissionId: "s",
              maxMarks: 10,
            }),
            auth,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await post(
            stub.url.replace("/v1/responses", "/v1/messages"),
            {},
            { "x-api-key": stub.apiKey },
          )
        ).status,
      ).toBe(404);
      expect(() => stub.planZeroMarks()).toThrow();
    } finally {
      await stub.close();
    }
  });

  it("journey mode answers Professor/Tutor/Lab with fixed text and lab grading deterministically; zero marks and failure are one-shot and clearable; no request content is echoed", async () => {
    const { startProviderStub, JOURNEY_STUB_TEXT } =
      await import("../scripts/acceptance/examiner-provider-stub.mjs");
    const stub = await startProviderStub({ journey: true });
    try {
      const auth = { authorization: `Bearer ${stub.apiKey}` };
      const professor = await post(
        stub.url,
        responsesBody("get_lesson_context", {
          lessonTitle: "Secret lesson body",
        }),
        auth,
      );
      const professorText = await professor.text();
      expect(JSON.parse(professorText).output[0].content[0].text).toBe(
        JOURNEY_STUB_TEXT.PROFESSOR,
      );
      expect(professorText).not.toContain("Secret lesson body");

      const tutor = await (
        await post(
          stub.url,
          responsesBody(
            "tutor_lab_support",
            { role: "TUTOR", learnerMessage: "private" },
            "gpt-5.6-luna",
          ),
          auth,
        )
      ).json();
      expect(tutor.output[0].content[0].text).toBe(JOURNEY_STUB_TEXT.TUTOR);
      // The Lab role is never answered over the OpenAI contract.
      expect(
        (
          await post(
            stub.url,
            responsesBody("tutor_lab_support", { role: "LAB_INSTRUCTOR" }),
            auth,
          )
        ).status,
      ).toBe(400);

      const anthropicBody = {
        model: "claude-sonnet-5",
        max_tokens: 700,
        system: "governed",
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              capability: "tutor_lab_support",
              context: { role: "LAB_INSTRUCTOR", learnerMessage: "private" },
            }),
          },
        ],
      };
      expect(
        (
          await post(stub.anthropicUrl!, anthropicBody, {
            "x-api-key": "wrong",
          })
        ).status,
      ).toBe(401);
      const lab = await (
        await post(stub.anthropicUrl!, anthropicBody, {
          "x-api-key": stub.apiKey,
        })
      ).json();
      expect(lab.type).toBe("message");
      expect(lab.content[0].text).toBe(JOURNEY_STUB_TEXT.LAB_INSTRUCTOR);

      const labGrade = (marks?: boolean) =>
        post(
          stub.url,
          responsesBody(
            "grade_practical_lab",
            {
              submissionId: marks ? "sub-zero" : "sub-full",
              maxMarks: 10,
              submissionBody: "private body",
              gradingGuidance: "Acceptance grading guidance.",
            },
            "gpt-5.6-luna",
          ),
          auth,
        );
      const full = await (await labGrade()).text();
      expect(JSON.parse(JSON.parse(full).output[0].content[0].text)).toEqual({
        outcome: "GRADED",
        marksAwarded: 10,
      });
      expect(full).not.toMatch(/private body|Acceptance grading guidance/);
      stub.planZeroMarks();
      const zero = await (await labGrade(true)).json();
      expect(JSON.parse(zero.output[0].content[0].text).marksAwarded).toBe(0);
      const again = await (await labGrade()).json();
      expect(JSON.parse(again.output[0].content[0].text).marksAwarded).toBe(10);

      stub.planFailure();
      stub.planZeroMarks();
      stub.clearPlans();
      expect((await labGrade()).status).toBe(200);

      const byRole = stub.calls.filter((c: { role: string | null }) => c.role);
      expect(
        byRole.map((c: { role: string; transport: string; model: string }) => [
          c.role,
          c.transport,
          c.model,
        ]),
      ).toEqual([
        ["PROFESSOR", "OPENAI", "gpt-5.6-terra"],
        ["TUTOR", "OPENAI", "gpt-5.6-luna"],
        ["LAB_INSTRUCTOR", "ANTHROPIC", "claude-sonnet-5"],
      ]);
      const zeroCall = stub.calls.find(
        (c: { submissionId: string | null }) => c.submissionId === "sub-zero",
      );
      expect(zeroCall.zeroMarks).toBe(true);
      expect(JSON.stringify(stub.calls)).not.toMatch(
        /private|Secret lesson body|guidance/,
      );
    } finally {
      await stub.close();
    }
  });

  it("the redirect sends the exact Anthropic Messages URL to the same loopback stub only when journey-configured; otherwise Anthropic stays refused", async () => {
    const { createProviderRedirectFetch } =
      await import("../scripts/acceptance/examiner-provider-stub.mjs");
    const seen: string[] = [];
    const base = vi.fn(async (input: unknown) => {
      seen.push(String(input));
      return new Response("ok");
    });
    const stubUrl = "http://127.0.0.1:5555/v1/responses";
    const journey = createProviderRedirectFetch(
      base,
      stubUrl,
      "2".repeat(64),
      null,
      { anthropicStubUrl: "http://127.0.0.1:5555/v1/messages" },
    );
    await journey("https://api.anthropic.com/v1/messages", { method: "POST" });
    await expect(
      journey("https://api.anthropic.com/v1/complete"),
    ).rejects.toThrow();
    await expect(
      journey(
        new Request("https://api.anthropic.com/v1/messages", {
          method: "POST",
        }),
      ),
    ).rejects.toThrow();
    expect(seen).toEqual(["http://127.0.0.1:5555/v1/messages"]);
    const plain = createProviderRedirectFetch(base, stubUrl, "2".repeat(64));
    await expect(
      plain("https://api.anthropic.com/v1/messages"),
    ).rejects.toThrow();
    for (const bad of [
      "http://127.0.0.1:6666/v1/messages",
      "http://example.com:5555/v1/messages",
      "http://127.0.0.1:5555/v1/other",
    ])
      expect(() =>
        createProviderRedirectFetch(base, stubUrl, "2".repeat(64), null, {
          anthropicStubUrl: bad,
        }),
      ).toThrow();
  });

  it("the preload refuses an Anthropic stub URL outside the customer-journey driver", () => {
    const preload = pathToFileURL(
      fileURLToPath(
        new URL(
          "../scripts/acceptance/examiner-provider-redirect.mjs",
          import.meta.url,
        ),
      ),
    ).href;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ACCEPTANCE_APP_DRIVER_ENABLED: "true",
      ACCEPTANCE_PROVIDER_STUB_URL: "http://127.0.0.1:5555/v1/responses",
      ACCEPTANCE_PROVIDER_REDIRECT_TOKEN: "4".repeat(64),
      ACCEPTANCE_PROVIDER_ANTHROPIC_STUB_URL:
        "http://127.0.0.1:5555/v1/messages",
    };
    delete env.ACCEPTANCE_JOURNEY_DRIVER_ENABLED;
    const run = spawnSync(process.execPath, ["--import", preload, "-e", ""], {
      env,
      encoding: "utf8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(
      "available to the customer-journey driver only",
    );
    const ok = spawnSync(process.execPath, ["--import", preload, "-e", ""], {
      env: { ...env, ACCEPTANCE_JOURNEY_DRIVER_ENABLED: "true" },
      encoding: "utf8",
    });
    expect(ok.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("customer journey: fixture options", () => {
  it("journeyAgents enables only reviewed role configurations; defaults are unchanged for every other caller", async () => {
    const { buildAcceptancePackage } =
      await import("../scripts/acceptance/fixtures.mjs");
    const { roleCapabilityCatalogue } =
      await import("@/domain/academic-capability-policy");
    const { ROLE_RUNTIME_PROFILE_POLICY } =
      await import("@/domain/academic-runtime-profile");
    const pkg = buildAcceptancePackage("run", {
      journeyAgents: true,
      assessmentDurationMinutes: 2,
    });
    for (const [role, config] of Object.entries(pkg.agentConfiguration) as [
      keyof typeof roleCapabilityCatalogue,
      {
        enabled: boolean;
        modelProfileRef: string | null;
        capabilities: string[];
        escalationPolicy: string;
      },
    ][]) {
      if (role === "COUNSELLOR") {
        expect(config.enabled).toBe(false);
        continue;
      }
      expect(config.enabled).toBe(true);
      expect(config.modelProfileRef).toBe(
        ROLE_RUNTIME_PROFILE_POLICY[role].allowedRef,
      );
      expect(config.escalationPolicy).toBe("NONE");
      for (const capability of config.capabilities)
        expect(roleCapabilityCatalogue[role]).toContain(capability);
    }
    expect(
      pkg.assessmentTemplates.every(
        (t: { durationMinutes: number }) => t.durationMinutes === 2,
      ),
    ).toBe(true);

    const plain = buildAcceptancePackage("run");
    expect(
      Object.values(plain.agentConfiguration).every(
        (c) => (c as { enabled: boolean }).enabled === false,
      ),
    ).toBe(true);
    expect(
      plain.assessmentTemplates.every(
        (t: { durationMinutes: number }) => t.durationMinutes === 30,
      ),
    ).toBe(true);
    expect(() =>
      buildAcceptancePackage("run", { assessmentDurationMinutes: 0 }),
    ).toThrow();
  });

  it("journeyAssessmentWindows are strictly sequential from one base, each opening at the previous close; malformed schedules are refused", async () => {
    const { journeyAssessmentWindows } =
      await import("../scripts/acceptance/fixtures.mjs");
    const windows = journeyAssessmentWindows({
      firstOpensAt: Date.UTC(2026, 0, 1),
      windowMinutes: 3,
    });
    expect(windows.map((w: { templateKey: string }) => w.templateKey)).toEqual([
      "quiz_1",
      "quiz_2",
      "midterm",
      "quiz_3",
      "quiz_4",
      "final",
    ]);
    for (let i = 0; i < windows.length; i++) {
      expect(
        Date.parse(windows[i].closesAt) - Date.parse(windows[i].opensAt),
      ).toBe(180_000);
      if (i > 0) expect(windows[i].opensAt).toBe(windows[i - 1].closesAt);
    }
    expect(() =>
      journeyAssessmentWindows({ firstOpensAt: NaN, windowMinutes: 3 }),
    ).toThrow();
    expect(() =>
      journeyAssessmentWindows({ firstOpensAt: 0, windowMinutes: 0 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Independent-review corrections.
// ---------------------------------------------------------------------------
const POSITIVE_ORDER = [
  "ACCESS",
  "DELIVERY",
  "CLASSROOM",
  "TUTOR_LAB",
  "ASSESSMENTS",
  "RECOVERY",
  "LAB",
  "PROGRESS_COMPLETION",
];

async function runStagedWith(
  outcomes: Record<string, "PASS" | "FAIL" | "BLOCKED">,
) {
  const { buildStages, runJourneyStages, JOURNEY_SURFACES, STAGE_GRAPH } =
    await journeyModule();
  const { pass, fail, blocked } =
    await import("../scripts/acceptance/report.mjs");
  const keys = STAGE_GRAPH.map((g: { key: string }) => g.key) as string[];
  const executed: string[] = [];
  const runners = Object.fromEntries(
    keys.map((key) => [
      key,
      async () => {
        executed.push(key);
        const surface = JOURNEY_SURFACES[key];
        const status = outcomes[key] ?? "PASS";
        return status === "PASS"
          ? pass(surface, "ok")
          : status === "FAIL"
            ? fail(surface, "violated")
            : blocked(surface, "prerequisite");
      },
    ]),
  );
  const results: Result[] = await runJourneyStages(
    buildStages({}, {}, runners),
  );
  const status = Object.fromEntries(
    keys.map((key, i) => [key, results[i].status]),
  );
  return { executed, status, results };
}

describe("customer journey: the positive journey is one strictly staged chain", () => {
  it("declares the exact effective chain ACCESS -> DELIVERY -> CLASSROOM -> TUTOR_LAB -> ASSESSMENTS -> RECOVERY -> LAB -> PROGRESS_COMPLETION", async () => {
    const { STAGE_GRAPH } = await journeyModule();
    expect(
      STAGE_GRAPH.map(({ key, needs }: { key: string; needs: string[] }) => [
        key,
        [...needs],
      ]),
    ).toEqual([
      ["ACCESS", []],
      ["DELIVERY", ["ACCESS"]],
      ["CLASSROOM", ["DELIVERY"]],
      ["TUTOR_LAB", ["CLASSROOM"]],
      ["ASSESSMENTS", ["TUTOR_LAB"]],
      ["RECOVERY", []],
      ["LAB", ["ASSESSMENTS", "RECOVERY"]],
      ["PROGRESS_COMPLETION", ["ASSESSMENTS", "RECOVERY", "LAB"]],
      ["NEGATIVE_REPLAY", []],
    ]);
    const { executed, status } = await runStagedWith({});
    expect(executed).toEqual([...POSITIVE_ORDER, "NEGATIVE_REPLAY"]);
    expect(Object.values(status).every((v) => v === "PASS")).toBe(true);
  });

  it("1. a CLASSROOM BLOCK prevents TUTOR_LAB, ASSESSMENTS and LAB from executing", async () => {
    const { executed, status } = await runStagedWith({ CLASSROOM: "BLOCKED" });
    for (const key of [
      "TUTOR_LAB",
      "ASSESSMENTS",
      "LAB",
      "PROGRESS_COMPLETION",
    ]) {
      expect(executed).not.toContain(key);
      expect(status[key]).toBe("BLOCKED");
    }
  });

  it("2. a TUTOR_LAB FAIL prevents ASSESSMENTS and LAB from executing", async () => {
    const { executed, status } = await runStagedWith({ TUTOR_LAB: "FAIL" });
    expect(status.TUTOR_LAB).toBe("FAIL");
    for (const key of ["ASSESSMENTS", "LAB", "PROGRESS_COMPLETION"]) {
      expect(executed).not.toContain(key);
      expect(status[key]).toBe("BLOCKED");
    }
  });

  it("3. an ASSESSMENTS BLOCK prevents LAB from executing", async () => {
    const { executed, status } = await runStagedWith({
      ASSESSMENTS: "BLOCKED",
    });
    for (const key of ["LAB", "PROGRESS_COMPLETION"]) {
      expect(executed).not.toContain(key);
      expect(status[key]).toBe("BLOCKED");
    }
  });

  it("4. a RECOVERY BLOCK prevents LAB and PROGRESS_COMPLETION from executing", async () => {
    const { executed, status } = await runStagedWith({ RECOVERY: "BLOCKED" });
    for (const key of ["LAB", "PROGRESS_COMPLETION"]) {
      expect(executed).not.toContain(key);
      expect(status[key]).toBe("BLOCKED");
    }
  });

  it("5. skipped downstream stages are BLOCKED, never PASS, for every upstream non-PASS outcome; the aggregate is never PASS", async () => {
    const { aggregateJourney } = await journeyModule();
    for (const upstream of POSITIVE_ORDER.slice(0, -1))
      for (const outcome of ["FAIL", "BLOCKED"] as const) {
        const { executed, status, results } = await runStagedWith({
          [upstream]: outcome,
        });
        // RECOVERY only reports a captured result (its own stage stand-in
        // here always runs); every other later positive stage is skipped.
        const later = POSITIVE_ORDER.slice(
          POSITIVE_ORDER.indexOf(upstream) + 1,
        ).filter((key) => key !== "RECOVERY");
        for (const key of later) {
          expect(executed).not.toContain(key);
          expect(status[key]).toBe("BLOCKED");
        }
        expect(aggregateJourney(results).status).not.toBe("PASS");
      }
  });

  it("RECOVERY executes nothing of its own: it reports the captured ASSESSMENTS result, or BLOCKED when that point was never reached", async () => {
    const { reportRecovery, JOURNEY_SURFACES } = await journeyModule();
    const { pass } = await import("../scripts/acceptance/report.mjs");
    const captured = pass(JOURNEY_SURFACES.RECOVERY, "captured");
    expect(reportRecovery({}, { recoveryResult: captured })).toBe(captured);
    const notReached = reportRecovery({}, {});
    expect(notReached.status).toBe("BLOCKED");
    expect(notReached.reason).toContain("Not reached");
  });
});

describe("customer journey: foreign-learner lab admission refusal is BLOCKED", () => {
  it("GRADING_PENDING with no Examiner claim for the FOREIGN learner's own lab => FULL_JOURNEY:LAB BLOCKED (not FAIL/PASS), and the armed zero-mark plan is disarmed", async () => {
    const { stageLab, guardStage, createNegativeLedger, JOURNEY_SURFACES } =
      await journeyModule();
    const MAIN_SUB = "10000000-0000-4000-8000-0000000000d1";
    const FOREIGN_SUB = "10000000-0000-4000-8000-0000000000d2";
    const MAIN_REV = "10000000-0000-4000-8000-0000000000d3";
    const s = {
      enrolmentId: "E",
      learnerId: "L",
      foreign: { enrolmentId: "FE" },
      course: { practicalId: "P" },
    };
    const stubCalls: Record<string, unknown>[] = [];
    let mainSubmitted = false;
    const { ctx, stub } = fakeCtx(
      (jar, payload) => {
        const who = (jar as { id: string }).id;
        if (payload.operation !== "SUBMIT_LAB_AND_GRADE") return null;
        if (who === "foreign" && payload.enrolmentId === "E")
          return { error: "OPERATION_FAILED" };
        if (who === "learner") {
          if (!mainSubmitted)
            stubCalls.push({
              capability: "grade_practical_lab",
              submissionId: MAIN_SUB,
              outcome: "GRADED",
            });
          mainSubmitted = true;
          return {
            ok: true,
            result: { submissionId: MAIN_SUB, grading: "GRADED" },
          };
        }
        // The foreign learner's own lab: production admission refused.
        return {
          ok: true,
          result: { submissionId: FOREIGN_SUB, grading: "GRADING_PENDING" },
        };
      },
      (sql, params) => {
        if (sql.includes("from commercial_v1_lab_submissions"))
          return params[0] === "E" && mainSubmitted
            ? [
                {
                  id: MAIN_SUB,
                  student_id: "L",
                  enrolment_id: "E",
                  practical_id: "P",
                },
              ]
            : [];
        if (sql.includes("from commercial_v1_examiner_executions"))
          return params[0] === MAIN_SUB
            ? [
                {
                  id: "X",
                  state: "SUCCEEDED",
                  capability: "grade_practical_lab",
                  student_id: "L",
                  enrolment_id: "E",
                  result_revision_id: MAIN_REV,
                  provider_calls: 1,
                },
              ]
            : [];
        if (sql.includes("from commercial_v1_lab_result_revisions"))
          return params[0] === "E"
            ? [
                {
                  id: MAIN_REV,
                  revision_number: 1,
                  submission_id: MAIN_SUB,
                  earned_marks: 10,
                  max_marks: 10,
                  valid: true,
                },
              ]
            : [];
        return [];
      },
    );
    stub.calls = stubCalls;
    ctx.negatives = createNegativeLedger();
    const result = await guardStage(JOURNEY_SURFACES.LAB, () =>
      stageLab(ctx, s),
    );
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("foreign learner's lab grading");
    expect(result.reason).toContain("admission");
    // Armed for the foreign learner, then disarmed by the refusal handling.
    expect(stub.planZeroMarks).toHaveBeenCalledTimes(1);
    const armedAt = stub.planZeroMarks.mock.invocationCallOrder[0];
    expect(
      stub.clearPlans.mock.invocationCallOrder.some((order) => order > armedAt),
    ).toBe(true);
    // The primary learner's own lab path had already met its invariants.
    const ledger = ctx.negatives as {
      get: (n: string) => { problems: string[] } | null;
    };
    expect(ledger.get("LAB_SUBMISSION_REPLAY_IDEMPOTENT")?.problems).toEqual(
      [],
    );
    expect(ledger.get("FOREIGN_LAB_SUBMISSION_DENIED")?.problems).toEqual([]);
  });
});

describe("customer journey: foreign delivery denial must be the exact ownership refusal", () => {
  const response = (body: unknown, status = 200) => ({
    status,
    body,
    text: JSON.stringify(body),
  });
  const denial = (code: string) => ({
    ok: false,
    error: "DELIVERY_DENIED",
    code,
  });

  it("NOT_FOUND_OR_FORBIDDEN => negative check PASS", async () => {
    const { foreignDeliveryDenialProblems } = await journeyModule();
    expect(
      foreignDeliveryDenialProblems(response(denial("NOT_FOUND_OR_FORBIDDEN"))),
    ).toEqual([]);
  });

  it("SERVICE_UNAVAILABLE => negative check FAIL", async () => {
    const { foreignDeliveryDenialProblems } = await journeyModule();
    expect(
      foreignDeliveryDenialProblems(response(denial("SERVICE_UNAVAILABLE"))),
    ).toHaveLength(1);
  });

  it.each([
    "POLICY_BLOCKED",
    "FORBIDDEN",
    "UNAUTHENTICATED",
    "CONTEXT_CONFLICT",
    "ACTIVITY_BLOCKED",
    "INVALID_INPUT",
  ])(
    "another DeliveryDenied code (%s) => negative check FAIL",
    async (code) => {
      const { foreignDeliveryDenialProblems } = await journeyModule();
      expect(
        foreignDeliveryDenialProblems(response(denial(code))),
      ).toHaveLength(1);
    },
  );

  it("a non-200 status, a missing error, a success or no response is FAIL", async () => {
    const { foreignDeliveryDenialProblems } = await journeyModule();
    expect(
      foreignDeliveryDenialProblems(
        response(denial("NOT_FOUND_OR_FORBIDDEN"), 500),
      ),
    ).toHaveLength(1);
    expect(
      foreignDeliveryDenialProblems(
        response({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" }),
      ),
    ).toHaveLength(1);
    expect(
      foreignDeliveryDenialProblems(response({ ok: true, result: {} })),
    ).toHaveLength(1);
    expect(foreignDeliveryDenialProblems(null)).toHaveLength(1);
  });

  it("stageDelivery: a SERVICE_UNAVAILABLE foreign denial is a FAILED negative check AND FULL_JOURNEY:DELIVERY FAIL, not PASS", async () => {
    const { stageDelivery, createNegativeLedger } = await journeyModule();
    const planId = "10000000-0000-4000-8000-000000000001";
    const s = {
      enrolmentId: "E",
      learnerId: "L",
      lessonId: "LS",
      course: { programmeVersionId: "PV" },
    };
    const { ctx } = fakeCtx(
      (jar, payload) => {
        if ((jar as { id: string }).id === "foreign")
          return denial("SERVICE_UNAVAILABLE");
        if (payload.operation === "GET_DELIVERY_CONTEXT")
          return {
            ok: true,
            result: {
              enrolmentId: "E",
              enrolmentStatus: "ACTIVE",
              academicEligibility: "SUBJECT_TO_ACTIVITY",
              planId,
              planState: "CONFIRMED",
              planProgrammeVersionId: "PV",
              occurrenceCount: 1,
              occurrenceLessonIds: ["LS"],
            },
          };
        if (payload.operation === "GET_AGENT_ACCESS")
          return {
            ok: true,
            result: {
              PROFESSOR: "AVAILABLE",
              TUTOR: "AVAILABLE",
              LAB_INSTRUCTOR: "AVAILABLE",
            },
          };
        return { ok: true, result: { planId } };
      },
      {
        delivery_study_plans: [
          {
            id: planId,
            state: "CONFIRMED",
            student_id: "L",
            programme_version_id: "PV",
          },
        ],
        scheduled_learning_occurrences: [{ n: 1 }],
      },
    );
    ctx.negatives = createNegativeLedger();
    const result = await stageDelivery(ctx, s);
    const ledger = ctx.negatives as {
      get: (n: string) => { problems: string[] } | null;
    };
    const recorded = ledger.get("FOREIGN_DELIVERY_CONTEXT_DENIED")?.problems;
    expect(recorded).toHaveLength(1);
    // The SAME problem gates FULL_JOURNEY:DELIVERY itself.
    expect(result.status).toBe("FAIL");
    expect(result.details).toContain(recorded![0]);
  });
});

// ---------------------------------------------------------------------------
// Independent review V3: a surface's own PASS must include the negative/
// replay invariants its PASS text claims.
// ---------------------------------------------------------------------------
const V3_ENV_ID = "a0000000-0000-4000-8000-000000000001";
const DB_TS = "2026-09-28T12:00:00.000Z";
type Ledger = { get: (n: string) => { problems: string[] } | null };

// The real write gates (assertAcceptanceSupabaseWriteAuthorized +
// withAcceptanceWriteConnection) run unmodified against a fake `pg` whose
// marker query matches and a fake admin client that reports the same
// acceptance environment id.
function enableFakeWriteGates() {
  Object.assign(process.env, {
    ACCEPTANCE_WRITE_ENABLED: "true",
    ACCEPTANCE_ENVIRONMENT_ID: V3_ENV_ID,
    ACCEPTANCE_DATABASE_URL:
      "postgresql://acceptance:fake@localhost:5432/acceptance",
  });
  function FakeClient() {
    return {
      connect: async () => {},
      end: async () => {},
      query: async () => ({ rows: [{ "?column?": 1 }] }),
    };
  }
  vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
}

function classroomWorld(replayStatus: "DUPLICATE" | "SUCCEEDED") {
  const CS = "10000000-0000-4000-8000-0000000000c1";
  const CR = "10000000-0000-4000-8000-0000000000c2";
  const runId = "1790000000000-abcdef";
  const beginKey = `journey-${runId}-begin`;
  const askKey = `journey-${runId}-ask`;
  const s = {
    enrolmentId: "E",
    learnerId: "L",
    lessonId: "LS",
    course: { cohortId: "C", instructorId: "I" },
  };
  const professorCalls: Record<string, unknown>[] = [];
  let begun = false;
  const world = fakeCtx(
    (_jar, payload) => {
      switch (payload.operation) {
        case "OPEN_CLASSROOM":
          return {
            ok: true,
            result: {
              classroomId: CR,
              classSessionId: CS,
              enrolmentId: "E",
              lessonId: "LS",
              mode: "CATCH_UP",
            },
          };
        case "PROFESSOR_BEGIN_LESSON":
          if (begun)
            return { ok: true, result: { status: replayStatus, text: null } };
          begun = true;
          professorCalls.push({
            role: "PROFESSOR",
            transport: "OPENAI",
            model: "gpt-5.6-terra",
          });
          return {
            ok: true,
            result: {
              status: "SUCCEEDED",
              text: "Synthetic acceptance Professor response.",
            },
          };
        case "PROFESSOR_ASK":
          professorCalls.push({
            role: "PROFESSOR",
            transport: "OPENAI",
            model: "gpt-5.6-terra",
          });
          return {
            ok: true,
            result: {
              status: "SUCCEEDED",
              text: "Synthetic acceptance Professor response.",
            },
          };
      }
      return null;
    },
    (sql) => {
      if (sql.includes("clock_timestamp() as ts"))
        return [{ ms: 0, ts: DB_TS }];
      if (sql.includes("from academic_provider_executions"))
        return [
          {
            id: "P1",
            state: "SUCCEEDED",
            reason_code: null,
            provider_calls: 1,
          },
          {
            id: "P2",
            state: "SUCCEEDED",
            reason_code: null,
            provider_calls: 1,
          },
        ];
      if (sql.includes("from professor_classroom_sessions"))
        return [
          {
            id: CR,
            student_id: "L",
            enrolment_id: "E",
            lesson_id: "LS",
            mode: "CATCH_UP",
          },
        ];
      if (sql.includes("from professor_classroom_interaction_reservations"))
        return [askKey, beginKey].sort().map((k) => ({ idempotency_key: k }));
      return [];
    },
  );
  world.stub.calls = professorCalls;
  Object.assign(world.ctx, {
    adminClient: {
      rpc: async (name: string) =>
        name === "get_ducelio_acceptance_environment_id"
          ? { data: V3_ENV_ID, error: null }
          : name === "create_class_session"
            ? { data: CS, error: null }
            : { data: null, error: { message: "unexpected rpc" } },
    },
  });
  return { ...world, s };
}

type TutorLabWorldOptions = {
  // Foreign probe returns SUCCEEDED (and a non-owner reservation exists).
  foreignReaches?: boolean;
  // Foreign probe returns UNAVAILABLE but ADDS a reservation and execution.
  foreignAddsRows?: boolean;
  // The first hosted failure shape: the OWNER's Tutor support fails
  // (UNAVAILABLE, no provider execution, no provider call).
  ownerTutorFails?: boolean;
};

function tutorLabWorld(options: TutorLabWorldOptions | boolean = {}) {
  const {
    foreignReaches = false,
    foreignAddsRows = false,
    ownerTutorFails = false,
  } = typeof options === "boolean" ? { foreignReaches: options } : options;
  const T = "10000000-0000-4000-8000-0000000000f1";
  const LH = "10000000-0000-4000-8000-0000000000f2";
  const OBJ = "10000000-0000-4000-8000-0000000000f3";
  const s = {
    enrolmentId: "E",
    learnerId: "L",
    lessonId: "LS",
    objectiveId: OBJ,
    course: { practicalId: "P" },
  };
  const roleOf: Record<string, string> = {
    [T]: "TUTOR",
    [LH]: "LAB_INSTRUCTOR",
  };
  const answered = new Set<string>();
  const stubCalls: Record<string, unknown>[] = [];
  const handoffRequests: Record<string, unknown>[] = [];
  let foreignProbed = false;
  const world = fakeCtx(
    (jar, payload) => {
      const who = (jar as { id: string }).id;
      if (payload.operation === "REQUEST_TUTOR_HANDOFF") {
        handoffRequests.push(payload);
        return { ok: true, result: { handoffId: T } };
      }
      if (payload.operation === "REQUEST_PRACTICAL_SUPPORT")
        return { ok: true, result: { ok: true, handoffId: LH } };
      if (payload.operation !== "TUTOR_LAB_SUPPORT") return null;
      const handoffId = payload.handoffId as string;
      if (who === "foreign") {
        foreignProbed = true;
        return foreignReaches
          ? {
              ok: true,
              result: {
                status: "SUCCEEDED",
                role: "TUTOR",
                text: "Synthetic acceptance Tutor response.",
              },
            }
          : {
              ok: true,
              result: { status: "UNAVAILABLE", role: null, text: null },
            };
      }
      const role = roleOf[handoffId];
      if (role === "TUTOR" && ownerTutorFails)
        return {
          ok: true,
          result: { status: "UNAVAILABLE", role: null, text: null },
        };
      if (answered.has(handoffId))
        return {
          ok: true,
          result: { status: "DUPLICATE", role: null, text: null },
        };
      answered.add(handoffId);
      stubCalls.push(
        role === "TUTOR"
          ? { role, transport: "OPENAI", model: "gpt-5.6-luna" }
          : { role, transport: "ANTHROPIC", model: "claude-sonnet-5" },
      );
      return {
        ok: true,
        result: {
          status: "SUCCEEDED",
          role,
          text:
            role === "TUTOR"
              ? "Synthetic acceptance Tutor response."
              : "Synthetic acceptance Lab Instructor response.",
        },
      };
    },
    (sql, params) => {
      if (sql.includes("clock_timestamp() as ts"))
        return [{ ms: 0, ts: DB_TS }];
      if (sql.includes("state='BLOCKED' and reason_code='RATE_LIMITED'"))
        return [{ n: 0 }];
      if (sql.includes("from delivery_handoffs")) {
        const id = params[0] as string;
        return [
          {
            id,
            enrolment_id: "E",
            requested_by: "L",
            destination_profile: roleOf[id],
            reason_code:
              id === T ? "OBJECTIVE_REINFORCEMENT" : "PRACTICAL_HELP",
            lesson_id: "LS",
            objective_id: id === T ? OBJ : null,
          },
        ];
      }
      if (sql.includes("from tutor_lab_interaction_reservations")) {
        const rows = [{ student_id: "L", idempotency_key: "owner-key" }];
        if (foreignReaches)
          rows.push({ student_id: "FOREIGN", idempotency_key: "old-key" });
        if (foreignAddsRows && foreignProbed)
          rows.push({ student_id: "FOREIGN", idempotency_key: "probe-key" });
        return rows;
      }
      if (sql.includes("from tutor_lab_provider_executions e")) {
        const id = params[0] as string;
        const role = roleOf[id];
        const rows: Record<string, unknown>[] =
          role === "TUTOR" && ownerTutorFails
            ? []
            : [
                {
                  id: `X-${id}`,
                  state: "SUCCEEDED",
                  reason_code: null,
                  agent_profile: role,
                  student_id: "L",
                  provider_calls: 1,
                },
              ];
        if (id === T && foreignAddsRows && foreignProbed)
          rows.push({
            id: "X-foreign-probe",
            state: "ABSTAINED",
            reason_code: "POLICY_BLOCKED",
            agent_profile: "TUTOR",
            student_id: "FOREIGN",
            provider_calls: 0,
          });
        return rows;
      }
      return [];
    },
  );
  world.stub.calls = stubCalls;
  return { ...world, s, handoffRequests, T, OBJ };
}

function labWorld({
  foreignOnLearnerSucceeds = false,
  replayDiffers = false,
} = {}) {
  const MAIN_SUB = "10000000-0000-4000-8000-0000000000d1";
  const OTHER_SUB = "10000000-0000-4000-8000-0000000000d9";
  const MAIN_REV = "10000000-0000-4000-8000-0000000000d3";
  const s = {
    enrolmentId: "E",
    learnerId: "L",
    foreign: { enrolmentId: "FE" },
    course: { practicalId: "P" },
  };
  const stubCalls: Record<string, unknown>[] = [];
  let learnerSubmits = 0;
  const world = fakeCtx(
    (jar, payload) => {
      const who = (jar as { id: string }).id;
      if (payload.operation !== "SUBMIT_LAB_AND_GRADE") return null;
      if (who === "foreign" && payload.enrolmentId === "E")
        return foreignOnLearnerSucceeds
          ? { ok: true, result: { submissionId: OTHER_SUB, grading: "GRADED" } }
          : { error: "OPERATION_FAILED" };
      if (who === "learner") {
        learnerSubmits += 1;
        if (learnerSubmits === 1)
          stubCalls.push({
            capability: "grade_practical_lab",
            submissionId: MAIN_SUB,
            outcome: "GRADED",
          });
        return {
          ok: true,
          result: {
            submissionId:
              learnerSubmits > 1 && replayDiffers ? OTHER_SUB : MAIN_SUB,
            grading: "GRADED",
          },
        };
      }
      return {
        ok: true,
        result: { submissionId: OTHER_SUB, grading: "GRADED" },
      };
    },
    (sql, params) => {
      if (sql.includes("from commercial_v1_lab_submissions"))
        return params[0] === "E" && learnerSubmits > 0
          ? [
              {
                id: MAIN_SUB,
                student_id: "L",
                enrolment_id: "E",
                practical_id: "P",
              },
            ]
          : [];
      if (sql.includes("from commercial_v1_examiner_executions"))
        return params[0] === MAIN_SUB
          ? [
              {
                id: "X",
                state: "SUCCEEDED",
                capability: "grade_practical_lab",
                student_id: "L",
                enrolment_id: "E",
                result_revision_id: MAIN_REV,
                provider_calls: 1,
              },
            ]
          : [];
      if (sql.includes("from commercial_v1_lab_result_revisions"))
        return params[0] === "E"
          ? [
              {
                id: MAIN_REV,
                revision_number: 1,
                submission_id: MAIN_SUB,
                earned_marks: 10,
                max_marks: 10,
                valid: true,
              },
            ]
          : [];
      return [];
    },
  );
  world.stub.calls = stubCalls;
  return { ...world, s };
}

describe("customer journey (review V3): each surface's own PASS includes the negative/replay invariants it claims", () => {
  afterEach(() => {
    vi.doUnmock("pg");
  });

  it("CLASSROOM: a coherent world PASSes (control)", async () => {
    enableFakeWriteGates();
    vi.resetModules();
    const { stageClassroom, createNegativeLedger } = await journeyModule();
    const { ctx, s } = classroomWorld("DUPLICATE");
    ctx.negatives = createNegativeLedger();
    const result = await stageClassroom(ctx, s);
    expect(result.status).toBe("PASS");
  });

  it("2. CLASSROOM: a replayed key that is not DUPLICATE => FULL_JOURNEY:CLASSROOM FAIL (same problem recorded in the ledger)", async () => {
    enableFakeWriteGates();
    vi.resetModules();
    const { stageClassroom, createNegativeLedger } = await journeyModule();
    const { ctx, s } = classroomWorld("SUCCEEDED");
    ctx.negatives = createNegativeLedger();
    const result = await stageClassroom(ctx, s);
    expect(result.status).toBe("FAIL");
    const recorded = (ctx.negatives as Ledger).get(
      "CLASSROOM_INTERACTION_REPLAY",
    )?.problems;
    expect(recorded).toHaveLength(1);
    expect(result.details).toContain(recorded![0]);
  });

  it("TUTOR_LAB: a coherent world PASSes (control)", async () => {
    const { stageTutorLab, createNegativeLedger } = await journeyModule();
    const { ctx, s } = tutorLabWorld(false);
    ctx.negatives = createNegativeLedger();
    const result = await stageTutorLab(ctx, s);
    expect(result.status).toBe("PASS");
  });

  it("3. TUTOR_LAB: the foreign learner reaches/reserves another learner's Tutor handoff => FULL_JOURNEY:TUTOR_LAB FAIL (same problem recorded in the ledger)", async () => {
    const { stageTutorLab, createNegativeLedger } = await journeyModule();
    const { ctx, s } = tutorLabWorld(true);
    ctx.negatives = createNegativeLedger();
    const result = await stageTutorLab(ctx, s);
    expect(result.status).toBe("FAIL");
    const recorded = (ctx.negatives as Ledger).get(
      "FOREIGN_TUTOR_LAB_DENIED",
    )?.problems;
    // Evidence-specific: the SUCCEEDED status and the non-owner row are
    // reported separately; every recorded problem gates the stage.
    expect(recorded?.length).toBeGreaterThan(0);
    for (const problem of recorded ?? [])
      expect(result.details).toContain(problem);
  });

  it("LAB: a coherent world PASSes (control) and runs the foreign learner's own zero-mark lab", async () => {
    const { stageLab, createNegativeLedger } = await journeyModule();
    const { ctx, s, stub } = labWorld();
    ctx.negatives = createNegativeLedger();
    const result = await stageLab(ctx, s);
    expect(result.status).toBe("PASS");
    expect(stub.planZeroMarks).toHaveBeenCalledTimes(1);
  });

  it("4. LAB: a foreign submission into this learner's enrolment => FULL_JOURNEY:LAB FAIL before any learner or foreign-own lab write", async () => {
    const { stageLab, createNegativeLedger } = await journeyModule();
    const { ctx, s, stub, calls, jars } = labWorld({
      foreignOnLearnerSucceeds: true,
    });
    ctx.negatives = createNegativeLedger();
    const result = await stageLab(ctx, s);
    expect(result.status).toBe("FAIL");
    const recorded = (ctx.negatives as Ledger).get(
      "FOREIGN_LAB_SUBMISSION_DENIED",
    )?.problems;
    expect(recorded).toHaveLength(1);
    expect(result.details).toContain(recorded![0]);
    // Exactly the one foreign probe was sent; nothing after it.
    expect(calls).toHaveLength(1);
    expect(calls[0].jar).toBe(jars.foreign);
    expect(calls[0].payload.enrolmentId).toBe("E");
    expect(calls.some((c) => c.jar === jars.learner)).toBe(false);
    expect(stub.planZeroMarks).not.toHaveBeenCalled();
  });

  it("5. LAB: a lab replay invariant failure => FULL_JOURNEY:LAB FAIL and planZeroMarks is never armed; the foreign learner's own lab is never submitted", async () => {
    const { stageLab, createNegativeLedger } = await journeyModule();
    const { ctx, s, stub, calls, jars } = labWorld({ replayDiffers: true });
    ctx.negatives = createNegativeLedger();
    const result = await stageLab(ctx, s);
    expect(result.status).toBe("FAIL");
    const recorded = (ctx.negatives as Ledger).get(
      "LAB_SUBMISSION_REPLAY_IDEMPOTENT",
    )?.problems;
    expect(recorded).toHaveLength(1);
    expect(result.details).toContain(recorded![0]);
    expect(stub.planZeroMarks).not.toHaveBeenCalled();
    expect(
      calls.some(
        (c) => c.jar === jars.foreign && c.payload.enrolmentId === "FE",
      ),
    ).toBe(false);
  });

  it("6. any such stage FAIL blocks every downstream positive stage in the staged chain", async () => {
    for (const stage of ["DELIVERY", "CLASSROOM", "TUTOR_LAB", "LAB"]) {
      const { executed, status } = await runStagedWith({ [stage]: "FAIL" });
      const later = POSITIVE_ORDER.slice(
        POSITIVE_ORDER.indexOf(stage) + 1,
      ).filter((key) => key !== "RECOVERY");
      for (const key of later) {
        expect(executed).not.toContain(key);
        expect(status[key]).toBe("BLOCKED");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Hosted run 1790630225143-vf2w0i regressions: the Tutor handoff carries the
// fixture's REAL objective, and the foreign-Tutor negative check measures
// only the foreign probe.
// ---------------------------------------------------------------------------
describe("customer journey: Tutor handoff objective and foreign-probe isolation (hosted run 1790630225143-vf2w0i)", () => {
  it("requests the Tutor handoff as OBJECTIVE_REINFORCEMENT with the fixture's real objective id and asserts it on the durable handoff", async () => {
    const { stageTutorLab, createNegativeLedger } = await journeyModule();
    const { ctx, s, handoffRequests, OBJ } = tutorLabWorld();
    ctx.negatives = createNegativeLedger();
    const result = await stageTutorLab(ctx, s);
    expect(result.status).toBe("PASS");
    expect(handoffRequests).toEqual([
      {
        operation: "REQUEST_TUTOR_HANDOFF",
        enrolmentId: "E",
        lessonId: "LS",
        objectiveId: OBJ,
      },
    ]);
  });

  it("FAILs the Tutor path when the durable Tutor handoff does not carry the exact fixture objective", async () => {
    const { stageTutorLab, createNegativeLedger } = await journeyModule();
    const { ctx, s } = tutorLabWorld();
    ctx.negatives = createNegativeLedger();
    const result = await stageTutorLab(ctx, {
      ...s,
      objectiveId: "10000000-0000-4000-8000-0000000000f9",
    });
    expect(result.status).toBe("FAIL");
    expect(result.details?.join(" ")).toContain(
      "OBJECTIVE_REINFORCEMENT handoff for the fixture lesson and objective",
    );
  });

  it("the actual hosted failure shape: the OWNER Tutor path fails (UNAVAILABLE, 0 executions, 0 provider calls) and the foreign probe is refused without side effects => TUTOR_LAB FAIL for the owner path, FOREIGN_TUTOR_LAB_DENIED PASS, no foreign-breach claim", async () => {
    const { stageTutorLab, createNegativeLedger } = await journeyModule();
    const { ctx, s } = tutorLabWorld({ ownerTutorFails: true });
    ctx.negatives = createNegativeLedger();
    const result = await stageTutorLab(ctx, s);
    expect(result.status).toBe("FAIL");
    const details = result.details?.join(" ") ?? "";
    expect(details).toContain(
      "TUTOR support did not return SUCCEEDED from the governed path (UNAVAILABLE)",
    );
    expect(details).toContain(
      "Expected exactly one SUCCEEDED TUTOR execution for its handoff; found 0",
    );
    const ledger = ctx.negatives as {
      get: (n: string) => { problems: string[] } | null;
    };
    expect(ledger.get("FOREIGN_TUTOR_LAB_DENIED")?.problems).toEqual([]);
    expect(details).not.toMatch(/foreign/i);
  });

  it.each([
    [
      "returns SUCCEEDED on another learner's handoff",
      { foreignReaches: true },
    ],
    [
      "adds a reservation and an execution to another learner's handoff",
      { foreignAddsRows: true },
    ],
  ])(
    "a true foreign fault -- the probe %s -- FAILs FOREIGN_TUTOR_LAB_DENIED and the stage",
    async (_label, options) => {
      const { stageTutorLab, createNegativeLedger } = await journeyModule();
      const { ctx, s } = tutorLabWorld(options);
      ctx.negatives = createNegativeLedger();
      const result = await stageTutorLab(ctx, s);
      expect(result.status).toBe("FAIL");
      const recorded = (
        ctx.negatives as { get: (n: string) => { problems: string[] } | null }
      ).get("FOREIGN_TUTOR_LAB_DENIED")?.problems;
      expect(recorded?.length).toBeGreaterThan(0);
      for (const problem of recorded ?? [])
        expect(result.details).toContain(problem);
    },
  );

  it("foreignTutorProbeProblems judges only the probe and names the observed evidence", async () => {
    const { foreignTutorProbeProblems } = await journeyModule();
    const owner = { student_id: "L", idempotency_key: "k1" };
    const ownerExec = { id: "X1", student_id: "L" };
    // Owner path produced nothing (hosted failure shape): not a foreign breach.
    expect(
      foreignTutorProbeProblems({
        status: "UNAVAILABLE",
        before: { reservations: [owner], executions: [] },
        after: { reservations: [owner], executions: [] },
        ownerId: "L",
      }),
    ).toEqual([]);
    // Owner path fine; probe refused and inert.
    expect(
      foreignTutorProbeProblems({
        status: "UNAVAILABLE",
        before: { reservations: [owner], executions: [ownerExec] },
        after: { reservations: [owner], executions: [ownerExec] },
        ownerId: "L",
      }),
    ).toEqual([]);
    expect(
      foreignTutorProbeProblems({
        status: "DUPLICATE",
        before: { reservations: [], executions: [] },
        after: { reservations: [], executions: [] },
        ownerId: "L",
      }),
    ).toEqual([
      "The foreign learner's Tutor support probe on another learner's handoff returned DUPLICATE.",
    ]);
    expect(
      foreignTutorProbeProblems({
        status: "UNAVAILABLE",
        before: { reservations: [owner], executions: [ownerExec] },
        after: {
          reservations: [owner, { student_id: "F", idempotency_key: "k2" }],
          executions: [ownerExec, { id: "X2", student_id: "F" }],
        },
        ownerId: "L",
      }),
    ).toEqual([
      "The foreign probe added 1 interaction reservation(s) to another learner's Tutor handoff.",
      "The foreign probe added 1 provider execution(s) to another learner's Tutor handoff.",
      "2 reservation/execution row(s) on the learner's Tutor handoff are owned by another learner.",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Hosted run 1790635594309-jz55ep: a failed GET_ACTIVE_QUESTIONS (HTTP 500
// OPERATION_FAILED from the route) was mislabelled as a protected-question
// release, and every post-start mismatch collapsed into one sentence.
// ---------------------------------------------------------------------------
describe("customer journey: GET_ACTIVE_QUESTIONS evidence is classified truthfully", () => {
  const ATTEMPT = "10000000-0000-4000-8000-0000000000a1";
  const ASSESSMENT = "10000000-0000-4000-8000-0000000000a2";
  const QUESTION = "10000000-0000-4000-8000-0000000000a3";
  const ok = (result: Record<string, unknown>) => ({
    status: 200,
    body: { ok: true, result },
    text: "",
  });
  const routeFailed = {
    status: 500,
    body: { error: "OPERATION_FAILED" },
    text: "",
  };
  const idle = ok({
    activityState: "NORMAL",
    activeAttemptId: null,
    activeAssessmentId: null,
    questions: [],
  });
  const live = (overrides: Record<string, unknown> = {}) =>
    ok({
      activityState: "CONTROLLED_ASSESSMENT_ACTIVE",
      activeAttemptId: ATTEMPT,
      activeAssessmentId: ASSESSMENT,
      questions: [{ id: QUESTION, maxMarks: 10 }],
      ...overrides,
    });
  const expected = {
    attemptId: ATTEMPT,
    assessmentId: ASSESSMENT,
    questionCount: 1,
  };

  it("1. a route/HTTP failure before start is reported as a failed operation, NEVER as a question release", async () => {
    const { preStartQuestionReleaseProblems } = await journeyModule();
    const problems = preStartQuestionReleaseProblems(routeFailed);
    expect(problems).toEqual([
      "GET_ACTIVE_QUESTIONS failed before attempt start (HTTP 500, OPERATION_FAILED).",
    ]);
    expect(problems.join(" ")).not.toMatch(/released/i);
    // No response at all (transport failure) is equally not a release.
    expect(preStartQuestionReleaseProblems(null)).toEqual([
      "GET_ACTIVE_QUESTIONS failed before attempt start (HTTP none, no error code).",
    ]);
  });

  it("2. a successful pre-start response that actually carries question identifiers IS protected-content-release evidence", async () => {
    const { preStartQuestionReleaseProblems } = await journeyModule();
    expect(
      preStartQuestionReleaseProblems(
        ok({
          activityState: "NORMAL",
          activeAttemptId: null,
          activeAssessmentId: null,
          questions: [{ id: QUESTION, maxMarks: 10 }],
        }),
      ),
    ).toEqual([
      "Questions were released before the learner started an attempt (1 question identifier(s)).",
    ]);
    expect(
      preStartQuestionReleaseProblems(
        ok({
          activityState: "CONTROLLED_ASSESSMENT_ACTIVE",
          activeAttemptId: ATTEMPT,
          activeAssessmentId: ASSESSMENT,
          questions: [],
        }),
      ),
    ).toEqual([
      "GET_ACTIVE_QUESTIONS reported an active attempt before the learner started one.",
    ]);
    // The expected idle state is clean.
    expect(preStartQuestionReleaseProblems(idle)).toEqual([]);
  });

  it("3. a post-start HTTP failure gets its own accurate diagnostic (and nothing else)", async () => {
    const { postStartQuestionReleaseProblems } = await journeyModule();
    expect(
      postStartQuestionReleaseProblems(routeFailed, expected, "QUIZ_1"),
    ).toEqual([
      "QUIZ_1: GET_ACTIVE_QUESTIONS failed after attempt start (HTTP 500, OPERATION_FAILED).",
    ]);
  });

  it("4. an activeAttemptId mismatch gets its own diagnostic", async () => {
    const { postStartQuestionReleaseProblems } = await journeyModule();
    const other = "10000000-0000-4000-8000-0000000000a9";
    expect(
      postStartQuestionReleaseProblems(
        live({ activeAttemptId: other }),
        expected,
        "QUIZ_1",
      ),
    ).toEqual([
      `QUIZ_1: the reported active attempt (${other}) is not the attempt just started (${ATTEMPT}).`,
    ]);
  });

  it("5. an activeAssessmentId mismatch gets its own diagnostic", async () => {
    const { postStartQuestionReleaseProblems } = await journeyModule();
    expect(
      postStartQuestionReleaseProblems(
        live({ activeAssessmentId: null }),
        expected,
        "QUIZ_1",
      ),
    ).toEqual([
      `QUIZ_1: the reported active assessment (none) is not the component's assessment (${ASSESSMENT}).`,
    ]);
  });

  it("6. an activityState mismatch gets its own diagnostic", async () => {
    const { postStartQuestionReleaseProblems } = await journeyModule();
    expect(
      postStartQuestionReleaseProblems(
        live({ activityState: "NORMAL" }),
        expected,
        "QUIZ_1",
      ),
    ).toEqual([
      "QUIZ_1: the activity state was NORMAL, expected CONTROLLED_ASSESSMENT_ACTIVE.",
    ]);
  });

  it("7. a released question-count mismatch gets its own diagnostic", async () => {
    const { postStartQuestionReleaseProblems } = await journeyModule();
    expect(
      postStartQuestionReleaseProblems(
        live({ questions: [] }),
        expected,
        "QUIZ_1",
      ),
    ).toEqual(["QUIZ_1: 0 question identifier(s) were released; expected 1."]);
  });

  it("8. a coherent post-start response PASSes; several mismatches are each reported separately", async () => {
    const { postStartQuestionReleaseProblems } = await journeyModule();
    expect(
      postStartQuestionReleaseProblems(live(), expected, "QUIZ_1"),
    ).toEqual([]);
    expect(
      postStartQuestionReleaseProblems(
        live({ activityState: "NORMAL", questions: [] }),
        expected,
        "QUIZ_1",
      ),
    ).toHaveLength(2);
  });

  it("reports only a bounded status and top-level route code, never message or exception text", async () => {
    const { routeFailure, preStartQuestionReleaseProblems } =
      await journeyModule();
    expect(routeFailure(idle)).toBeNull();
    const noisy = {
      status: 500,
      body: {
        error: "internal: relation programme_versions secret-sentinel",
        message: "stack trace secret-sentinel",
      },
      text: "secret-sentinel",
    };
    expect(routeFailure(noisy)).toBe("HTTP 500, no error code");
    expect(
      JSON.stringify(preStartQuestionReleaseProblems(noisy)),
    ).not.toContain("secret-sentinel");
    expect(
      routeFailure({
        status: 200,
        body: { ok: false, error: "DELIVERY_DENIED" },
        text: "",
      }),
    ).toBe("HTTP 200, DELIVERY_DENIED");
  });
});

describe("customer journey: the hosted ASSESSMENTS failure shape (run 1790635594309-jz55ep)", () => {
  it("GET_ACTIVE_QUESTIONS HTTP 500 before and after start => ASSESSMENTS FAIL with two accurate route-failure diagnostics and no question-release claim", async () => {
    const { stageAssessments, createNegativeLedger, JOURNEY_SURFACES } =
      await journeyModule();
    const ATTEMPT = "10000000-0000-4000-8000-0000000000b1";
    const FOREIGN_ATTEMPT = "10000000-0000-4000-8000-0000000000b2";
    const assessmentIdsByComponent = Object.fromEntries(
      ["QUIZ_1", "QUIZ_2", "MIDTERM", "QUIZ_3", "QUIZ_4", "FINAL"].map(
        (c, i) => [c, `10000000-0000-4000-8000-00000000c0${i}0`],
      ),
    );
    const windows = Object.fromEntries(
      Object.keys(assessmentIdsByComponent).map((c) => [
        c,
        { opensAt: 0, latestStartAt: 10 * 60_000 },
      ]),
    );
    const calls: Record<string, unknown>[] = [];
    const client = {
      call: async (jar: { id: string }, payload: Record<string, unknown>) => {
        calls.push({ who: jar.id, ...payload });
        if (payload.operation === "GET_ACTIVE_QUESTIONS")
          return {
            status: 500,
            body: { error: "OPERATION_FAILED" },
            text: '{"error":"OPERATION_FAILED"}',
          };
        if (payload.operation === "START_ASSESSMENT")
          return {
            status: 200,
            body: {
              ok: true,
              result: {
                attemptId: jar.id === "learner" ? ATTEMPT : FOREIGN_ATTEMPT,
              },
            },
            text: "",
          };
        return { status: 500, body: { error: "OPERATION_FAILED" }, text: "" };
      },
    };
    const ctx = {
      runId: "1790000000000-abcdef",
      jars: { learner: { id: "learner" }, foreign: { id: "foreign" } },
      journey: client,
      app: client,
      stub: {
        calls: [],
        clearPlans: vi.fn(),
        planZeroMarks: vi.fn(),
        planFailure: vi.fn(),
      },
      negatives: createNegativeLedger(),
      query: async (sql: string) =>
        sql.includes("from assessment_questions") ? [{ n: 1 }] : [],
      log: () => {},
      sleep: async () => {},
      dbNowMs: async () => 60_000,
    };
    const s = {
      enrolmentId: "E",
      learnerId: "L",
      windows,
      course: { assessmentIdsByComponent },
    } as Record<string, unknown>;
    const result = await stageAssessments(ctx, s);
    expect(result.surface).toBe(JOURNEY_SURFACES.ASSESSMENTS);
    expect(result.status).toBe("FAIL");
    const details = (result.details ?? []).join("\n");
    expect(details).toContain(
      "GET_ACTIVE_QUESTIONS failed before attempt start (HTTP 500, OPERATION_FAILED).",
    );
    expect(details).toContain(
      "QUIZ_1: GET_ACTIVE_QUESTIONS failed after attempt start (HTTP 500, OPERATION_FAILED).",
    );
    expect(details).not.toMatch(
      /released before|question release does not match/i,
    );
    // The stage stopped at the first component: no response was recorded
    // and nothing was submitted or graded.
    expect(
      calls.some((c) =>
        ["RECORD_RESPONSE", "SUBMIT_AND_GRADE_ASSESSMENT"].includes(
          c.operation as string,
        ),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Independent review v2: a successful-looking but structurally incomplete
// pre-start projection is its own bounded evidence failure -- never a clean
// idle state, and never "questions released".
// ---------------------------------------------------------------------------
describe("customer journey: pre-start GET_ACTIVE_QUESTIONS projection must be complete", () => {
  const QUESTION = "10000000-0000-4000-8000-0000000000d4";
  const INCOMPLETE =
    "GET_ACTIVE_QUESTIONS returned an incomplete projection before attempt start.";
  const ok = (result: Record<string, unknown>) => ({
    status: 200,
    body: { ok: true, result },
    text: "",
  });
  const cleanResult = {
    activityState: "NORMAL",
    activeAttemptId: null,
    activeAssessmentId: null,
    questions: [],
  };
  const without = (key: string) =>
    Object.fromEntries(
      Object.entries(cleanResult).filter(([name]) => name !== key),
    );

  it("HTTP 200 / ok=true / result missing `questions` => incomplete projection, NEVER 'Questions were released'", async () => {
    const { preStartQuestionReleaseProblems } = await journeyModule();
    const problems = preStartQuestionReleaseProblems(ok(without("questions")));
    expect(problems).toEqual([INCOMPLETE]);
    expect(problems.join(" ")).not.toMatch(/released/i);
  });

  it("HTTP 200 / ok=true / activeAttemptId missing => incomplete projection", async () => {
    const { preStartQuestionReleaseProblems } = await journeyModule();
    const problems = preStartQuestionReleaseProblems(
      ok(without("activeAttemptId")),
    );
    expect(problems).toEqual([INCOMPLETE]);
    expect(problems.join(" ")).not.toMatch(/released|active attempt/i);
  });

  it("a coherent clean pre-start response PASSes", async () => {
    const { preStartQuestionReleaseProblems } = await journeyModule();
    expect(preStartQuestionReleaseProblems(ok({ ...cleanResult }))).toEqual([]);
  });

  it.each([
    ["activeAssessmentId missing", without("activeAssessmentId")],
    ["activityState missing", without("activityState")],
    [
      "activityState not a known state",
      { ...cleanResult, activityState: "SOMETHING" },
    ],
    ["questions not an array", { ...cleanResult, questions: "none" }],
    [
      "activeAttemptId of the wrong type",
      { ...cleanResult, activeAttemptId: 7 },
    ],
    ["an empty result object", {}],
    // Review v3: an empty id is neither "no attempt" nor a real identifier.
    [
      'activeAttemptId: "" (empty string)',
      { ...cleanResult, activeAttemptId: "" },
    ],
    [
      'activeAssessmentId: "" (empty string)',
      { ...cleanResult, activeAssessmentId: "" },
    ],
  ])("%s => incomplete projection, not a release", async (_label, result) => {
    const { preStartQuestionReleaseProblems } = await journeyModule();
    const problems = preStartQuestionReleaseProblems(ok(result));
    expect(problems).toEqual([INCOMPLETE]);
    expect(problems.join(" ")).not.toMatch(/released/i);
  });

  it("question entries without identifiers are an incomplete projection, not released question identifiers", async () => {
    const { preStartQuestionReleaseProblems } = await journeyModule();
    const problems = preStartQuestionReleaseProblems(
      ok({ ...cleanResult, questions: [{ maxMarks: 10 }] }),
    );
    expect(problems).toEqual([INCOMPLETE]);
  });

  it("genuine release evidence is still reported even alongside an incomplete projection", async () => {
    const { preStartQuestionReleaseProblems } = await journeyModule();
    expect(
      preStartQuestionReleaseProblems(
        ok({
          activeAttemptId: null,
          questions: [{ id: QUESTION, maxMarks: 10 }],
        }),
      ),
    ).toEqual([
      "Questions were released before the learner started an attempt (1 question identifier(s)).",
      INCOMPLETE,
    ]);
  });

  it("with no attempt reported, a non-idle assessment id or activity state gets its own bounded diagnostic", async () => {
    const { preStartQuestionReleaseProblems } = await journeyModule();
    expect(
      preStartQuestionReleaseProblems(
        ok({
          ...cleanResult,
          activityState: "CONTROLLED_ASSESSMENT_ACTIVE",
          activeAssessmentId: "10000000-0000-4000-8000-0000000000d5",
        }),
      ),
    ).toEqual([
      "GET_ACTIVE_QUESTIONS reported an active assessment before the learner started an attempt.",
      "GET_ACTIVE_QUESTIONS reported activity state CONTROLLED_ASSESSMENT_ACTIVE before the learner started an attempt.",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Bounded assessment read-stage diagnostic (hosted journey run #3): the
// route may add a fixed assessmentReadStage to OPERATION_FAILED; the
// harness reports it only when it is exactly one of the six known codes.
// ---------------------------------------------------------------------------
describe("customer journey: bounded assessmentReadStage in route-failure diagnostics", () => {
  const STAGES = [
    "FINALIZE",
    "READ_ASSESSMENTS",
    "READ_ATTEMPTS",
    "READ_RESPONSES",
    "ACTIVITY",
    "READ_VERSIONS",
  ];
  const failed = (body: Record<string, unknown>) => ({
    status: 500,
    body,
    text: JSON.stringify(body),
  });

  it("the harness whitelist is exactly the production stage list", async () => {
    const { ASSESSMENT_READ_STAGES } = await journeyModule();
    expect([...ASSESSMENT_READ_STAGES]).toEqual(STAGES);
    // Pinned against src/server/assessments.ts's own list (scripts never
    // import src/**, so the source text is compared).
    const source = await readRepo("src/server/assessments.ts");
    const declared = /STUDENT_ASSESSMENT_READ_STAGES = \[([^\]]*)\]/.exec(
      source,
    )?.[1];
    expect(
      [...(declared ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]),
    ).toEqual(STAGES);
  });

  it("a known FINALIZE stage appears in the bounded pre-start failure diagnostic", async () => {
    const { preStartQuestionReleaseProblems } = await journeyModule();
    expect(
      preStartQuestionReleaseProblems(
        failed({ error: "OPERATION_FAILED", assessmentReadStage: "FINALIZE" }),
      ),
    ).toEqual([
      "GET_ACTIVE_QUESTIONS failed before attempt start (HTTP 500, OPERATION_FAILED, assessment stage FINALIZE).",
    ]);
  });

  it.each(STAGES)(
    "stage %s is represented safely in route failures",
    async (stage) => {
      const { routeFailure, postStartQuestionReleaseProblems } =
        await journeyModule();
      const response = failed({
        error: "OPERATION_FAILED",
        assessmentReadStage: stage,
      });
      expect(routeFailure(response)).toBe(
        `HTTP 500, OPERATION_FAILED, assessment stage ${stage}`,
      );
      expect(
        postStartQuestionReleaseProblems(
          response,
          { attemptId: "a", assessmentId: "b", questionCount: 1 },
          "QUIZ_1",
        ),
      ).toEqual([
        `QUIZ_1: GET_ACTIVE_QUESTIONS failed after attempt start (HTTP 500, OPERATION_FAILED, assessment stage ${stage}).`,
      ]);
    },
  );

  it.each([
    ["an unknown code", "SOMETHING_UNEXPECTED"],
    ["a lower-case look-alike", "finalize"],
    ["injected text", "FINALIZE; drop table secret"],
    ["a number", 7],
    ["an object", { stage: "FINALIZE" }],
    ["an array", ["FINALIZE"]],
  ])(
    "an unknown or malformed assessmentReadStage (%s) is ignored",
    async (_label, value) => {
      const { routeFailure } = await journeyModule();
      const out = routeFailure(
        failed({ error: "OPERATION_FAILED", assessmentReadStage: value }),
      );
      expect(out).toBe("HTTP 500, OPERATION_FAILED");
      expect(out).not.toMatch(/assessment stage|drop|SOMETHING|finalize/);
    },
  );

  it("absence of assessmentReadStage preserves the existing diagnostic exactly", async () => {
    const { routeFailure, preStartQuestionReleaseProblems } =
      await journeyModule();
    const response = failed({ error: "OPERATION_FAILED" });
    expect(routeFailure(response)).toBe("HTTP 500, OPERATION_FAILED");
    expect(preStartQuestionReleaseProblems(response)).toEqual([
      "GET_ACTIVE_QUESTIONS failed before attempt start (HTTP 500, OPERATION_FAILED).",
    ]);
  });

  it("never prints the raw response body or upstream exception text", async () => {
    const { routeFailure, preStartQuestionReleaseProblems } =
      await journeyModule();
    const response = {
      status: 500,
      body: {
        error: "OPERATION_FAILED",
        assessmentReadStage: "READ_VERSIONS",
        message: "raw upstream secret-sentinel relation",
        details: "secret-sentinel details",
        stack: "Error: secret-sentinel\n    at x (y.ts:1:1)",
      },
      text: "raw secret-sentinel body",
    };
    const out = [
      routeFailure(response),
      ...preStartQuestionReleaseProblems(response),
    ].join("\n");
    expect(out).toContain("assessment stage READ_VERSIONS");
    expect(out).not.toMatch(/secret-sentinel|relation|details|stack|at x/);
  });
});
