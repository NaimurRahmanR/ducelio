import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

// Actual migrations, RLS, SECURITY DEFINER functions and triggers. Sequential
// PGlite transactions do not prove concurrent hosted PostgreSQL acceptance.
let db: PGlite;
const student = "10000000-0000-4000-8000-000000000001";
const admin = "10000000-0000-4000-8000-000000000002";
const other = "10000000-0000-4000-8000-000000000003";
const auth = (n: number) =>
  `82000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cohort = "50000000-0000-4000-8000-000000000001";
const lesson = "40000000-0000-4000-8000-000000000001";
const version = "20000000-0000-4000-8000-000000000002";
const capability = "get_lesson_context";
let assessment: string;
let enrolment: string;
type Grant = {
  ok: boolean;
  release_id: string;
  student_id: string;
  invocation_id: string;
  code?: string;
};
async function asUser(n: number | null) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    n ? auth(n) : "",
  ]);
  await db.exec("set role authenticated");
}
async function begin(
  invocation = randomUUID(),
  name = capability,
  contract = "PROFESSOR_READ_V2",
) {
  return (
    await db.query<{ value: Grant }>(
      "select public.begin_academic_content_release($1,$2,$3) as value",
      [invocation, name, contract],
    )
  ).rows[0].value;
}
async function close(id: string, complete = true) {
  return (
    await db.query<{ value: unknown }>(
      "select public.close_academic_content_release($1,$2) as value",
      [id, complete],
    )
  ).rows[0].value;
}
async function start() {
  return (
    await db.query<{ id: string }>(
      "select public.start_assessment_attempt($1) as id",
      [assessment],
    )
  ).rows[0].id;
}
async function rejected(sql: string, params: unknown[] = [], message = "") {
  await db.exec("savepoint expected_denial");
  await expect(db.query(sql, params)).rejects.toThrow(message);
  await db.exec(
    "rollback to savepoint expected_denial; release savepoint expected_denial",
  );
}
async function row(id: string) {
  await db.exec("reset role");
  const result = (
    await db.query<{ state: string; terminal_at: Date; expires_at: Date }>(
      "select * from public.academic_content_releases where id=$1",
      [id],
    )
  ).rows[0];
  await db.exec("set role authenticated");
  return result;
}
async function events(id: string) {
  await db.exec("reset role");
  const result = (
    await db.query<{
      action: string;
      reason: string;
      before_state: null;
      after_state: Record<string, unknown>;
    }>(
      "select action,reason,before_state,after_state from public.audit_events where target_type='academic_content_releases' and target_id=$1 order by occurred_at,id",
      [id],
    )
  ).rows;
  await db.exec("set role authenticated");
  return result;
}
async function staleRelease() {
  // Privileged fixture of a lease whose fixed DB expiry has already elapsed.
  // No sleeps or production timestamp-mutation authority are introduced.
  await db.exec("reset role");
  const id = (
    await db.query<{ id: string }>(
      `insert into public.academic_content_releases(student_id,invocation_id,capability_name,capability_contract_version,state,started_at,expires_at)
    values($1,$2,$3,'PROFESSOR_READ_V2','ACTIVE',now()-interval '31 seconds',now()-interval '1 second') returning id`,
      [student, randomUUID(), capability],
    )
  ).rows[0].id;
  await db.exec("set role authenticated");
  return id;
}
beforeAll(async () => {
  db = await testDatabase();
  await db.exec("alter table auth.users disable trigger academy_identity");
  for (const [n, id] of [
    [1, student],
    [2, admin],
    [3, other],
  ] as const) {
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      [auth(n), `release${n}@test.example`],
    );
    await db.query(
      "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
      [auth(n), id],
    );
  }
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR')",
    [admin],
  );
  enrolment = (
    await db.query<{ id: string }>(
      "select id from public.enrolments where student_id=$1 and cohort_id=$2",
      [student, cohort],
    )
  ).rows[0].id;
  await asUser(2);
  assessment = (
    await db.query<{ id: string }>(
      "select public.create_assessment($1,$2,$3,'Controlled fixture','Assessment instruction sentinel',now()-interval '1 hour',now()+interval '2 hours',60,5,'Release security fixture') as id",
      [cohort, lesson, admin],
    )
  ).rows[0].id;
  await db.query(
    "select public.add_assessment_question($1,1,'Assessment prompt sentinel',10,'Expected answer sentinel','Marking guidance sentinel','Release security fixture')",
    [assessment],
  );
  await db.query(
    "select public.change_assessment_status($1,'PUBLISHED','Release security fixture')",
    [assessment],
  );
});
beforeEach(async () => {
  await db.exec("begin");
  await asUser(1);
});
afterEach(async () => {
  await db.exec("rollback; reset role");
});
afterAll(async () => {
  await db?.close();
});

describe("DB-owned academic content release authorization", () => {
  it("grants NORMAL students a fixed 30-second self-scoped release and audits opening", async () => {
    const invocation = randomUUID();
    const grant = await begin(invocation);
    expect(grant).toMatchObject({
      ok: true,
      student_id: student,
      invocation_id: invocation,
    });
    const persisted = await row(grant.release_id);
    expect(persisted.state).toBe("ACTIVE");
    expect(persisted.terminal_at).toBeNull();
    expect((await events(grant.release_id)).map((e) => e.action)).toEqual([
      "CONTENT_RELEASE_ACTIVE",
    ]);
  });
  it("blocks assessment start while any valid release remains, then permits start after closure", async () => {
    const first = await begin();
    const second = await begin();
    await rejected(
      "select public.start_assessment_attempt($1)",
      [assessment],
      "Academic activity is busy. Retry shortly.",
    );
    await close(first.release_id);
    await rejected(
      "select public.start_assessment_attempt($1)",
      [assessment],
      "Academic activity is busy. Retry shortly.",
    );
    await close(second.release_id);
    const attempt = await start();
    expect(await start()).toBe(attempt); // Phase 2 idempotency survives.
  });
  it("persists a blocked release and audit despite a structured activity denial", async () => {
    await start();
    const invocation = randomUUID();
    expect(await begin(invocation)).toEqual({
      ok: false,
      code: "ACTIVITY_BLOCKED",
    });
    await db.exec("commit; begin; reset role");
    const denied = (
      await db.query<{ id: string; state: string }>(
        "select id,state from public.academic_content_releases where invocation_id=$1",
        [invocation],
      )
    ).rows[0];
    expect(denied.state).toBe("BLOCKED");
    expect((await events(denied.id)).map((e) => e.action)).toEqual([
      "CONTENT_RELEASE_BLOCKED",
    ]);
    // Restore the committed attempt to a terminal state for subsequent fixtures.
    await asUser(1);
    await db.query(
      "select public.submit_assessment_attempt(id) from public.assessment_attempts where student_id=$1 and state='ACTIVE'",
      [student],
    );
    await db.exec("commit; begin");
  });
  it.each(["SUBMITTED", "VOIDED", "EXPIRED"])(
    "permits release after an assessment is %s",
    async (state) => {
      if (state === "EXPIRED") {
        await db.exec("reset role");
        await db.query(
          `insert into public.assessment_attempts(assessment_id,enrolment_id,student_id,cohort_id,programme_version_id,attempt_number,started_at,expires_at)
        select $1,$2,$3,$4,$5,coalesce(max(attempt_number),0)+1,now()-interval '2 minutes',now()-interval '1 minute' from public.assessment_attempts where assessment_id=$1`,
          [assessment, enrolment, student, cohort, version],
        );
      } else {
        const attempt = await start();
        if (state === "VOIDED") {
          await asUser(2);
          await db.query(
            "select public.void_assessment_attempt($1,'Controlled test override')",
            [attempt],
          );
        } else
          await db.query("select public.submit_assessment_attempt($1)", [
            attempt,
          ]);
      }
      await asUser(1);
      expect((await begin()).ok).toBe(true);
    },
  );
  it.each(["begin", "close", "assessment"])(
    "deterministically expires stale leases on %s",
    async (operation) => {
      const id = await staleRelease();
      if (operation === "begin") expect((await begin()).ok).toBe(true);
      if (operation === "close")
        expect(await close(id)).toEqual({
          ok: true,
          state: "EXPIRED",
          transitioned: false,
        });
      if (operation === "assessment") expect(await start()).toBeTruthy();
      const stale = await row(id);
      expect(stale.state).toBe("EXPIRED");
      expect(stale.terminal_at).toEqual(stale.expires_at);
      const actions = (await events(id)).map((event) => event.action);
      expect(actions).toHaveLength(2);
      expect(actions).toEqual(
        expect.arrayContaining([
          "CONTENT_RELEASE_ACTIVE",
          "CONTENT_RELEASE_EXPIRED",
        ]),
      );
    },
  );
  it.each([true, false])(
    "closes idempotently without rewriting terminal history (complete=%s)",
    async (complete) => {
      const grant = await begin();
      const state = complete ? "COMPLETED" : "ABORTED";
      expect(await close(grant.release_id, complete)).toEqual({
        ok: true,
        state,
        transitioned: true,
      });
      const original = await row(grant.release_id);
      expect(await close(grant.release_id, !complete)).toEqual({
        ok: true,
        state,
        transitioned: false,
      });
      expect(await row(grant.release_id)).toEqual(original);

      const actions = (await events(grant.release_id)).map(
        (event) => event.action,
      );
      expect(actions).toHaveLength(2);
      expect(actions).toEqual(
        expect.arrayContaining([
          "CONTENT_RELEASE_ACTIVE",
          `CONTENT_RELEASE_${state}`,
        ]),
      );

      await db.exec("reset role");
      await rejected(
        "update public.academic_content_releases set state='ACTIVE',terminal_at=null where id=$1",
        [grant.release_id],
        "immutable",
      );
    },
  );
  it("forbids release deletion and identity/expiry mutation even through privileged ordinary DML", async () => {
    const grant = await begin();
    await db.exec("reset role");
    await rejected(
      "delete from public.academic_content_releases where id=$1",
      [grant.release_id],
      "cannot be deleted",
    );
    await rejected(
      "update public.academic_content_releases set invocation_id=$2 where id=$1",
      [grant.release_id, randomUUID()],
      "identity is immutable",
    );
    await rejected(
      "update public.academic_content_releases set expires_at=expires_at+interval '1 second' where id=$1",
      [grant.release_id],
      "identity is immutable",
    );
  });
  it("does not disclose or close foreign releases even to a multi-role STUDENT", async () => {
    const grant = await begin();
    await db.exec("reset role");
    await db.query(
      "insert into public.role_grants values($1,'PLATFORM_ADMIN'),($1,'ACADEMIC_ADMIN')",
      [other],
    );
    await asUser(3);
    expect(await close(grant.release_id)).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    expect(await close(randomUUID())).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    await rejected(
      "select * from public.academic_content_releases",
      [],
      "permission denied",
    );
    expect((await begin()).student_id).toBe(other);
    expect((await row(grant.release_id)).state).toBe("ACTIVE");
  });
  it.each([null, 2])(
    "denies unauthenticated/non-STUDENT principal %s",
    async (n) => {
      await asUser(n);
      expect(await begin()).toEqual({
        ok: false,
        code: n ? "FORBIDDEN" : "UNAUTHENTICATED",
      });
    },
  );
  it.each([
    "get_actor_context",
    "get_activity_permissions",
    "record_learning_evidence",
    "__proto__",
    "secret prose",
  ])("rejects forged/non-content capability %s", async (name) => {
    expect(await begin(randomUUID(), name)).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
  });
  it("rejects forged contract versions and invocation reuse", async () => {
    expect(await begin(randomUUID(), capability, "PROFESSOR_READ_V3")).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    const invocation = randomUUID();
    const grant = await begin(invocation);
    expect(await begin(invocation)).toEqual({
      ok: false,
      code: "CONTEXT_CONFLICT",
    });
    await close(grant.release_id);
    expect(await begin(invocation)).toEqual({
      ok: false,
      code: "CONTEXT_CONFLICT",
    });
    expect((await events(grant.release_id)).length).toBe(2);
  });
  it("allows revoked STUDENT cleanup without completing release", async () => {
    const grant = await begin();
    await db.exec("reset role");
    await db.query(
      "delete from public.role_grants where user_id=$1 and role='STUDENT'",
      [student],
    );
    await asUser(1);
    expect(await close(grant.release_id)).toEqual({
      ok: true,
      state: "ABORTED",
      transitioned: true,
    });
  });
  it("denies direct authenticated table mutations and private helpers", async () => {
    const grant = await begin();
    for (const sql of [
      "insert into public.academic_content_releases default values",
      "update public.academic_content_releases set state='COMPLETED'",
      "delete from public.academic_content_releases",
      "insert into public.audit_events default values",
      "update public.audit_events set action='FORGED'",
      "delete from public.audit_events",
      "select public.expire_my_academic_content_releases()",
      "select public.academic_content_release_explain_allowed()",
    ])
      await rejected(sql, [], "permission denied");
    expect((await row(grant.release_id)).state).toBe("ACTIVE");
  });
  it("audits only fixed allowlisted metadata, ignoring caller session audit prose", async () => {
    await db.query("select set_config('app.audit_reason',$1,true)", [
      "resource body evidence_reference expected_answer marking_guidance support prose learner response",
    ]);
    const grant = await begin();
    await close(grant.release_id, false);
    const audit = await events(grant.release_id);
    for (const event of audit) {
      expect(event.before_state).toBeNull();
      expect(Object.keys(event.after_state).sort()).toEqual(
        [
          "student_id",
          "agent_profile",
          "capability_name",
          "capability_contract_version",
          "invocation_id",
          "release_id",
          "state",
          "started_at",
          "expires_at",
          "terminal_at",
        ].sort(),
      );
    }
    expect(JSON.stringify(audit)).not.toMatch(
      /resource body|evidence_reference|expected_answer|marking_guidance|support prose|learner response|sentinel/i,
    );
  });
  it("rolls back a grant or completion when durable audit persistence fails", async () => {
    const grant = await begin();
    await db.exec(`reset role;
      create function public.test_fail_release_audit() returns trigger language plpgsql as $$begin
        if NEW.target_type='academic_content_releases' then raise exception 'Simulated audit failure'; end if; return NEW; end$$;
      create trigger test_fail_release_audit before insert on public.audit_events for each row execute function public.test_fail_release_audit();`);
    await asUser(1);
    await rejected(
      "select public.close_academic_content_release($1,true)",
      [grant.release_id],
      "Simulated audit failure",
    );
    expect((await row(grant.release_id)).state).toBe("ACTIVE");
    expect((await events(grant.release_id)).length).toBe(1);
    const invocation = randomUUID();
    await rejected(
      "select public.begin_academic_content_release($1,$2,'PROFESSOR_READ_V2')",
      [invocation, capability],
      "Simulated audit failure",
    );
    await db.exec("reset role");
    expect(
      (
        await db.query(
          "select id from public.academic_content_releases where invocation_id=$1",
          [invocation],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("uses the same learner FOR UPDATE lock before either path checks exclusion", async () => {
    await db.exec("reset role");
    for (const signature of [
      "public.begin_academic_content_release(uuid,text,text)",
      "public.close_academic_content_release(uuid,boolean)",
      "public.start_assessment_attempt(uuid)",
    ]) {
      const body = (
        await db.query<{ body: string }>(
          "select pg_get_functiondef($1::regprocedure) as body",
          [signature],
        )
      ).rows[0].body;
      const lock = body.search(
        /student_profiles where user_id\s*=\s*actor for update/,
      );
      expect(lock).toBeGreaterThan(0);
      expect(lock).toBeLessThan(
        body.indexOf("perform public.expire_my_academic_content_releases()"),
      );
    }
  });
});
