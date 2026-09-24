import type { PGlite } from "@electric-sql/pglite";
import {
  capabilityDbClient,
  type CapabilityDbState,
} from "./capability-db-client";

// Test-only adapter forwarding the exact RPC surface
// submitControlledAssessmentAndGrade/submitPracticalLabWorkAndGrade actually
// reach end to end: the two submission RPCs and the entire existing initial
// Examiner AUTHORIZE/START/CONTEXT_READ/FINALIZE governed surface (migration
// 031/036, unmodified). Every call executes for real against PGlite under
// the authenticated role with all repository RLS/ACLs -- nothing here
// simulates or shortcuts the governed chain.
//
// Each RPC uses PostgreSQL's named-parameter call syntax
// (fn(p_x => $1::type, ...)) with an explicit cast on every bind parameter
// -- Postgres cannot infer a bind parameter's type from context alone when
// combined with named-parameter syntax, so an uncast parameter fails to
// resolve to any overload at all. This also means a parameter's POSITION in
// the list below can never silently swap two same-shaped fields, unlike a
// purely positional forwarder.
type Param = { name: string; cast: string };
const RPCS: Record<string, Param[]> = {
  start_assessment_attempt: [{ name: "p_assessment_id", cast: "uuid" }],
  submit_assessment_attempt: [{ name: "p_attempt_id", cast: "uuid" }],
  submit_commercial_v1_lab_work: [
    { name: "p_enrolment_id", cast: "uuid" },
    { name: "p_practical_id", cast: "uuid" },
    { name: "p_body", cast: "text" },
    { name: "p_idempotency_key", cast: "text" },
  ],
  govern_commercial_v1_examiner_execution: [
    { name: "p_key_id", cast: "uuid" },
    { name: "p_execution_id", cast: "uuid" },
    { name: "p_capability", cast: "text" },
    { name: "p_target_kind", cast: "text" },
    { name: "p_attempt_id", cast: "uuid" },
    { name: "p_submission_id", cast: "uuid" },
    { name: "p_enrolment_id", cast: "uuid" },
    { name: "p_activation_id", cast: "uuid" },
    { name: "p_operation", cast: "text" },
    { name: "p_state", cast: "text" },
    { name: "p_reason", cast: "text" },
    { name: "p_budget_stage", cast: "text" },
    { name: "p_max_calls", cast: "integer" },
    { name: "p_max_output", cast: "integer" },
    { name: "p_max_cost", cast: "bigint" },
    { name: "p_calls", cast: "integer" },
    { name: "p_attempts", cast: "integer" },
    { name: "p_input", cast: "integer" },
    { name: "p_output", cast: "integer" },
    { name: "p_cost", cast: "bigint" },
    { name: "p_elapsed", cast: "integer" },
    { name: "p_grade_digest", cast: "text" },
    { name: "p_issued_at", cast: "bigint" },
    { name: "p_expires_at", cast: "bigint" },
    { name: "p_mac", cast: "text" },
    { name: "p_assessment_marks", cast: "jsonb" },
    { name: "p_lab_marks_awarded", cast: "integer" },
  ],
  get_commercial_v1_examiner_assessment_context: [
    { name: "p_key_id", cast: "uuid" },
    { name: "p_execution_id", cast: "uuid" },
    { name: "p_attempt_id", cast: "uuid" },
    { name: "p_enrolment_id", cast: "uuid" },
    { name: "p_activation_id", cast: "uuid" },
    { name: "p_issued_at", cast: "bigint" },
    { name: "p_expires_at", cast: "bigint" },
    { name: "p_mac", cast: "text" },
  ],
  get_commercial_v1_examiner_lab_context: [
    { name: "p_key_id", cast: "uuid" },
    { name: "p_execution_id", cast: "uuid" },
    { name: "p_submission_id", cast: "uuid" },
    { name: "p_enrolment_id", cast: "uuid" },
    { name: "p_activation_id", cast: "uuid" },
    { name: "p_issued_at", cast: "bigint" },
    { name: "p_expires_at", cast: "bigint" },
    { name: "p_mac", cast: "text" },
  ],
};

export type SubmissionGradingClientState = CapabilityDbState & {
  rpcLog: string[];
  failRpc?: string;
};
export function newSubmissionGradingClientState(): SubmissionGradingClientState {
  return { authUser: null, calls: [], rpcLog: [] };
}

export function submissionGradingClient(
  db: PGlite,
  state: SubmissionGradingClientState,
) {
  const base = capabilityDbClient(db, state);
  return {
    ...base,
    async rpc(name: string, args: Record<string, unknown> = {}) {
      if (!(name in RPCS)) return base.rpc(name, args);
      state.rpcLog.push(name);
      if (state.failRpc === name)
        return { data: null, error: { message: "SQL credential sentinel" } };
      await db.exec("savepoint submission_grading_rpc");
      try {
        const params = RPCS[name];
        const call = params
          .map((p, i) => `${p.name} => $${i + 1}::${p.cast}`)
          .join(",");
        const values = params.map((p) => args[p.name] ?? null);
        const result = await db.query<{ v: unknown }>(
          `select public.${name}(${call}) as v`,
          values,
        );
        await db.exec("release savepoint submission_grading_rpc");
        return { data: result.rows[0]?.v ?? null, error: null };
      } catch (e) {
        await db.exec(
          "rollback to savepoint submission_grading_rpc;release savepoint submission_grading_rpc",
        );
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
}
