#!/usr/bin/env node
// AC-3 (migration 202610050052) true-PostgreSQL concurrency acceptance:
//
//   POSTGRES_CONCURRENCY:AC3_PROFESSOR_HANDOFF_DUPLICATE
//
// Separate from, and never evidence for, the Commercial V1 scenarios in
// concurrency.mjs. It races TWO calls to the real governed
// public.request_professor_academic_handoff(...) for the SAME authenticated
// acceptance learner, Professor classroom, reason (OBJECTIVE_REINFORCEMENT)
// and objective, from TWO genuinely independent PostgreSQL connections
// (db.mjs's connectMany(2)) whose distinct pg_backend_pid() values are part
// of the PASS evidence. Both contenders are released from ONE in-process
// start gate (createStartGate) only after both connections are fully
// prepared. This proves both requests were dispatched together from the
// client side, never that the server began executing them at the same
// instant.
//
// PASS requires exactly the property AC-3's classroom FOR UPDATE lock plus
// uniqueness/idempotency design is meant to guarantee: one result
// {ok:true,duplicate:false}, the other {ok:true,duplicate:true}, the SAME
// handoffId, exactly ONE professor_academic_handoffs row for the
// classroom/reason/scope with the correct destination/reason/scope/source,
// and exactly ONE matching delivery_handoffs row with that same id.
//
// AUTHENTICATION -- no service-role shortcut, no bypass of the RPC boundary.
// Each connection independently, inside its own transaction:
//   1. sets Supabase's standard request-JWT GUCs LOCALLY (request.jwt.claims
//      with sub/role/aud, plus the legacy request.jwt.claim.sub/role), which
//      hosted auth.uid() reads;
//   2. SET LOCAL ROLE authenticated -- the exact database role PostgREST
//      uses for a signed-in learner, so the RPC runs under authenticated's
//      own EXECUTE grants and the function's own SECURITY DEFINER boundary;
//   3. verifies current_user = 'authenticated' and current_app_user() equals
//      the acceptance learner's app_users id resolved from their real
//      hosted Supabase Auth identity (never hardcoded).
// If the acceptance database role is not a member of `authenticated`, the
// role switch is refused, or the identity does not resolve to that learner,
// the scenario is BLOCKED with the precise reason, never run with a
// privileged direct call instead.
// SCOPE OF THIS EVIDENCE: setting the request-JWT GUCs and SET LOCAL ROLE
// authenticated reproduces the database-side authenticated-role semantics
// for the real acceptance learner subject; it does NOT prove Supabase JWT
// signature/expiry validation or PostgREST token enforcement, which remain
// separate acceptance evidence (JWT_POSTGREST, currently BLOCKED).
//
// FIXTURE -- labelled fixture setup, not evidence:
//   * The post-052 course/cohort/enrolment comes from fixtures.mjs's
//     seedAcceptanceCourse (the same governed RPC pipeline the other
//     acceptance scenarios use), so its Tutor binding is frozen at
//     publication by migration 051/052's own trigger; the scenario verifies
//     it is TUTOR_BEHAVIOUR_V2 and BLOCKs otherwise.
//   * The class session is created by the governed create_class_session
//     RPC (acceptance admin), and the classroom by the learner's own
//     governed open_professor_classroom RPC.
//   * The SUCCEEDED Professor execution, its two COMPLETED content releases,
//     its AC-2 provenance row and context-release manifest are SEEDED
//     DIRECTLY (one gated transaction), because producing them through the
//     attested V2 protocol needs the controller HMAC key, which this
//     scenario does not test. This is NOT evidence that any Professor HMAC
//     execution was accepted. Every value the database can derive (runtime
//     profile ref, institutional baseline, effective behaviour, fingerprint)
//     is derived by the database's own AC-2 functions in the same INSERT,
//     and every row satisfies the tables' real FK/CHECK constraints. Note
//     that the tables' own AFTER INSERT audit triggers record these rows
//     with their fixed source labels; they remain identifiable through
//     this run's unique cohort/class session (operator review).
//
// WRITE SAFETY: Supabase fixture writes pass
// assertAcceptanceSupabaseWriteAuthorized; the direct seed uses
// withAcceptanceWriteConnection; both race connections pass
// assertAllAcceptanceDatabaseWriteAuthorized before any statement. No
// TRUNCATE, DROP or DELETE. Nothing is deleted afterwards: every row is
// immutable institutional history by design.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  connectMany,
  withConnection,
  withAcceptanceWriteConnection,
  acceptanceDbConfigured,
  assertAllAcceptanceDatabaseWriteAuthorized,
  AcceptanceWriteNotAuthorizedError,
} from "./db.mjs";
import {
  hostedSupabaseConfigured,
  acceptanceIdentities,
  acceptanceIdentitiesConfigured,
  assertAcceptanceSupabaseWriteAuthorized,
} from "./supabase.mjs";
import { seedAcceptanceCourse } from "./fixtures.mjs";
import {
  pass,
  fail,
  blocked,
  printResult,
  printSummary,
  exitCodeFor,
} from "./report.mjs";
import { createStartGate } from "./concurrency-app-races.mjs";

