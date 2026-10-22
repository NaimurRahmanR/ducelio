import { createHmac, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  asExecutionUser,
  foreignLearner,
  learner,
  openExecutionRelease,
} from "./execution-fixture";
import { tutorLabFixture, type TutorLabFixture } from "./tutor-lab-fixture";
import {
  sendProviderCommand,
  signedProviderCommand,
} from "./provider-execution-fixture";
import {
  sendTutorLabCommand,
  signedTutorLabCommand,
} from "./tutor-lab-provider-execution-fixture";

// Migration 064 against the B2B (cohort) governance it serves: a real
// activated cohort, its learner's own migration 021 Professor release and
// migration 028 Tutor/Lab releases from real DELIVERY_V1 handoffs, driven
// through the UNCHANGED migration 025/028 governance with signed commands
// (PGlite). Each test runs in a transaction that is rolled back.
let f: TutorLabFixture;
beforeAll(async () => {
  f = await tutorLabFixture();
});
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback; reset role");
});
afterAll(async () => {
  await f.db?.close();
});

const usage = {
  calls: 1,
  attempts: 1,
  input: 100,
  output: 30,
  cost: 70,
  elapsed: 800,
};
const value = async <T>(sql: string, args: unknown[] = []) =>
  (await f.db.query<{ v: T }>(sql, args)).rows[0].v;
const owner = () => f.db.exec("reset role");
const asLearner = () => asExecutionUser(f.db, 1);
const asForeign = () => asExecutionUser(f.db, 3);

function mac(canonical: (string | number)[]) {
  return createHmac("sha256", f.key).update(canonical.join("\n")).digest("hex");
}
function late(
  kind: string,
  executionId: string,
  releaseId: string,
  actor = learner,
  u = usage,
) {
  const iat = Math.floor(Date.now() / 1000);
  return value<{ ok: boolean; code?: string }>(
    "select public.record_late_provider_execution_usage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) v",
    [
      kind,
      f.keyId,
      executionId,
      releaseId,
      u.calls,
      u.attempts,
      u.input,
      u.output,
      u.cost,
      u.elapsed,
      iat,
      iat + 10,
      mac([
        "DUCELIO_LATE_PROVIDER_USAGE_HMAC_SHA256_V1",
        kind,
        f.keyId,
        actor,
        executionId,
        releaseId,
        u.calls,
        u.attempts,
        u.input,
        u.output,
        u.cost,
        u.elapsed,
        iat,
        iat + 10,
      ]),
    ],
  );
}
function abandon(kind: string, executionId: string, releaseId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return value<{ ok: boolean; code?: string; state?: string }>(
    "select public.abandon_unstarted_provider_execution($1,$2,$3,$4,$5,$6,$7,$8) v",
    [
      kind,
      f.keyId,
      executionId,
      releaseId,
      "POLICY_BLOCKED",
      iat,
      iat + 10,
      mac([
        "DUCELIO_ABANDON_PROVIDER_EXECUTION_HMAC_SHA256_V1",
        kind,
        f.keyId,
        learner,
        executionId,
        releaseId,
        "POLICY_BLOCKED",
        iat,
        iat + 10,
      ]),
    ],
  );
}
// Let one execution's 20-second envelope pass (owner only; the history
// guard is disabled inside this rolled-back transaction).
async function age(table: string, executionId: string) {
  const guard =
    table === "academic_provider_executions"
      ? "guard_provider_execution_history"
      : "guard_tutor_lab_provider_execution_history";
  await owner();
  await f.db.exec(`alter table public.${table} disable trigger ${guard}`);
  await f.db.query(
    `update public.${table} set created_at = created_at - interval '25 seconds',
       authorized_at = authorized_at - interval '25 seconds', started_at = started_at - interval '25 seconds',
       expires_at = expires_at - interval '25 seconds' where id = $1`,
    [executionId],
  );
  await f.db.exec(`alter table public.${table} enable trigger ${guard}`);
}
const professor = (overrides: Parameters<typeof signedProviderCommand>[1]) =>
  sendProviderCommand(f.db, signedProviderCommand(f, overrides)) as Promise<{
    ok: boolean;
    code?: string;
  }>;
const tutorLab = (overrides: Parameters<typeof signedTutorLabCommand>[1]) =>
  sendTutorLabCommand(f.db, signedTutorLabCommand(f, overrides)) as Promise<{
    ok: boolean;
    code?: string;
  }>;
async function cohortTutorLabRelease(handoffId: string) {
  return value<{ ok: true; release_id: string; role: string }>(
    "select public.begin_tutor_lab_content_release($1,$2) v",
    [randomUUID(), handoffId],
  );
}

