import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

// LR-BASELINE-01: hosted Supabase grants every new public function to anon,
// authenticated and service_role explicitly (verified on the acceptance
// project's pg_default_acl). Phase 1-2 migrations only `revoke ... from
// public`, which leaves those explicit grants in place, so this suite
// replays the full chain under that exact default and checks the effective
// privileges a PostgREST caller actually has.

let db: PGlite;
// The same chain under the same defaults, stopped before migration 057.
let before: PGlite;
// Exactly the chain through 057, so the impact suite measures 057 alone
// even after later migrations are added.
let at057: PGlite;

// Reviewed public RPCs the migrations themselves grant to anon (catalogue
// reads and the HMAC-attested commerce controller surface).
const INTENDED_ANON_FUNCTIONS = [
  "apply_academy_commerce_operation",
  "apply_commercial_v1_commerce_operation",
  "fulfill_academy_order",
  "fulfill_commercial_v1_order",
  "get_commercial_v1_offer",
  "list_academy_catalogue",
  "list_commercial_v1_offers",
];
const MASTERY_POLICY =
  "public.apply_objective_mastery_policy(uuid,uuid,uuid,uuid)";
const MASTERY_SIGNATURE =
  "public.apply_objective_mastery_policy(uuid, uuid, uuid, uuid)";
// The 52 signatures migration 057 revokes from anon, read from its own text.
const MIGRATION_057 = readFileSync(
  "supabase/migrations/202610130057_supabase_default_privilege_hardening.sql",
  "utf8",
);
const SIGNATURE_ARRAY = MIGRATION_057.slice(
  MIGRATION_057.indexOf("signatures text[] := array["),
  MIGRATION_057.indexOf("];", MIGRATION_057.indexOf("signatures text[]")),
);
const REVOKED_FROM_ANON = [
  ...SIGNATURE_ARRAY.matchAll(/'(public\.[a-z0-9_]+\([^)]*\))'/g),
]
  .map((m) => m[1])
  .sort();
type Privileges = {
  public: boolean;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
};

// Effective EXECUTE of every non-extension function in every non-system
// schema, keyed the way migration 057 writes signatures.
async function snapshot(database: PGlite) {
  const { rows } = await database.query<Privileges & { signature: string }>(
    `select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature,
       has_function_privilege('public', p.oid, 'execute') as public,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('pg_catalog', 'information_schema')
       and not exists (
         select 1 from pg_depend d
         where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
       )`,
  );
  return new Map<string, Privileges>(
    rows.map(({ signature, ...privileges }) => [signature, privileges]),
  );
}

const adminId = "10000000-0000-4000-8000-000000000002";
const learnerId = "10000000-0000-4000-8000-000000000001";
const adminAuth = "89000000-0000-4000-8000-000000000002";
const learnerAuth = "89000000-0000-4000-8000-000000000001";
const programmeId = "29000000-0000-4000-8000-000000000001";
const versionId = "29000000-0000-4000-8000-000000000002";
const moduleId = "39000000-0000-4000-8000-000000000001";
const lessonId = "49000000-0000-4000-8000-000000000001";
const objectiveId = "49000000-0000-4000-8000-000000000002";
const cohortId = "59000000-0000-4000-8000-000000000001";

async function asAuth(authId: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    authId,
  ]);
  await db.exec("set role authenticated");
}
async function resetRole() {
  await db.exec("reset role; reset request.jwt.claim.sub");
}

beforeAll(async () => {
  [db, before, at057] = await Promise.all([
    testDatabase({ supabaseDefaultPrivileges: true }),
    testDatabase({ supabaseDefaultPrivileges: true, throughMigration: 56 }),
    testDatabase({ supabaseDefaultPrivileges: true, throughMigration: 57 }),
  ]);
});

afterAll(async () => {
  await Promise.all([db?.close(), before?.close(), at057?.close()]);
});

