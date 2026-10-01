import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import {
  buildCommerceFixture,
  administrator,
  learner as commerceLearner,
  foreignLearner as commerceForeignLearner,
  asPolicyUser,
} from "./commercial-v1-commerce-fixture";

// Migration 202610010044: governed People/role/account-status authority,
// last-PLATFORM_ADMIN and self-lockout protection, and the governed cohort
// lifecycle. Every identity below is a real (test) Supabase Auth user
// provisioned by migration 002's trigger -- the same path a real signup
// takes -- except the single bootstrap PLATFORM_ADMIN, which (as in any new
// environment) needs one privileged grant before the governed RPCs exist
// for anyone to call.

let db: PGlite;

async function value<T = unknown>(sql: string, args: unknown[] = []) {
  return (await db.query<{ v: T }>(sql, args)).rows[0]?.v;
}
async function as(authId: string) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    authId,
  ]);
  await db.exec("set role authenticated");
}
async function owner() {
  await db.exec("reset role; reset request.jwt.claim.sub");
}
async function signUp(name: string, confirmed = true) {
  await owner();
  const auth = randomUUID();
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values($1,$2,$3::jsonb,$4)",
    [
      auth,
      `${name.toLowerCase().replace(/\s+/g, ".")}@people.example`,
      JSON.stringify({ display_name: name }),
      confirmed ? new Date().toISOString() : null,
    ],
  );
  const id = await value<string>(
    "select id as v from public.app_users where auth_user_id=$1",
    [auth],
  );
  return { auth, id: id! };
}
async function refused(sql: string, args: unknown[], code: string) {
  await expect(db.query(sql, args)).rejects.toThrow(code);
}
const grant = "select public.admin_grant_role($1,$2,$3) as v";
const revoke = "select public.admin_revoke_role($1,$2,$3) as v";
const status = "select public.admin_set_account_status($1,$2,$3) as v";
const profile = "select public.admin_set_staff_profile($1,$2,$3) as v";

