#!/usr/bin/env node
// Read-only Academy deployment-readiness guard.
//
//   npm run acceptance:academy-readiness
//
// An Academy release is not operational until the target database has every
// Academy migration (060-073) recorded and every RPC the application calls
// exists with its intended grants. This verifier checks exactly that, from
// the operator's acceptance credential (ACCEPTANCE_DATABASE_URL), inside
// BEGIN TRANSACTION READ ONLY, rolled back. It is operator tooling only:
// nothing here is imported by application code or reachable by a learner,
// and it prints only schema object names, counts and PASS/FAIL -- never a
// connection string, key, e-mail or row value.
//
// The contract (academy-readiness-contract.json) is kept in step with the
// code by tests/academy-readiness-contract.test.ts: every Academy-migration
// function that src/ references must be listed, and every listed RPC must be
// created by a migration.
// Exit 0 only if every check passes; 1 on any failed check.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ACADEMY_READINESS_CONTRACT = JSON.parse(
  readFileSync(
    new URL("./academy-readiness-contract.json", import.meta.url),
    "utf8",
  ),
);

/** Pure evaluation of a database snapshot against the contract. */
export function evaluateAcademyReadiness(
  snapshot,
  contract = ACADEMY_READINESS_CONTRACT,
) {
  const results = [];
  const check = (name, ok, detail = "") =>
    results.push({ name, ok: Boolean(ok), detail });
  const ledger = new Set(snapshot.ledger);
  const missingMigrations = contract.migrations.filter((v) => !ledger.has(v));
  check(
    "Academy migrations recorded in the ledger",
    missingMigrations.length === 0,
    missingMigrations.length ? `missing ${missingMigrations.join(", ")}` : "",
  );
  const byName = new Map(snapshot.rpcs.map((r) => [r.name, r]));
  const anonAllowed = new Set(contract.anonRpcs);
  // Pre-060 functions that an Academy migration only redefines keep their
  // existing ACL; their service_role grant is the recorded phase 1-2
  // baseline item (migration 057), not an Academy defect.
  const baseline = new Set(contract.baselineRpcs);
  const missing = [];
  const notAuthenticated = [];
  const anonExposed = [];
  const serviceRole = [];
  const unpinned = [];
  for (const name of contract.rpcs) {
    const r = byName.get(name);
    if (!r || r.overloads === 0) {
      missing.push(name);
      continue;
    }
    // An allow-listed anon RPC (catalogue reads, certificate verification,
    // the HMAC-claimed dispatchers) must be callable by anon; every other
    // RPC by authenticated users.
    if (anonAllowed.has(name) ? !r.anon : !r.authenticated)
      notAuthenticated.push(name);
    if (r.anon && !anonAllowed.has(name)) anonExposed.push(name);
    if (r.serviceRole && !baseline.has(name)) serviceRole.push(name);
    if (r.securityDefiner && !r.pinnedSearchPath) unpinned.push(name);
  }
  const list = (a) => a.join(", ");
  check(
    `Academy RPCs present (${contract.rpcs.length})`,
    !missing.length,
    missing.length ? `missing ${list(missing)}` : "",
  );
  check(
    "Academy RPCs executable by their intended role",
    !notAuthenticated.length,
    list(notAuthenticated),
  );
  check(
    "No Academy RPC executable by anon outside the reviewed allow-list",
    !anonExposed.length,
    list(anonExposed),
  );
  check(
    "No Academy-created RPC executable by service_role",
    !serviceRole.length,
    list(serviceRole),
  );
  check(
    "Every SECURITY DEFINER Academy RPC pins search_path",
    !unpinned.length,
    list(unpinned),
  );
  const tables = snapshot.tables;
  const noRls = tables.filter((t) => !t.rls).map((t) => t.name);
  const clientPrivileged = tables
    .filter((t) => t.clientPrivileged)
    .map((t) => t.name);
  check("Academy tables exist", tables.length > 0, `${tables.length} tables`);
  check(
    "Row level security enabled on every Academy table",
    !noRls.length,
    list(noRls),
  );
  check(
    "No client writes or protected-body reads; organisation metadata requires RLS",
    !clientPrivileged.length,
    list(clientPrivileged),
  );
  const schemas = new Map(snapshot.schemas.map((s) => [s.name, s]));
  const absentSchemas = contract.privateSchemas.filter((n) => !schemas.has(n));
  const usableSchemas = contract.privateSchemas.filter(
    (n) => schemas.get(n)?.clientUsage,
  );
  check(
    "Academy private schemas present",
    !absentSchemas.length,
    list(absentSchemas),
  );
  check(
    "Academy private schemas unusable by client roles",
    !usableSchemas.length,
    list(usableSchemas),
  );
  return results;
}

/** Reads the snapshot in a read-only transaction that is always rolled back. */
export async function readAcademySnapshot(
  client,
  contract = ACADEMY_READINESS_CONTRACT,
) {
  await client.query("begin transaction read only");
  try {
    const ledger = (
      await client.query(
        "select version from supabase_migrations.schema_migrations",
      )
    ).rows.map((r) => r.version);
    const rpcs = (
      await client.query(
        `select x.name, count(p.oid)::int overloads,
           coalesce(bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')), false) authenticated,
           coalesce(bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')), false) anon,
           coalesce(bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')), false) "serviceRole",
           coalesce(bool_or(p.prosecdef), false) "securityDefiner",
           coalesce(bool_and(array_to_string(p.proconfig, ',') like '%search_path=%'), false) "pinnedSearchPath"
         from unnest($1::text[]) x(name)
         left join pg_proc p on p.proname = x.name and p.pronamespace = 'public'::regnamespace
         group by x.name`,
        [contract.rpcs],
      )
    ).rows;
    const tables = (
      await client.query(
        `select c.relname "name", c.relrowsecurity rls,
           (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
             or has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE')
             or (has_table_privilege('authenticated', c.oid, 'SELECT') and (c.relname not in ('course_engine_organisations','course_engine_memberships') or not exists(select 1 from pg_policy p where p.polrelid=c.oid)))) "clientPrivileged"
         from pg_class c
         where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and (c.relname like 'academy\\_%' or c.relname in ('course_engine_packages','course_engine_publications','course_engine_coupons','course_engine_coupon_redemptions','course_engine_order_terms','course_engine_recoveries','course_engine_organisations','course_engine_memberships','course_engine_academic_resolutions','course_engine_revision_requests','course_engine_checkout_cancellations'))`,
      )
    ).rows;
    const schemas = (
      await client.query(
        `select n.nspname "name",
           (has_schema_privilege('anon', n.oid, 'USAGE') or has_schema_privilege('authenticated', n.oid, 'USAGE')) "clientUsage"
         from pg_namespace n where n.nspname = any($1::text[])`,
        [contract.privateSchemas],
      )
    ).rows;
    return { ledger, rpcs, tables, schemas };
  } finally {
    await client.query("rollback");
  }
}

async function main() {
  const { withConnection } = await import("./db.mjs");
  const results = await withConnection((client) =>
    readAcademySnapshot(client).then((s) => evaluateAcademyReadiness(s)),
  );
  for (const r of results)
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` -- ${r.detail}` : ""}`,
    );
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    failed
      ? `Academy NOT READY: ${failed} of ${results.length} checks failed.`
      : `Academy READY: ${results.length}/${results.length} checks passed.`,
  );
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
