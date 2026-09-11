import { randomUUID } from "node:crypto";
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
  openExecutionRelease,
  signedExecutionCommand,
  sendExecutionCommand,
  learner,
  enrolledLesson,
  type ExecutionFixture,
} from "./execution-fixture";
import {
  executionContentCapabilitySchema,
  NO_PROVIDER_BUDGET,
} from "@/domain/academic-execution";
const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));
import { executeProfessorRead } from "@/server/academic-execution";
let f: ExecutionFixture;
const state: CapabilityDbState = { authUser: null, calls: [] };
const request = () => ({
  capability: "get_lesson_context",
  input: { enrolmentId: f.enrolmentId, lessonId: enrolledLesson },
});
beforeAll(async () => {
  f = await executionFixture();
});
beforeEach(async () => {
  await f.db.exec("begin");
  await asExecutionUser(f.db, 1, state);
  state.calls = [];
  state.failRpc = undefined;
  state.failTable = undefined;
  state.beforeRead = undefined;
  state.beforeRpc = undefined;
  state.transformRpc = undefined;
  state.transformRows = undefined;
  mocks.client.mockImplementation(async () => capabilityDbClient(f.db, state));
  vi.stubEnv("ACADEMIC_EXECUTION_KEY_ID", f.keyId);
  vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", f.key.toString("hex"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await f.db.exec("rollback; reset role");
});
afterAll(async () => {
  await f.db?.close();
});
async function executions() {
  await f.db.exec("reset role");
  const records = (
    await f.db.query<{ id: string; state: string; reason_code: string }>(
      "select * from public.academic_executions where student_id=$1",
      [learner],
    )
  ).rows;
  await f.db.exec("set role authenticated");
  return records;
}
describe("B1 real controller, Node HMAC and PostgreSQL execution governance", () => {
  it.each(executionContentCapabilitySchema.options)(
    "binds %s to 1D-A and intentionally abstains without a provider",
    async (capability) => {
      const withoutLesson = [
        "get_current_learner_context",
        "get_current_class_session",
        "get_permitted_learning_history",
      ].includes(capability);
      const result = await executeProfessorRead({
        capability,
        input: {
          enrolmentId: f.enrolmentId,
          ...(withoutLesson ? {} : { lessonId: enrolledLesson }),
        },
      });
      expect(result).toMatchObject({
        ok: true,
        execution: {
          state: "ABSTAINED",
          reasonCode: "POLICY_BLOCKED",
          executionKind: "CONTROL_PLANE_ONLY",
          budget: NO_PROVIDER_BUDGET,
        },
      });
      expect(result).not.toHaveProperty("data");
      const calls = state.calls
        .filter((call) => call.rpc)
        .map((call) =>
          call.rpc === "govern_professor_execution"
            ? call.args!.p_operation
            : call.rpc,
        );
      const opened = calls.indexOf("begin_academic_content_release"),
        admitted = calls.indexOf("AUTHORIZE"),
        started = calls.indexOf("START"),
        closed = calls.indexOf("FINALIZE"),
        released = calls.indexOf("close_academic_content_release");
      expect(opened).toBeLessThan(admitted);
      expect(admitted).toBeLessThan(started);
      expect(started).toBeLessThan(closed);
      expect(closed).toBeLessThan(released);
      expect(await executions()).toHaveLength(1);
      await f.db.exec("reset role");
      expect(
        (
          await f.db.query<{ state: string }>(
            "select state from public.academic_content_releases where student_id=$1",
            [learner],
          )
        ).rows.map((row) => row.state),
      ).toEqual(["COMPLETED"]);
      expect(
        (
          await f.db.query<{ action: string }>(
            "select action from public.audit_events where target_type='academic_executions' order by occurred_at,id",
          )
        ).rows.map((row) => row.action),
      ).toEqual([
        "EXECUTION_AUTHORIZED",
        "EXECUTION_RUNNING",
        "EXECUTION_ABSTAINED",
      ]);
    },
  );
  it.each([null, 2])(
    "denies unauthenticated/non-STUDENT %s before admission",
    async (n) => {
      await asExecutionUser(f.db, n, state);
      expect(await executeProfessorRead(request())).toMatchObject({
        ok: false,
        error: { code: n ? "FORBIDDEN" : "UNAUTHENTICATED" },
      });
      expect(
        state.calls.some((call) => call.rpc === "govern_professor_execution"),
      ).toBe(false);
    },
  );
  it.each([
    "get_actor_context",
    "get_activity_permissions",
    "constructor",
    "record_learning_evidence",
  ])("rejects non-content capability %s", async (capability) => {
    expect(await executeProfessorRead({ capability, input: {} })).toMatchObject(
      { ok: false, error: { code: "INVALID_INPUT" } },
    );
    expect(await executions()).toHaveLength(0);
  });
  it.each([
    "actorId",
    "studentId",
    "agentProfile",
    "role",
    "releaseId",
    "executionId",
    "budget",
    "maxConcurrent",
    "outcome",
    "prompt",
    "signature",
  ])("rejects caller-supplied %s", async (field) => {
    for (const payload of [
      { ...request(), [field]: "untrusted" },
      { ...request(), input: { ...request().input, [field]: "untrusted" } },
    ])
      expect(await executeProfessorRead(payload)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    expect(await executions()).toHaveLength(0);
  });
  it.each(["", "not-a-key", "0".repeat(64)])(
    "fails closed on missing/malformed/nonmatching attestation configuration (%s)",
    async (key) => {
      vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", key);
      expect(await executeProfessorRead(request())).toMatchObject({
        ok: false,
        error: {
          code:
            key.length === 64 ? "UNTRUSTED_EXECUTION" : "SERVICE_UNAVAILABLE",
        },
      });
      expect(await executions()).toHaveLength(0);
      await f.db.exec("reset role");
      expect(
        (
          await f.db.query<{ state: string }>(
            "select state from public.academic_content_releases where student_id=$1",
            [learner],
          )
        ).rows.map((row) => row.state),
      ).toEqual(["ABORTED"]);
    },
  );
  it("returns no credential/signature or content in execution results and audit", async () => {
    const macs: string[] = [];
    state.beforeRpc = async (name, args) => {
      if (name === "govern_professor_execution") macs.push(String(args?.p_mac));
    };
    const result = await executeProfessorRead(request());
    const records = await executions();
    await f.db.exec("reset role");
    const audit = (
      await f.db.query(
        "select * from public.audit_events where target_type='academic_executions'",
      )
    ).rows;
    const serialized = JSON.stringify({ result, records, audit });
    expect(serialized).not.toContain(f.key.toString("hex"));
    for (const mac of macs) expect(serialized).not.toContain(mac);
    expect(serialized).not.toMatch(
      /evidence_reference|prompt|expected_answer|marking_guidance|response_body|support_prose|signature|p_mac|secret/i,
    );
  });
  it("normalizes admission-accounting failure without creating execution", async () => {
    state.failRpc = "govern_professor_execution";
    expect(await executeProfessorRead(request())).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(await executions()).toHaveLength(0);
  });
  it("preserves RATE_LIMITED admission and makes release-close failure take precedence", async () => {
    const release = await openExecutionRelease(f.db);
    await sendExecutionCommand(
      f.db,
      signedExecutionCommand(f, { releaseId: release.release_id }),
    );
    expect(await executeProfessorRead(request())).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
    state.failRpc = "close_academic_content_release";
    expect(await executeProfessorRead(request())).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });
  it.each(["AUTHORIZE", "START", "FINALIZE"])(
    "malformed %s output fails closed",
    async (operation) => {
      let currentOperation: unknown;
      state.beforeRpc = async (name, args) => {
        if (name === "govern_professor_execution")
          currentOperation = args?.p_operation;
      };
      state.transformRpc = (name, data) =>
        name === "govern_professor_execution" && currentOperation === operation
          ? { ...(data as object), secret: "private-sentinel" }
          : data;
      const result = await executeProfessorRead(request());
      expect(result).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      expect(JSON.stringify(result)).not.toContain("private-sentinel");
    },
  );
  it("discards results if terminal audit persistence fails after RUNNING", async () => {
    let installed = false;
    state.beforeRpc = async (name, args) => {
      if (
        installed ||
        name !== "govern_professor_execution" ||
        args?.p_operation !== "FINALIZE"
      )
        return;
      installed = true;
      await f.db
        .exec(`reset role;create function public.fail_b1_terminal_audit() returns trigger language plpgsql as $$begin if NEW.target_type='academic_executions' then raise exception 'private database sentinel';end if;return NEW;end$$;
        create trigger fail_b1_terminal_audit before insert on public.audit_events for each row execute function public.fail_b1_terminal_audit();set role authenticated`);
    };
    const result = await executeProfessorRead(request());
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });
  it("cannot treat early direct release completion as permission to start trusted execution", async () => {
    state.beforeRpc = async (name, args) => {
      if (
        name === "govern_professor_execution" &&
        args?.p_operation === "AUTHORIZE"
      )
        await f.db.query(
          "select public.close_academic_content_release($1,true)",
          [args.p_release_id],
        );
    };
    expect(await executeProfessorRead(request())).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(await executions()).toHaveLength(0);
  });
  it("does not admit when controlled assessment blocks the existing content path", async () => {
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    expect(await executeProfessorRead(request())).toMatchObject({
      ok: false,
      error: { code: "ACTIVITY_BLOCKED" },
    });
    expect(await executions()).toHaveLength(0);
  });
  it("cannot bind forged/foreign academic context before service validation", async () => {
    expect(
      await executeProfessorRead({
        capability: "get_lesson_context",
        input: { enrolmentId: randomUUID(), lessonId: enrolledLesson },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONTENT_RELEASE_UNAVAILABLE" },
    });
    expect(
      await executeProfessorRead({
        capability: "get_lesson_context",
        input: { enrolmentId: f.enrolmentId, lessonId: randomUUID() },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONTENT_RELEASE_UNAVAILABLE" },
    });
    expect(await executions()).toHaveLength(0);
  });
  it.each(
    ["START", "FINALIZE"].flatMap((operation) =>
      [
        "POLICY_BLOCKED",
        "CONTENT_RELEASE_UNAVAILABLE",
        "ACTIVITY_BLOCKED",
        "EXECUTION_TIMEOUT",
      ].map((code) => ({ operation, code })),
    ),
  )(
    "preserves DB terminal $code at $operation without rewriting history",
    async ({ operation, code }) => {
      state.beforeRpc = async (name, args) => {
        if (
          name !== "govern_professor_execution" ||
          args?.p_operation !== operation
        )
          return;
        state.beforeRpc = undefined;
        if (code === "CONTENT_RELEASE_UNAVAILABLE") {
          await f.db.query(
            "select public.close_academic_content_release($1,false)",
            [args.p_release_id],
          );
          return;
        }
        await f.db.exec("reset role");
        if (code === "POLICY_BLOCKED")
          await f.db.query(
            "delete from public.role_grants where user_id=$1 and role='STUDENT'",
            [learner],
          );
        // Privileged fixtures simulate an authoritative activity change/elapsed
        // deadline. Ordinary assessment start remains excluded by the real lease.
        if (code === "ACTIVITY_BLOCKED")
          await f.db.exec(
            "create or replace function public.academic_content_release_explain_allowed() returns boolean language sql security definer set search_path='' as $$select false$$",
          );
        if (code === "EXECUTION_TIMEOUT") {
          await f.db.exec(
            "alter table public.academic_executions disable trigger guard_execution_history; alter table public.academic_executions disable trigger audit_execution_lifecycle",
          );
          await f.db.query(
            "update public.academic_executions set created_at=now()-interval '21 seconds',authorized_at=now()-interval '21 seconds',started_at=case when started_at is null then null else now()-interval '20 seconds' end,expires_at=now()-interval '1 second' where id=$1",
            [args.p_execution_id],
          );
          await f.db.exec(
            "alter table public.academic_executions enable trigger guard_execution_history; alter table public.academic_executions enable trigger audit_execution_lifecycle",
          );
        }
        await f.db.exec("set role authenticated");
      };
      expect(await executeProfessorRead(request())).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(
        (await executions()).map(({ state, reason_code }) => ({
          state,
          reason_code,
        })),
      ).toEqual([{ state: "FAILED", reason_code: code }]);
      expect(
        state.calls.filter(
          (call) =>
            call.rpc === "govern_professor_execution" &&
            call.args?.p_reason === "INTERNAL_ERROR",
        ),
      ).toHaveLength(0);
      await f.db.exec("reset role");
      expect(
        (
          await f.db.query(
            "select id from public.audit_events where target_type='academic_executions' and action='EXECUTION_FAILED'",
          )
        ).rows,
      ).toHaveLength(1);
    },
  );
  it.each([false, true])(
    "attempts necessary cleanup after transport uncertainty; cleanup unavailable=%s",
    async (cleanupUnavailable) => {
      state.beforeRpc = async (name, args) => {
        if (name !== "govern_professor_execution") return;
        if (
          args?.p_operation === "START" ||
          (cleanupUnavailable && args?.p_reason === "INTERNAL_ERROR")
        )
          throw new Error("Transport uncertainty sentinel");
      };
      expect(await executeProfessorRead(request())).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      expect(
        state.calls.filter(
          (call) =>
            call.rpc === "govern_professor_execution" &&
            call.args?.p_reason === "INTERNAL_ERROR",
        ),
      ).toHaveLength(1);
      expect(
        (await executions()).map(({ state, reason_code }) => ({
          state,
          reason_code,
        })),
      ).toEqual([
        {
          state: cleanupUnavailable ? "AUTHORIZED" : "FAILED",
          reason_code: cleanupUnavailable ? null : "INTERNAL_ERROR",
        },
      ]);
    },
  );
});
