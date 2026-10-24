// Bounded RPC caller for the opted-in hosted acceptance journeys.
//
// The 2026-10-23 hosted run lost a 26-minute real-time journey to a single
// client-side transport failure: postgrest-js turns a thrown `fetch` (no HTTP
// response, status 0) into `{ code: "" }`, and the previous wrapper printed
// only that empty code. The hosted database proved the quiz_4 start never
// committed (no attempt row, no ACADEMY_ASSESSMENT_STARTED audit event).
//
// Diagnostics stay bounded: RPC name plus an uppercase policy code, SQLSTATE,
// HTTP status or transport cause code. No sessions, credentials, e-mails or
// response bodies are printed.
//
// Retries are limited to transport failures of RPCs whose server contract is
// idempotent, so a replay can only resume/return the same server-owned state:
// - start_my_academy_assessment resumes the caller's ACTIVE attempt for the ref;
// - record_my_academy_response replays by its idempotency key;
// - submit_my_academy_attempt returns the already-final attempt;
// - the remaining names are reads.
// A PostgREST/SQL refusal (any HTTP response) is never retried, and RPCs whose
// concurrency is under test (orders, coupons, schedule confirmation) are never
// retried at all.
export const TRANSPORT_RETRY_SAFE_RPCS = new Set([
  "start_my_academy_assessment",
  "record_my_academy_response",
  "submit_my_academy_attempt",
  "get_my_academy_attempt",
  "get_my_academy_timetable",
  "get_my_academy_results",
  "get_my_unified_revision",
  "list_my_academy_enrolments",
  "list_unified_course_catalogue",
]);

const MAX_ATTEMPTS = 3;

/** True when supabase-js reports a thrown fetch: no HTTP response at all. */
export function isTransportFailure(status, error) {
  return status === 0 && error?.code === "";
}

/** Bounded, non-sensitive description of a failed RPC response. */
export function describeRpcError(status, error) {
  if (isTransportFailure(status, error)) {
    const cause = /\(([A-Z][A-Z0-9_]{1,40})\)/.exec(error.details ?? "")?.[1];
    return `TRANSPORT_FAILURE${cause ? `(${cause})` : ""}`;
  }
  if (/^[A-Z_]+$/.test(error?.message ?? "")) return error.message;
  if (typeof error?.code === "string" && /^[A-Z0-9]{5,8}$/.test(error.code))
    return error.code;
  return `HTTP_${Number.isInteger(status) ? status : "UNKNOWN"}`;
}

/**
 * Calls an RPC and returns its data or throws a bounded error. Transport
 * failures of retry-safe RPCs are retried (bounded, logged). `onRetry`
 * receives `{ name, attempt, reason }` for evidence.
 */
export async function callHostedRpc(client, name, args = {}, options = {}) {
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retrySafe = TRANSPORT_RETRY_SAFE_RPCS.has(name);
  for (let attempt = 1; ; attempt++) {
    const { data, error, status } = await client.rpc(name, args);
    if (!error) return data;
    const reason = describeRpcError(status, error);
    if (
      retrySafe &&
      isTransportFailure(status, error) &&
      attempt < MAX_ATTEMPTS
    ) {
      options.onRetry?.({ name, attempt, reason });
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    throw new Error(`${name}: ${reason}`);
  }
}
