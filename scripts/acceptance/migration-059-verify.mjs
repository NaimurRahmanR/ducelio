#!/usr/bin/env node
// CP2F: read-only pre/post verifier for migration 059 on ducelio-acceptance.
//
//   node --env-file=<acceptance .env.local> scripts/acceptance/migration-059-verify.mjs --phase=pre  --snapshot=<new file> --repo=<deploy worktree>
//   node --env-file=<acceptance .env.local> scripts/acceptance/migration-059-verify.mjs --phase=post --snapshot=<pre file> --repo=<deploy worktree>
//
// Local rehearsal against a disposable loopback server only:
//   CP2F_LOCAL_URL=postgres://...@127.0.0.1:<port>/postgres node scripts/acceptance/migration-059-verify.mjs --local ...
//
// Every statement runs inside BEGIN TRANSACTION READ ONLY and is rolled
// back. Hosted mode requires certificate-verified TLS (CP2F_CA_FILE = the
// Supabase root CA) and refuses any insecure override. Nothing secret is
// printed: no connection string, password, e-mail, key material or row
// content -- only identifiers of schema objects, counts and PASS/FAIL.
// Exit 0 only if every check passes; 1 on any failed check; 2 on usage.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  }),
);
const usage = (m) => {
  console.error(m);
  process.exitCode = 2;
};
if (!["pre", "post"].includes(args.phase) || !args.snapshot || !args.repo) {
  usage(
    "usage: --phase=pre|post --snapshot=<file> --repo=<worktree> [--local]",
  );
  process.exit();
}
const repo = resolve(args.repo);
const require = createRequire(join(repo, "package.json"));
const pg = require("pg");

const EXPECTED_REF = "blqaomssojfxaxskcyxd";
const MIGRATION_059 = "202610160059_interactive_examination_engine.sql";
const SHA_059 =
  "2a200a89ed11625703cd326b30ffdcc8df2462e5f9089ece5c677df71db1f2f7";
const CONTRACT_SHA =
  "cc615b2abac6176afb79f90b080eaa6aa379c18753b6d24d278628b5ada38953";
