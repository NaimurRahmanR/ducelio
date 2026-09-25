// Central environment preflight for the Commercial V1 hosted-acceptance
// harness (docs/38-commercial-v1-checkpoint-d-hosted-acceptance-
// prerequisites.md). Reports, per named variable, only one of
// "configured" / "missing" / "malformed" -- the raw value is NEVER read
// into a log line, NEVER interpolated into an error message, and NEVER
// returned from this module. Every application-runtime variable name below
// is copied verbatim from real source, not guessed (see the comment above
// each group for exactly where it is read in the repository).
//
// Every ACCEPTANCE_* variable here is deliberately NOT application-runtime:
//   ACCEPTANCE_DATABASE_URL, ACCEPTANCE_WRITE_ENABLED,
//   ACCEPTANCE_ENVIRONMENT_ID, ACCEPTANCE_DATABASE_INSECURE_TLS,
//   ACCEPTANCE_*_EMAIL, ACCEPTANCE_*_PASSWORD,
//   ACCEPTANCE_LIVE_PROVIDER_OPT_IN, ACCEPTANCE_STRIPE_LIVE_OPT_IN.
// These exist ONLY for this acceptance harness and are never imported by
// src/**. In particular there is intentionally no application-runtime
// SUPABASE_SERVICE_ROLE_KEY anywhere in this codebase (a deliberate RLS/
// RPC-only architecture decision -- see docs/38's own note) and this
// harness does not introduce one either: ACCEPTANCE_DATABASE_URL is a
// separate, acceptance-tooling-only privileged connection string, used only
// for read/verify migration introspection (see db.mjs), never granted to
// the running application.
const HEX_KEY_64 = /^[0-9a-f]{64}$/i;
const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUrl(value, { requireHttps = false } = {}) {
  try {
    const u = new URL(value);
    if (requireHttps) return u.protocol === "https:";
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// A real `pg.Client({ connectionString })` value, never http/https --
// independent-review finding 1: the prior isValidUrl(v) check silently
// accepted only http:/https: schemes, so a genuine postgres://... value
// would have been reported MALFORMED. Deliberately a SEPARATE validator
// from isValidUrl (never weakens the Supabase/provider http(s) checks
// above): accepts only postgres:/postgresql: (the two schemes libpq and
// node-postgres both recognise), with a non-empty host, and a userinfo
// section requiring both a username and password to be present when
// either is (a bare "postgres://host/db" with no credentials at all is a
// separate, legitimate shape -- e.g. peer/trust auth -- so it is not
// rejected; a URL with a username but no password, or vice versa, is
// malformed input, not a valid connection string).
function isValidDatabaseUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return false;
  if (!u.hostname) return false;
  if ((u.username && !u.password) || (!u.username && u.password)) return false;
  return true;
}

/**
 * @typedef {"configured"|"missing"|"malformed"} VarStatus
 * @typedef {{ name: string, status: VarStatus, scope: "app"|"acceptance", note?: string }} VarReport
 */

/** @type {Array<{name: string, scope: "app"|"acceptance", validate?: (v: string) => boolean, note: string}>} */
const KNOWN_VARS = [
  // -- Application runtime: src/lib/env.ts (readConfig) --
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    scope: "app",
    validate: (v) => isValidUrl(v),
    note: "Supabase project URL (browser-exposed).",
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    scope: "app",
    note: "Supabase publishable/anon key (browser-exposed).",
  },
  // -- Application runtime: src/server/academic-runtime/provider.ts --
  {
    name: "ACADEMIC_PROVIDER_BASE_URL",
    scope: "app",
    validate: (v) => isValidUrl(v, { requireHttps: true }),
    note: "AI provider base URL. Server-only; the running app fails closed to NO_PROVIDER_CONFIGURED without it.",
  },
  {
    name: "ACADEMIC_PROVIDER_API_KEY",
    scope: "app",
    note: "AI provider API key. Server-only.",
  },
  // -- Application runtime: src/server/{academic-execution,academic-provider-execution,
  //    commercial-v1-examiner-grading,commercial-v1-examiner-regrade,
  //    commercial-v1-examiner-recovery,tutor-lab-execution}/authority.ts --
  {
    name: "ACADEMIC_EXECUTION_KEY_ID",
    scope: "app",
    validate: (v) => UUID_LIKE.test(v),
    note: "Shared controller HMAC key id for every Examiner/Professor/Tutor-Lab governance surface.",
  },
  {
    name: "ACADEMIC_EXECUTION_HMAC_KEY_HEX",
    scope: "app",
    validate: (v) => HEX_KEY_64.test(v),
    note: "Shared controller HMAC key (64 lowercase hex chars = 32 bytes).",
  },
  // -- Application runtime: src/lib/env.ts (readCommerceConfig) --
  {
    name: "STRIPE_SECRET_KEY",
    scope: "app",
    validate: (v) => /^sk_(test|live)_/.test(v),
    note: "Stripe secret key. This harness refuses to run Stripe acceptance against an sk_live_ key.",
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    scope: "app",
    validate: (v) => /^whsec_/.test(v),
    note: "Stripe webhook signing secret.",
  },
  {
    name: "COMMERCE_CONTROLLER_KEY_ID",
    scope: "app",
    validate: (v) => UUID_LIKE.test(v),
    note: "Commerce controller HMAC key id (separate trust root from ACADEMIC_EXECUTION_*).",
  },
  {
    name: "COMMERCE_CONTROLLER_HMAC_KEY_HEX",
    scope: "app",
    validate: (v) => HEX_KEY_64.test(v),
    note: "Commerce controller HMAC key (64 lowercase hex chars).",
  },
  // -- Acceptance-tooling only. Never imported by src/**. --
  {
    name: "ACCEPTANCE_DATABASE_URL",
    scope: "acceptance",
    validate: (v) => isValidDatabaseUrl(v),
    note: "Direct PostgreSQL connection string (postgres:// or postgresql://) for a dedicated staging/acceptance database (migration verification, introspection, true-concurrency tests). Never production. Never the application runtime's own credential.",
  },
  {
    name: "ACCEPTANCE_WRITE_ENABLED",
    scope: "acceptance",
    validate: (v) => v === "true",
    note: "Must be exactly 'true' to permit any mutating acceptance/concurrency fixture write, and only in combination with the acceptance-environment marker row this harness independently requires inside the target database itself (see db.mjs's assertAcceptanceDatabaseWriteAuthorized). Neither alone is sufficient; a connection string existing is never itself authorization to write.",
  },
  {
    name: "ACCEPTANCE_ENVIRONMENT_ID",
    scope: "acceptance",
    validate: (v) => UUID_LIKE.test(v),
    note: "Independent-review finding 1: the single identifier binding ACCEPTANCE_DATABASE_URL and NEXT_PUBLIC_SUPABASE_URL to the SAME deliberately-provisioned acceptance environment. Both the direct-database marker row and a narrowly-scoped hosted Supabase RPC (public.get_ducelio_acceptance_environment_id, manually provisioned -- never a Ducelio migration) must independently return exactly this UUID before any mutating acceptance/concurrency fixture writes anything. A connection string alone never proves which environment it points at.",
  },
  {
    name: "ACCEPTANCE_DATABASE_INSECURE_TLS",
    scope: "acceptance",
    validate: (v) => v === "true",
    note: "INSECURE. Independent-review finding 4: disables TLS certificate verification for the direct ACCEPTANCE_DATABASE_URL connection. Only for an isolated development environment that genuinely cannot present a verifiable certificate; never for a real hosted target. Must be exactly 'true' to take effect -- omitted, the connection uses the connection string's own TLS configuration unmodified.",
  },
  {
    name: "ACCEPTANCE_ADMIN_EMAIL",
    scope: "acceptance",
    note: "Synthetic ACADEMIC_ADMIN/PLATFORM_ADMIN acceptance identity (hosted Supabase Auth email) for JWT/RLS/RPC acceptance.",
  },
  {
    name: "ACCEPTANCE_ADMIN_PASSWORD",
    scope: "acceptance",
    note: "Password for ACCEPTANCE_ADMIN_EMAIL.",
  },
  {
    name: "ACCEPTANCE_LEARNER_EMAIL",
    scope: "acceptance",
    note: "Synthetic STUDENT acceptance identity for JWT/RLS/RPC acceptance.",
  },
  {
    name: "ACCEPTANCE_LEARNER_PASSWORD",
    scope: "acceptance",
    note: "Password for ACCEPTANCE_LEARNER_EMAIL.",
  },
  {
    name: "ACCEPTANCE_FOREIGN_LEARNER_EMAIL",
    scope: "acceptance",
    note: "A second, unrelated synthetic STUDENT identity, used only to prove cross-learner denial.",
  },
  {
    name: "ACCEPTANCE_FOREIGN_LEARNER_PASSWORD",
    scope: "acceptance",
    note: "Password for ACCEPTANCE_FOREIGN_LEARNER_EMAIL.",
  },
  {
    name: "ACCEPTANCE_LIVE_PROVIDER_OPT_IN",
    scope: "acceptance",
    validate: (v) => v === "true",
    note: "Must be exactly the string 'true' AND the operator must have separately instructed this session to run live acceptance -- a key existing is never itself permission. See docs/38 section 5.",
  },
  {
    name: "ACCEPTANCE_STRIPE_LIVE_OPT_IN",
    scope: "acceptance",
    validate: (v) => v === "true",
    note: "Reserved for a separate, later production Stripe acceptance phase. Never used to authorize a live charge from this harness.",
  },
];

