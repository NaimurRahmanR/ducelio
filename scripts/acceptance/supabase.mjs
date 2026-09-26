// Hosted Supabase client helpers for the acceptance harness. Uses the SAME
// @supabase/supabase-js package and the SAME public URL/publishable-key
// pair the application itself uses (NEXT_PUBLIC_SUPABASE_URL,
// NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) -- this harness never uses a
// service-role credential, because the application has none and this
// harness deliberately exercises the exact same authority boundary real
// learners/admins go through (PostgREST + RLS + the governed RPCs), not a
// privileged bypass.
import { createClient } from "@supabase/supabase-js";
import { isConfigured } from "./env.mjs";
import { AcceptanceWriteNotAuthorizedError } from "./db.mjs";

export function hostedSupabaseConfigured() {
  return (
    isConfigured("NEXT_PUBLIC_SUPABASE_URL") &&
    isConfigured("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
  );
}

/** An anonymous (unauthenticated) client -- exactly what a signed-out browser gets. */
export function anonClient() {
  if (!hostedSupabaseConfigured())
    throw new Error("Hosted Supabase is not configured.");
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

/**
 * Signs in a synthetic acceptance identity via real Supabase Auth (email +
 * password) and returns an authenticated client. Never creates or invents a
 * session; a missing/incorrect credential fails closed and the caller
 * reports BLOCKED, never a fabricated PASS.
 */
export async function signIn(emailVar, passwordVar) {
  const email = process.env[emailVar];
  const password = process.env[passwordVar];
  if (!email || !password)
    throw new Error(
      `Acceptance identity ${emailVar}/${passwordVar} is not configured.`,
    );
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error)
    throw new Error(
      `Acceptance identity ${emailVar} could not authenticate (hosted Supabase Auth denied it).`,
    );
  return client;
}

export const acceptanceIdentities = {
  admin: () => signIn("ACCEPTANCE_ADMIN_EMAIL", "ACCEPTANCE_ADMIN_PASSWORD"),
  learner: () =>
    signIn("ACCEPTANCE_LEARNER_EMAIL", "ACCEPTANCE_LEARNER_PASSWORD"),
  foreignLearner: () =>
    signIn(
      "ACCEPTANCE_FOREIGN_LEARNER_EMAIL",
      "ACCEPTANCE_FOREIGN_LEARNER_PASSWORD",
    ),
  // JWT_POSTGREST completion (this pass): a fourth identity, distinct from
  // admin/learner/foreignLearner, used only to prove an UNRELATED
  // non-admin staff principal cannot cross the institutional recovery
  // role gate. Signing in proves nothing about its ROLE on its own --
  // see verifyNonAdminStaffRole below, which independently confirms this
  // against the real hosted role model before any test relies on it.
  unrelatedStaff: () =>
    signIn(
      "ACCEPTANCE_UNRELATED_STAFF_EMAIL",
      "ACCEPTANCE_UNRELATED_STAFF_PASSWORD",
    ),
};

export function acceptanceIdentitiesConfigured() {
  return (
    isConfigured("ACCEPTANCE_ADMIN_EMAIL") &&
    isConfigured("ACCEPTANCE_ADMIN_PASSWORD") &&
    isConfigured("ACCEPTANCE_LEARNER_EMAIL") &&
    isConfigured("ACCEPTANCE_LEARNER_PASSWORD")
  );
}

// Independent-review finding 3: JWT_POSTGREST must not be able to PASS
// without ever proving foreign-learner isolation. This requires the
// COMPLETE pair -- an email with no password (or vice versa) is an
// incomplete prerequisite, not a usable identity, and returns false just
// like both being absent.
export function foreignLearnerIdentityConfigured() {
  return (
    isConfigured("ACCEPTANCE_FOREIGN_LEARNER_EMAIL") &&
    isConfigured("ACCEPTANCE_FOREIGN_LEARNER_PASSWORD")
  );
}

// JWT_POSTGREST completion (this pass): same complete-pair requirement as
// foreignLearnerIdentityConfigured above -- a partial pair is not a usable
// identity.
export function unrelatedStaffIdentityConfigured() {
  return (
    isConfigured("ACCEPTANCE_UNRELATED_STAFF_EMAIL") &&
    isConfigured("ACCEPTANCE_UNRELATED_STAFF_PASSWORD")
  );
}

// ---------------------------------------------------------------------------
// JWT_POSTGREST completion (this pass): verifies, against the REAL hosted
// role model -- public.has_role(wanted), migration 2609080003, granted to
// `authenticated` -- that an already-signed-in identity genuinely carries
// `staffRole` and genuinely does NOT carry ACADEMIC_ADMIN or PLATFORM_ADMIN.
// Never inferred from the ACCEPTANCE_UNRELATED_STAFF_EMAIL variable's own
// name -- an operator could misconfigure it to point at an admin account,
// and this must fail closed rather than silently produce a false "unrelated
// staff denied" acceptance result off an admin identity that was ALWAYS
// going to be permitted.
// ---------------------------------------------------------------------------
export async function verifyNonAdminStaffRole(client, staffRole) {
  const { data: hasStaffRole, error: staffRoleError } = await client.rpc(
    "has_role",
    { wanted: staffRole },
  );
  if (staffRoleError)
    return {
      verified: false,
      reason: `has_role(${staffRole}) RPC failed: ${staffRoleError.message}`,
    };
  if (!hasStaffRole)
    return {
      verified: false,
      reason: `The configured identity does not actually carry the ${staffRole} role.`,
    };
  const { data: hasAcademicAdmin, error: academicAdminError } =
    await client.rpc("has_role", { wanted: "ACADEMIC_ADMIN" });
  if (academicAdminError)
    return {
      verified: false,
      reason: `has_role(ACADEMIC_ADMIN) RPC failed: ${academicAdminError.message}`,
    };
  const { data: hasPlatformAdmin, error: platformAdminError } =
    await client.rpc("has_role", { wanted: "PLATFORM_ADMIN" });
  if (platformAdminError)
    return {
      verified: false,
      reason: `has_role(PLATFORM_ADMIN) RPC failed: ${platformAdminError.message}`,
    };
  if (hasAcademicAdmin || hasPlatformAdmin)
    return {
      verified: false,
      reason:
        "The configured 'unrelated staff' identity actually carries ACADEMIC_ADMIN or PLATFORM_ADMIN -- refusing to use it as a non-admin denial fixture.",
    };
  return { verified: true };
}

// ---------------------------------------------------------------------------
// JWT_POSTGREST completion (this pass): invalid/expired-JWT acceptance
// needs full control over the raw HTTP request -- supabase-js's own
// session management never lets a caller present a bearer token that
// wasn't the result of a real sign-in. This calls the SAME PostgREST RPC
// endpoint the application's own hosted Supabase project already exposes
// (`POST {url}/rest/v1/rpc/{name}`), using the SAME public
// apikey/publishable-key header every real browser client sends -- never
// a service-role credential -- with a caller-supplied bearer token that
// may be malformed or genuinely expired. A network failure (DNS, TLS,
// connection refused) is distinguished from a completed HTTP response:
// callers must never treat the former as evidence of denial. The raw
// token is NEVER returned or logged. The raw response body is never
// returned or logged either -- only a BOUNDED subset of the PostgREST
// error envelope (`status`, `code`, `message` -- never `details`/`hint`,
// which could echo back arbitrary request content) needed to classify
// the response as a genuine JWT/auth rejection rather than an unrelated
// failure (independent review, V2: a bare `ok:false` previously let a
// 404 schema-cache miss, a 500/503 outage or an unrelated 4xx count as
// fail-closed JWT evidence).
// ---------------------------------------------------------------------------
export async function callProtectedRpcWithBearerToken(
  rpcName,
  token,
  args = {},
) {
  if (!hostedSupabaseConfigured())
    throw new Error("Hosted Supabase is not configured.");
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "");
  const url = `${base}/rest/v1/rpc/${rpcName}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    let code = null;
    let message = null;
    let bodyParseError = false;
    try {
      const rawText = await response.text();
      if (rawText) {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.code === "string") code = parsed.code;
          if (typeof parsed.message === "string") message = parsed.message;
        }
      }
    } catch {
      // Honestly distinguished from a successfully-parsed body -- the
      // response completed (this is NOT a network error), but its body
      // was not the bounded JSON error envelope PostgREST normally
      // returns. code/message stay null; callers must never treat that
      // as itself a JWT/auth rejection.
      bodyParseError = true;
    }
    return {
      networkError: false,
      status: response.status,
      ok: response.ok,
      code,
      message,
      bodyParseError,
    };
  } catch (thrown) {
    return {
      networkError: true,
      status: null,
      ok: false,
      code: null,
      message: null,
      bodyParseError: false,
      // Bounded to the thrown Error's own message (e.g. "fetch failed",
      // "ECONNREFUSED") -- the request never completed, so there is no
      // response body or token to leak here regardless.
      networkErrorMessage:
        thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

// PostgREST's own JWT/authentication error-code family (see postgrest.org's
// error-code reference). V3 correction (independent review, blocker 3): a
// bare PGRST3XX prefix match was too broad -- it also matched PGRST302
// ("Bearer header missing while anon role is disabled"), which this
// harness's own check can never actually receive: it ALWAYS sends a
// Bearer token (a deliberately malformed or expired one), so a rejection
// classified as "no Bearer header at all" would not be evidence that the
// SUPPLIED token was ever inspected and rejected. Narrowed to the exact
// two codes that genuinely mean "a Bearer token was presented and
// PostgREST could not decode/validate it": PGRST301 ("JWT invalid/could
// not be decoded") and PGRST303 ("JWT claims validation/parsing failed").
const POSTGREST_JWT_AUTH_ERROR_CODES = new Set(["PGRST301", "PGRST303"]);

/**
 * True only for a genuine hosted PostgREST JWT/authentication rejection
 * of a SUPPLIED bearer token: HTTP 401 AND exactly PGRST301 or PGRST303.
 * Never true for a network error, a body-parse failure, PGRST302 (no
 * Bearer header at all -- not what this harness's checks ever send), or
 * any other HTTP status/code family (400/403/404/429/500/503, or a 401
 * with no recognisable code at all) -- those are real, unrelated
 * failures, never JWT evidence.
 */
export function isJwtAuthRejection(result) {
  return (
    !result?.networkError &&
    result?.status === 401 &&
    typeof result?.code === "string" &&
    POSTGREST_JWT_AUTH_ERROR_CODES.has(result.code)
  );
}

/**
 * True only for a hosted PostgREST rejection that is BOTH a genuine
 * JWT/auth rejection (see isJwtAuthRejection) AND whose own message
 * specifically identifies expiry (case-insensitively). A generic
 * "invalid JWT" rejection -- the same shape a merely malformed token
 * gets -- is deliberately NOT sufficient here: it does not establish
 * that expiry enforcement itself is what rejected this token.
 */
export function isJwtExpiryRejection(result) {
  return (
    isJwtAuthRejection(result) &&
    typeof result.message === "string" &&
    result.message.toLowerCase().includes("expired")
  );
}

// ---------------------------------------------------------------------------
// V3 correction (independent review, blockers 1 & 2): a bare "some error
// came back" was accepted as denial evidence for the anon and
// learner-admin-RPC checks, which would also accept a 404 schema-cache
// miss, a 500/503 outage or any other unrelated failure. These classify
// the SPECIFIC, documented insufficient-privilege (SQLSTATE 42501)
// rejection each caller is actually supposed to receive, using the
// SAME bounded status/code fields postgrest-js/supabase-js already
// exposes (never a raw response body or the caller's token).
//
// Current hosted PostgREST semantics distinguish these by HTTP status
// depending on whether the caller ever presented a JWT bound to a
// non-anon role at all: a caller using ONLY the anon key (no bearer
// session -- migration 2609140027 revokes function EXECUTE from anon
// entirely for list_practical_enrolments, so this is a grant-level
// rejection) gets HTTP 401; an authenticated caller who has EXECUTE but
// is denied by the function's OWN role check (migration 2609140027's
// course_activation_private.require_admin(), `raise exception 'FORBIDDEN'
// using errcode='42501'`) gets HTTP 403.
// ---------------------------------------------------------------------------

/**
 * True only for the documented insufficient-privilege rejection an
 * ANONYMOUS (no bearer session) caller receives: HTTP 401 AND SQLSTATE
 * 42501. Never true for an unrelated 400/404/429/500/503, a network
 * failure, or a 401 with no 42501 code -- those never count as evidence
 * that the intended authorization boundary (not some unrelated failure)
 * is what denied the call.
 */
export function isAnonInsufficientPrivilegeRejection(status, error) {
  return status === 401 && error?.code === "42501";
}

/**
 * True only for the documented insufficient-privilege rejection an
 * AUTHENTICATED (bearer session present) but unauthorized caller
 * receives: HTTP 403 AND SQLSTATE 42501. Never true for an unrelated
 * 400/404/429/500/503, a network failure, or a 403 with no 42501 code.
 */
export function isAuthenticatedInsufficientPrivilegeRejection(status, error) {
  return status === 403 && error?.code === "42501";
}

// ---------------------------------------------------------------------------
// Independent-review finding 1, gate 2 of 2: the Supabase/PostgREST side of
// the same-environment binding. A direct-database marker match alone does
// NOT prove that writes issued through the authenticated Supabase client
// (a completely different network path, authenticated by
// NEXT_PUBLIC_SUPABASE_URL/PUBLISHABLE_KEY, never ACCEPTANCE_DATABASE_URL)
// land on the same environment. This independently re-derives the
// environment id through a narrowly-scoped, manually-provisioned hosted
// RPC and compares it to ACCEPTANCE_ENVIRONMENT_ID. Both this gate and
// db.mjs's assertAcceptanceDatabaseWriteAuthorized must independently
// agree with the SAME operator-declared ACCEPTANCE_ENVIRONMENT_ID before
// seedAcceptanceCourse() (fixtures.mjs) writes anything.
//
// public.get_ducelio_acceptance_environment_id() is NOT a Ducelio
// migration and never will be -- it belongs to the same manually-
// provisioned acceptance marker contract as db.mjs's marker table,
// created once, by hand, directly against the dedicated acceptance
// Supabase project:
//
//   create or replace function public.get_ducelio_acceptance_environment_id()
//   returns uuid language sql stable as $$
//     select '<the exact same ACCEPTANCE_ENVIRONMENT_ID uuid>'::uuid
//   $$;
//   revoke all on function public.get_ducelio_acceptance_environment_id() from public, anon;
//   grant execute on function public.get_ducelio_acceptance_environment_id() to authenticated;
//
// It returns only the acceptance environment's own UUID -- no secret, no
// privileged database metadata, and is granted to `authenticated` only
// (never `anon`), so only a signed-in acceptance identity can even call
// it.
// ---------------------------------------------------------------------------
export async function assertAcceptanceSupabaseWriteAuthorized(client) {
  if (!isConfigured("ACCEPTANCE_ENVIRONMENT_ID"))
    throw new AcceptanceWriteNotAuthorizedError(
      "ACCEPTANCE_ENVIRONMENT_ID is not configured or is not a valid UUID.",
    );
  const expected = process.env.ACCEPTANCE_ENVIRONMENT_ID.trim().toLowerCase();
  let data, error;
  try {
    ({ data, error } = await client.rpc(
      "get_ducelio_acceptance_environment_id",
    ));
  } catch (thrown) {
    error = thrown;
  }
  if (error)
    throw new AcceptanceWriteNotAuthorizedError(
      "the hosted Supabase project does not expose (or denied) get_ducelio_acceptance_environment_id() -- this does not look like a deliberately provisioned acceptance environment.",
    );
  if (typeof data !== "string" || data.trim().toLowerCase() !== expected)
    throw new AcceptanceWriteNotAuthorizedError(
      "the hosted Supabase acceptance-environment id does not match ACCEPTANCE_ENVIRONMENT_ID -- refusing to write (NEXT_PUBLIC_SUPABASE_URL may point at a different environment than ACCEPTANCE_DATABASE_URL).",
    );
}