const contractPath = new URL("./migration-059-contract.json", import.meta.url);
const contractText = readFileSync(contractPath);
const contract = JSON.parse(contractText);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`,
  );
};
const sha = (b) => createHash("sha256").update(b).digest("hex");
const norm = (s) => s.replace(/[\s;]+/g, "");

check(
  "contract file is the reviewed PostgreSQL 17 rehearsal delta",
  sha(contractText) === CONTRACT_SHA,
);
const migDir = join(repo, "supabase/migrations");
const files = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
check(
  "deploy worktree carries exactly 59 migrations ending with 059",
  files.length === 59 && files.at(-1) === MIGRATION_059,
  `${files.length} files`,
);
check(
  "migration 059 SHA-256 equals the reviewed file",
  sha(readFileSync(join(migDir, MIGRATION_059))) === SHA_059,
);

// ---- Target binding ------------------------------------------------------
let connection;
if (args.local) {
  const url = process.env.CP2F_LOCAL_URL ?? "";
  const host = new URL(url).hostname;
  check("local rehearsal target is loopback", host.startsWith("127."));
  connection = { connectionString: url };
} else {
  const api = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://x");
  const db = new URL(process.env.ACCEPTANCE_DATABASE_URL ?? "postgres://x");
  const user = decodeURIComponent(db.username);
  check(
    "API origin is the acceptance project over HTTPS",
    api.protocol === "https:" && api.hostname === `${EXPECTED_REF}.supabase.co`,
  );
  check(
    "database user is the acceptance project's postgres session-pooler user",
    user === `postgres.${EXPECTED_REF}` &&
      db.hostname.endsWith(".pooler.supabase.com") &&
      db.port === "5432" &&
      db.pathname === "/postgres",
  );
  check(
    "insecure TLS override is absent",
    process.env.ACCEPTANCE_DATABASE_INSECURE_TLS === undefined,
  );
  check(
    "certificate-verifying TLS CA is supplied",
    Boolean(process.env.CP2F_CA_FILE),
  );
  connection = {
    connectionString: process.env.ACCEPTANCE_DATABASE_URL,
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(process.env.CP2F_CA_FILE, "utf8"),
    },
  };
}
if (results.some((r) => !r.ok)) {
  console.log("STOP: preconditions failed; no database connection made.");
  process.exitCode = 1;
  process.exit();
}

const client = new pg.Client(connection);
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
await q("begin transaction isolation level repeatable read read only");
await q("set local statement_timeout = '60s'");
await q("set local lock_timeout = '2s'");

const CATALOGUE = {
  funcs: `select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' k,
    md5(p.prosrc)||'|'||p.prosecdef||'|'||coalesce(array_to_string(p.proconfig,','),'')||'|'||pg_get_userbyid(p.proowner)||'|'||coalesce(p.proacl::text,'') v
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' or n.nspname like '%\\_private') and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')`,
  tables: `select c.oid::regclass::text k, c.relrowsecurity::text||'|'||c.relforcerowsecurity::text||'|'||coalesce(c.relacl::text,'') v
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p','v') and (n.nspname='public' or n.nspname like '%\\_private')`,
  cols: `select c.oid::regclass::text||'.'||a.attname k, format_type(a.atttypid,a.atttypmod)||'|'||a.attnotnull::text||'|'||coalesce(a.attacl::text,'') v
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
    where c.relkind in ('r','p','v') and a.attnum>0 and not a.attisdropped and (n.nspname='public' or n.nspname like '%\\_private')`,
  triggers: `select t.tgrelid::regclass::text||'.'||t.tgname k, md5(pg_get_triggerdef(t.oid))||'|'||t.tgenabled::text v
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and (n.nspname='public' or n.nspname like '%\\_private')`,
  policies: `select schemaname||'.'||tablename||'.'||policyname k, md5(coalesce(qual,'')||coalesce(with_check,'')||cmd||array_to_string(roles,',')) v
    from pg_policies where schemaname='public' or schemaname like '%\\_private'`,
  schemas: `select nspname k, coalesce(nspacl::text,'')||'|'||pg_get_userbyid(nspowner) v from pg_namespace where nspname='public' or nspname like '%\\_private'`,
  defacl: `select pg_get_userbyid(defaclrole)||'/'||coalesce(defaclnamespace::regnamespace::text,'*')||'/'||defaclobjtype::text k, defaclacl::text v from pg_default_acl`,
};
async function catalogue() {
  const out = {};
  for (const [k, sql] of Object.entries(CATALOGUE))
    out[k] = Object.fromEntries((await q(sql)).map((r) => [r.k, r.v]));
  return out;
}
async function rowCounts() {
  const tables =
    await q(`select c.oid::regclass::text t from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and n.nspname='public' order by 1`);
  const out = {};
  for (const { t } of tables)
    out[t] = Number((await q(`select count(*)::bigint n from ${t}`))[0].n);
  return out;
}
async function ledger() {
  return q(
    "select version, statements from supabase_migrations.schema_migrations order by version",
  );
}
function ledgerMatches(rows, upTo) {
  const expected = files.slice(0, upTo);
  if (rows.length !== expected.length) return false;
  return expected.every(
    (f, i) =>
      rows[i].version === f.slice(0, 12) &&
      norm(rows[i].statements.join(";")) ===
        norm(readFileSync(join(migDir, f), "utf8")),
  );
}