describe("governed People authority (migration 044)", () => {
  let admin: { auth: string; id: string };
  let instructor: { auth: string; id: string };
  let counsellor: { auth: string; id: string };
  let academic: { auth: string; id: string };
  let registrar: { auth: string; id: string };
  let learner: { auth: string; id: string };

  beforeAll(async () => {
    db = await testDatabase();
    admin = await signUp("Pat Admin");
    instructor = await signUp("Ira Instructor");
    counsellor = await signUp("Cass Counsellor");
    academic = await signUp("Ada Academic");
    registrar = await signUp("Rey Registrar");
    learner = await signUp("Lee Learner");
    // Bootstrap only: the first PLATFORM_ADMIN in a fresh environment.
    await owner();
    await db.query(
      "insert into public.staff_profiles values($1,'Platform administrator')",
      [admin.id],
    );
    await db.query(
      "insert into public.role_grants values($1,'PLATFORM_ADMIN')",
      [admin.id],
    );
  });
  afterAll(async () => {
    await db?.close();
  });

  it("defaults existing accounts to ACTIVE and keeps STUDENT provisioning intact", async () => {
    await owner();
    expect(
      await value(
        "select count(*)::int as v from public.app_users where account_status<>'ACTIVE'",
      ),
    ).toBe(0);
    expect(
      await value(
        "select count(*)::int as v from public.role_grants where user_id=$1 and role='STUDENT'",
        [learner.id],
      ),
    ).toBe(1);
  });

  it("refuses every People operation to non-PLATFORM_ADMIN actors", async () => {
    await owner();
    await db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($2,'REGISTRAR')",
      [academic.id, registrar.id],
    );
    for (const actor of [academic, registrar, learner, instructor]) {
      await as(actor.auth);
      await refused(
        grant,
        [learner.id, "INSTRUCTOR", "Unauthorised grant"],
        "FORBIDDEN",
      );
      await refused(
        revoke,
        [admin.id, "PLATFORM_ADMIN", "Unauthorised revoke"],
        "FORBIDDEN",
      );
      await refused(
        status,
        [admin.id, "DEACTIVATED", "Unauthorised deactivation"],
        "FORBIDDEN",
      );
      await refused(
        profile,
        [learner.id, "Self-appointed", "Unauthorised profile"],
        "FORBIDDEN",
      );
      await refused(
        "select public.admin_list_people(null) as v",
        [],
        "FORBIDDEN",
      );
    }
    await owner();
    expect(
      await value(
        "select count(*)::int as v from public.role_grants where user_id=$1 and role='INSTRUCTOR'",
        [learner.id],
      ),
    ).toBe(0);
  });

  it("keeps role, status and profile tables RPC-only for client sessions", async () => {
    await as(admin.auth);
    await expect(
      db.query("insert into public.role_grants values($1,'INSTRUCTOR')", [
        learner.id,
      ]),
    ).rejects.toThrow();
    await expect(
      db.query(
        "update public.app_users set account_status='DEACTIVATED' where id=$1",
        [learner.id],
      ),
    ).rejects.toThrow();
    await expect(
      db.query("insert into public.staff_profiles values($1,'Direct')", [
        learner.id,
      ]),
    ).rejects.toThrow();
  });

  it("locates an existing Ducelio identity by email for a PLATFORM_ADMIN", async () => {
    await as(admin.auth);
    const found = await value<{
      usablePlatformAdmins: number;
      people: Array<Record<string, unknown>>;
    }>("select public.admin_list_people($1) as v", [
      "IRA.INSTRUCTOR@people.example",
    ]);
    expect(found!.usablePlatformAdmins).toBe(1);
    expect(found!.people).toHaveLength(1);
    expect(found!.people[0]).toMatchObject({
      id: instructor.id,
      displayName: "Ira Instructor",
      accountStatus: "ACTIVE",
      staffTitle: null,
      roles: ["STUDENT"],
      isStudent: true,
      emailConfirmed: true,
    });
    const staff = await value<{ people: Array<{ id: string }> }>(
      "select public.admin_list_people(null) as v",
    );
    // Default listing is staff only, never the demo seed accounts.
    expect(staff!.people.map((p) => p.id).sort()).toEqual(
      [admin.id, academic.id, registrar.id].sort(),
    );
  });

  it("requires a staff profile before a staff role, and audits profile creation", async () => {
    await as(admin.auth);
    await refused(
      grant,
      [instructor.id, "INSTRUCTOR", "Teaching appointment"],
      "STAFF_PROFILE_REQUIRED",
    );
    const created = await value<Record<string, unknown>>(profile, [
      instructor.id,
      "  Cybersecurity instructor ",
      "Appointed to teaching staff",
    ]);
    expect(created).toMatchObject({
      created: true,
      changed: true,
      title: "Cybersecurity instructor",
    });
    const replay = await value<Record<string, unknown>>(profile, [
      instructor.id,
      "Cybersecurity instructor",
      "Appointed to teaching staff",
    ]);
    expect(replay).toMatchObject({ created: false, changed: false });
    await owner();
    const audit = await db.query<{
      actor_id: string;
      action: string;
      reason: string;
    }>(
      "select actor_id,action,reason from public.audit_events where target_type='staff_profiles' and target_id=$1",
      [instructor.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_id: admin.id,
        action: "INSERT",
        reason: "Appointed to teaching staff",
      },
    ]);
  });

  it("grants INSTRUCTOR idempotently with an attributable audit row", async () => {
    await as(admin.auth);
    expect(
      await value(grant, [instructor.id, "INSTRUCTOR", "Teaching appointment"]),
    ).toMatchObject({ role: "INSTRUCTOR", changed: true });
    expect(
      await value(grant, [instructor.id, "INSTRUCTOR", "Teaching appointment"]),
    ).toMatchObject({ changed: false });
    await owner();
    const audit = await db.query<{
      actor_id: string;
      action: string;
      reason: string;
      after_state: { role: string; user_id: string };
      occurred_at: Date;
    }>(
      "select actor_id,action,reason,after_state,occurred_at from public.audit_events where target_type='role_grants' and target_id=$1 and after_state->>'role'='INSTRUCTOR'",
      [instructor.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_id: admin.id,
      action: "INSERT",
      reason: "Teaching appointment",
      after_state: { role: "INSTRUCTOR", user_id: instructor.id },
    });
    expect(audit.rows[0].occurred_at).toBeInstanceOf(Date);
  });

  it("grants COUNSELLOR, ACADEMIC_ADMIN and REGISTRAR, and never STUDENT", async () => {
    await as(admin.auth);
    await value(profile, [
      counsellor.id,
      "Learner success counsellor",
      "Appointed to support staff",
    ]);
    await value(grant, [counsellor.id, "COUNSELLOR", "Support appointment"]);
    await value(profile, [
      academic.id,
      "Academic administrator",
      "Appointed to academic staff",
    ]);
    await value(grant, [academic.id, "ACADEMIC_ADMIN", "Already held"]);
    await value(profile, [
      registrar.id,
      "Registrar",
      "Appointed to registry staff",
    ]);
    await value(grant, [registrar.id, "REGISTRAR", "Already held"]);
    await refused(
      grant,
      [learner.id, "STUDENT", "Student role is provisioned"],
      "UNSUPPORTED_ROLE",
    );
    await refused(
      revoke,
      [learner.id, "STUDENT", "Student role is provisioned"],
      "UNSUPPORTED_ROLE",
    );
    await refused(
      grant,
      [counsellor.id, "SUPERUSER", "Invented role"],
      "UNSUPPORTED_ROLE",
    );
    await refused(grant, [counsellor.id, "INSTRUCTOR", "no"], "INVALID_INPUT");
    await refused(
      grant,
      ["10000000-0000-4000-8000-000000000002", "INSTRUCTOR", "Demo account"],
      "DEMO_ACCOUNT",
    );
    await refused(
      grant,
      [randomUUID(), "INSTRUCTOR", "Unknown account"],
      "NOT_FOUND",
    );
    await owner();
    const roles = await db.query<{ user_id: string; role: string }>(
      "select user_id,role from public.role_grants where user_id = any($1) and role<>'STUDENT' order by role",
      [[counsellor.id, academic.id, registrar.id]],
    );
    expect(roles.rows).toEqual([
      { user_id: counsellor.id, role: "COUNSELLOR" },
      { user_id: academic.id, role: "ACADEMIC_ADMIN" },
      { user_id: registrar.id, role: "REGISTRAR" },
    ]);
  });

  it("refuses to revoke or deactivate the last usable PLATFORM_ADMIN", async () => {
    // An unconfirmed identity holding PLATFORM_ADMIN cannot sign in, so it
    // never counts toward the usable-administrator floor.
    const unconfirmed = await signUp("Una Unconfirmed", false);
    await as(admin.auth);
    await value(profile, [
      unconfirmed.id,
      "Pending admin",
      "Pending appointment",
    ]);
    await value(grant, [
      unconfirmed.id,
      "PLATFORM_ADMIN",
      "Pending appointment",
    ]);
    await refused(
      revoke,
      [admin.id, "PLATFORM_ADMIN", "Stepping down"],
      "LAST_PLATFORM_ADMIN",
    );
    await refused(
      status,
      [admin.id, "DEACTIVATED", "Leaving the academy"],
      "LAST_PLATFORM_ADMIN",
    );
    await owner();
    expect(
      await value(
        "select account_status as v from public.app_users where id=$1",
        [admin.id],
      ),
    ).toBe("ACTIVE");
    expect(
      await value(
        "select count(*)::int as v from public.role_grants where user_id=$1 and role='PLATFORM_ADMIN'",
        [admin.id],
      ),
    ).toBe(1);
  });

  it("refuses self-lockout even when another PLATFORM_ADMIN exists", async () => {
    await as(admin.auth);
    await value(profile, [academic.id, "Academic administrator", "No change"]);
    await value(grant, [academic.id, "PLATFORM_ADMIN", "Second administrator"]);
    await refused(
      revoke,
      [admin.id, "PLATFORM_ADMIN", "Stepping down"],
      "SELF_LOCKOUT",
    );
    await refused(
      status,
      [admin.id, "DEACTIVATED", "Leaving the academy"],
      "SELF_LOCKOUT",
    );
    // Self-revoke of a non-administrative role is not a lockout.
    await value(profile, [admin.id, "Platform administrator", "No change"]);
    await value(grant, [admin.id, "INSTRUCTOR", "Temporary cover"]);
    expect(
      await value(revoke, [admin.id, "INSTRUCTOR", "Cover ended"]),
    ).toMatchObject({ changed: true });
  });

  it("refuses to revoke COUNSELLOR while learners are still assigned", async () => {
    await owner();
    await db.query(
      "insert into public.counsellor_assignments(student_id,counsellor_id) values($1,$2)",
      [learner.id, counsellor.id],
    );
    await as(admin.auth);
    await refused(
      revoke,
      [counsellor.id, "COUNSELLOR", "Leaving support team"],
      "ACTIVE_COUNSELLOR_ASSIGNMENTS",
    );
  });

  it("deactivation removes all application authority but preserves identity, grants and history", async () => {
    // academic now holds ACADEMIC_ADMIN + PLATFORM_ADMIN.
    await as(academic.auth);
    expect(await value("select public.current_app_user() as v")).toBe(
      academic.id,
    );
    expect(
      (await value<{ people: unknown[] }>(
        "select public.admin_list_people(null) as v",
      ))!.people.length,
    ).toBeGreaterThan(0);

    await as(admin.auth);
    expect(
      await value(status, [academic.id, "DEACTIVATED", "Account compromised"]),
    ).toMatchObject({ status: "DEACTIVATED", changed: true });

    await as(academic.auth);
    expect(await value("select public.current_app_user() as v")).toBeNull();
    expect(await value("select public.has_role('PLATFORM_ADMIN') as v")).toBe(
      false,
    );
    expect(await value("select public.current_account_status() as v")).toBe(
      "DEACTIVATED",
    );
    expect((await db.query("select * from public.app_users")).rows).toEqual([]);
    expect((await db.query("select * from public.enrolments")).rows).toEqual(
      [],
    );
    await refused(
      "select public.admin_list_people(null) as v",
      [],
      "FORBIDDEN",
    );
    await refused(
      grant,
      [learner.id, "INSTRUCTOR", "Deactivated actor grant"],
      "FORBIDDEN",
    );
    await refused(
      "select public.create_enrolment($1,'50000000-0000-4000-8000-000000000001','Deactivated actor enrolment')",
      [learner.id],
      "Access denied",
    );

    await owner();
    const grants = await db.query<{ role: string }>(
      "select role from public.role_grants where user_id=$1 order by role",
      [academic.id],
    );
    expect(grants.rows.map((r) => r.role)).toEqual([
      "STUDENT",
      "ACADEMIC_ADMIN",
      "PLATFORM_ADMIN",
    ]);
    expect(
      await value(
        "select title as v from public.staff_profiles where user_id=$1",
        [academic.id],
      ),
    ).toBe("Academic administrator");
    const audit = await db.query<{
      actor_id: string;
      action: string;
      source: string;
      reason: string;
      before_state: unknown;
      after_state: unknown;
    }>(
      "select actor_id,action,source,reason,before_state,after_state from public.audit_events where target_type='app_users' and target_id=$1",
      [academic.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_id: admin.id,
        action: "ACCOUNT_DEACTIVATED",
        source: "ADMIN_PEOPLE_V1",
        reason: "Account compromised",
        before_state: { account_status: "ACTIVE" },
        after_state: { account_status: "DEACTIVATED" },
      },
    ]);

    // A deactivated account cannot be given new authority.
    await as(admin.auth);
    await refused(
      grant,
      [academic.id, "REGISTRAR", "New duty"],
      "ACCOUNT_DEACTIVATED",
    );
    // A deactivated administrator is not usable, so the active admin is the
    // last usable PLATFORM_ADMIN again.
    await refused(
      revoke,
      [admin.id, "PLATFORM_ADMIN", "Stepping down"],
      "LAST_PLATFORM_ADMIN",
    );
  });

  it("reactivation is governed, audited and restores authority", async () => {
    await as(admin.auth);
    expect(
      await value(status, [academic.id, "ACTIVE", "Credentials rotated"]),
    ).toMatchObject({ status: "ACTIVE", changed: true });
    expect(
      await value(status, [academic.id, "ACTIVE", "Credentials rotated"]),
    ).toMatchObject({ changed: false });
    await as(academic.auth);
    expect(await value("select public.current_app_user() as v")).toBe(
      academic.id,
    );
    expect(await value("select public.has_role('PLATFORM_ADMIN') as v")).toBe(
      true,
    );
    await owner();
    expect(
      await value(
        "select action as v from public.audit_events where target_type='app_users' and target_id=$1 order by occurred_at desc limit 1",
        [academic.id],
      ),
    ).toBe("ACCOUNT_REACTIVATED");
  });

  it("lets one PLATFORM_ADMIN revoke another, with the revoke audited", async () => {
    await as(admin.auth);
    expect(
      await value(revoke, [
        academic.id,
        "PLATFORM_ADMIN",
        "Second admin no longer needed",
      ]),
    ).toMatchObject({ changed: true });
    await as(academic.auth);
    expect(await value("select public.has_role('PLATFORM_ADMIN') as v")).toBe(
      false,
    );
    expect(await value("select public.has_role('ACADEMIC_ADMIN') as v")).toBe(
      true,
    );
    await owner();
    const audit = await db.query<{
      actor_id: string;
      action: string;
      reason: string;
      before_state: { role: string };
    }>(
      "select actor_id,action,reason,before_state from public.audit_events where target_type='role_grants' and target_id=$1 and action='DELETE'",
      [academic.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_id: admin.id,
        action: "DELETE",
        reason: "Second admin no longer needed",
        before_state: { role: "PLATFORM_ADMIN", user_id: academic.id },
      },
    ]);
  });
});

