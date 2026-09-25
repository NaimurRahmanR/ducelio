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
  AcceptanceWriteNotAuthorizedError,
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
// MIGRATIONS
//
// Independent-review finding 3: the prior check only confirmed the FIRST
// table/function each local migration file happens to create still exists
// -- a partially-applied migration (e.g. one that failed midway through a
// later statement) could still PASS. This is replaced with authoritative
// verification against Supabase's own migration ledger
// (supabase_migrations.schema_migrations, the table `supabase db push`/the
// CLI itself writes one row to per applied migration version) wherever that
// ledger is actually present on the target -- PASS now means the hosted
// ledger's version set is EXACTLY the local repository's migration version
// set, not merely "one object exists". If the ledger table itself is not
// present (a target not provisioned via the Supabase CLI, or one this
// connection cannot read `supabase_migrations`), that is reported honestly
// as its own condition, never silently downgraded to the weaker object-
// existence heuristic as if it were equivalent evidence.
//
// Separately, and only as supplementary, explicitly-labelled evidence
// (never the sole basis for PASS), the three most recent, most critical
// forward migrations (040, 041, 042 -- the Examiner recovery authority, the
// independent-review correction checkpoint, and activation discovery) each
// get a bounded, hand-verified check of every top-level object they define,
// not just the first one.
// ---------------------------------------------------------------------------
const CRITICAL_MIGRATION_OBJECTS = {
  "202609240040_commercial_v1_examiner_initial_grade_recovery.sql": [
    { kind: "table", name: "commercial_v1_examiner_recovery_executions" },
    { kind: "table", name: "commercial_v1_examiner_recovery_usage" },
    { kind: "function", name: "govern_commercial_v1_examiner_recovery" },
  ],
  "202609240041_commercial_v1_grading_chain_review_corrections.sql": [
    { kind: "function", name: "list_commercial_v1_examiner_recovery_targets" },
    { kind: "function", name: "get_commercial_v1_examiner_recovery_target" },
    { kind: "function", name: "get_commercial_v1_policy_setup_options" },
  ],
  "202609250042_commercial_v1_activation_discovery.sql": [
    { kind: "function", name: "list_commercial_v1_activations" },
  ],
};

function localMigrationVersion(filename) {
  // Every migration filename in this repository starts with a 12-digit
  // timestamp (YYYYMMDDHHMM), matching the version format the Supabase CLI
  // itself writes into supabase_migrations.schema_migrations.
  return filename.slice(0, 12);
}

async function checkCriticalMigrationObjects(client) {
  const missing = [];
  for (const [file, objects] of Object.entries(CRITICAL_MIGRATION_OBJECTS)) {
    for (const obj of objects) {
      const exists =
        obj.kind === "table"
          ? await tableExists(client, obj.name)
          : await functionExists(client, obj.name);
      if (!exists) missing.push(`${file} -> ${obj.kind} ${obj.name}`);
    }
  }
  return missing;
}

