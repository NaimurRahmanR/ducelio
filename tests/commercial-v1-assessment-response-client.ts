import type { PGlite } from "@electric-sql/pglite";
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
};

export function newAssessmentClientState(): AssessmentClientState {
  return { authUser: null, calls: [], rpcLog: [], rpcArgs: [] };
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

const TABLE_FIELDS: Record<string, string> = {
  assessments:
    "t.id,t.title,t.instructions,t.opens_at,t.closes_at,t.duration_minutes,t.attempts_allowed,t.status,json_build_object('title',l.title) as lessons,json_build_object('label',v.label,'title_snapshot',v.title_snapshot) as programme_versions",
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
      if (state.failRpc === name)
        return { data: null, error: { message: "SQL credential sentinel" } };
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
      const filters: string[] = [];
      const params: unknown[] = [];
      let limit = 1000;
      const query = {
        select() {
          return query;
        },
        in(col: string, values: unknown[]) {
          if (!["cohort_id", "status"].includes(col))
            throw new Error("Unsupported filter");
          if (values.length === 0) throw new Error("Unsafe empty .in() filter");
          params.push(values);
          filters.push("t." + col + "=any($" + params.length + ")");
          return query;
        },
        eq(col: string, value: unknown) {
          if (col !== "student_id") throw new Error("Unsupported filter");
          params.push(value);
          filters.push("t.student_id=$" + params.length);
          return query;
        },
        order() {
          return query;
        },
        limit(n: number) {
          limit = n;
          return query;
        },
        then(
          resolve: (v: unknown) => unknown,
          reject: (e: unknown) => unknown,
        ) {
          const join =
            table === "assessments"
              ? " join public.lessons l on l.id=t.lesson_id join public.programme_versions v on v.id=t.programme_version_id"
              : "";
          return db
            .query<{ data: unknown }>(
              "select row_to_json(q) as data from (select " +
                TABLE_FIELDS[table] +
                " from public." +
                table +
                " t" +
                join +
                (filters.length ? " where " + filters.join(" and ") : "") +
                " limit " +
                limit +
                ") q",
              params,
            )
            .then((r) => ({ data: r.rows.map((x) => x.data), error: null }))
            .then(resolve, reject);
        },
      };
      return query;
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
