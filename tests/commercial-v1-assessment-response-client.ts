import type { PGlite } from "@electric-sql/pglite";
import { postgrestSelectQuery } from "./postgrest-select-query";
import {
  capabilityDbClient,
  type CapabilityDbState,
} from "./capability-db-client";
import {
  asPolicyUser,
  learnerAuth,
} from "./commercial-v1-assessment-policy-fixture";

// Test-only adapter for the exact PostgREST subset the learner assessment
// services use. Every RPC and table read executes in PGlite under the
// authenticated role with all repository RLS/ACLs, exactly as
// tests/course-activation-server.test.ts does for the legacy services. This
// adapter additionally records the ORDERED list of RPC names actually invoked
// so a test can prove which writer a server composition reached -- and, just
// as importantly, which it never reached. It does not simulate hosted
// PostgREST, cookies or Supabase Auth.
export const ASSESSMENT_RPC_PARAMS: Record<string, string[]> = {
  my_coursework_scope: [],
  current_academic_activity_state: [],
  start_assessment_attempt: ["p_assessment_id"],
  get_active_assessment_questions: ["p_assessment_id"],
  record_assessment_response: [
    "p_attempt_id",
    "p_question_id",
    "p_body",
    "p_idempotency_key",
  ],
  record_commercial_v1_assessment_response: [
    "p_attempt_id",
    "p_question_id",
    "p_body",
    "p_idempotency_key",
  ],
  submit_assessment_attempt: ["p_attempt_id"],
  finalize_expired_commercial_v1_attempts: [],
  get_commercial_v1_active_attempt: [],
};

export type AssessmentClientState = CapabilityDbState & {
  rpcLog: string[];
  rpcArgs: { name: string; args: Record<string, unknown> }[];
  failRpc?: string;
  // Every table read's requested PostgREST select string, in order, so a
  // test can check each embedded relation against the real migrated FK
  // graph (this adapter itself does not resolve embeds the way PostgREST
  // does -- see TABLE_FIELDS).
  selects: { table: string; select: string }[];
  // A table whose read should fail as a PostgREST error would.
  failTableRead?: string;
  // An RPC that executes normally (its database effects are applied) but
  // whose client-visible result is an error. Test adapter only.
  errorAfterRpc?: string;
  // An RPC or table read whose next `times` requests fail before any HTTP
  // response exists, exactly as postgrest-js reports a rejected fetch
  // (status 0). Nothing executes in the database for those requests.
  transportFail?: { name: string; times: number };
};

// Every simulated upstream error carries sentinel text in each field a real
// Supabase/PostgREST error has, so a test can prove none of it escapes.
export const UPSTREAM_ERROR_SENTINEL = "UPSTREAM-SENTINEL";
function upstreamError(label: string) {
  return {
    message: `${label} ${UPSTREAM_ERROR_SENTINEL} relation "secret" SQL select 1`,
    details: `${UPSTREAM_ERROR_SENTINEL} details`,
    hint: `${UPSTREAM_ERROR_SENTINEL} hint`,
    code: "XX000",
  };
}

// postgrest-js's result for a request whose fetch rejected: no HTTP status.
function transportFailure(state: AssessmentClientState, name: string) {
  if (state.transportFail?.name !== name || state.transportFail.times <= 0)
    return null;
  state.transportFail.times -= 1;
  return {
    data: null,
    error: {
      message: `TypeError: fetch failed ${UPSTREAM_ERROR_SENTINEL}`,
      details: `${UPSTREAM_ERROR_SENTINEL} details`,
      hint: "",
      code: "",
    },
    status: 0,
    statusText: "",
  };
}

export function newAssessmentClientState(): AssessmentClientState {
  return { authUser: null, calls: [], rpcLog: [], rpcArgs: [], selects: [] };
}

export async function actAs(
  db: PGlite,
  state: AssessmentClientState,
  n: number,
) {
  await asPolicyUser(db, n);
  state.authUser = {
    id: learnerAuth(n),
    email_confirmed_at: "2026-01-01T00:00:00Z",
  };
}

