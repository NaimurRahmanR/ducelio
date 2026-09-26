// One function per Checkpoint D acceptance surface (docs/38). Each returns
// exactly one Result (report.mjs): PASS, FAIL, BLOCKED or NOT_RUN. A
// missing prerequisite is always BLOCKED, never converted to PASS or
// silently skipped.
import { randomUUID } from "node:crypto";
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
  foreignLearnerIdentityConfigured,
  unrelatedStaffIdentityConfigured,
  verifyNonAdminStaffRole,
  callProtectedRpcWithBearerToken,
  isJwtAuthRejection,
  isJwtExpiryRejection,
  isAnonInsufficientPrivilegeRejection,
  isAuthenticatedInsufficientPrivilegeRejection,
} from "./supabase.mjs";
import {
  seedAcceptanceCourse,
  seedAcceptanceResults,
  enrolAcceptanceLearner,
  cleanupAcceptanceRun,
} from "./fixtures.mjs";
import { isStructurallyExpiredJwt } from "./jwt.mjs";

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
// (never the sole basis for PASS, and never a replacement for the ledger
// comparison above, which remains the sole authoritative version
// evidence), the three most recent, most critical forward migrations (040,
// 041, 042 -- the Examiner recovery authority, the independent-review
// correction checkpoint, and activation discovery) each get a bounded,
// hand-verified existence check of a SELECTED set of critical/sentinel
// public objects (independent-review finding 5: this is a curated
// selection, not an exhaustive enumeration of literally every object each
// migration file defines -- wording corrected to say exactly that).
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
              ? `Supplementary selected critical/sentinel object check (040/041/042): ${criticalMissing.length} missing -- ${criticalMissing.join("; ")}`
              : "Supplementary selected critical/sentinel object check (040/041/042): all present (a curated selection, not exhaustive; not authoritative on its own).",
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
            `Selected critical/sentinel migration object(s) missing despite ledger row: ${criticalMissing.join("; ")}`,
          );
        return fail(
          "MIGRATIONS",
          "Hosted migration-ledger version set does not genuinely match the repository's expected migration set.",
          details,
        );
      }

      return pass(
        "MIGRATIONS",
        `Hosted supabase_migrations.schema_migrations (the authoritative version evidence) exactly matches the local repository's ${localVersions.size} migration versions (through ${localMigrationVersion(files[files.length - 1])}); a selected set of critical/sentinel objects for 040/041/042 (supplementary, non-exhaustive integrity evidence) also all exist.`,
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
// JWT_POSTGREST -- exercises the full docs/38 section 3 Auth/JWT/role/
// PostgREST boundary with real synthetic hosted identities. Deliberately
// never touches the Examiner HMAC canonical-message/signing protocol
// itself (src/server/commercial-v1-examiner-*/authority.ts) -- see
// buildNonAuthoritativeRecoveryInvocation below for exactly how the
// recovery role-gate check stays on the JWT/role side of that boundary.
//
// History: independent review found, across several passes, that a PASS
// here previously required only admin+learner (never proving foreign-
// learner isolation at all), that a failed isolation-check RPC could
// silently resolve to an empty list and manufacture a false "no overlap"
// PASS, and that an isolation check between two genuinely empty lists is
// vacuous. All three are fixed and preserved below (the foreign-learner
// pair is a hard prerequisite; every RPC contributing to PASS has its
// error checked explicitly; the primary learner's enrolment is real and
// known, never inferred from non-emptiness alone).
//
// This pass completes the surface: every remaining docs/38 section 3
// requirement previously left this function permanently BLOCKED (never
// PASS) even when its narrower core sample succeeded. Full evidence now
// requires, in addition to the pre-existing core sample:
//   - a real hosted HTTP/PostgREST rejection of a deliberately malformed
//     JWT (never a local decoder standing in for the hosted server);
//   - a real hosted HTTP/PostgREST rejection of a genuinely expired,
//     previously-valid synthetic JWT (ACCEPTANCE_EXPIRED_LEARNER_JWT --
//     never freshly signed by this harness; structurally confirmed
//     expired via jwt.mjs before use, never assumed);
//   - a real, KNOWN cross-learner enrolment-ownership override denial
//     (get_commercial_v1_course_progress), not an isolation check on
//     opaque/unknown ids;
//   - a fourth, independently role-VERIFIED (never label-trusted)
//     unrelated-staff identity, proving that role denied at the
//     institutional-recovery gate exactly like the learner;
//   - the authorized admin identity reaching PAST the role gate to the
//     HMAC boundary for a deliberately non-authoritative recovery
//     invocation (UNTRUSTED_EXECUTION) -- explicitly NOT a claim of
//     successful recovery, which remains INITIAL_RECOVERY's own, separate,
//     still-BLOCKED-by-design surface;
//   - a real hosted denial of a direct PostgREST read of protected
//     answer-key storage, plus a real denial of the learner-facing
//     question-release RPC without an active attempt.
// Any missing prerequisite BLOCKS; any violated security property FAILS;
// PASS requires every one of the above to genuinely execute and succeed.
// ---------------------------------------------------------------------------

// Migration 2609240040's own governed recovery RPC, called with a
// deliberately, obviously non-authoritative shape: every structural field
// verify_command requires (component 2, this same migration) is present
// and well-formed so the call reaches the HMAC comparison itself, but
// p_mac can never match any real signature -- this harness computes no
// HMAC, ever. p_key_id/p_execution_id/p_source_execution_id are fresh
// random ids (deliberately not any real key/execution), which is
// sufficient: for a non-admin caller the ROLE check (migration 040's own
// UNAUTHENTICATED -> FORBIDDEN ordering, verified against actual current
// source before relying on it) returns before verify_command is ever
// reached; for the admin caller, verify_command itself fails (the key
// does not exist, and even if it did, the mac would not match), which is
// exactly what proves the HMAC boundary is reached and remains untrusted,
// never bypassed. No branch of this call ever inserts/updates a row.
// V2 correction (independent review, blocker 2): a token that expired
// only moments ago could still be honoured by a verifier with a small
// clock-skew allowance -- 5 minutes comfortably exceeds any ordinary
// PostgREST/Supabase Auth clock-skew tolerance, so a token failing this
// LOCAL prerequisite genuinely, unambiguously already expired before the
// hosted server is ever asked to reject it.
const JWT_EXPIRY_CLOCK_SKEW_SECONDS = 300;

function buildNonAuthoritativeRecoveryInvocation() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    p_key_id: randomUUID(),
    p_execution_id: randomUUID(),
    p_source_execution_id: randomUUID(),
    p_recovery_reason: "Acceptance JWT_POSTGREST role-gate boundary check",
    p_capability: "grade_controlled_assessment",
    p_target_kind: "ASSESSMENT_ATTEMPT",
    p_student_id: null,
    p_attempt_id: null,
    p_submission_id: null,
    p_enrolment_id: null,
    p_activation_id: null,
    p_operation: "AUTHORIZE",
    p_state: "AUTHORIZED",
    p_reason: "NONE",
    p_budget_stage: "NONE",
    p_max_calls: 1,
    p_max_output: 1200,
    p_max_cost: 50000,
    p_calls: 0,
    p_attempts: 0,
    p_input: 0,
    p_output: 0,
    p_cost: 0,
    p_elapsed: 0,
    p_grade_digest: null,
    p_issued_at: nowSeconds,
    p_expires_at: nowSeconds + 10,
    // 64 lowercase hex characters -- passes verify_command's own shape
    // check, but can never be a real signature; this harness never
    // computes one.
    p_mac: "0".repeat(64),
    p_assessment_marks: null,
    p_lab_marks_awarded: null,
  };
}