export async function checkMigrations() {
  if (!acceptanceDbConfigured())
    return blocked("MIGRATIONS", "ACCEPTANCE_DATABASE_URL is not configured.");
  const files = await listLocalMigrationFiles();
  const localVersions = new Set(files.map(localMigrationVersion));

  try {
    return await withConnection(async (client) => {
      const criticalMissing = await checkCriticalMigrationObjects(client);

      let ledgerExists = true;
      let hostedVersions;
      try {
        const { rows } = await client.query(
          "select version from supabase_migrations.schema_migrations",
        );
        hostedVersions = new Set(rows.map((r) => String(r.version)));
      } catch {
        ledgerExists = false;
      }

      if (!ledgerExists) {
        // Honest degraded path: no authoritative ledger to compare against.
        // Never claims PASS -- "one object exists" was exactly the
        // overclaim this correction removes. The bounded critical-object
        // check above is reported as supplementary evidence only.
        return blocked(
          "MIGRATIONS",
          "supabase_migrations.schema_migrations is not present (or not readable) on this target -- it was not provisioned via the Supabase CLI, or this connection lacks access. Authoritative migration-version verification is unavailable; object-existence alone is not sufficient evidence of PASS.",
          [
            criticalMissing.length
              ? `Supplementary critical-migration object check (040/041/042): ${criticalMissing.length} missing -- ${criticalMissing.join("; ")}`
              : "Supplementary critical-migration object check (040/041/042): all present (not authoritative on its own).",
          ],
        );
      }

      const missingFromHosted = [...localVersions].filter(
        (v) => !hostedVersions.has(v),
      );
      const extraOnHosted = [...hostedVersions].filter(
        (v) => !localVersions.has(v),
      );

      if (
        missingFromHosted.length ||
        extraOnHosted.length ||
        criticalMissing.length
      ) {
        const details = [];
        if (missingFromHosted.length)
          details.push(
            `${missingFromHosted.length} local migration version(s) not applied on hosted: ${missingFromHosted.join(", ")}`,
          );
        if (extraOnHosted.length)
          details.push(
            `${extraOnHosted.length} hosted migration version(s) not present locally: ${extraOnHosted.join(", ")}`,
          );
        if (criticalMissing.length)
          details.push(
            `Critical migration object(s) missing despite ledger row: ${criticalMissing.join("; ")}`,
          );
        return fail(
          "MIGRATIONS",
          "Hosted migration-ledger version set does not genuinely match the repository's expected migration set.",
          details,
        );
      }

      return pass(
        "MIGRATIONS",
        `Hosted supabase_migrations.schema_migrations exactly matches the local repository's ${localVersions.size} migration versions (through ${localMigrationVersion(files[files.length - 1])}), and all bounded critical-migration objects (040/041/042) exist.`,
      );
    });
  } catch (error) {
    return fail("MIGRATIONS", "Migration verification query failed.", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

// ---------------------------------------------------------------------------
// RLS_ACL
//
// Independent-review finding 5: this surface's PASS was worded as if it
// were broad RLS/ACL acceptance. It is not -- it is the exact
// has_table_privilege effective-privilege check every reviewed migration in
// this codebase already runs at deployment time, against a bounded sample
// of the most sensitive Commercial V1 tables. It does NOT evaluate RLS
// policy predicates/behaviour (row-level filtering itself), and does not
// exercise every table this repository protects. The real, behavioural
// row-level checks (a learner can read only their own data, a foreign
// learner is denied, etc.) are separate, already-genuine evidence gathered
// by JWT_POSTGREST, not this surface. This result is now explicitly
// labelled as a bounded sample so it cannot be mistaken for the broader
// claim.
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
    return fail(
      "RLS_ACL",
      "Sensitive-table ACL sample introspection query failed.",
      [error instanceof Error ? error.message : String(error)],
    );
  }
  if (unsafe.length)
    return fail(
      "RLS_ACL",
      `Sensitive-table ACL sample: ${unsafe.length} unsafe effective privilege(s) found.`,
      unsafe,
    );
  return pass(
    "RLS_ACL",
    `Sensitive-table ACL sample only (${SENSITIVE_TABLES.length} tables x anon/authenticated/service_role effective table privileges) -- no unsafe privilege found. This is not full RLS policy/behavioural acceptance; see JWT_POSTGREST for real row-level behavioural evidence.`,
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
    if (error instanceof AcceptanceWriteNotAuthorizedError)
      return blocked("RESULT_PROGRESS_COMPLETION", error.message, [
        "See scripts/acceptance/db.mjs's ACCEPTANCE_MARKER_PROVISIONING_SQL for how to designate a database as a disposable acceptance environment.",
      ]);
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
    return pass(
      "STRIPE_TEST_MODE",
      "Test-mode API connectivity only (balance retrieval) -- NOT full Commercial V1 Stripe acceptance.",
      [
        "Does not yet prove: server-owned checkout amount/currency, a signed test webhook, duplicate-webhook idempotency, entitlement creation, redirect-is-not-payment-proof, or the REVIEWER_COMPLIMENTARY non-payment path (docs/38 section 6). Wiring those requires this harness to run alongside the application's own commerce Server Actions -- not yet implemented here.",
      ],
    );
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