try {
  if (!args.local) {
    const marker = await q(
      "select count(*)::int n from public._ducelio_acceptance_marker where marker='DUCELIO_ACCEPTANCE_ENVIRONMENT_V1' and environment_id=$1::uuid",
      [process.env.ACCEPTANCE_ENVIRONMENT_ID?.trim()],
    );
    check(
      "acceptance marker matches ACCEPTANCE_ENVIRONMENT_ID",
      marker[0].n === 1,
    );
  }
  const [who] = await q(
    "select current_user u, current_setting('transaction_read_only') ro, (select rolsuper from pg_roles where rolname=current_user) su",
  );
  // Hosted: the non-superuser postgres migration role. A locally initialised
  // rehearsal cluster's postgres is a superuser, so that part is hosted-only.
  check(
    "connected as the postgres migration role in a read-only transaction" +
      (args.local ? "" : ", not superuser"),
    who.u === "postgres" && who.ro === "on" && (args.local || who.su === false),
  );
  const rows = await ledger();

  if (args.phase === "pre") {
    check(
      "ledger is exactly 001-058 with statements identical to the repository",
      ledgerMatches(rows, 58),
      `${rows.length} rows`,
    );
    const [c] = await q(`select
      to_regnamespace('assessment_interaction_private') is null as no_schema,
      to_regclass('public.assessment_question_interactions') is null and to_regclass('public.assessment_question_objective_keys') is null as no_tables,
      not exists(select 1 from pg_trigger where tgname='guard_objective_question_mark') as no_guard,
      not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname in ('add_objective_assessment_question','get_active_assessment_exam_state','list_assessment_authoring_interactions'))
        or (n.nspname='course_engineering_private' and p.proname in ('assert_full_package_valid_v037','without_objective_question_extensions','assert_objective_question_extensions'))) as no_functions`);
    check(
      "none of 059's objects exist (no collision)",
      c.no_schema && c.no_tables && c.no_guard && c.no_functions,
    );
    const deps = await q(`select
      to_regprocedure('extensions.digest(text,text)') is not null as digest,
      to_regprocedure('public.get_commercial_v1_examiner_assessment_context(uuid,uuid,uuid,uuid,uuid,bigint,bigint,text)') is not null as ctx,
      to_regprocedure('public.get_commercial_v1_academic_review_case(uuid)') is not null as review,
      to_regprocedure('course_engineering_private.assert_full_package_valid(text,integer,text,jsonb)') is not null as validator,
      to_regprocedure('course_engineering_private.redact_answer_keys(jsonb)') is not null as redact,
      to_regprocedure('commercial_v1_commerce_private.require_attempt_access(uuid)') is not null as access,
      to_regprocedure('commercial_v1_commerce_private.record_assessment_response(uuid,uuid,text,text)') is not null as legacy_writer,
      to_regprocedure('commercial_v1_commerce_private.record_commercial_v1_assessment_response(uuid,uuid,text,text)') is not null as governed_writer,
      to_regclass('commercial_v1_review_private.open_cases') is not null as open_cases,
      to_regclass('public.commercial_v1_assessment_question_marks') is not null as marks,
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
        ('get_commercial_v1_examiner_assessment_context','govern_commercial_v1_examiner_regrade','govern_commercial_v1_examiner_recovery','get_commercial_v1_academic_review_case'))::int as wrapped`);
    const d = deps[0];
    check(
      "every object 059 depends on or wraps exists, each wrapped function exactly once",
      d.digest &&
        d.ctx &&
        d.review &&
        d.validator &&
        d.redact &&
        d.access &&
        d.legacy_writer &&
        d.governed_writer &&
        d.open_cases &&
        d.marks &&
        d.wrapped === 4,
    );
    const [active] = await q(
      "select count(*)::int n from public.assessment_attempts where state='ACTIVE'",
    );
    check(
      "no ACTIVE assessment attempt (quiescent)",
      active.n === 0,
      `${active.n} active`,
    );
    const execTables =
      await q(`select c.table_schema||'.'||c.table_name t from information_schema.columns c
      where c.column_name='state' and c.table_name like '%examiner%execution%' and c.table_schema in ('public')`);
    let running = 0;
    for (const { t } of execTables)
      running += (
        await q(
          `select count(*)::int n from ${t} where state in ('AUTHORIZED','RUNNING')`,
        )
      )[0].n;
    check(
      "no AUTHORIZED/RUNNING Examiner execution in any execution table",
      running === 0,
      `${execTables.length} tables, ${running} live`,
    );
    const [old] = await q(
      `select count(*)::int n from pg_stat_activity where pid<>pg_backend_pid() and xact_start < now()-interval '60 seconds' and datname=current_database()`,
    );
    check(
      "no transaction open longer than 60 seconds",
      old.n === 0,
      `${old.n} found`,
    );
    const snapshot = {
      version: 1,
      phase: "pre",
      migration: MIGRATION_059,
      migrationSha256: SHA_059,
      takenAt: new Date().toISOString(),
      catalogue: await catalogue(),
      rowCounts: await rowCounts(),
    };
    if (results.every((r) => r.ok)) {
      writeFileSync(args.snapshot, JSON.stringify(snapshot), { flag: "wx" });
      console.log("snapshot written (exclusive create)");
    } else console.log("snapshot NOT written: a pre check failed");
  } else {
    const snap = JSON.parse(readFileSync(args.snapshot, "utf8"));
    check(
      "snapshot is a pre-059 snapshot for the same migration",
      snap.phase === "pre" && snap.migrationSha256 === SHA_059,
    );
    check(
      "ledger is exactly 001-059 with statements identical to the repository",
      ledgerMatches(rows, 59),
      `${rows.length} rows`,
    );
    const now = await catalogue();
    const delta = (k) => {
      const B = snap.catalogue[k],
        A = now[k];
      return {
        added: Object.keys(A)
          .filter((x) => !(x in B))
          .sort(),
        removed: Object.keys(B)
          .filter((x) => !(x in A))
          .sort(),
        changed: Object.keys(B)
          .filter((x) => x in A && A[x] !== B[x])
          .sort(),
      };
    };
    const same = (a, b) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const f = delta("funcs"),
      t = delta("tables"),
      c = delta("cols"),
      g = delta("triggers"),
      p = delta("policies"),
      s = delta("schemas"),
      dacl = delta("defacl");
    check(
      "functions: exactly the 32 contracted additions",
      same(f.added, contract.functionsAdded),
      `${f.added.length} added`,
    );
    check(
      "functions: none removed",
      f.removed.length === 0,
      f.removed.join(", "),
    );
    check(
      "functions: exactly the 9 contracted replacements changed",
      same(f.changed, contract.functionsChanged),
      `${f.changed.length} changed`,
    );
    check(
      "tables: exactly the 2 new tables, no existing table changed",
      same(t.added, contract.tablesAdded) &&
        !t.removed.length &&
        !t.changed.length,
    );
    check(
      "columns: exactly the 10 new columns, no existing column changed",
      same(c.added, contract.columnsAdded) &&
        !c.removed.length &&
        !c.changed.length,
    );
    check(
      "triggers: exactly the 6 new triggers, no existing trigger changed",
      same(g.added, contract.triggersAdded) &&
        !g.removed.length &&
        !g.changed.length,
    );
    check(
      "policies unchanged",
      !p.added.length && !p.removed.length && !p.changed.length,
    );
    check(
      "schemas: only assessment_interaction_private added",
      same(s.added, contract.schemasAdded) &&
        !s.removed.length &&
        !s.changed.length,
    );
    check(
      "default ACLs unchanged",
      !dacl.added.length && !dacl.removed.length && !dacl.changed.length,
    );
    const [nt] = await q(`select
      (select relrowsecurity from pg_class where oid='public.assessment_question_interactions'::regclass)
        and (select relrowsecurity from pg_class where oid='public.assessment_question_objective_keys'::regclass) as rls,
      (select count(*) from public.assessment_question_interactions)::int + (select count(*) from public.assessment_question_objective_keys)::int as rows,
      not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
        where has_table_privilege(r,'public.assessment_question_interactions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or has_table_privilege(r,'public.assessment_question_objective_keys','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or has_any_column_privilege(r,'public.assessment_question_interactions','SELECT,INSERT,UPDATE,REFERENCES')
           or has_any_column_privilege(r,'public.assessment_question_objective_keys','SELECT,INSERT,UPDATE,REFERENCES')
           or has_schema_privilege(r,'assessment_interaction_private','USAGE,CREATE')) as no_api_access`);
    check(
      "new tables: RLS on, empty, no API-role table/column/schema privilege",
      nt.rls && nt.rows === 0 && nt.no_api_access,
    );
    const pub =
      await q(`select p.proname, coalesce(p.proacl::text,'') acl, p.prosecdef sd, coalesce(array_to_string(p.proconfig,','),'') cfg
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
      ('add_objective_assessment_question','get_active_assessment_exam_state','list_assessment_authoring_interactions','record_assessment_response',
       'record_commercial_v1_assessment_response','get_commercial_v1_examiner_assessment_context','govern_commercial_v1_examiner_regrade',
       'govern_commercial_v1_examiner_recovery','get_commercial_v1_academic_review_case')`);
    check(
      "the 9 public 059 entry points: authenticated-only EXECUTE, SECURITY DEFINER, empty search_path",
      pub.length === 9 &&
        pub.every(
          (r) =>
            r.acl === "{postgres=X/postgres,authenticated=X/postgres}" &&
            r.sd &&
            r.cfg.startsWith('search_path=""'),
        ),
    );
    const [act] = await q(
      `select coalesce(p.proacl::text,'') acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='activate_course_package'`,
    );
    check(
      "activate_course_package privileges unchanged (authenticated-only)",
      act.acl === "{postgres=X/postgres,authenticated=X/postgres}",
    );
    const [priv] =
      await q(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join unnest(array['anon','authenticated','service_role']) r
      where n.nspname='assessment_interaction_private' and has_function_privilege(r, p.oid, 'EXECUTE')`);
    check(
      "no API role can execute any assessment_interaction_private function",
      priv.n === 0,
    );
    const [sd] = await q(
      `select p.prosecdef sd from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='assessment_interaction_private' and p.proname='require_objective_key'`,
    );
    check(
      "deferred key-presence trigger function is SECURITY DEFINER (CP2B fix)",
      sd?.sd === true,
    );
    const [guard] = await q(
      `select tgenabled::text e from pg_trigger where tgname='guard_objective_question_mark' and tgrelid='public.commercial_v1_assessment_question_marks'::regclass`,
    );
    check(
      "objective-mark guard attached and enabled on the marks table",
      guard?.e === "O",
    );
    const counts = await rowCounts();
    const changedTables = Object.keys(snap.rowCounts).filter(
      (k) => counts[k] !== snap.rowCounts[k],
    );
    const newTables = Object.keys(counts)
      .filter((k) => !(k in snap.rowCounts))
      .sort();
    check(
      "no existing row changed in count (no DML on existing data)",
      changedTables.length === 0,
      changedTables.join(", "),
    );
    check(
      "only the 2 new tables are new",
      same(newTables, contract.tablesAdded),
    );
  }
} finally {
  await q("rollback");
  await client.end();
}
const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} checks passed (${args.phase}).`,
);
process.exitCode = failed ? 1 : 0;