/** @returns {VarReport} */
function reportOne(entry) {
  const raw = process.env[entry.name];
  if (raw === undefined || raw.trim() === "")
    return { name: entry.name, status: "missing", scope: entry.scope };
  if (entry.validate && !entry.validate(raw.trim()))
    return { name: entry.name, status: "malformed", scope: entry.scope };
  return { name: entry.name, status: "configured", scope: entry.scope };
}

/** @returns {VarReport[]} */
export function preflightReport() {
  return KNOWN_VARS.map(reportOne);
}

/** @param {string} name @returns {VarStatus} */
export function statusOf(name) {
  const entry = KNOWN_VARS.find((e) => e.name === name);
  if (!entry) throw new Error(`Unknown acceptance variable: ${name}`);
  return reportOne(entry).status;
}

export function isConfigured(name) {
  return statusOf(name) === "configured";
}

// True only when STRIPE_SECRET_KEY is configured AND shaped like a live-mode
// key. Never reads or returns the key itself.
export function stripeLooksLive() {
  const raw = process.env.STRIPE_SECRET_KEY;
  return typeof raw === "string" && raw.trim().startsWith("sk_live_");
}

// True only when the explicit, double-gated opt-in env var is exactly
// "true". This function alone is NEVER sufficient permission to run a
// billable provider call -- callers must also have been separately
// instructed by the operator in this session (see surfaces.mjs).
export function liveProviderOptedIn() {
  return (
    isConfigured("ACADEMIC_PROVIDER_BASE_URL") &&
    isConfigured("ACADEMIC_PROVIDER_API_KEY") &&
    process.env.ACCEPTANCE_LIVE_PROVIDER_OPT_IN?.trim() === "true"
  );
}

export { KNOWN_VARS };