describe("cohort Professor executions (migration 025 governance)", () => {
  it("record a late provider call's usage once, without reviving the execution", async () => {
    await asLearner();
    const release = await openExecutionRelease(f.db);
    const executionId = randomUUID();
    const ids = { executionId, releaseId: release.release_id };
    expect(await professor({ ...ids })).toMatchObject({ ok: true });
    expect(
      await professor({
        ...ids,
        operation: "START",
        state: "RUNNING",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
      }),
    ).toMatchObject({ ok: true });
    await age("academic_provider_executions", executionId);
    await asLearner();
    // The unchanged governance refuses the late FINALIZE and writes no usage.
    expect(
      await professor({
        ...ids,
        operation: "FINALIZE",
        state: "SUCCEEDED",
        reason: "PROVIDER_COMPLETE",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
        ...usage,
      }),
    ).toEqual({ ok: false, code: "EXECUTION_TIMEOUT" });
    // Another learner cannot report it; the owner can, exactly once.
    await asForeign();
    expect(
      await late("PROFESSOR", executionId, release.release_id, foreignLearner),
    ).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    await asLearner();
    expect(await late("PROFESSOR", executionId, release.release_id)).toEqual({
      ok: true,
      state: "TIMEOUT",
    });
    expect(await late("PROFESSOR", executionId, release.release_id)).toEqual({
      ok: false,
      code: "ALREADY_RECORDED",
    });
    await owner();
    expect(
      (
        await f.db.query(
          `select x.state, x.reason_code, u.provider_calls, u.output_tokens
           from public.academic_provider_executions x join public.academic_provider_execution_usage u
           on u.execution_id = x.id where x.id = $1`,
          [executionId],
        )
      ).rows,
    ).toEqual([
      {
        state: "TIMEOUT",
        reason_code: "EXECUTION_TIMEOUT",
        provider_calls: 1,
        output_tokens: 30,
      },
    ]);
  });

  it("abandon an AUTHORIZED execution so the learner's next one is admitted at once", async () => {
    await asLearner();
    const release = await openExecutionRelease(f.db);
    const executionId = randomUUID();
    expect(
      await professor({ executionId, releaseId: release.release_id }),
    ).toMatchObject({ ok: true });
    // Before migration 064 this execution held the learner's single active
    // slot until expiry: a second admission is RATE_LIMITED.
    const blockedRelease = await openExecutionRelease(f.db);
    expect(
      await professor({ releaseId: blockedRelease.release_id }),
    ).toMatchObject({
      ok: true,
      execution: { state: "BLOCKED", reasonCode: "RATE_LIMITED" },
    });
    expect(await abandon("PROFESSOR", executionId, release.release_id)).toEqual(
      {
        ok: true,
        state: "FAILED",
        transitioned: true,
      },
    );
    const next = await openExecutionRelease(f.db);
    expect(await professor({ releaseId: next.release_id })).toMatchObject({
      ok: true,
      execution: { state: "AUTHORIZED" },
    });
  });
});

describe("cohort Tutor and Lab Instructor executions (migration 028 governance)", () => {
  it.each([
    ["TUTOR", "missedLessonHandoffId"],
    ["LAB_INSTRUCTOR", "practicalHelpHandoffId"],
  ] as const)(
    "%s: abandon an unstarted execution and late-record a timed-out one",
    async (role, handoff) => {
      await asLearner();
      const first = await cohortTutorLabRelease(f[handoff]);
      expect(first).toMatchObject({ ok: true, role });
      const firstId = randomUUID();
      expect(
        await tutorLab({
          role,
          executionId: firstId,
          releaseId: first.release_id,
        }),
      ).toMatchObject({ ok: true });
      expect(await abandon(role, firstId, first.release_id)).toMatchObject({
        ok: true,
        state: "FAILED",
      });
      // The other role's governance kind cannot touch it.
      const other = role === "TUTOR" ? "LAB_INSTRUCTOR" : "TUTOR";
      expect(await late(other, firstId, first.release_id)).toEqual({
        ok: false,
        code: "NOT_FOUND_OR_FORBIDDEN",
      });

      const second = await cohortTutorLabRelease(f[handoff]);
      const secondId = randomUUID();
      const ids = { role, executionId: secondId, releaseId: second.release_id };
      expect(await tutorLab(ids)).toMatchObject({ ok: true });
      expect(
        await tutorLab({
          ...ids,
          operation: "START",
          state: "RUNNING",
          maxCalls: 0,
          maxOutput: 0,
          maxCost: 0,
        }),
      ).toMatchObject({ ok: true });
      await age("tutor_lab_provider_executions", secondId);
      await asLearner();
      expect(
        await tutorLab({
          ...ids,
          operation: "FINALIZE",
          state: "SUCCEEDED",
          reason: "PROVIDER_COMPLETE",
          maxCalls: 0,
          maxOutput: 0,
          maxCost: 0,
          ...usage,
        }),
      ).toEqual({ ok: false, code: "EXECUTION_TIMEOUT" });
      expect(await late(role, secondId, second.release_id)).toEqual({
        ok: true,
        state: "TIMEOUT",
      });
      expect(await late(role, secondId, second.release_id)).toEqual({
        ok: false,
        code: "ALREADY_RECORDED",
      });
      await owner();
      expect(
        (
          await f.db.query(
            `select x.state, u.provider_calls, u.output_tokens,
               (select count(*)::int from public.academic_agent_execution_provenance p
                 where p.tutor_lab_execution_id = x.id) cohort_provenance
             from public.tutor_lab_provider_executions x
             join public.tutor_lab_provider_execution_usage u on u.execution_id = x.id where x.id = $1`,
            [secondId],
          )
        ).rows,
      ).toEqual([
        {
          state: "TIMEOUT",
          provider_calls: 1,
          output_tokens: 30,
          cohort_provenance: 1,
        },
      ]);
    },
  );
});