describe("governed cohort lifecycle (migration 044)", () => {
  let versionId: string;
  let draftVersionId: string;
  let cohortId: string;
  const academicAuth = "84000000-0000-4000-8000-000000000001";
  const registrarAuth = "84000000-0000-4000-8000-000000000002";
  const instructorAuth = "84000000-0000-4000-8000-000000000003";
  let academicId: string;
  let learners: string[] = [];

  beforeAll(async () => {
    db = await testDatabase();
    await db.exec("alter table auth.users disable trigger academy_identity");
    for (const [auth, name] of [
      [academicAuth, "Academic"],
      [registrarAuth, "Registrar"],
      [instructorAuth, "Instructor"],
    ]) {
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [auth, `${name.toLowerCase()}@cohorts.example`],
      );
      await db.query(
        "insert into public.app_users(auth_user_id,display_name) values($1,$2)",
        [auth, name],
      );
    }
    await db.exec("alter table auth.users enable trigger academy_identity");
    academicId = (await value<string>(
      "select id as v from public.app_users where auth_user_id=$1",
      [academicAuth],
    ))!;
    const registrarId = await value<string>(
      "select id as v from public.app_users where auth_user_id=$1",
      [registrarAuth],
    );
    const instructorId = await value<string>(
      "select id as v from public.app_users where auth_user_id=$1",
      [instructorAuth],
    );
    await db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($2,'REGISTRAR'),($3,'INSTRUCTOR')",
      [academicId, registrarId, instructorId],
    );
    versionId = (await value<string>(
      "insert into public.programme_versions(programme_id,label) values('20000000-0000-4000-8000-000000000001','2026 institutional') returning id as v",
    ))!;
    const moduleId = await value<string>(
      "insert into public.modules(programme_version_id,title,position) values($1,'Security principles',1) returning id as v",
      [versionId],
    );
    const lessonId = await value<string>(
      "insert into public.lessons(module_id,programme_version_id,title,position) values($1,$2,'Access control',1) returning id as v",
      [moduleId, versionId],
    );
    await db.query(
      "insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values($1,$2,'Explain least privilege',1)",
      [lessonId, versionId],
    );
    await db.query(
      "update public.programme_versions set status='PUBLISHED',is_demo=false where id=$1",
      [versionId],
    );
    draftVersionId = (await value<string>(
      "insert into public.programme_versions(programme_id,label) values('20000000-0000-4000-8000-000000000001','2027 draft') returning id as v",
    ))!;
    learners = [];
    for (const n of [1, 2, 3]) {
      const auth = randomUUID();
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [auth, `cohort-learner-${n}@cohorts.example`],
      );
      learners.push(
        (await value<string>(
          "select id as v from public.app_users where auth_user_id=$1",
          [auth],
        ))!,
      );
    }
  });
  afterAll(async () => {
    await db?.close();
  });

  const create =
    "select public.admin_create_cohort($1,$2,$3::date,$4::date,$5,$6) as v";
  const update =
    "select public.admin_update_cohort($1,$2,$3::date,$4::date,$5,$6) as v";
  const change = "select public.admin_change_cohort_status($1,$2,$3) as v";

  it("refuses cohort creation to REGISTRAR, INSTRUCTOR and learners", async () => {
    for (const auth of [registrarAuth, instructorAuth]) {
      await as(auth);
      await refused(
        create,
        [versionId, "Unauthorised", "2026-11-02", null, null, "Not permitted"],
        "FORBIDDEN",
      );
      await refused(
        "select public.admin_cohort_workspace() as v",
        [],
        "FORBIDDEN",
      );
    }
  });

  it("refuses unknown, draft and demo programme versions and invalid dates", async () => {
    await as(academicAuth);
    await refused(
      create,
      [randomUUID(), "Ghost", "2026-11-02", null, null, "Unknown version"],
      "VERSION_NOT_FOUND",
    );
    await refused(
      create,
      [draftVersionId, "Draft", "2026-11-02", null, null, "Draft version"],
      "VERSION_NOT_PUBLISHED",
    );
    await refused(
      create,
      [
        "20000000-0000-4000-8000-000000000002",
        "Demo",
        "2026-11-02",
        null,
        null,
        "Demo version",
      ],
      "DEMO_VERSION",
    );
    await refused(
      create,
      [versionId, "Backwards", "2026-11-02", "2026-11-01", null, "Bad dates"],
      "INVALID_INPUT",
    );
    await refused(
      create,
      [versionId, "No seats", "2026-11-02", null, 0, "Bad capacity"],
      "INVALID_INPUT",
    );
  });

  it("creates an OPEN, audited cohort idempotently and lists it", async () => {
    await as(academicAuth);
    cohortId = (await value<string>(create, [
      versionId,
      "  November 2026 cohort ",
      "2026-11-02",
      "2027-01-29",
      2,
      "Launch the November intake",
    ]))!;
    expect(
      await value(create, [
        versionId,
        "november 2026 cohort",
        "2026-11-02",
        "2027-01-29",
        2,
        "Launch the November intake",
      ]),
    ).toBe(cohortId);
    await refused(
      create,
      [
        versionId,
        "November 2026 cohort",
        "2026-11-02",
        null,
        2,
        "Different end",
      ],
      "COHORT_CONFLICT",
    );
    const workspace = await value<{
      cohorts: Array<Record<string, unknown>>;
      versions: Array<{ id: string }>;
    }>("select public.admin_cohort_workspace() as v");
    expect(workspace!.versions.map((v) => v.id)).toEqual([versionId]);
    expect(workspace!.cohorts.find((c) => c.id === cohortId)).toMatchObject({
      title: "November 2026 cohort",
      status: "OPEN",
      startsOn: "2026-11-02",
      endsOn: "2027-01-29",
      capacity: 2,
      programmeVersionId: versionId,
      versionLabel: "2026 institutional",
      activationId: null,
      publishedOfferSlug: null,
      enrolments: { active: 0, paused: 0, completed: 0, withdrawn: 0 },
    });
    await owner();
    const audit = await db.query<{
      actor_id: string;
      action: string;
      reason: string;
    }>(
      "select actor_id,action,reason from public.audit_events where target_type='cohorts' and target_id=$1",
      [cohortId],
    );
    expect(audit.rows).toEqual([
      {
        actor_id: academicId,
        action: "INSERT",
        reason: "Launch the November intake",
      },
    ]);
  });

  it("enforces capacity and freezes the start date once learners enrol", async () => {
    await as(academicAuth);
    for (const id of learners.slice(0, 2))
      await db.query(
        "select public.create_enrolment($1,$2,'Approved intake')",
        [id, cohortId],
      );
    await refused(
      "select public.create_enrolment($1,$2,'Approved intake')",
      [learners[2], cohortId],
      "COHORT_FULL",
    );
    await refused(
      update,
      [
        cohortId,
        "November 2026 cohort",
        "2026-11-09",
        "2027-01-29",
        2,
        "Move start",
      ],
      "STARTS_ON_LOCKED",
    );
    await refused(
      update,
      [
        cohortId,
        "November 2026 cohort",
        "2026-11-02",
        "2027-01-29",
        1,
        "Shrink",
      ],
      "CAPACITY_BELOW_ENROLMENT",
    );
    expect(
      await value(update, [
        cohortId,
        "November 2026 cohort (evening)",
        "2026-11-02",
        "2027-02-05",
        3,
        "Add an evening seat",
      ]),
    ).toBe(cohortId);
    const roster = await value<{
      total: number;
      enrolments: Array<Record<string, unknown>>;
    }>("select public.admin_cohort_roster($1) as v", [cohortId]);
    expect(roster!.total).toBe(2);
    expect(roster!.enrolments.map((e) => e.studentId)).toEqual(
      learners.slice(0, 2),
    );
    expect(Object.keys(roster!.enrolments[0]).sort()).toEqual(
      [
        "displayName",
        "enrolledAt",
        "enrolmentId",
        "status",
        "studentId",
        "studentNumber",
      ].sort(),
    );
    // Enrolments keep their own historical snapshot of the original title.
    await owner();
    const snapshots = await db.query<{ cohort_title_snapshot: string }>(
      "select cohort_title_snapshot from public.enrolments where cohort_id=$1",
      [cohortId],
    );
    expect(new Set(snapshots.rows.map((r) => r.cohort_title_snapshot))).toEqual(
      new Set(["November 2026 cohort"]),
    );
  });

  it("closing refuses new enrolments but keeps existing ones and idempotent replays", async () => {
    await as(academicAuth);
    await refused(
      change,
      [cohortId, "COMPLETED", "Skip closing"],
      "INVALID_TRANSITION",
    );
    expect(
      await value(change, [cohortId, "CLOSED", "Intake closed"]),
    ).toMatchObject({
      status: "CLOSED",
      changed: true,
      archivedOfferIds: [],
    });
    await refused(
      "select public.create_enrolment($1,$2,'Late intake')",
      [learners[2], cohortId],
      "COHORT_NOT_OPEN",
    );
    const existing = await value<string>(
      "select public.create_enrolment($1,$2,'Approved intake') as v",
      [learners[0], cohortId],
    );
    expect(existing).toBeTruthy();
    expect(
      await value(change, [cohortId, "OPEN", "Reopened for one learner"]),
    ).toMatchObject({
      status: "OPEN",
    });
    await db.query("select public.create_enrolment($1,$2,'Late intake')", [
      learners[2],
      cohortId,
    ]);
    await value(change, [cohortId, "CLOSED", "Intake closed"]);
  });

  it("completion freezes the cohort without altering learner records", async () => {
    await owner();
    const before = await db.query(
      "select id,status,cohort_title_snapshot,cohort_starts_on_snapshot::text from public.enrolments where cohort_id=$1 order by id",
      [cohortId],
    );
    await as(academicAuth);
    await value(change, [cohortId, "COMPLETED", "Course delivered"]);
    await refused(change, [cohortId, "OPEN", "Reopen"], "COHORT_COMPLETED");
    await refused(
      update,
      [cohortId, "Renamed", "2026-11-02", null, null, "Rename completed"],
      "COHORT_COMPLETED",
    );
    await owner();
    const after = await db.query(
      "select id,status,cohort_title_snapshot,cohort_starts_on_snapshot::text from public.enrolments where cohort_id=$1 order by id",
      [cohortId],
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toHaveLength(3);
    // The lifecycle guard binds privileged writers too.
    await expect(
      db.query("update public.cohorts set status='OPEN' where id=$1", [
        cohortId,
      ]),
    ).rejects.toThrow("COHORT_COMPLETED");
    const audit = await db.query<{
      reason: string;
      before: string;
      after: string;
    }>(
      "select reason,before_state->>'status' as before,after_state->>'status' as after from public.audit_events where target_type='cohorts' and target_id=$1 and action='UPDATE' and before_state->>'status' is distinct from after_state->>'status' order by occurred_at",
      [cohortId],
    );
    expect(audit.rows).toEqual([
      { reason: "Intake closed", before: "OPEN", after: "CLOSED" },
      { reason: "Reopened for one learner", before: "CLOSED", after: "OPEN" },
      { reason: "Intake closed", before: "OPEN", after: "CLOSED" },
      { reason: "Course delivered", before: "CLOSED", after: "COMPLETED" },
    ]);
  });
});

