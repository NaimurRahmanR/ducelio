import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  capabilityDbClient,
  type CapabilityDbState,
} from "./capability-db-client";
import {
  executionFixture,
  asExecutionUser,
  learner,
  enrolledLesson,
  type ExecutionFixture,
} from "./execution-fixture";
import {
  counsellorRequestAllowed,
  handoffInput,
  optionalProspectProfileSchema,
} from "@/domain/delivery";
const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));
import {
  saveDeliveryStudyPlan,
  confirmDeliveryStudyPlan,
  getDeliveryContext,
  getDeliveryAgentAccess,
  getCounsellorLifecycle,
  requestDeliveryHandoff,
  listDeliveryHandoffs,
  getProfessorDeliveryContext,
  getDeliveryAdminContext,
  startScheduledLearning,
} from "@/server/delivery";
let f: ExecutionFixture;
const state: CapabilityDbState = { authUser: null, calls: [] };
const rpcArgs: Record<string, string[]> = {
  start_scheduled_learning: ["p_occurrence_id"],
  save_delivery_study_plan: [
    "p_enrolment_id",
    "p_study_days",
    "p_local_start_time",
    "p_timezone",
  ],
  confirm_delivery_study_plan: ["p_enrolment_id"],
  get_delivery_context: ["p_enrolment_id", "p_cursor"],
  get_delivery_admin_context: ["p_enrolment_id", "p_cursor"],
  get_delivery_agent_access: ["p_enrolment_id"],
  get_counsellor_lifecycle: [],
  request_delivery_handoff: [
    "p_enrolment_id",
    "p_lesson_id",
    "p_objective_id",
    "p_reason_code",
    "p_request_id",
  ],
  list_delivery_handoffs: ["p_enrolment_id", "p_cursor"],
};
beforeAll(async () => {
  f = await executionFixture();
});
beforeEach(async () => {
  await f.db.exec("begin");
  await asExecutionUser(f.db, 1, state);
  Object.assign(state, {
    calls: [],
    failRpc: undefined,
    beforeRpc: undefined,
    transformRpc: undefined,
    beforeRead: undefined,
  });
  mocks.client.mockImplementation(async () => {
    const base = capabilityDbClient(f.db, state);
    return {
      ...base,
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        const keys = rpcArgs[name];
        if (!keys) return base.rpc(name, args);
        state.calls.push({ rpc: name, args });
        await f.db.exec("savepoint delivery_call");
        try {
          await state.beforeRpc?.(name, args);
          if (state.failRpc === name)
            throw new Error("Private database error sentinel");
          const { rows } = await f.db.query<{ value: unknown }>(
            `select public.${name}(${keys.map((_, i) => `$${i + 1}`).join(",")}) as value`,
            keys.map((k) => args[k]),
          );
          await f.db.exec("release savepoint delivery_call");
          return {
            data: state.transformRpc
              ? state.transformRpc(name, rows[0].value)
              : rows[0].value,
            error: null,
          };
        } catch (error) {
          await f.db.exec(
            "rollback to savepoint delivery_call; release savepoint delivery_call",
          );
          return {
            data: null,
            error: {
              message:
                error instanceof Error
                  ? error.message
                  : "Private database error sentinel",
            },
          };
        }
      },
    };
  });
});
afterEach(async () => {
  await f.db.exec("rollback; reset role");
});
afterAll(async () => {
  await f.db?.close();
});
const request = () => ({ enrolmentId: f.enrolmentId });
describe("real server delivery boundary", () => {
  it("returns NOT_OPEN for a future occurrence without granting a start", async () => {
    await saveDeliveryStudyPlan(request());
    await confirmDeliveryStudyPlan(request());
    const occurrence = (await getDeliveryContext(request())).occurrences[0];
    expect(
      await startScheduledLearning({ occurrenceId: occurrence.id }),
    ).toEqual({
      occurrenceId: occurrence.id,
      decision: "NOT_OPEN",
      startedAt: null,
    });
  });
  it("rejects caller-selected start time and actor", async () => {
    await expect(
      startScheduledLearning({
        occurrenceId: enrolledLesson,
        startedAt: "2026-01-01T00:00:00Z",
        actorId: learner,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("saves/confirms/reads own schedule via authenticated database authority", async () => {
    await saveDeliveryStudyPlan(request());
    await confirmDeliveryStudyPlan(request());
    expect(await getDeliveryContext(request())).toMatchObject({
      plan: { state: "CONFIRMED", cadence: 3 },
      occurrences: [{ lessonId: enrolledLesson, state: "UPCOMING" }],
    });
  });
  it("normalizes unauthenticated callers", async () => {
    await asExecutionUser(f.db, null, state);
    await expect(getDeliveryContext(request())).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
  it("normalizes non-STUDENT and foreign learner denials exactly", async () => {
    await asExecutionUser(f.db, 2, state);
    await expect(getDeliveryContext(request())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await asExecutionUser(f.db, 3, state);
    await expect(getDeliveryContext(request())).rejects.toMatchObject({
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
  });
  it.each([
    "actorId",
    "studentId",
    "sourceProfile",
    "destinationProfile",
    "summary",
    "assessmentPrompt",
    "role",
    "scheduledAt",
  ])("rejects caller-controlled %s", async (field) => {
    expect(() =>
      requestDeliveryHandoff({
        ...request(),
        lessonId: enrolledLesson,
        reasonCode: "PRACTICAL_HELP",
        [field]: "untrusted",
      }),
    ).toThrow("INVALID_INPUT");
  });
  it("rejects unsupported teaching and sensitive optional profile fields", () => {
    expect(
      optionalProspectProfileSchema.safeParse({ choice: "SKIP" }).success,
    ).toBe(true);
    expect(
      optionalProspectProfileSchema.safeParse({
        choice: "SHARE",
        medicalHistory: "private",
      }).success,
    ).toBe(false);
    expect(
      optionalProspectProfileSchema.safeParse({ choice: "SHARE" }).success,
    ).toBe(true);
  });
  it.each(["PROSPECT", "ACTIVE_COURSE", "POST_COURSE"] as const)(
    "constrains %s Counsellor categories",
    (mode) => {
      for (const forbidden of [
        "TEACHING",
        "ASSIGNMENT_SOLVING",
        "LAB_DEBUGGING",
        "ASSESSMENT_HELP",
        "GENERAL_CHAT",
      ])
        expect(counsellorRequestAllowed(mode, forbidden, "ACTIVE")).toBe(false);
    },
  );
  it.each(["COOLDOWN", "HIBERNATED"] as const)(
    "%s only affects Counsellor conversation, not account/materials/academic services",
    async (mode) => {
      expect(
        counsellorRequestAllowed("ACTIVE_COURSE", "STUDY_PLANNING", mode),
      ).toBe(false);
      expect(await getDeliveryAgentAccess(request())).toHaveProperty(
        "PROFESSOR",
        "AVAILABLE",
      );
      expect(await getCounsellorLifecycle()).toHaveProperty("available", true);
      expect(await getDeliveryContext(request())).toHaveProperty(
        "enrolmentId",
        f.enrolmentId,
      );
    },
  );
  it("minimizes handoff output and reports explicit learner-request provenance", async () => {
    await requestDeliveryHandoff({
      ...request(),
      lessonId: enrolledLesson,
      reasonCode: "PRACTICAL_HELP",
    });
    const rows = await listDeliveryHandoffs(request());
    expect(rows[0]).toMatchObject({
      initiator_kind: "LEARNER",
      status: "OPEN",
      destination_profile: "LAB_INSTRUCTOR",
      provenance: "LEARNER_REQUEST",
    });
    expect(rows[0]).not.toHaveProperty("requested_by");
    expect(rows[0]).not.toHaveProperty("request_id");
  });
  it("rejects substituted sensitive prose even inside a bounded summary", async () => {
    await requestDeliveryHandoff({
      ...request(),
      lessonId: enrolledLesson,
      reasonCode: "PRACTICAL_HELP",
    });
    state.transformRpc = (name, data) =>
      name === "list_delivery_handoffs"
        ? (data as object[]).map((row) => ({
            ...row,
            summary: "Protected assessment answer",
          }))
        : data;
    await expect(listDeliveryHandoffs(request())).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
  it("normalizes database failure without raw error leakage", async () => {
    state.failRpc = "get_delivery_context";
    await expect(getDeliveryContext(request())).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "SERVICE_UNAVAILABLE",
    });
  });
  it("fails closed on malformed or sensitive backend output", async () => {
    state.transformRpc = (name, data) =>
      name === "get_delivery_context"
        ? { ...(data as object), supportProse: "private" }
        : data;
    await expect(getDeliveryContext(request())).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
  it("rejects oversized occurrence output", async () => {
    await saveDeliveryStudyPlan(request());
    await confirmDeliveryStudyPlan(request());
    state.transformRpc = (name, data) => {
      if (name !== "get_delivery_context") return data;
      const row = data as { occurrences: unknown[] };
      return { ...row, occurrences: Array(26).fill(row.occurrences[0]) };
    };
    await expect(getDeliveryContext(request())).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
  it("detects a role change after the database returned its projection", async () => {
    let reads = 0;
    state.beforeRead = async (table) => {
      if (table === "role_grants" && ++reads === 2) {
        await f.db.exec("reset role");
        await f.db.query(
          "delete from public.role_grants where user_id=$1 and role='STUDENT'",
          [learner],
        );
        await f.db.exec("set role authenticated");
      }
    };
    await expect(getDeliveryContext(request())).rejects.toMatchObject({
      code: "CONTEXT_CONFLICT",
    });
  });
  it("closes the Professor delivery port after course completion, retaining ordinary materials", async () => {
    await f.db.exec("reset role");
    await f.db.query(
      "update public.enrolments set status='COMPLETED' where id=$1",
      [f.enrolmentId],
    );
    await f.db.exec("set role authenticated");
    await expect(getProfessorDeliveryContext(request())).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
    });
    expect(state.calls.some((c) => c.rpc === "get_delivery_context")).toBe(
      false,
    );
    expect(await getDeliveryContext(request())).toHaveProperty(
      "academicEligibility",
      "CLOSED",
    );
  });
  it("aborts the Professor release on a mismatched enrolled version", async () => {
    await saveDeliveryStudyPlan(request());
    await confirmDeliveryStudyPlan(request());
    state.transformRpc = (name, data) => {
      if (name !== "get_delivery_context") return data;
      const row = data as { plan: object };
      return {
        ...row,
        plan: {
          ...row.plan,
          programmeVersionId: "20000000-0000-4000-8000-000000000099",
        },
      };
    };
    await expect(getProfessorDeliveryContext(request())).rejects.toMatchObject({
      code: "CONTEXT_CONFLICT",
    });
    await f.db.exec("reset role");
    expect(
      (await f.db.query("select state from public.academic_content_releases"))
        .rows,
    ).toEqual([{ state: "ABORTED" }]);
  });
  it("rejects returned context mismatch", async () => {
    state.transformRpc = (name, data) =>
      name === "get_delivery_context"
        ? {
            ...(data as object),
            enrolmentId: "10000000-0000-4000-8000-000000000003",
          }
        : data;
    await expect(getDeliveryContext(request())).rejects.toMatchObject({
      code: "CONTEXT_CONFLICT",
    });
  });
  it("revalidates roles before release", async () => {
    state.beforeRpc = async (name) => {
      if (name === "get_delivery_context") {
        await f.db.exec("reset role");
        await f.db.query(
          "delete from public.role_grants where user_id=$1 and role='STUDENT'",
          [learner],
        );
        await f.db.exec("set role authenticated");
      }
    };
    await expect(getDeliveryContext(request())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("uses the explicit staff projection, never widening a self request", async () => {
    await asExecutionUser(f.db, 2, state);
    expect(await getDeliveryAdminContext(request())).toHaveProperty(
      "enrolmentId",
      f.enrolmentId,
    );
    await expect(getDeliveryContext(request())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("keeps Professor delivery context inside the existing release and closes before return", async () => {
    await saveDeliveryStudyPlan(request());
    await confirmDeliveryStudyPlan(request());
    expect(await getProfessorDeliveryContext(request())).toHaveProperty(
      "currentLessonId",
      enrolledLesson,
    );
    const names = state.calls.filter((c) => c.rpc).map((c) => c.rpc);
    expect(names.indexOf("begin_academic_content_release")).toBeLessThan(
      names.indexOf("get_delivery_context"),
    );
    expect(names.lastIndexOf("close_academic_content_release")).toBeGreaterThan(
      names.indexOf("get_delivery_context"),
    );
    await f.db.exec("reset role");
    expect(
      (await f.db.query("select state from public.academic_content_releases"))
        .rows,
    ).toEqual([{ state: "COMPLETED" }]);
  });
  it("blocks Professor content path during controlled assessment", async () => {
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    await expect(getProfessorDeliveryContext(request())).rejects.toBeDefined();
    expect(state.calls.some((c) => c.rpc === "get_delivery_context")).toBe(
      false,
    );
  });
  it("fails closed if the Professor release cannot close", async () => {
    state.failRpc = "close_academic_content_release";
    await expect(getProfessorDeliveryContext(request())).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});

describe("OBJECTIVE_REINFORCEMENT requires an objective (domain + server boundary)", () => {
  const ENROLMENT = "10000000-0000-4000-8000-0000000000e1";
  const LESSON = "10000000-0000-4000-8000-0000000000e2";
  const OBJECTIVE = "10000000-0000-4000-8000-0000000000e3";

  it.each([
    ["missing", {}],
    ["null", { objectiveId: null }],
  ])(
    "handoffInput rejects OBJECTIVE_REINFORCEMENT with a %s objectiveId",
    (_label, objective) => {
      expect(
        handoffInput.safeParse({
          enrolmentId: ENROLMENT,
          lessonId: LESSON,
          reasonCode: "OBJECTIVE_REINFORCEMENT",
          ...objective,
        }).success,
      ).toBe(false);
    },
  );

  it("handoffInput accepts OBJECTIVE_REINFORCEMENT with a valid objectiveId", () => {
    expect(
      handoffInput.safeParse({
        enrolmentId: ENROLMENT,
        lessonId: LESSON,
        objectiveId: OBJECTIVE,
        reasonCode: "OBJECTIVE_REINFORCEMENT",
      }).success,
    ).toBe(true);
  });

  it.each([
    "MISSED_LESSON_PRACTICE",
    "PRACTICAL_PREREQUISITE",
    "PRACTICAL_HELP",
  ])(
    "handoffInput still accepts %s without an objectiveId (missing or null)",
    (reasonCode) => {
      for (const objective of [{}, { objectiveId: null }])
        expect(
          handoffInput.safeParse({
            enrolmentId: ENROLMENT,
            lessonId: LESSON,
            reasonCode,
            ...objective,
          }).success,
        ).toBe(true);
    },
  );

  it("handoffInput keeps rejecting a malformed objectiveId and unknown fields", () => {
    expect(
      handoffInput.safeParse({
        enrolmentId: ENROLMENT,
        lessonId: LESSON,
        objectiveId: "not-a-uuid",
        reasonCode: "OBJECTIVE_REINFORCEMENT",
      }).success,
    ).toBe(false);
    expect(
      handoffInput.safeParse({
        enrolmentId: ENROLMENT,
        lessonId: LESSON,
        objectiveId: OBJECTIVE,
        reasonCode: "OBJECTIVE_REINFORCEMENT",
        role: "TUTOR",
      }).success,
    ).toBe(false);
  });

  it("requestDeliveryHandoff refuses OBJECTIVE_REINFORCEMENT without an objective as INVALID_INPUT before any RPC", async () => {
    expect(() =>
      requestDeliveryHandoff({
        ...request(),
        lessonId: enrolledLesson,
        reasonCode: "OBJECTIVE_REINFORCEMENT",
      }),
    ).toThrow("INVALID_INPUT");
    expect(
      state.calls.some(
        (c) => (c as { rpc?: string }).rpc === "request_delivery_handoff",
      ),
    ).toBe(false);
  });

  it("requestDeliveryHandoff accepts OBJECTIVE_REINFORCEMENT with an objectiveId and forwards it unchanged to the authoritative RPC", async () => {
    // Published curriculum is immutable, so this fixture lesson has no
    // objective of its own: the RPC's unchanged ownership validation then
    // refuses the unknown objective. What this proves is the boundary: the
    // domain accepted the shape and forwarded the exact objective id.
    // Acceptance with a real owned objective is proven against the migrated
    // schema in tests/delivery-workflow.test.ts (migration 043).
    await expect(
      requestDeliveryHandoff({
        ...request(),
        lessonId: enrolledLesson,
        objectiveId: OBJECTIVE,
        reasonCode: "OBJECTIVE_REINFORCEMENT",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND_OR_FORBIDDEN" });
    const call = state.calls.find(
      (c) => (c as { rpc?: string }).rpc === "request_delivery_handoff",
    ) as { args: Record<string, unknown> } | undefined;
    expect(call?.args).toMatchObject({
      p_enrolment_id: f.enrolmentId,
      p_lesson_id: enrolledLesson,
      p_objective_id: OBJECTIVE,
      p_reason_code: "OBJECTIVE_REINFORCEMENT",
    });
  });
});