export const AC3_SURFACE =
  "POSTGRES_CONCURRENCY:AC3_PROFESSOR_HANDOFF_DUPLICATE";
const REASON = "OBJECTIVE_REINFORCEMENT";
const EVIDENCE_LABEL =
  "AC-3 (migration 052) acceptance, separate from the Commercial V1 scenarios";

/** The authenticated learner context could not be established: BLOCKED. */
export class Ac3ContextUnavailable extends Error {
  constructor(reason) {
    super(reason);
    this.name = "Ac3ContextUnavailable";
  }
}

const isUuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const message = (error) =>
  error instanceof Error ? error.message : String(error);

/**
 * Opens a transaction on `client` and establishes the acceptance learner's
 * authenticated context in it (see the module header). Returns this
 * connection's backend pid. Throws Ac3ContextUnavailable (BLOCKED) when the
 * context cannot be established; any other error propagates (FAIL).
 */
export async function prepareAuthenticatedLearner(
  client,
  { learnerAuthUserId, studentId },
) {
  const { rows: probe } = await client.query(
    "select pg_backend_pid() as pid, pg_has_role(current_user, 'authenticated', 'MEMBER') as member",
  );
  if (probe[0]?.member !== true)
    throw new Ac3ContextUnavailable(
      "The acceptance database role is not a member of `authenticated`, so it cannot SET ROLE authenticated to call the RPC as the learner. Refusing to substitute a privileged direct call.",
    );
  await client.query("begin");
  try {
    const claims = JSON.stringify({
      sub: learnerAuthUserId,
      role: "authenticated",
      aud: "authenticated",
    });
    await client.query(
      "select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)",
      [claims, learnerAuthUserId],
    );
    // Firewall pre-check (read-only), as the acceptance role: authenticated
    // has no EXECUTE on this helper; it reads only auth.uid(). If the
    // acceptance role cannot call it either, the pre-check is skipped (in a
    // savepoint, so the transaction stays usable) and the RPC's own
    // ACTIVITY_BLOCKED refusal is classified as BLOCKED instead.
    await client.query("savepoint ac3_firewall_check");
    let allowed = null;
    try {
      const { rows: firewall } = await client.query(
        "select public.academic_content_release_explain_allowed() as allowed",
      );
      allowed = firewall[0]?.allowed;
      await client.query("release savepoint ac3_firewall_check");
    } catch {
      await client.query("rollback to savepoint ac3_firewall_check");
    }
    if (allowed === false)
      throw new Ac3ContextUnavailable(
        "The acceptance learner currently has an active controlled assessment (explanation firewall closed); the handoff RPC would refuse with ACTIVITY_BLOCKED.",
      );
    try {
      await client.query("set local role authenticated");
    } catch (error) {
      throw new Ac3ContextUnavailable(
        `SET LOCAL ROLE authenticated was refused: ${message(error)}`,
      );
    }
    const { rows: who } = await client.query(
      "select current_user::text as role, public.current_app_user() as app_user",
    );
    if (who[0]?.role !== "authenticated")
      throw new Ac3ContextUnavailable(
        "The connection is not running as `authenticated` after SET LOCAL ROLE.",
      );
    if (who[0]?.app_user !== studentId)
      throw new Ac3ContextUnavailable(
        "current_app_user() did not resolve to the acceptance learner's app_users id from the request-JWT context.",
      );
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
  return probe[0].pid;
}

async function contend(client, gate, fixture) {
  await gate.arrive();
  return callHandoffRpcAndCommit(client, fixture);
}

/**
 * The governed RPC call on a connection already prepared by
 * prepareAuthenticatedLearner (inside its transaction), then COMMIT, which
 * releases the classroom lock. On any error the transaction is rolled back.
 */
export async function callHandoffRpcAndCommit(client, fixture) {
  try {
    const { rows } = await client.query(
      "select public.request_professor_academic_handoff($1, $2, $3, null) as v",
      [fixture.classSessionId, REASON, fixture.objectiveId],
    );
    await client.query("commit");
    return rows[0]?.v;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/**
 * Pure verdict. `settled` are the two contenders' Promise.allSettled
 * results; `verification` the post-race reads.
 */
export function classifyAc3Race({ pids, settled, verification, fixture }) {
  const failure = (reason, details = []) => ({
    status: "FAIL",
    reason,
    details,
  });
  if (pids.length !== 2 || new Set(pids).size !== 2)
    return failure(
      `The two contenders did not run on two distinct backend processes (pg_backend_pid ${pids.join(", ")}).`,
    );
  const rejected = settled.filter((s) => s.status === "rejected");
  if (rejected.length)
    return failure(
      "A contender's RPC call failed with a database or network error.",
      rejected.map((s) => message(s.reason)),
    );
  const results = settled.map((s) => s.value);
  if (
    results.every((r) => r && r.ok === false && r.code === "ACTIVITY_BLOCKED")
  )
    return {
      status: "BLOCKED",
      reason:
        "Both requests were refused by the controlled-assessment firewall (ACTIVITY_BLOCKED); the race could not be exercised.",
      details: [],
    };
  const shapeOk = results.every(
    (r) =>
      r &&
      typeof r === "object" &&
      r.ok === true &&
      typeof r.duplicate === "boolean" &&
      isUuid(r.handoffId),
  );
  if (!shapeOk)
    return failure(
      "Unexpected RPC result: both contenders must return ok=true with a boolean duplicate and a handoffId.",
      results.map((r) => JSON.stringify(r)),
    );
  const fresh = results.filter((r) => r.duplicate === false).length;
  const dupes = results.filter((r) => r.duplicate === true).length;
  if (fresh !== 1 || dupes !== 1)
    return failure(
      `Expected exactly one duplicate=false and one duplicate=true; got ${fresh} and ${dupes}.`,
      results.map((r) => JSON.stringify(r)),
    );
  const handoffId = results[0].handoffId;
  if (results[1].handoffId !== handoffId)
    return failure(
      "The two contenders returned different handoffIds.",
      results.map((r) => r.handoffId),
    );
  const projection = verification?.projectionRows ?? [];
  const delivery = verification?.deliveryRows ?? [];
  if (projection.length !== 1)
    return failure(
      `Expected exactly one professor_academic_handoffs row for the classroom/reason/scope; found ${projection.length}.`,
    );
  if (delivery.length !== 1)
    return failure(
      `Expected exactly one matching delivery_handoffs row; found ${delivery.length}.`,
    );
  const [p] = projection;
  const [d] = delivery;
  const scope = `OBJECTIVE:${fixture.objectiveId}`;
  if (
    p.handoff_id !== handoffId ||
    p.destination_role !== "TUTOR" ||
    p.reason_code !== REASON ||
    p.scope_key !== scope ||
    p.objective_id !== fixture.objectiveId ||
    p.source_professor_execution_id !== fixture.sourceExecutionId
  )
    return failure(
      "The single professor_academic_handoffs row does not carry the expected handoff/destination/reason/scope/source.",
      [JSON.stringify(p)],
    );
  if (
    d.id !== handoffId ||
    d.destination_profile !== "TUTOR" ||
    d.reason_code !== REASON ||
    d.objective_id !== fixture.objectiveId
  )
    return failure(
      "The single delivery_handoffs row does not match the projection.",
      [JSON.stringify(d)],
    );
  return {
    status: "PASS",
    reason: `${EVIDENCE_LABEL}: two genuinely independent PostgreSQL connections (pg_backend_pid ${pids[0]} and ${pids[1]}), each authenticated as the same learner via request-JWT GUCs and SET LOCAL ROLE authenticated, were released from one start gate and raced public.request_professor_academic_handoff for the same classroom/reason/objective. Exactly one created (duplicate=false), the other replayed it (duplicate=true) with the same handoffId; exactly one projection row and one delivery handoff exist. Fixture execution/provenance rows were seeded directly (not evidence of Professor HMAC acceptance).`,
    details: [`handoffId ${handoffId}`, `run ${fixture.runId}`],
  };
}

/**
 * The race itself, with injectable dependencies for behavioural tests.
 * Throws AcceptanceWriteNotAuthorizedError / Ac3ContextUnavailable for the
 * caller to map to BLOCKED.
 */
export async function runAc3HandoffRace(fixture, deps = {}) {
  const open = deps.connectMany ?? connectMany;
  const gateAll =
    deps.assertAllWriteAuthorized ?? assertAllAcceptanceDatabaseWriteAuthorized;
  const verify = deps.readVerification ?? readAc3Verification;
  const makeGate = deps.createStartGate ?? createStartGate;
  const { clients, closeAll } = await open(2);
  try {
    if (clients.length !== 2)
      throw new Error("connectMany(2) did not return two connections.");
    await gateAll(clients);
    // Both connections are fully prepared before either can pass the gate.
    const pids = await Promise.all(
      clients.map((client) => prepareAuthenticatedLearner(client, fixture)),
    );
    // The database clock just before release: only delivery handoffs
    // created from here on are attributed to this race.
    const { rows: clock } = await clients[0].query(
      "select clock_timestamp() as t",
    );
    const raceStartedAt = clock[0]?.t;
    if (!raceStartedAt)
      throw new Error("Could not read the database clock before the race.");
    const gate = makeGate(2);
    const settled = await Promise.allSettled(
      clients.map((client) => contend(client, gate, fixture)),
    );
    const verification = await verify(fixture, raceStartedAt);
    return classifyAc3Race({ pids, settled, verification, fixture });
  } finally {
    await closeAll();
  }
}

/** Read-only post-race verification on a fresh connection. */
export async function readAc3Verification(fixture, raceStartedAt) {
  return withConnection((client) =>
    queryAc3Verification(client, fixture, raceStartedAt),
  );
}

/** The verification reads themselves (read-only), on a given client. */
export async function queryAc3Verification(client, fixture, raceStartedAt) {
  const { rows: projectionRows } = await client.query(
    `select handoff_id, destination_role, reason_code, scope_key, objective_id,
            source_professor_execution_id
     from public.professor_academic_handoffs
     where classroom_id=$1 and reason_code=$2 and scope_key=$3`,
    [fixture.classroomId, REASON, `OBJECTIVE:${fixture.objectiveId}`],
  );
  const { rows: deliveryRows } = await client.query(
    `select id, destination_profile, reason_code, objective_id
     from public.delivery_handoffs
     where enrolment_id=$1 and lesson_id=$2 and objective_id=$3 and reason_code=$4
       and created_at >= $5`,
    [
      fixture.enrolmentId,
      fixture.lessonId,
      fixture.objectiveId,
      REASON,
      raceStartedAt,
    ],
  );
  return { projectionRows, deliveryRows };
}

/**
 * Fixture (see the module header). Returns everything the race and the
 * verification need. Throws Ac3ContextUnavailable (BLOCKED) when a
 * precondition of this environment is not met.
 */
export async function seedAc3Fixture(runId) {
  const admin = await acceptanceIdentities.admin();
  const learner = await acceptanceIdentities.learner();
  await assertAcceptanceSupabaseWriteAuthorized(learner);
  const { data: learnerUser, error: learnerUserError } =
    await learner.auth.getUser();
  if (learnerUserError || !isUuid(learnerUser?.user?.id))
    throw new Ac3ContextUnavailable(
      "Could not resolve the acceptance learner's own hosted Supabase Auth user id.",
    );
  const learnerAuthUserId = learnerUser.user.id;
  const course = await seedAcceptanceCourse(admin, runId, learnerAuthUserId);

  const scope = await withConnection(async (client) => {
    const { rows } = await client.query(
      `select l.id as lesson_id, o.id as objective_id,
              (select count(*)::int from public.lesson_objectives x
                where x.lesson_id=l.id and x.programme_version_id=l.programme_version_id) as objective_count,
              (select b.behaviour_version from public.academic_agent_behaviour_bindings b
                where b.programme_version_id=l.programme_version_id and b.role='TUTOR') as tutor_version
       from public.lessons l
       join public.lesson_objectives o on o.lesson_id=l.id and o.programme_version_id=l.programme_version_id
       where l.programme_version_id=$1
       order by l.position, o.position limit 1`,
      [course.programmeVersionId],
    );
    return rows[0] ?? null;
  });
  if (!scope)
    throw new Error("The acceptance programme has no lesson objective.");
  if (scope.tutor_version !== "TUTOR_BEHAVIOUR_V2")
    throw new Ac3ContextUnavailable(
      `The acceptance programme version's frozen Tutor binding is ${scope.tutor_version ?? "missing"}, not TUTOR_BEHAVIOUR_V2 -- migration 052 is not in effect for it.`,
    );
  if (scope.objective_count > 50)
    throw new Error("The acceptance lesson has more than 50 objectives.");

  // A unique, already-ended five-minute window (catch-up classroom), so the
  // instructor's other acceptance sessions are not overlapped.
  const offsetMinutes = 24 * 60 + Math.floor(Math.random() * 300 * 24 * 60);
  const start = new Date(Date.now() - offsetMinutes * 60_000);
  const { data: classSessionId, error: sessionError } = await admin.rpc(
    "create_class_session",
    {
      p_cohort_id: course.cohortId,
      p_lesson_id: scope.lesson_id,
      p_instructor_id: course.instructorId,
      p_scheduled_start: start.toISOString(),
      p_scheduled_end: new Date(start.getTime() + 5 * 60_000).toISOString(),
      p_reason: `AC-3 acceptance class session ${runId}`,
    },
  );
  if (sessionError || !isUuid(classSessionId))
    throw new Error(
      `create_class_session failed: ${sessionError?.message ?? "no id"}`,
    );
  const { data: opened, error: openError } = await learner.rpc(
    "open_professor_classroom",
    { p_class_session_id: classSessionId },
  );
  if (openError || opened?.ok !== true)
    throw new Error(
      `open_professor_classroom failed: ${openError?.message ?? JSON.stringify(opened)}`,
    );

  const seeded = await withAcceptanceWriteConnection((client) =>
    seedProfessorExecutionFixture(client, {
      studentId: course.studentId,
      classSessionId,
    }),
  );

  return {
    runId,
    learnerAuthUserId,
    studentId: course.studentId,
    enrolmentId: course.enrolmentId,
    programmeVersionId: course.programmeVersionId,
    classSessionId,
    classroomId: seeded.classroomId,
    lessonId: scope.lesson_id,
    objectiveId: scope.objective_id,
    sourceExecutionId: seeded.executionId,
  };
}

/**
 * FIXTURE ONLY (see the module header): seeds, in one transaction on an
 * already write-gated `client`, the SUCCEEDED Professor execution, its two
 * COMPLETED PROFESSOR_READ_V2 releases, its AC-2 provenance row (every
 * derivable value derived by the database's own AC-2 functions) and its
 * context-release manifest for the learner's existing classroom. Not
 * evidence that any Professor HMAC execution was accepted.
 */
export async function seedProfessorExecutionFixture(
  client,
  { studentId, classSessionId },
) {
  await client.query("begin");
  try {
    const { rows: classroomRows } = await client.query(
      "select id from public.professor_classroom_sessions where student_id=$1 and class_session_id=$2",
      [studentId, classSessionId],
    );
    const classroomId = classroomRows[0]?.id;
    if (!classroomId) throw new Error("The classroom was not created.");
    const contextRelease = randomUUID();
    const objectivesRelease = randomUUID();
    const contextInvocation = randomUUID();
    const executionId = randomUUID();
    // FIXTURE: two COMPLETED PROFESSOR_READ_V2 releases on one timeline.
    await client.query(
      `with stamp as (select clock_timestamp() as t)
       insert into public.academic_content_releases(
         id, student_id, invocation_id, capability_name, capability_contract_version,
         state, started_at, expires_at, terminal_at)
       select $1::uuid, $3::uuid, $4::uuid, 'get_lesson_context', 'PROFESSOR_READ_V2', 'COMPLETED',
              t - interval '60 seconds', t - interval '30 seconds', t - interval '40 seconds' from stamp
       union all
       select $2::uuid, $3::uuid, $5::uuid, 'get_lesson_objectives', 'PROFESSOR_READ_V2', 'COMPLETED',
              t - interval '59 seconds', t - interval '29 seconds', t - interval '41 seconds' from stamp`,
      [
        contextRelease,
        objectivesRelease,
        studentId,
        contextInvocation,
        randomUUID(),
      ],
    );
    // FIXTURE: the SUCCEEDED V2 execution of the outer release.
    await client.query(
      `with stamp as (select clock_timestamp() as t)
       insert into public.academic_provider_executions(
         id, student_id, release_id, invocation_id, state, reason_code,
         created_at, authorized_at, started_at, terminal_at, expires_at,
         max_provider_calls, max_output_tokens, max_estimated_cost_microusd)
       select $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', 'PROVIDER_COMPLETE',
              t - interval '58 seconds', t - interval '58 seconds', t - interval '57 seconds',
              t - interval '56 seconds', t - interval '38 seconds', 1, 1200, 50000
       from stamp`,
      [executionId, studentId, contextRelease, contextInvocation],
    );
    // FIXTURE: AC-2 provenance, every derivable value derived by the
    // database's own AC-2 functions.
    await client.query(
      `insert into public.academic_agent_execution_provenance(
         execution_kind, professor_execution_id, student_id, role, programme_version_id,
         enrolment_id, classroom_id, runtime_profile_ref, institutional_baseline_version,
         behaviour_version, behaviour_config_source, behaviour_config_version,
         behaviour_config_id, behaviour_fingerprint)
       select 'PROFESSOR_PROVIDER_V2', $1::uuid, c.student_id, 'PROFESSOR', c.programme_version_id,
              c.enrolment_id, c.id,
              agent_behaviour_private.runtime_profile_ref(c.programme_version_id, 'PROFESSOR'),
              agent_behaviour_private.institutional_baseline_version(),
              eff.behaviour_version, eff.source, eff.config_version, eff.config_id,
              agent_behaviour_private.behaviour_fingerprint(c.programme_version_id)
       from public.professor_classroom_sessions c
       cross join lateral agent_behaviour_private.effective_config(c.programme_version_id, 'PROFESSOR') eff
       where c.id = $2::uuid and eff.ok`,
      [executionId, classroomId],
    );
    await client.query(
      `insert into public.academic_agent_execution_context_releases(
         professor_execution_id, release_id, capability_name, position)
       values ($1::uuid, $2::uuid, 'get_lesson_context', 1), ($1::uuid, $3::uuid, 'get_lesson_objectives', 2)`,
      [executionId, contextRelease, objectivesRelease],
    );
    await client.query("commit");
    return { classroomId, executionId };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/** Maps a race verdict or a thrown error to a report entry. */
export function ac3ReportFor(outcome) {
  if (outcome instanceof AcceptanceWriteNotAuthorizedError)
    return blocked(AC3_SURFACE, outcome.message, [
      "See scripts/acceptance/db.mjs's acceptanceMarkerProvisioningSql().",
    ]);
  if (outcome instanceof Ac3ContextUnavailable)
    return blocked(AC3_SURFACE, outcome.message);
  if (outcome instanceof Error)
    return fail(AC3_SURFACE, "The AC-3 scenario failed unexpectedly.", [
      outcome.message,
    ]);
  if (outcome.status === "PASS")
    return pass(AC3_SURFACE, outcome.reason, outcome.details);
  if (outcome.status === "BLOCKED")
    return blocked(AC3_SURFACE, outcome.reason, outcome.details);
  return fail(AC3_SURFACE, outcome.reason, outcome.details);
}

/** Fixture plus race; never throws (BLOCKED/FAIL are report entries). */
export async function scenarioAc3ProfessorHandoffDuplicate(runId, deps = {}) {
  const seed = deps.seedFixture ?? seedAc3Fixture;
  try {
    const fixture = await seed(runId);
    return ac3ReportFor(await runAc3HandoffRace(fixture, deps));
  } catch (error) {
    return ac3ReportFor(
      error instanceof Error ? error : new Error(message(error)),
    );
  }
}

/** Environment preconditions; returns a BLOCKED entry or null. */
export function ac3Preconditions() {
  if (!acceptanceDbConfigured())
    return blocked(AC3_SURFACE, "ACCEPTANCE_DATABASE_URL is not configured.");
  if (!hostedSupabaseConfigured() || !acceptanceIdentitiesConfigured())
    return blocked(
      AC3_SURFACE,
      "Hosted Supabase and/or acceptance identities are not configured (NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, ACCEPTANCE_ADMIN_EMAIL/PASSWORD, ACCEPTANCE_LEARNER_EMAIL/PASSWORD).",
    );
  return null;
}

async function main() {
  const runId = `ac3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log("===== AC-3 true PostgreSQL concurrency acceptance =====");
  console.log(`Acceptance run: ${runId}`);
  const result =
    ac3Preconditions() ?? (await scenarioAc3ProfessorHandoffDuplicate(runId));
  printResult(result);
  printSummary([result], "AC-3 true-PostgreSQL-concurrency acceptance");
  process.exit(exitCodeFor([result]));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