describe("cohort lifecycle against real commerce and activation (migration 044)", () => {
  async function cohortStatus(cohortId: string, next: string, reason: string) {
    await asPolicyUser(db, 2);
    const result = await value<Record<string, unknown>>(
      "select public.admin_change_cohort_status($1,$2,$3) as v",
      [cohortId, next, reason],
    );
    await owner();
    return result;
  }
  const publish =
    "select public.publish_commercial_v1_offer($1,$2,19900,'GBP','Introductory offer','Publish the cohort offer') as v";

  afterAll(async () => {
    await db?.close();
  });

  it("closing archives the published offer, refuses new orders and offers, and honours a pending order", async () => {
    const f = await buildCommerceFixture({ throughMigration: 9999 });
    db = f.db;
    await asPolicyUser(db, 2);
    const offerId = await value<string>(publish, [
      f.activationId,
      "cohort-close-offer",
    ]);
    // A learner starts checkout while the cohort is OPEN.
    await asPolicyUser(db, 1);
    const pending = await value<{ ok: boolean; orderId: string }>(
      "select public.create_commercial_v1_order('cohort-close-offer') as v",
    );
    expect(pending!.ok).toBe(true);
    await owner();

    const closed = await cohortStatus(f.cohortId, "CLOSED", "Intake closed");
    expect(closed).toMatchObject({
      status: "CLOSED",
      archivedOfferIds: [offerId],
    });
    await owner();
    expect(
      await value(
        "select state as v from public.commercial_v1_offers where id=$1",
        [offerId],
      ),
    ).toBe("ARCHIVED");
    expect(
      await value(
        "select count(*)::int as v from public.audit_events where target_id=$1 and action='COMMERCIAL_V1_OFFER_ARCHIVED' and source='ADMIN_COHORTS_V1'",
        [offerId],
      ),
    ).toBe(1);

    // No new offer or order for a closed cohort, even with privileged writes.
    await asPolicyUser(db, 2);
    await refused(
      publish,
      [f.activationId, "cohort-close-again"],
      "COHORT_NOT_OPEN",
    );
    await owner();
    await expect(
      db.query(
        "insert into public.commercial_v1_orders(learner_id,offer_id,activation_id,cohort_id,programme_version_id,amount_minor,currency) values($1,$2,$3,$4,$5,100,'GBP')",
        [
          commerceForeignLearner,
          offerId,
          f.activationId,
          f.cohortId,
          f.programmeVersionId,
        ],
      ),
    ).rejects.toThrow("COHORT_NOT_OPEN");
    // Without a pending order, a new enrolment is refused...
    await expect(
      db.query(
        "insert into public.enrolments(student_id,cohort_id,programme_version_id) values($1,$2,$3)",
        [commerceForeignLearner, f.cohortId, f.programmeVersionId],
      ),
    ).rejects.toThrow("COHORT_NOT_OPEN");
    // ...but the learner whose checkout began while OPEN is still honoured
    // (the fulfilment path's enrolment insert), so paid evidence never rolls back.
    await db.query(
      "insert into public.enrolments(student_id,cohort_id,programme_version_id) values($1,$2,$3)",
      [commerceLearner, f.cohortId, f.programmeVersionId],
    );

    // A CLOSED cohort is completed; a completed cohort refuses activation.
    await cohortStatus(f.cohortId, "COMPLETED", "Course delivered");
    expect(
      await value(
        "select count(*)::int as v from public.enrolments where cohort_id=$1",
        [f.cohortId],
      ),
    ).toBe(1);
    expect(administrator).toBeTruthy();
  });

  it("a completed cohort refuses a new activation", async () => {
    await owner();
    const cohort = await value<string>(
      "insert into public.cohorts(programme_version_id,title,starts_on) select programme_version_id,'Completed before activation',current_date from public.course_activations limit 1 returning id as v",
    );
    await db.query("update public.cohorts set status='CLOSED' where id=$1", [
      cohort,
    ]);
    await db.query("update public.cohorts set status='COMPLETED' where id=$1", [
      cohort,
    ]);
    await expect(
      db.query(
        "insert into public.course_activations(import_id,programme_version_id,cohort_id,instructor_id,request_hash,created_by) select import_id,programme_version_id,$1,instructor_id,repeat('a',64),created_by from public.course_activations limit 1",
        [cohort],
      ),
    ).rejects.toThrow("COHORT_COMPLETED");
  });
});