// Every column the learner projections filter on.
const LEARNER_FILTER_COLUMNS = [
  "cohort_id",
  "status",
  "id",
  "assessment_id",
  "student_id",
  "state",
  "attempt_id",
] as const;
const TABLE_FIELDS: Record<string, string> = {
  assessments:
    "t.id,t.title,t.instructions,t.opens_at,t.closes_at,t.duration_minutes,t.attempts_allowed,t.status,t.programme_version_id,json_build_object('title',l.title) as lessons",
  programme_versions: "t.id,t.label,t.title_snapshot",
  assessment_attempts:
    "t.id,t.assessment_id,t.attempt_number,t.state,t.started_at,t.expires_at,t.submitted_at",
  assessment_responses:
    "t.id,t.attempt_id,t.question_id,t.revision_number,t.recorded_at",
};

export function assessmentClient(db: PGlite, state: AssessmentClientState) {
  const base = capabilityDbClient(db, state);
  return {
    ...base,
    async rpc(name: string, args: Record<string, unknown> = {}) {
      if (!(name in ASSESSMENT_RPC_PARAMS)) return base.rpc(name, args);
      state.rpcLog.push(name);
      state.rpcArgs.push({ name, args });
      const transport = transportFailure(state, name);
      if (transport) return transport;
      if (state.failRpc === name)
        return {
          data: null,
          error: upstreamError("SQL credential sentinel"),
          status: 400,
          statusText: "Bad Request",
        };
      await db.exec("savepoint assessment_rpc");
      try {
        const params = ASSESSMENT_RPC_PARAMS[name].map((k) => args[k]);
        const placeholders = params.map((_, i) => "$" + (i + 1)).join(",");
        const table = name === "get_active_assessment_questions";
        const result = await db.query<{ data: unknown }>(
          table
            ? `select row_to_json(q) as data from public.${name}(${placeholders}) q`
            : `select public.${name}(${placeholders}) as data`,
          params,
        );
        await db.exec("release savepoint assessment_rpc");
        if (state.errorAfterRpc === name)
          return {
            data: null,
            error: upstreamError("Response lost after state transition"),
          };
        return {
          data: table
            ? result.rows.map((r) => r.data)
            : (result.rows[0]?.data ?? null),
          error: null,
        };
      } catch (e) {
        await db.exec(
          "rollback to savepoint assessment_rpc;release savepoint assessment_rpc",
        );
        return { data: null, error: { message: (e as Error).message } };
      }
    },
    from(table: string) {
      if (!(table in TABLE_FIELDS)) return base.from(table);
      return postgrestSelectQuery({
        db,
        table,
        columns: TABLE_FIELDS[table],
        join:
          table === "assessments"
            ? " join public.lessons l on l.id=t.lesson_id and l.programme_version_id=t.programme_version_id"
            : "",
        filterColumns: LEARNER_FILTER_COLUMNS,
        onSelect: (select) => state.selects?.push({ table, select }),
        intercept: () =>
          transportFailure(state, table) ??
          (state.failTableRead === table
            ? {
                data: null,
                error: upstreamError("PostgREST read failure sentinel"),
              }
            : undefined),
      });
    },
  };
}

// Test-only elapsed-time simulation, matching the existing lifecycle suites:
// guard_assessment_attempt_history (migration 016) makes expires_at immutable
// for every runtime caller, so the single owner-level UPDATE that simulates
// "the deadline has already passed" briefly disables that one trigger and
// re-enables it immediately. No governed function ever does this.
export async function forceExpire(db: PGlite, attemptId: string) {
  await db.exec("reset role");
  await db.exec(
    "alter table public.assessment_attempts disable trigger guard_assessment_attempt_history",
  );
  try {
    await db.query(
      "update public.assessment_attempts set expires_at=started_at+interval '1 microsecond' where id=$1",
      [attemptId],
    );
  } finally {
    await db.exec(
      "alter table public.assessment_attempts enable trigger guard_assessment_attempt_history",
    );
  }
}
