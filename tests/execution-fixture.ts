import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import type { CapabilityDbState } from "./capability-db-client";

export const learner = "10000000-0000-4000-8000-000000000001";
export const administrator = "10000000-0000-4000-8000-000000000002";
export const foreignLearner = "10000000-0000-4000-8000-000000000003";
export const enrolledLesson = "40000000-0000-4000-8000-000000000001";
export const learnerAuth = (n: number) =>
  `83000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export type ExecutionFixture = Awaited<ReturnType<typeof executionFixture>>;
export async function executionFixture() {
  const db = await testDatabase();
  const keyId = randomUUID(),
    key = randomBytes(32);
  await db.exec("alter table auth.users disable trigger academy_identity");
  for (const [n, id] of [
    [1, learner],
    [2, administrator],
    [3, foreignLearner],
  ] as const) {
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      [learnerAuth(n), `execution${n}@test.example`],
    );
    await db.query(
      "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
      [learnerAuth(n), id],
    );
  }
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR')",
    [administrator],
  );
  // Exercise the actual private provisioning operation with bound ephemeral key
  // bytes. No fixed secret, real deployment secret, or secret output is involved.
  await db.query(
    "select academic_execution_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
  const enrolmentId = (
    await db.query<{ id: string }>(
      "select id from public.enrolments where student_id=$1",
      [learner],
    )
  ).rows[0].id;
  await asExecutionUser(db, 2);
  const assessmentId = (
    await db.query<{ id: string }>(
      "select public.create_assessment($1,$2,$3,'B1 fixture','Controlled instructions',now()-interval '1 hour',now()+interval '1 hour',30,5,'Trusted execution fixture') as id",
      ["50000000-0000-4000-8000-000000000001", enrolledLesson, administrator],
    )
  ).rows[0].id;
  await db.query(
    "select public.add_assessment_question($1,1,'Protected prompt sentinel',10,'Answer key sentinel','Marking guidance sentinel','Execution fixture question')",
    [assessmentId],
  );
  await db.query(
    "select public.change_assessment_status($1,'PUBLISHED','Execution fixture ready')",
    [assessmentId],
  );
  return { db, keyId, key, enrolmentId, assessmentId };
}
export async function asExecutionUser(
  db: PGlite,
  n: number | null,
  state?: CapabilityDbState,
) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    n ? learnerAuth(n) : "",
  ]);
  await db.exec("set role authenticated");
  if (state)
    state.authUser = n
      ? { id: learnerAuth(n), email_confirmed_at: "2026-09-01T00:00:00Z" }
      : null;
}
export async function openExecutionRelease(db: PGlite) {
  const invocationId = randomUUID();
  return (
    await db.query<{
      value: {
        ok: true;
        release_id: string;
        student_id: string;
        invocation_id: string;
      };
    }>(
      "select public.begin_academic_content_release($1,'get_lesson_context','PROFESSOR_READ_V2') as value",
      [invocationId],
    )
  ).rows[0].value;
}
export function signedExecutionCommand(
  fixture: ExecutionFixture,
  overrides: Partial<{
    executionId: string;
    releaseId: string;
    actor: string;
    operation: string;
    state: string;
    reason: string;
    calls: number;
    input: number;
    output: number;
    cost: number;
    issuedAt: number;
    expiresAt: number;
    keyId: string;
  }> = {},
) {
  const command = {
    executionId: randomUUID(),
    releaseId: randomUUID(),
    actor: learner,
    operation: "AUTHORIZE",
    state: "AUTHORIZED",
    reason: "NONE",
    calls: 0,
    input: 0,
    output: 0,
    cost: 0,
    issuedAt: Math.floor(Date.now() / 1000),
    keyId: fixture.keyId,
    ...overrides,
  };
  const expiresAt = overrides.expiresAt ?? command.issuedAt + 10;
  const canonical = [
    "DUCELIO_EXECUTION_HMAC_SHA256_V1",
    "PROFESSOR_EXECUTION_V1",
    "PROFESSOR",
    command.keyId,
    command.actor,
    command.executionId,
    command.releaseId,
    command.operation,
    command.state,
    command.reason,
    command.calls,
    command.input,
    command.output,
    command.cost,
    command.issuedAt,
    expiresAt,
  ].join("\n");
  return {
    p_key_id: command.keyId,
    p_execution_id: command.executionId,
    p_release_id: command.releaseId,
    p_operation: command.operation,
    p_state: command.state,
    p_reason: command.reason,
    p_calls: command.calls,
    p_input: command.input,
    p_output: command.output,
    p_cost: command.cost,
    p_issued_at: command.issuedAt,
    p_expires_at: expiresAt,
    p_mac: createHmac("sha256", fixture.key).update(canonical).digest("hex"),
  };
}
export const executionArgNames = [
  "p_key_id",
  "p_execution_id",
  "p_release_id",
  "p_operation",
  "p_state",
  "p_reason",
  "p_calls",
  "p_input",
  "p_output",
  "p_cost",
  "p_issued_at",
  "p_expires_at",
  "p_mac",
] as const;
export async function sendExecutionCommand(
  db: PGlite,
  args: ReturnType<typeof signedExecutionCommand>,
) {
  return (
    await db.query<{ value: unknown }>(
      `select public.govern_professor_execution(${executionArgNames.map((_, i) => `$${i + 1}`).join(",")}) as value`,
      executionArgNames.map((name) => args[name]),
    )
  ).rows[0].value;
}