describe("Commercial V1 checkpoint 1 acceptance workflow: no privileged SQL after bootstrap", () => {
  afterAll(async () => {
    await db?.close();
  });

  it("appoints staff, protects the last administrator and runs a cohort lifecycle through governed RPCs only", async () => {
    db = await testDatabase();
    // 1. Existing Ducelio users (real sign-up provisioning).
    const admin = await signUp("Morgan Admin");
    const teacher = await signUp("Tariq Teacher");
    const supporter = await signUp("Sam Support");
    const academic = await signUp("Avery Academic");
    const registrar = await signUp("Robin Registrar");
    const learner = await signUp("Lou Learner");
    // Bootstrap only (any fresh environment): the first PLATFORM_ADMIN.
    await owner();
    await db.query("insert into public.staff_profiles values($1,'Owner')", [
      admin.id,
    ]);
    await db.query(
      "insert into public.role_grants values($1,'PLATFORM_ADMIN')",
      [admin.id],
    );
    // A published institutional programme version already exists.
    const version = await value<string>(
      "insert into public.programme_versions(programme_id,label) values('20000000-0000-4000-8000-000000000001','2026 workflow') returning id as v",
    );
    const moduleId = await value<string>(
      "insert into public.modules(programme_version_id,title,position) values($1,'Module',1) returning id as v",
      [version],
    );
    const lessonId = await value<string>(
      "insert into public.lessons(module_id,programme_version_id,title,position) values($1,$2,'Lesson',1) returning id as v",
      [moduleId, version],
    );
    await db.query(
      "insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values($1,$2,'Objective',1)",
      [lessonId, version],
    );
    await db.query(
      "update public.programme_versions set status='PUBLISHED' where id=$1",
      [version],
    );
    const auditBefore = await value<number>(
      "select count(*)::int as v from public.audit_events",
    );

    // 2-6. PLATFORM_ADMIN opens People and appoints staff.
    await as(admin.auth);
    const located = await value<{ people: Array<{ id: string }> }>(
      "select public.admin_list_people($1) as v",
      ["tariq.teacher@people.example"],
    );
    expect(located!.people.map((p) => p.id)).toEqual([teacher.id]);
    for (const [target, title, role] of [
      [teacher, "Instructor", "INSTRUCTOR"],
      [supporter, "Counsellor", "COUNSELLOR"],
      [academic, "Academic administrator", "ACADEMIC_ADMIN"],
      [registrar, "Registrar", "REGISTRAR"],
    ] as const) {
      await value(profile, [target.id, title, "Staff appointment"]);
      await value(grant, [target.id, role, `Appointed as ${role}`]);
    }

    // 7. Audit identifies the actor and each change.
    await owner();
    const grants = await db.query<{ target_id: string; role: string }>(
      "select target_id,after_state->>'role' as role from public.audit_events where actor_id=$1 and target_type='role_grants' and action='INSERT' order by occurred_at",
      [admin.id],
    );
    expect(grants.rows).toEqual([
      { target_id: teacher.id, role: "INSTRUCTOR" },
      { target_id: supporter.id, role: "COUNSELLOR" },
      { target_id: academic.id, role: "ACADEMIC_ADMIN" },
      { target_id: registrar.id, role: "REGISTRAR" },
    ]);

    // 8. Last-admin protection.
    await as(admin.auth);
    await refused(
      revoke,
      [admin.id, "PLATFORM_ADMIN", "Stepping down"],
      "LAST_PLATFORM_ADMIN",
    );
    await refused(
      status,
      [admin.id, "DEACTIVATED", "Leaving"],
      "LAST_PLATFORM_ADMIN",
    );

    // 9-11. PLATFORM_ADMIN opens Cohorts and creates one; it appears.
    const cohortId = await value<string>(
      "select public.admin_create_cohort($1,'Workflow cohort','2026-11-02'::date,null,null,'Workflow intake') as v",
      [version],
    );
    const listed = await value<{
      cohorts: Array<{ id: string; status: string }>;
    }>("select public.admin_cohort_workspace() as v");
    expect(listed!.cohorts).toContainEqual(
      expect.objectContaining({ id: cohortId, status: "OPEN", isDemo: false }),
    );

    // The newly appointed ACADEMIC_ADMIN enrols a learner (existing
    // governed enrolment authority); the REGISTRAR cannot manage cohorts.
    await as(academic.auth);
    await db.query("select public.create_enrolment($1,$2,'Approved intake')", [
      learner.id,
      cohortId,
    ]);
    await as(registrar.auth);
    await refused(
      "select public.admin_change_cohort_status($1,'CLOSED','Registrar attempt') as v",
      [cohortId],
      "FORBIDDEN",
    );

    // 12. Roster.
    await as(academic.auth);
    const roster = await value<{ enrolments: Array<{ studentId: string }> }>(
      "select public.admin_cohort_roster($1) as v",
      [cohortId],
    );
    expect(roster!.enrolments.map((e) => e.studentId)).toEqual([learner.id]);

    // 13. Lifecycle.
    await value(
      "select public.admin_change_cohort_status($1,'CLOSED','Intake closed') as v",
      [cohortId],
    );
    await value(
      "select public.admin_change_cohort_status($1,'COMPLETED','Course delivered') as v",
      [cohortId],
    );

    // 14. Audit records the cohort changes with their actors.
    await owner();
    const cohortAudit = await db.query<{ actor_id: string; reason: string }>(
      "select actor_id,reason from public.audit_events where target_type='cohorts' and target_id=$1 order by occurred_at",
      [cohortId],
    );
    expect(cohortAudit.rows).toEqual([
      { actor_id: admin.id, reason: "Workflow intake" },
      { actor_id: academic.id, reason: "Intake closed" },
      { actor_id: academic.id, reason: "Course delivered" },
    ]);
    expect(
      await value<number>("select count(*)::int as v from public.audit_events"),
    ).toBeGreaterThan(auditBefore!);
  });
});