describe("effective function privileges under hosted Supabase defaults", () => {
  it("leaves anon EXECUTE only on the reviewed public RPCs", async () => {
    const { rows } = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public'
         and pg_get_function_result(p.oid) <> 'trigger'
         and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
         and has_function_privilege('anon', p.oid, 'execute')
       order by 1`,
    );
    expect(rows.map((row) => row.proname)).toEqual(INTENDED_ANON_FUNCTIONS);
  });

  it("keeps the internal mastery policy callable by no API role", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const { rows } = await db.query<{ allowed: boolean }>(
        "select has_function_privilege($1, $2, 'execute') as allowed",
        [role, MASTERY_POLICY],
      );
      expect({ role, allowed: rows[0].allowed }).toEqual({
        role,
        allowed: false,
      });
    }
  });

  it("grants anon no public table privilege", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      "select distinct table_name from information_schema.role_table_grants where table_schema='public' and grantee='anon'",
    );
    expect(rows).toEqual([]);
  });
});

describe("security impact of migration 057 (before vs after, same defaults)", () => {
  it("revokes exactly the hosted-observed drift and nothing else", async () => {
    const [pre, post] = [await snapshot(before), await snapshot(at057)];
    expect([...post.keys()].sort()).toEqual([...pre.keys()].sort());
    const changed = [...pre.keys()]
      .filter(
        (key) => JSON.stringify(pre.get(key)) !== JSON.stringify(post.get(key)),
      )
      .sort();
    expect(changed).toEqual([...REVOKED_FROM_ANON, MASTERY_SIGNATURE].sort());
    for (const key of REVOKED_FROM_ANON) {
      expect(pre.get(key)).toEqual({
        public: false,
        anon: true,
        authenticated: true,
        service_role: true,
      });
      expect(post.get(key)).toEqual({
        public: false,
        anon: false,
        authenticated: true,
        service_role: true,
      });
    }
    expect(pre.get(MASTERY_SIGNATURE)).toEqual({
      public: false,
      anon: true,
      authenticated: true,
      service_role: true,
    });
    expect(post.get(MASTERY_SIGNATURE)).toEqual({
      public: false,
      anon: false,
      authenticated: false,
      service_role: false,
    });
  });

  it("revokes from anon exactly the non-trigger drift beyond the reviewed anon RPCs", async () => {
    const { rows } = await before.query<{ signature: string }>(
      `select 'public.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and pg_get_function_result(p.oid) <> 'trigger'
         and has_function_privilege('anon', p.oid, 'execute')
         and p.proname <> all($1::text[])
       order by 1`,
      [INTENDED_ANON_FUNCTIONS],
    );
    expect(REVOKED_FROM_ANON).toHaveLength(52);
    expect([...REVOKED_FROM_ANON, MASTERY_SIGNATURE].sort()).toEqual(
      rows.map((row) => row.signature).sort(),
    );
  });

  it("leaves every trigger function, table and sequence privilege unchanged", async () => {
    const tableGrants = (database: PGlite) =>
      database
        .query(
          `select table_schema, table_name, grantee, privilege_type
           from information_schema.role_table_grants
           where grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
           order by 1, 2, 3, 4`,
        )
        .then((result) => result.rows);
    const sequenceGrants = (database: PGlite) =>
      database
        .query(
          `select c.relname, a.grantee::regrole::text as grantee, a.privilege_type
           from pg_class c, lateral aclexplode(c.relacl) a
           where c.relkind = 'S' and a.grantee <> 0
           order by 1, 2, 3`,
        )
        .then((result) => result.rows);
    const triggerFunctions = (database: PGlite) =>
      database
        .query(
          `select p.oid::regprocedure::text as signature,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where pg_get_function_result(p.oid) = 'trigger'
             and n.nspname not in ('pg_catalog', 'information_schema')
           order by 1`,
        )
        .then((result) => result.rows);
    expect(await tableGrants(at057)).toEqual(await tableGrants(before));
    expect(await sequenceGrants(at057)).toEqual(await sequenceGrants(before));
    const triggers = await triggerFunctions(at057);
    expect(triggers.length).toBeGreaterThan(0);
    expect(triggers).toEqual(await triggerFunctions(before));
  });

  it("changes no supabase_admin default privilege", async () => {
    const defaults = (database: PGlite) =>
      database
        .query(
          `select defaclnamespace::regnamespace::text as schema, defaclobjtype, defaclacl::text
           from pg_default_acl where defaclrole = 'supabase_admin'::regrole
           order by 1, 2`,
        )
        .then((result) => result.rows);
    const after = await defaults(at057);
    expect(after).not.toEqual([]);
    expect(after).toEqual(await defaults(before));
  });
});

describe("functions created after migration 057", () => {
  async function executable(signature: string) {
    const { rows } = await db.query<Record<string, boolean>>(
      `select has_function_privilege('public', $1, 'execute') as public,
         has_function_privilege('anon', $1, 'execute') as anon,
         has_function_privilege('authenticated', $1, 'execute') as authenticated,
         has_function_privilege('service_role', $1, 'execute') as service_role`,
      [signature],
    );
    return rows[0];
  }

  it("does not make a new internal SECURITY DEFINER function callable by any API role", async () => {
    await db.exec(`create function public.lr_internal_helper(p_actor uuid) returns uuid
      language sql security definer set search_path = '' as 'select p_actor'`);
    expect(await executable("public.lr_internal_helper(uuid)")).toEqual({
      public: false,
      anon: false,
      authenticated: false,
      service_role: false,
    });
    await asAuth(learnerAuth);
    try {
      await expect(
        db.query("select public.lr_internal_helper($1)", [adminId]),
      ).rejects.toThrow("permission denied for function lr_internal_helper");
    } finally {
      await resetRole();
    }
  });

  it("still lets a migration authorise an RPC explicitly", async () => {
    await db.exec(`create function public.lr_authorised_rpc() returns integer
      language sql security definer set search_path = '' as 'select 1';
      grant execute on function public.lr_authorised_rpc() to authenticated`);
    expect(await executable("public.lr_authorised_rpc()")).toEqual({
      public: false,
      anon: false,
      authenticated: true,
      service_role: false,
    });
    await asAuth(learnerAuth);
    try {
      const { rows } = await db.query<{ v: number }>(
        "select public.lr_authorised_rpc() as v",
      );
      expect(rows[0].v).toBe(1);
    } finally {
      await resetRole();
    }
  });

  it("keeps the PUBLIC default for functions postgres creates in extensions", async () => {
    await db.exec(`create function extensions.lr_extension_like() returns integer
      language sql as 'select 1'`);
    expect((await executable("extensions.lr_extension_like()")).public).toBe(
      true,
    );
  });

  it("keeps Supabase's own defaults for functions supabase_admin creates", async () => {
    await db.exec(`set role supabase_admin;
      create function public.lr_supabase_managed() returns integer
        language sql as 'select 1';
      reset role`);
    expect(await executable("public.lr_supabase_managed()")).toEqual({
      public: true,
      anon: true,
      authenticated: true,
      service_role: true,
    });
  });
});

describe("reviewed anonymous RPCs after migration 057", () => {
  it("still serve the public catalogue to anon, including their internal identity checks", async () => {
    await db.exec("set role anon");
    try {
      const list = await db.query<{ v: unknown }>(
        "select public.list_commercial_v1_offers() as v",
      );
      const offer = await db.query<{ v: { ok: boolean } }>(
        "select public.get_commercial_v1_offer('no-such-course') as v",
      );
      expect(Array.isArray(list.rows[0].v)).toBe(true);
      expect(offer.rows[0].v.ok).toBe(false);
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("mastery history cannot be replayed by a learner", () => {
  let enrolmentId: string;
  let olderCorrectEvidenceId: string;
  let masteryId: string;

  beforeAll(async () => {
    await db.exec("alter table auth.users disable trigger academy_identity");
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'privilege-admin@example.com',now()),($2,'privilege-learner@example.com',now())",
      [adminAuth, learnerAuth],
    );
    await db.query(
      "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
      [adminAuth, adminId],
    );
    await db.query(
      "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
      [learnerAuth, learnerId],
    );
    await db.exec("alter table auth.users enable trigger academy_identity");
    await db.query(
      "insert into public.role_grants(user_id,role) values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR') on conflict do nothing",
      [adminId],
    );
    await db.query(
      `insert into public.programmes(id,slug,title,examination_body,qualification_name)
       values($1,'privilege-test','Privilege Test Programme','Ducelio Test Body','Privilege Test')`,
      [programmeId],
    );
    await db.query(
      "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Privilege draft')",
      [versionId, programmeId],
    );
    await db.query(
      "insert into public.modules(id,programme_version_id,title,position) values($1,$2,'Module one',1)",
      [moduleId, versionId],
    );
    await db.query(
      `insert into public.lessons(id,module_id,programme_version_id,title,position)
       values($1,$2,$3,'Privilege lesson',1)`,
      [lessonId, moduleId, versionId],
    );
    await db.query(
      `insert into public.lesson_objectives(id,lesson_id,programme_version_id,description,position)
       values($1,$2,$3,'Demonstrate the privilege objective',1)`,
      [objectiveId, lessonId, versionId],
    );
    await asAuth(adminAuth);
    await db.query(
      "select public.publish_programme_version($1,'Privilege curriculum reviewed')",
      [versionId],
    );
    await resetRole();
    await db.query(
      "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Privilege cohort',current_date)",
      [cohortId, versionId],
    );
    await asAuth(adminAuth);
    enrolmentId = (
      await db.query<{ id: string }>(
        "select public.create_enrolment($1,$2,'Approved privilege learner') as id",
        [learnerId, cohortId],
      )
    ).rows[0].id;
    const sessions: string[] = [];
    for (const [start, end] of [
      ["4 hours", "3 hours"],
      ["2 hours", "1 hour"],
    ])
      sessions.push(
        (
          await db.query<{ id: string }>(
            `select public.create_class_session($1,$2,$3,now()-$4::interval,now()-$5::interval,'Privilege session') as id`,
            [cohortId, lessonId, adminId, start, end],
          )
        ).rows[0].id,
      );
    const evidence = async (
      session: string,
      kind: string,
      result: string,
      key: string,
    ) =>
      (
        await db.query<{ id: string }>(
          "select public.record_learning_evidence($1,$2,$3,$4,$5,$6,$7,'Privilege evidence') as id",
          [
            session,
            enrolmentId,
            objectiveId,
            kind,
            result,
            `privilege-${key}`,
            `privilege-key-${key}`,
          ],
        )
      ).rows[0].id;
    await evidence(sessions[0], "CLASS_RESPONSE", "CORRECT", "first");
    olderCorrectEvidenceId = await evidence(
      sessions[1],
      "RETRIEVAL_CHECK",
      "CORRECT",
      "second",
    );
    await evidence(sessions[1], "PRACTICAL_TASK", "PARTIAL", "third");
    await resetRole();
    masteryId = (
      await db.query<{ id: string }>(
        "select id from public.objective_mastery where enrolment_id=$1 and objective_id=$2",
        [enrolmentId, objectiveId],
      )
    ).rows[0].id;
  });

  it("refuses a learner replaying older correct evidence with a forged evaluator", async () => {
    const before = await db.query<{ state: string }>(
      "select state from public.objective_mastery where id=$1",
      [masteryId],
    );
    expect(before.rows[0].state).toBe("NEEDS_REINFORCEMENT");

    await asAuth(learnerAuth);
    await expect(
      db.query(`select ${MASTERY_POLICY.replace(/\(.*$/, "")}($1,$2,$3,$4)`, [
        enrolmentId,
        objectiveId,
        olderCorrectEvidenceId,
        adminId,
      ]),
    ).rejects.toThrow("permission denied for function");
    await resetRole();

    const after = await db.query<{ state: string; evaluated_by: string }>(
      "select state,evaluated_by from public.objective_mastery where id=$1",
      [masteryId],
    );
    expect(after.rows[0].state).toBe("NEEDS_REINFORCEMENT");
    const history = await db.query<{ to_state: string }>(
      "select to_state from public.objective_mastery_history where mastery_id=$1 order by changed_at,id",
      [masteryId],
    );
    expect(history.rows.map((row) => row.to_state)).toEqual([
      "DEVELOPING",
      "DEMONSTRATED",
      "NEEDS_REINFORCEMENT",
    ]);
  });

  it("still applies the policy through the governed evidence service", async () => {
    // record_learning_evidence calls the policy as its definer, so revoking
    // API EXECUTE must not break the legitimate path.
    await asAuth(adminAuth);
    const sessionId = (
      await db.query<{ id: string }>(
        "select session_id as id from public.learning_evidence where id=$1",
        [olderCorrectEvidenceId],
      )
    ).rows[0].id;
    await db.query(
      "select public.record_learning_evidence($1,$2,$3,'PRACTICAL_TASK','CORRECT','privilege-fourth','privilege-key-fourth','Privilege evidence')",
      [sessionId, enrolmentId, objectiveId],
    );
    await resetRole();
    const after = await db.query<{ state: string }>(
      "select state from public.objective_mastery where id=$1",
      [masteryId],
    );
    expect(after.rows[0].state).toBe("DEMONSTRATED");
  });
});
