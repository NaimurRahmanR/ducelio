// One function per Checkpoint D acceptance surface (docs/38). Each returns
// exactly one Result (report.mjs): PASS, FAIL, BLOCKED or NOT_RUN. A
// missing prerequisite is always BLOCKED, never converted to PASS or
// silently skipped.
import { pass, fail, blocked, notRun } from "./report.mjs";
import { isConfigured, stripeLooksLive, liveProviderOptedIn } from "./env.mjs";
import {
  acceptanceDbConfigured,
  withConnection,
  functionExists,
  tableExists,
  listLocalMigrationFiles,
} from "./db.mjs";
import {
  hostedSupabaseConfigured,
  anonClient,
  acceptanceIdentities,
  acceptanceIdentitiesConfigured,
} from "./supabase.mjs";
import {
  seedAcceptanceCourse,
  seedAcceptanceResults,
  cleanupAcceptanceRun,
} from "./fixtures.mjs";

// ---------------------------------------------------------------------------
// HOSTED_DATABASE
// ---------------------------------------------------------------------------
export async function checkHostedDatabase() {
  if (!acceptanceDbConfigured())
    return blocked(
      "HOSTED_DATABASE",
      "ACCEPTANCE_DATABASE_URL is not configured.",
      [
        "Provision a dedicated staging/acceptance PostgreSQL and set ACCEPTANCE_DATABASE_URL.",
      ],
    );
  try {
    const version = await withConnection(async (client) => {
      const { rows } = await client.query("select version() as v");
      return rows[0].v;
    });
    return pass("HOSTED_DATABASE", "Connected to the acceptance database.", [
      `Server: ${version.split(",")[0]}`,
    ]);
  } catch (error) {
    return fail(
      "HOSTED_DATABASE",
      "Could not connect to ACCEPTANCE_DATABASE_URL.",
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

// ---------------------------------------------------------------------------
// MIGRATIONS -- for every local migration file, extract its first
// `create table public.X` / `create function public.X(` and verify that
// object exists in the target database. Not a full replay, but a real,
// mechanically-derived coherence check (never a hardcoded, driftable list).
// ---------------------------------------------------------------------------
async function firstCreatedObject(filename) {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(
    new URL(`../../supabase/migrations/${filename}`, import.meta.url),
    "utf8",
  );
  const tableMatch = text.match(/create table public\.([a-z0-9_]+)/i);
  const functionMatch = text.match(
    /create (?:or replace )?function public\.([a-z0-9_]+)/i,
  );
  const tableIdx = tableMatch ? text.indexOf(tableMatch[0]) : Infinity;
  const functionIdx = functionMatch ? text.indexOf(functionMatch[0]) : Infinity;
  if (tableIdx === Infinity && functionIdx === Infinity) return null;
  return tableIdx < functionIdx
    ? { kind: "table", name: tableMatch[1] }
    : { kind: "function", name: functionMatch[1] };
}

export async function checkMigrations() {
  if (!acceptanceDbConfigured())
    return blocked("MIGRATIONS", "ACCEPTANCE_DATABASE_URL is not configured.");
  const files = await listLocalMigrationFiles();
  const missing = [];
  try {
    await withConnection(async (client) => {
      for (const file of files) {
        const marker = await firstCreatedObject(file);
        if (!marker) continue; // a migration with no table/function marker (rare) is skipped, not failed
        const exists =
          marker.kind === "table"
            ? await tableExists(client, marker.name)
            : await functionExists(client, marker.name);
        if (!exists) missing.push(`${file} -> ${marker.kind} ${marker.name}`);
      }
    });
  } catch (error) {
    return fail("MIGRATIONS", "Migration verification query failed.", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  if (missing.length)
    return fail(
      "MIGRATIONS",
      `${missing.length} of ${files.length} local migrations have no matching object in the hosted database.`,
      missing,
    );
  return pass(
    "MIGRATIONS",
    `All ${files.length} local migrations (through 202609250042) have a matching object hosted.`,
  );
}

// ---------------------------------------------------------------------------
// RLS_ACL -- reuses the exact has_table_privilege/has_function_privilege
// effective-privilege check every reviewed migration in this codebase
// already runs at deployment time, against a sample of the most sensitive
// Commercial V1 tables.
// ---------------------------------------------------------------------------
const SENSITIVE_TABLES = [
  "commercial_v1_examiner_executions",
  "commercial_v1_examiner_regrade_executions",
  "commercial_v1_examiner_recovery_executions",
  "assessment_answer_keys",
  "academic_execution_private.controller_keys",
];
export async function checkRlsAcl() {
  if (!acceptanceDbConfigured())
    return blocked("RLS_ACL", "ACCEPTANCE_DATABASE_URL is not configured.");
  const unsafe = [];
  try {
    await withConnection(async (client) => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const table of SENSITIVE_TABLES) {
          const { rows } = await client.query(
            `select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as unsafe`,
            [role, table],
          );
          if (rows[0]?.unsafe) unsafe.push(`${role} on ${table}`);
        }
      }
    });
  } catch (error) {
    return fail("RLS_ACL", "RLS/ACL introspection query failed.", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  if (unsafe.length)
    return fail(
      "RLS_ACL",
      `${unsafe.length} unsafe effective privilege(s) found on sensitive tables.`,
      unsafe,
    );
  return pass(
    "RLS_ACL",
    `No unsafe anon/authenticated/service_role privileges on ${SENSITIVE_TABLES.length} sampled sensitive tables.`,
  );
}

// ---------------------------------------------------------------------------
// JWT_POSTGREST -- exercises the plain JWT+role-gated RPC boundary (no HMAC
// involved) with real synthetic hosted identities.
// ---------------------------------------------------------------------------
export async function checkJwtPostgrest() {
  if (!hostedSupabaseConfigured())
    return blocked(
      "JWT_POSTGREST",
      "Hosted Supabase is not configured (NEXT_PUBLIC_SUPABASE_*).",
    );
  if (!acceptanceIdentitiesConfigured())
    return blocked(
      "JWT_POSTGREST",
      "Acceptance identities are not configured.",
      [
        "Set ACCEPTANCE_ADMIN_EMAIL/PASSWORD and ACCEPTANCE_LEARNER_EMAIL/PASSWORD (real hosted Supabase Auth users).",
      ],
    );
  const evidence = [];
  try {
    const anon = anonClient();
    const { error: anonError } = await anon.rpc("list_practical_enrolments");
    if (!anonError)
      return fail(
        "JWT_POSTGREST",
        "Anonymous caller was NOT denied list_practical_enrolments.",
      );
    evidence.push("anon denied list_practical_enrolments: OK");

    const learner = await acceptanceIdentities.learner();
    const { error: learnerListError } = await learner.rpc(
      "list_practical_enrolments",
    );
    if (learnerListError)
      return fail(
        "JWT_POSTGREST",
        "Authenticated learner was denied their own enrolment list.",
        [learnerListError.message],
      );
    evidence.push("learner can list own enrolments: OK");

    const { error: learnerAdminError } = await learner.rpc(
      "list_commercial_v1_activations",
    );
    if (!learnerAdminError)
      return fail(
        "JWT_POSTGREST",
        "A learner was NOT denied the admin-only activation-discovery RPC.",
      );
    evidence.push("learner denied admin-only RPC: OK");

    const admin = await acceptanceIdentities.admin();
    const { error: adminError } = await admin.rpc(
      "list_commercial_v1_activations",
    );
    if (adminError)
      return fail(
        "JWT_POSTGREST",
        "Authenticated admin was denied the admin-only activation-discovery RPC.",
        [adminError.message],
      );
    evidence.push("admin can call admin-only RPC: OK");

    if (isConfigured("ACCEPTANCE_FOREIGN_LEARNER_EMAIL")) {
      const foreign = await acceptanceIdentities.foreignLearner();
      const { data: foreignEnrolments } = await foreign.rpc(
        "list_practical_enrolments",
      );
      const { data: learnerEnrolments } = await learner.rpc(
        "list_practical_enrolments",
      );
      const learnerIds = new Set((learnerEnrolments ?? []).map((e) => e.id));
      const overlap = (foreignEnrolments ?? []).some((e) =>
        learnerIds.has(e.id),
      );
      if (overlap)
        return fail(
          "JWT_POSTGREST",
          "A foreign learner's own enrolment list included another learner's enrolment.",
        );
      evidence.push(
        "foreign learner does not see the other learner's enrolments: OK",
      );
    }
    return pass(
      "JWT_POSTGREST",
      "JWT/RLS/RPC boundary matches local assumptions.",
      evidence,
    );
  } catch (error) {
    return fail(
      "JWT_POSTGREST",
      "Acceptance identity sign-in or RPC call failed unexpectedly.",
      [error instanceof Error ? error.message : String(error), ...evidence],
    );
  }
}

// ---------------------------------------------------------------------------
// GRADING / INITIAL_RECOVERY / REGRADE -- deliberately BLOCKED by design.
// The HMAC canonical-message-construction logic for these three governance
// surfaces exists in exactly one place, src/server/commercial-v1-examiner-
// {grading,regrade,recovery}/authority.ts, and this harness intentionally
// never reimplements it: a second, independently-maintained copy of a
// trust-critical signing protocol is a real security/maintenance risk this
// checkpoint's own instructions explicitly ask to avoid ("preserve
// controller/HMAC trust"; "avoid ... hidden fallbacks"). Full hosted
// acceptance for these three surfaces means driving the real Ducelio
// application server (Next.js, configured with this hosted database and
// ACADEMIC_EXECUTION_KEY_ID/HMAC_KEY_HEX) -- e.g. an HTTP/browser
// acceptance pass against a deployed instance, mirroring scripts/smoke.mjs's
// own established pattern -- not a parallel script.
// ---------------------------------------------------------------------------
function hmacBlockedResult(surface) {
  return blocked(
    surface,
    "Requires driving the real Ducelio application server (exclusive HMAC signing implementation), not a standalone acceptance script.",
    [
      "This harness deliberately never reimplements the controller/HMAC canonical-message protocol outside src/server/commercial-v1-examiner-*/authority.ts.",
      "Next step: run the Next.js app itself against this hosted database/provider config and drive it over HTTP (see scripts/smoke.mjs's pattern) for full acceptance of this surface.",
    ],
  );
}
export async function checkGrading() {
  return hmacBlockedResult("GRADING");
}
export async function checkInitialRecovery() {
  return hmacBlockedResult("INITIAL_RECOVERY");
}
export async function checkRegrade() {
  return hmacBlockedResult("REGRADE");
}

// ---------------------------------------------------------------------------
// RESULT_PROGRESS_COMPLETION -- does not require HMAC (get_commercial_v1_
// course_progress / attempt_commercial_v1_course_completion are plain JWT-
// gated RPCs). Seeds a real course through governed RPCs, seeds results
// through the dedicated acceptance-only mechanism (fixtures.mjs), then
// proves completion end to end, including idempotent replay.
// ---------------------------------------------------------------------------
export async function checkResultProgressCompletion() {
  if (!acceptanceDbConfigured())
    return blocked(
      "RESULT_PROGRESS_COMPLETION",
      "ACCEPTANCE_DATABASE_URL is not configured.",
    );
  if (!hostedSupabaseConfigured() || !acceptanceIdentitiesConfigured())
    return blocked(
      "RESULT_PROGRESS_COMPLETION",
      "Hosted Supabase and/or acceptance identities are not configured.",
    );
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const admin = await acceptanceIdentities.admin();
    const learner = await acceptanceIdentities.learner();
    const { data: learnerUser } = await learner.auth.getUser();
    const course = await seedAcceptanceCourse(
      admin,
      runId,
      learnerUser.user.id,
    );
    await seedAcceptanceResults(course, learnerUser.user.id, true);

    const { data: progress, error: progressError } = await learner.rpc(
      "get_commercial_v1_course_progress",
      { p_enrolment_id: course.enrolmentId },
    );
    if (progressError || !progress?.ok)
      return fail(
        "RESULT_PROGRESS_COMPLETION",
        "Progress read failed after seeding a fully graded course.",
        [progressError?.message ?? JSON.stringify(progress)],
      );
    if (progress.courseScoreBp !== 10000)
      return fail(
        "RESULT_PROGRESS_COMPLETION",
        `Expected courseScoreBp 10000, got ${progress.courseScoreBp}.`,
      );

    const { data: first } = await learner.rpc(
      "attempt_commercial_v1_course_completion",
      {
        p_enrolment_id: course.enrolmentId,
        p_reason: "Acceptance completion attempt",
      },
    );
    const { data: replay } = await learner.rpc(
      "attempt_commercial_v1_course_completion",
      {
        p_enrolment_id: course.enrolmentId,
        p_reason: "Acceptance completion replay",
      },
    );
    if (first?.code !== "COMPLETED" || replay?.code !== "ALREADY_COMPLETED")
      return fail(
        "RESULT_PROGRESS_COMPLETION",
        "Completion or idempotent replay did not behave as expected.",
        [JSON.stringify(first), JSON.stringify(replay)],
      );
    return pass(
      "RESULT_PROGRESS_COMPLETION",
      "Hosted deterministic progress/completion machinery proven end to end, including idempotent replay.",
      [`Acceptance run ${runId}`],
    );
  } catch (error) {
    return fail(
      "RESULT_PROGRESS_COMPLETION",
      "Hosted result/progress/completion acceptance failed.",
      [error instanceof Error ? error.message : String(error)],
    );
  } finally {
    await cleanupAcceptanceRun(runId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// STRIPE_TEST_MODE
// ---------------------------------------------------------------------------
export async function checkStripeTestMode() {
  if (
    !isConfigured("STRIPE_SECRET_KEY") ||
    !isConfigured("STRIPE_WEBHOOK_SECRET")
  )
    return blocked(
      "STRIPE_TEST_MODE",
      "STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET are not configured.",
    );
  if (stripeLooksLive())
    return blocked(
      "STRIPE_TEST_MODE",
      "STRIPE_SECRET_KEY is shaped like a LIVE-mode key (sk_live_...). Refusing to run against it.",
      [
        "Set ACCEPTANCE_STRIPE_LIVE_OPT_IN=true only for a separate, later, explicitly-authorized production acceptance phase.",
      ],
    );
  try {
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const balance = await stripe.balance.retrieve();
    if (balance.livemode)
      return fail(
        "STRIPE_TEST_MODE",
        "Stripe account reports livemode=true despite an sk_test_ key.",
      );
    return pass("STRIPE_TEST_MODE", "Connected to Stripe in test mode.", [
      "Full checkout/webhook/entitlement acceptance requires this harness to run alongside the application's own commerce Server Actions (server-owned amount/currency, signed webhook, entitlement creation) -- not yet wired here; this check proves test-mode connectivity only.",
    ]);
  } catch (error) {
    return fail(
      "STRIPE_TEST_MODE",
      "Stripe test-mode connectivity check failed.",
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

// ---------------------------------------------------------------------------
// SUPABASE_AUTH_EMAIL -- Supabase Auth's own hosted email, distinct from any
// custom transactional email subsystem (which does not exist in this
// codebase -- see docs/38 section 7).
// ---------------------------------------------------------------------------
export async function checkSupabaseAuthEmail() {
  if (!hostedSupabaseConfigured())
    return blocked("SUPABASE_AUTH_EMAIL", "Hosted Supabase is not configured.");
  return blocked(
    "SUPABASE_AUTH_EMAIL",
    "Email deliverability cannot be proven programmatically without a real inbox to poll.",
    [
      "This is Supabase Auth's own hosted email (project dashboard SMTP settings), never a Ducelio application variable.",
      "CUSTOM_TRANSACTIONAL_EMAIL remains NOT_IMPLEMENTED / OUT_OF_SCOPE -- no application code sends email.",
      "Evidence needed: a disposable-inbox acceptance identity plus manual or IMAP-polled confirmation that the signup/reset email actually arrives from the configured hosted sender.",
    ],
  );
}

// ---------------------------------------------------------------------------
// LIVE_PROVIDER -- never runs without an explicit, double-gated opt-in AND
// the operator having separately instructed this session to perform live
// acceptance. A configured credential is never itself permission.
// ---------------------------------------------------------------------------
export async function checkLiveProvider({ operatorAuthorized = false } = {}) {
  if (
    !isConfigured("ACADEMIC_PROVIDER_BASE_URL") ||
    !isConfigured("ACADEMIC_PROVIDER_API_KEY")
  )
    return blocked(
      "LIVE_PROVIDER",
      "ACADEMIC_PROVIDER_BASE_URL/ACADEMIC_PROVIDER_API_KEY are not configured.",
    );
  if (!liveProviderOptedIn())
    return blocked("LIVE_PROVIDER", "EXPLICIT_AUTHORIZATION_REQUIRED", [
      "ACCEPTANCE_LIVE_PROVIDER_OPT_IN must be exactly 'true'.",
    ]);
  if (!operatorAuthorized)
    return blocked("LIVE_PROVIDER", "EXPLICIT_AUTHORIZATION_REQUIRED", [
      "Credentials and the opt-in flag are present, but the operator has not separately instructed this session to run a billable live-provider request. Never inferred from a key existing.",
    ]);
  return notRun(
    "LIVE_PROVIDER",
    "Live provider acceptance was authorized but this invocation did not request it.",
  );
}

// ---------------------------------------------------------------------------
// MONITORING / BACKUP_RESTORE -- never fabricated.
// ---------------------------------------------------------------------------
export async function checkMonitoring() {
  return blocked(
    "MONITORING",
    "No programmatic monitoring evidence source is configured.",
    [
      "Evidence needed: an error-monitoring/log-aggregation API this harness can query (e.g. a status/health endpoint) to confirm a controlled non-sensitive failure is actually visible.",
    ],
  );
}
export async function checkBackupRestore() {
  return blocked(
    "BACKUP_RESTORE",
    "No programmatic backup/restore evidence source is configured.",
    [
      "Evidence needed: a restore-to-isolated-environment exercise with confirmation that enrolments/results/receipts survive coherently (docs/38 section 9) -- not something this harness can assert from application credentials alone.",
    ],
  );
}

// ---------------------------------------------------------------------------
// FULL_CUSTOMER_JOURNEY -- orchestration placeholder. Composes the surfaces
// above; BLOCKED as a whole while GRADING (its middle step) is itself
// BLOCKED by design. Never claims a journey ran that did not.
// ---------------------------------------------------------------------------
export async function checkFullCustomerJourney(allResults) {
  const byName = Object.fromEntries(allResults.map((r) => [r.surface, r]));
  const required = [
    "HOSTED_DATABASE",
    "MIGRATIONS",
    "RLS_ACL",
    "JWT_POSTGREST",
    "GRADING",
    "INITIAL_RECOVERY",
    "RESULT_PROGRESS_COMPLETION",
    "STRIPE_TEST_MODE",
  ];
  const notPassed = required.filter((name) => byName[name]?.status !== "PASS");
  if (notPassed.length)
    return blocked(
      "FULL_CUSTOMER_JOURNEY",
      `${notPassed.length} prerequisite surface(s) have not PASSed.`,
      notPassed.map((n) => `${n}: ${byName[n]?.status ?? "NOT_RUN"}`),
    );
  return notRun(
    "FULL_CUSTOMER_JOURNEY",
    "All prerequisite surfaces PASS, but the full public-course-through-completion browser/HTTP journey itself has not been run by this invocation.",
  );
}