export async function checkJwtPostgrest() {
  if (!hostedSupabaseConfigured())
    return blocked(
      "JWT_POSTGREST",
      "Hosted Supabase is not configured (NEXT_PUBLIC_SUPABASE_*).",
    );
  if (!acceptanceDbConfigured())
    return blocked(
      "JWT_POSTGREST",
      "ACCEPTANCE_DATABASE_URL is not configured -- seeding the real course/enrolment this surface now proves cross-learner ownership and protected-content denial against requires it (via fixtures.mjs's seedAcceptanceCourse), even though the denials themselves are proven purely through PostgREST/RPC calls.",
    );
  if (!acceptanceIdentitiesConfigured())
    return blocked(
      "JWT_POSTGREST",
      "Acceptance identities are not configured.",
      [
        "Set ACCEPTANCE_ADMIN_EMAIL/PASSWORD and ACCEPTANCE_LEARNER_EMAIL/PASSWORD (real hosted Supabase Auth users).",
      ],
    );
  if (!foreignLearnerIdentityConfigured())
    return blocked(
      "JWT_POSTGREST",
      "A complete foreign-learner acceptance identity is required to prove cross-learner isolation.",
      [
        "Set BOTH ACCEPTANCE_FOREIGN_LEARNER_EMAIL and ACCEPTANCE_FOREIGN_LEARNER_PASSWORD -- a partial pair (only one configured) blocks this surface rather than silently skipping the isolation assertion.",
      ],
    );
  if (!unrelatedStaffIdentityConfigured())
    return blocked(
      "JWT_POSTGREST",
      "A complete unrelated-staff acceptance identity is required to prove that unrelated staff roles cannot cross the institutional recovery role gate.",
      [
        "Set BOTH ACCEPTANCE_UNRELATED_STAFF_EMAIL and ACCEPTANCE_UNRELATED_STAFF_PASSWORD -- a real hosted Supabase Auth user that is genuinely NOT ACADEMIC_ADMIN/PLATFORM_ADMIN (verified against the real hosted role model, never trusted by this variable's name alone).",
      ],
    );
  if (!isConfigured("ACCEPTANCE_EXPIRED_LEARNER_JWT"))
    return blocked(
      "JWT_POSTGREST",
      "ACCEPTANCE_EXPIRED_LEARNER_JWT is not configured -- a malformed token alone is not evidence that expiry enforcement itself works.",
      [
        "Set ACCEPTANCE_EXPIRED_LEARNER_JWT to a genuinely expired, previously valid synthetic acceptance-learner JWT issued by the real hosted Supabase Auth project. Never freshly generated or signed by this harness.",
      ],
    );
  if (
    !isStructurallyExpiredJwt(
      process.env.ACCEPTANCE_EXPIRED_LEARNER_JWT,
      JWT_EXPIRY_CLOCK_SKEW_SECONDS,
    )
  )
    return blocked(
      "JWT_POSTGREST",
      `ACCEPTANCE_EXPIRED_LEARNER_JWT is configured but its own exp claim is not confirmed to be comfortably (at least ${JWT_EXPIRY_CLOCK_SKEW_SECONDS}s) in the past, allowing for ordinary server clock-skew tolerance (or it is not structurally JWT-shaped) -- refusing to claim expired-token evidence from a token that may not actually, unambiguously be expired. This is only ever this harness's own LOCAL prerequisite check -- the real expired-JWT evidence is the hosted PostgREST server's own rejection, proven separately below.`,
      [
        `Supply a token whose decoded (never signature-verified) exp claim is a Unix timestamp at least ${JWT_EXPIRY_CLOCK_SKEW_SECONDS} seconds in the past.`,
      ],
    );

  const evidence = [];
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    // V3 correction (independent review, blocker 1): ANY error was
    // previously accepted as denial evidence -- a 404 schema-cache miss,
    // a 500/503 outage, or any other unrelated failure would all satisfy
    // that check too. Migration 2609140027 revokes function EXECUTE on
    // list_practical_enrolments from anon entirely, so a real hosted
    // anonymous call fails at the grant level with the documented
    // insufficient-privilege shape (HTTP 401 + SQLSTATE 42501) -- see
    // supabase.mjs's isAnonInsufficientPrivilegeRejection.
    const anon = anonClient();
    const { error: anonError, status: anonStatus } = await anon.rpc(
      "list_practical_enrolments",
    );
    if (!anonError)
      return fail(
        "JWT_POSTGREST",
        "Anonymous caller was NOT denied list_practical_enrolments.",
      );
    if (!isAnonInsufficientPrivilegeRejection(anonStatus, anonError))
      return fail(
        "JWT_POSTGREST",
        `Anonymous caller did NOT receive the documented insufficient-privilege denial for list_practical_enrolments (HTTP ${anonStatus}, code ${anonError.code ?? "none"}) -- an unrelated failure (schema-cache miss, outage) is never accepted as fail-closed evidence.`,
      );
    evidence.push(
      `anon denied list_practical_enrolments with the documented insufficient-privilege shape: HTTP ${anonStatus} 42501`,
    );

    // --- Invalid JWT (docs/38 section 3, gap 1) ---------------------------
    // V2 correction (independent review, blocker 1): a bare `ok:false`
    // never proves a JWT/auth rejection -- an unrelated 404 schema-cache
    // miss, a 500/503 outage or an unrelated 4xx would all satisfy that
    // check too. isJwtAuthRejection requires HTTP 401 AND a recognised
    // PostgREST JWT/auth error code (see supabase.mjs).
    const invalidJwtResult = await callProtectedRpcWithBearerToken(
      "list_practical_enrolments",
      "not-a-valid-jwt.definitely-malformed.value",
    );
    if (invalidJwtResult.networkError)
      return fail(
        "JWT_POSTGREST",
        "Invalid-JWT check hit a network error, not a denial -- a network failure is never evidence of fail-closed behaviour.",
        [invalidJwtResult.networkErrorMessage ?? "unknown network error"],
      );
    if (!isJwtAuthRejection(invalidJwtResult))
      return fail(
        "JWT_POSTGREST",
        `A deliberately malformed bearer JWT did NOT receive a recognised PostgREST JWT-authentication rejection (HTTP ${invalidJwtResult.status}, code ${invalidJwtResult.code ?? "none"}${invalidJwtResult.bodyParseError ? ", response body was not the expected JSON error envelope" : ""}) -- an unrelated failure (schema-cache miss, outage, unrelated 4xx) is never accepted as fail-closed JWT evidence.`,
      );
    evidence.push(
      `invalid JWT rejected with a recognised PostgREST JWT-authentication error: HTTP ${invalidJwtResult.status} ${invalidJwtResult.code}`,
    );

    // --- Expired JWT (docs/38 section 3, gap 2) ---------------------------
    // V2 correction (independent review, blocker 2): the structural
    // exp-in-the-past prerequisite (already enforced by the BLOCKED guard
    // above) only proves this harness supplied a token that CLAIMS to be
    // expired -- it does not establish the hosted server rejected it
    // BECAUSE it is expired, rather than for some other/generic reason. A
    // fake token with a bad signature and an old exp claim would get the
    // exact same generic "invalid JWT" rejection as the malformed-token
    // check above; isJwtExpiryRejection additionally requires the
    // server's own bounded message to specifically identify expiry.
    const expiredJwtResult = await callProtectedRpcWithBearerToken(
      "list_practical_enrolments",
      process.env.ACCEPTANCE_EXPIRED_LEARNER_JWT,
    );
    if (expiredJwtResult.networkError)
      return fail(
        "JWT_POSTGREST",
        "Expired-JWT check hit a network error, not a denial -- a network failure is never evidence of fail-closed behaviour.",
        [expiredJwtResult.networkErrorMessage ?? "unknown network error"],
      );
    if (!isJwtExpiryRejection(expiredJwtResult))
      return fail(
        "JWT_POSTGREST",
        `A genuinely (structurally) expired, previously valid bearer JWT did NOT receive a hosted PostgREST rejection that specifically identifies expiry (HTTP ${expiredJwtResult.status}, code ${expiredJwtResult.code ?? "none"}, message ${JSON.stringify(expiredJwtResult.message)}) -- a generic invalid-JWT rejection alone does not establish that expiry enforcement itself is what rejected this token.`,
      );
    evidence.push(
      `genuinely expired JWT specifically rejected as expired by hosted PostgREST: HTTP ${expiredJwtResult.status} ${expiredJwtResult.code} (${expiredJwtResult.message})`,
    );

    const learner = await acceptanceIdentities.learner();
    const admin = await acceptanceIdentities.admin();
    const foreign = await acceptanceIdentities.foreignLearner();
    const unrelatedStaff = await acceptanceIdentities.unrelatedStaff();

    // --- Unrelated staff must be genuinely non-admin (gap 4) --------------
    // Never trusted by the ACCEPTANCE_UNRELATED_STAFF_EMAIL variable's own
    // name -- verified against the real hosted role model.
    const staffVerification = await verifyNonAdminStaffRole(
      unrelatedStaff,
      "INSTRUCTOR",
    );
    if (!staffVerification.verified)
      return blocked("JWT_POSTGREST", staffVerification.reason);
    evidence.push(
      "unrelated-staff identity independently verified INSTRUCTOR and NOT ACADEMIC_ADMIN/PLATFORM_ADMIN: OK",
    );

    // --- Four genuinely distinct hosted Auth principals (gap 4b) --------
    // V3 correction (independent review, blocker 4): verifying the staff
    // identity's ROLE (above) is not the same as verifying it is a
    // genuinely DIFFERENT principal from admin/learner/foreign-learner.
    // A misconfigured operator could point ACCEPTANCE_UNRELATED_STAFF_*
    // at an account that is ALSO the acceptance learner (a multi-role
    // user who happens to carry INSTRUCTOR too) -- which would prove
    // nothing about an unrelated principal. Resolved via each identity's
    // own real hosted auth.getUser() -- never inferred by comparing the
    // configured email strings, which an operator could alias.
    const identityAuthUsers = await Promise.all(
      [
        ["admin", admin],
        ["learner", learner],
        ["foreign learner", foreign],
        ["unrelated staff", unrelatedStaff],
      ].map(async ([label, client]) => {
        const { data, error } = await client.auth.getUser();
        return { label, id: data?.user?.id ?? null, error };
      }),
    );
    for (const identity of identityAuthUsers) {
      if (identity.error || !identity.id)
        return fail(
          "JWT_POSTGREST",
          `Could not resolve the ${identity.label} identity's own hosted Supabase Auth user id.`,
          [identity.error?.message ?? "no user id returned"],
        );
    }
    for (let i = 0; i < identityAuthUsers.length; i++) {
      for (let j = i + 1; j < identityAuthUsers.length; j++) {
        if (identityAuthUsers[i].id === identityAuthUsers[j].id)
          return blocked(
            "JWT_POSTGREST",
            `The configured ${identityAuthUsers[i].label} and ${identityAuthUsers[j].label} acceptance identities resolve to the SAME hosted Supabase Auth user id -- these must be four genuinely distinct principals, never one identity reused as a stand-in for another, before any acceptance write.`,
          );
      }
    }
    evidence.push(
      "admin/learner/foreign-learner/unrelated-staff resolve to four pairwise-distinct hosted Auth user ids: OK",
    );
    const [, learnerUser, foreignUser] = identityAuthUsers;

    try {
      // Real course/activation/enrolment, built through the SAME governed
      // RPC pipeline RESULT_PROGRESS_COMPLETION already uses -- gives a
      // real, KNOWN enrolment id and a real, bound QUIZ_1 assessment id,
      // never an inferred/opaque one.
      const course = await seedAcceptanceCourse(admin, runId, learnerUser.id);
      const foreignEnrolment = await enrolAcceptanceLearner(
        admin,
        course.cohortId,
        foreignUser.id,
      );

      const { data: learnerOwnEnrolments, error: learnerListError } =
        await learner.rpc("list_practical_enrolments");
      if (learnerListError)
        return fail(
          "JWT_POSTGREST",
          "Authenticated learner was denied their own enrolment list.",
          [learnerListError.message],
        );
      if (
        !(learnerOwnEnrolments ?? []).some((e) => e.id === course.enrolmentId)
      )
        return fail(
          "JWT_POSTGREST",
          "The learner's own enrolment list did not include the real, known enrolment this run just seeded for them.",
        );
      evidence.push(
        "learner reads their own real, known, non-empty enrolment: OK",
      );

      // V3 correction (independent review, blocker 2): ANY error was
      // previously accepted as authorization evidence here too.
      // Migration 2609250042 grants EXECUTE on list_commercial_v1_
      // activations to `authenticated` (a learner DOES have the grant),
      // but the function itself calls migration 2609140027's
      // course_activation_private.require_admin(), which raises the
      // documented `errcode='42501'` exception for a non-admin caller --
      // require the exact HTTP 403 + SQLSTATE 42501 shape, never an
      // unrelated 400/404/429/500/503.
      const { error: learnerAdminError, status: learnerAdminStatus } =
        await learner.rpc("list_commercial_v1_activations");
      if (!learnerAdminError)
        return fail(
          "JWT_POSTGREST",
          "A learner was NOT denied the admin-only activation-discovery RPC.",
        );
      if (
        !isAuthenticatedInsufficientPrivilegeRejection(
          learnerAdminStatus,
          learnerAdminError,
        )
      )
        return fail(
          "JWT_POSTGREST",
          `A learner's admin-only activation-discovery RPC call did NOT receive the documented insufficient-privilege denial (HTTP ${learnerAdminStatus}, code ${learnerAdminError.code ?? "none"}) -- an unrelated failure is never accepted as authorization evidence.`,
        );
      evidence.push(
        `learner denied admin-only RPC with the documented insufficient-privilege shape: HTTP ${learnerAdminStatus} 42501`,
      );

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

      // --- Foreign-learner isolation, both directions -----------------
      const { data: foreignEnrolments, error: foreignListError } =
        await foreign.rpc("list_practical_enrolments");
      if (foreignListError)
        return fail(
          "JWT_POSTGREST",
          "Foreign-learner enrolment-list RPC failed -- isolation cannot be evaluated from an error.",
          [foreignListError.message],
        );
      const { data: learnerEnrolments, error: learnerRecheckError } =
        await learner.rpc("list_practical_enrolments");
      if (learnerRecheckError)
        return fail(
          "JWT_POSTGREST",
          "Primary learner's second enrolment-list RPC failed -- isolation cannot be evaluated from an error.",
          [learnerRecheckError.message],
        );
      if ((foreignEnrolments ?? []).some((e) => e.id === course.enrolmentId))
        return fail(
          "JWT_POSTGREST",
          "The foreign learner's own enrolment list included the primary learner's known enrolment.",
        );
      if (
        (learnerEnrolments ?? []).some(
          (e) => e.id === foreignEnrolment.enrolmentId,
        )
      )
        return fail(
          "JWT_POSTGREST",
          "The primary learner's own enrolment list included the foreign learner's known enrolment.",
        );
      evidence.push(
        "neither learner's enrolment list includes the other's known-owned enrolment (both directions): OK",
      );

      // --- Actor/student ownership cannot be overridden (gap 3) --------
      // get_commercial_v1_course_progress derives ownership from the JWT
      // identity, not a caller-supplied actor field -- a caller supplying
      // ANOTHER real, known learner's own enrolment id must receive
      // exactly the RPC's own documented denial code, never inferred from
      // an empty/absent result.
      const { data: foreignReadsPrimary, error: crossReadError1 } =
        await foreign.rpc("get_commercial_v1_course_progress", {
          p_enrolment_id: course.enrolmentId,
        });
      if (crossReadError1)
        return fail(
          "JWT_POSTGREST",
          "Cross-learner ownership-override RPC call failed outright -- denial cannot be evaluated from an error.",
          [crossReadError1.message],
        );
      if (foreignReadsPrimary?.code !== "NOT_FOUND_OR_FORBIDDEN")
        return fail(
          "JWT_POSTGREST",
          `A foreign learner supplying the primary learner's real enrolment id to get_commercial_v1_course_progress did NOT receive the documented NOT_FOUND_OR_FORBIDDEN denial (got: ${JSON.stringify(foreignReadsPrimary)}).`,
        );
      const { data: primaryReadsForeign, error: crossReadError2 } =
        await learner.rpc("get_commercial_v1_course_progress", {
          p_enrolment_id: foreignEnrolment.enrolmentId,
        });
      if (crossReadError2)
        return fail(
          "JWT_POSTGREST",
          "Reverse cross-learner ownership-override RPC call failed outright -- denial cannot be evaluated from an error.",
          [crossReadError2.message],
        );
      if (primaryReadsForeign?.code !== "NOT_FOUND_OR_FORBIDDEN")
        return fail(
          "JWT_POSTGREST",
          `The primary learner supplying the foreign learner's real enrolment id to get_commercial_v1_course_progress did NOT receive the documented NOT_FOUND_OR_FORBIDDEN denial (got: ${JSON.stringify(primaryReadsForeign)}).`,
        );
      evidence.push(
        "actor/student identity cannot be overridden by supplying another real, known learner's own enrolment id (both directions, get_commercial_v1_course_progress): OK",
      );

      // --- Protected assessment content (gap 7) -------------------------
      // V2 correction (independent review, blocker 3A): ANY Supabase
      // error (a 404 schema-cache miss, a 500/503 outage, a transient
      // network-level failure surfaced as an "error" by postgrest-js)
      // previously counted as denial evidence. Migration 2609090016
      // enables RLS AND revokes every privilege on assessment_answer_keys
      // from anon/authenticated (migration 2609160032 additionally
      // revokes from service_role) -- with literally no GRANT at all, a
      // real hosted read fails the privilege check itself, which Postgres
      // raises as SQLSTATE 42501 ("permission denied for table ..."),
      // which PostgREST maps to HTTP 403. Only that specific,
      // authenticated insufficient-privilege shape counts as evidence.
      const { error: answerKeyError, status: answerKeyStatus } = await learner
        .from("assessment_answer_keys")
        .select("*");
      if (!answerKeyError)
        return fail(
          "JWT_POSTGREST",
          "A learner's direct PostgREST read of assessment_answer_keys was NOT denied.",
        );
      if (!(answerKeyStatus === 403 && answerKeyError.code === "42501"))
        return fail(
          "JWT_POSTGREST",
          `A learner's direct PostgREST read of assessment_answer_keys did NOT receive the documented insufficient-privilege denial (HTTP ${answerKeyStatus}, code ${answerKeyError.code ?? "none"}) -- an unrelated failure (schema-cache miss, outage) is never accepted as protected-content evidence.`,
        );
      evidence.push(
        `learner direct PostgREST read of assessment_answer_keys denied with the documented insufficient-privilege shape: HTTP ${answerKeyStatus} 42501`,
      );

      // V2 correction (independent review, blocker 3B): an arbitrary RPC
      // error is not enough either -- migration 2609090016's
      // get_active_assessment_questions raises the plain (no explicit
      // errcode, hence SQLSTATE P0001) exception 'Protected assessment
      // content requires an active attempt' when the caller has no
      // ACTIVE, unexpired attempt on this exact assessment. Require that
      // specific, documented denial, not merely "some error".
      const { error: noAttemptError } = await learner.rpc(
        "get_active_assessment_questions",
        { p_assessment_id: course.quiz1AssessmentId },
      );
      if (!noAttemptError)
        return fail(
          "JWT_POSTGREST",
          "get_active_assessment_questions returned content to a learner with no active attempt -- protected assessment content must never release without one.",
        );
      if (
        noAttemptError.code !== "P0001" ||
        !/active attempt/i.test(noAttemptError.message ?? "")
      )
        return fail(
          "JWT_POSTGREST",
          `get_active_assessment_questions did NOT receive the documented "no active attempt" denial (code ${noAttemptError.code ?? "none"}: ${JSON.stringify(noAttemptError.message)}) -- an unrelated RPC error is never accepted as protected-content evidence.`,
        );
      evidence.push(
        "get_active_assessment_questions denies content release without an active attempt, with the documented P0001 'requires an active attempt' error: OK",
      );

      // V2 correction (independent review, blocker 3C): the above proves
      // only the DENIAL path. The seeded QUIZ_1 component is deliberately
      // in-window (see seedAcceptanceCourse), so this additionally
      // exercises the SUCCESSFUL learner-facing release: starts a real
      // attempt through the same governed, non-HMAC learner RPC a real
      // browser uses, confirms the release contains ONLY the documented
      // learner-safe projection (id, position, prompt, max_marks) and
      // never expected_answer/marking_guidance/any other field, then
      // ALWAYS terminalizes the attempt (submit_assessment_attempt) in a
      // finally block -- even on failure -- so this run never strands an
      // ACTIVE attempt blocking a future acceptance run. If
      // terminalization itself fails, that alone is enough to withhold
      // PASS.
      let startedAttemptId = null;
      let protectedProjectionFailure = null;
      try {
        const { data: attemptId, error: startError } = await learner.rpc(
          "start_assessment_attempt",
          { p_assessment_id: course.quiz1AssessmentId },
        );
        if (startError) {
          protectedProjectionFailure = fail(
            "JWT_POSTGREST",
            "Learner could not start the seeded, in-window QUIZ_1 attempt -- the successful learner-facing projection cannot be exercised.",
            [startError.message],
          );
        } else {
          startedAttemptId = attemptId;
          const { data: releasedQuestions, error: releaseError } =
            await learner.rpc("get_active_assessment_questions", {
              p_assessment_id: course.quiz1AssessmentId,
            });
          if (releaseError) {
            protectedProjectionFailure = fail(
              "JWT_POSTGREST",
              "A learner with a genuinely active, in-window attempt was denied get_active_assessment_questions.",
              [releaseError.message],
            );
          } else if (
            !Array.isArray(releasedQuestions) ||
            releasedQuestions.length === 0
          ) {
            protectedProjectionFailure = fail(
              "JWT_POSTGREST",
              "get_active_assessment_questions returned no questions for a genuinely active, in-window attempt.",
            );
          } else {
            const ALLOWED_QUESTION_FIELDS = new Set([
              "id",
              "position",
              "prompt",
              "max_marks",
            ]);
            const FORBIDDEN_QUESTION_FIELDS = [
              "expected_answer",
              "marking_guidance",
              "answer",
              "answer_key",
              "provider",
            ];
            for (const item of releasedQuestions) {
              const keys = Object.keys(item ?? {});
              const hasUnexpectedField = keys.some(
                (key) => !ALLOWED_QUESTION_FIELDS.has(key),
              );
              const hasForbiddenField = FORBIDDEN_QUESTION_FIELDS.some(
                (field) => field in (item ?? {}),
              );
              if (hasUnexpectedField || hasForbiddenField) {
                protectedProjectionFailure = fail(
                  "JWT_POSTGREST",
                  `get_active_assessment_questions returned a field outside the documented learner-safe projection (id, position, prompt, max_marks) for a genuinely active attempt (got keys: ${keys.join(",")}).`,
                );
                break;
              }
            }
          }
        }
      } finally {
        if (startedAttemptId) {
          const { error: submitError } = await learner.rpc(
            "submit_assessment_attempt",
            { p_attempt_id: startedAttemptId },
          );
          if (submitError) {
            const terminationMessage = `Attempt ${startedAttemptId} could not be terminalized via submit_assessment_attempt -- refusing to leave it ACTIVE, which would block future acceptance runs: ${submitError.message}`;
            if (protectedProjectionFailure) {
              protectedProjectionFailure.details = [
                ...(protectedProjectionFailure.details ?? []),
                terminationMessage,
              ];
            } else {
              protectedProjectionFailure = fail(
                "JWT_POSTGREST",
                "Could not terminalize the acceptance-started assessment attempt -- refusing to claim PASS while an ACTIVE attempt may remain.",
                [terminationMessage],
              );
            }
          }
        }
      }
      if (protectedProjectionFailure) return protectedProjectionFailure;
      evidence.push(
        "learner with a genuinely active, in-window attempt receives ONLY the documented learner-safe projection (id, position, prompt, max_marks) -- never expected_answer/marking_guidance -- and the started attempt was safely terminalized via submit_assessment_attempt: OK",
      );

      // --- Institutional recovery role gate (gaps 4, 5, 6) --------------
      // Migration 2609240040's own ordering, verified against actual
      // current source above buildNonAuthoritativeRecoveryInvocation:
      // UNAUTHENTICATED -> FORBIDDEN (role) -> UNTRUSTED_EXECUTION (HMAC).
      // No branch below ever mutates anything.
      const invocation = buildNonAuthoritativeRecoveryInvocation();
      const { data: learnerRecovery, error: learnerRecoveryError } =
        await learner.rpc("govern_commercial_v1_examiner_recovery", invocation);
      if (learnerRecoveryError)
        return fail(
          "JWT_POSTGREST",
          "Learner recovery role-gate RPC call failed outright -- denial cannot be evaluated from an error.",
          [learnerRecoveryError.message],
        );
      if (learnerRecovery?.code !== "FORBIDDEN")
        return fail(
          "JWT_POSTGREST",
          `A learner was NOT denied the institutional recovery role gate with the documented FORBIDDEN code (got: ${JSON.stringify(learnerRecovery)}).`,
        );
      evidence.push(
        "learner denied institutional recovery role gate (FORBIDDEN): OK",
      );

      const { data: staffRecovery, error: staffRecoveryError } =
        await unrelatedStaff.rpc(
          "govern_commercial_v1_examiner_recovery",
          invocation,
        );
      if (staffRecoveryError)
        return fail(
          "JWT_POSTGREST",
          "Unrelated-staff recovery role-gate RPC call failed outright -- denial cannot be evaluated from an error.",
          [staffRecoveryError.message],
        );
      if (staffRecovery?.code !== "FORBIDDEN")
        return fail(
          "JWT_POSTGREST",
          `An unrelated (verified non-admin) staff identity was NOT denied the institutional recovery role gate with the documented FORBIDDEN code (got: ${JSON.stringify(staffRecovery)}).`,
        );
      evidence.push(
        "verified non-admin unrelated staff denied institutional recovery role gate (FORBIDDEN): OK",
      );

      const { data: adminRecovery, error: adminRecoveryError } =
        await admin.rpc("govern_commercial_v1_examiner_recovery", invocation);
      if (adminRecoveryError)
        return fail(
          "JWT_POSTGREST",
          "Admin recovery role-gate RPC call failed outright.",
          [adminRecoveryError.message],
        );
      if (
        adminRecovery?.code === "FORBIDDEN" ||
        adminRecovery?.code === "UNAUTHENTICATED"
      )
        return fail(
          "JWT_POSTGREST",
          `An authorized ACADEMIC_ADMIN/PLATFORM_ADMIN was incorrectly denied at the role gate (got: ${JSON.stringify(adminRecovery)}) -- the role check itself appears broken.`,
        );
      if (adminRecovery?.code !== "UNTRUSTED_EXECUTION")
        return fail(
          "JWT_POSTGREST",
          `The authorized admin's deliberately non-authoritative recovery invocation did not reach the expected post-role HMAC boundary result (got: ${JSON.stringify(adminRecovery)}). This is NOT evidence of successful recovery either way -- see INITIAL_RECOVERY for that separate, still-BLOCKED-by-design surface.`,
        );
      evidence.push(
        "authorized admin reaches PAST the role gate to the HMAC boundary for a deliberately non-authoritative invocation (UNTRUSTED_EXECUTION) -- proves JWT/role authority ONLY, never successful recovery: OK",
      );

      return pass(
        "JWT_POSTGREST",
        "Full docs/38 section 3 hosted Auth/JWT/role/PostgREST acceptance: anon receives the documented insufficient-privilege denial (HTTP 401/42501) for list_practical_enrolments; a malformed JWT receives a recognised PostgREST JWT-authentication rejection (HTTP 401 + exactly PGRST301/PGRST303, never PGRST302's unrelated 'no Bearer header' shape); a genuinely (structurally, comfortably beyond clock-skew tolerance) expired JWT receives a PostgREST rejection that specifically identifies expiry; admin/learner/foreign-learner/unrelated-staff resolve to four pairwise-distinct hosted Auth identities; learner reads their own real enrolment; learner receives the documented insufficient-privilege denial (HTTP 403/42501) for the admin-only RPC; admin permitted; both learners' enrolment lists mutually exclude each other's known-owned enrolment; actor/student ownership cannot be overridden via another real learner's own enrolment id; a learner's direct read of assessment_answer_keys receives the documented insufficient-privilege (HTTP 403/42501) denial; get_active_assessment_questions denies release without an active attempt with the documented P0001 error AND, for a genuinely active, in-window attempt, releases ONLY the documented learner-safe projection (id, position, prompt, max_marks) before the attempt is safely terminalized; the institutional recovery role gate denies the learner and a verified, genuinely distinct non-admin unrelated-staff identity (FORBIDDEN) while the authorized admin reaches the post-role HMAC boundary (UNTRUSTED_EXECUTION) for a deliberately non-authoritative invocation. This is NOT proof of successful HMAC-attested recovery -- that remains INITIAL_RECOVERY's own, separate, still-BLOCKED-by-design surface (this harness never reimplements the Examiner HMAC signing protocol).",
        evidence,
      );
    } finally {
      await cleanupAcceptanceRun(runId).catch(() => {});
    }
  } catch (error) {
    if (error instanceof AcceptanceWriteNotAuthorizedError)
      return blocked("JWT_POSTGREST", error.message, [
        "See scripts/acceptance/db.mjs's acceptanceMarkerProvisioningSql() for how to designate a database as a disposable acceptance environment.",
      ]);
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
    await seedAcceptanceResults(course, true);

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
        "See scripts/acceptance/db.mjs's acceptanceMarkerProvisioningSql() for how to designate a database as a disposable acceptance environment.",
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
