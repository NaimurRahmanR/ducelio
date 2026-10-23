import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "./db-helper";

// Whole-schema privilege inventory under Supabase default privileges, so a
// later migration cannot silently weaken an invariant every RPC relies on.
let db: PGlite;
const rows = async (sql: string) =>
  (await db.query<{ f: string }>(sql)).rows.map((r) => r.f);
beforeAll(async () => {
  db = await testDatabase({ supabaseDefaultPrivileges: true });
}, 180000);
afterAll(async () => {
  await db?.close();
});

describe("database privilege inventory", () => {
  it("pins search_path on every application SECURITY DEFINER function", async () => {
    expect(
      await rows(`select n.nspname||'.'||p.proname f from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace
        where p.prosecdef and n.nspname not in ('pg_catalog','information_schema','auth','extensions','storage')
          and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')`),
    ).toEqual([]);
  });

  it("keeps private schemas and their functions unreachable from API roles", async () => {
    expect(
      await rows(`select n.nspname||'.'||p.proname||' '||r f from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace
        cross join unnest(array['anon','authenticated','service_role']) r
        where n.nspname like '%private%' and has_function_privilege(r,p.oid,'EXECUTE')`),
    ).toEqual([]);
    expect(
      await rows(`select n.nspname||' '||r f from pg_namespace n
        cross join unnest(array['anon','authenticated']) r
        where n.nspname like '%private%' and has_schema_privilege(r,n.oid,'USAGE')`),
    ).toEqual([]);
  });

  it("gives anonymous callers no table access and learners no direct course-commerce access", async () => {
    expect(
      await rows(`select c.relname f from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p','v','m')
          and has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')`),
    ).toEqual([]);
    expect(
      await rows(`select c.relname f from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='r' and (c.relname like 'course_engine%' or c.relname like 'academy_%')
          and has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')`),
    ).toEqual([]);
    // Only organisation and membership registers are directly readable, and
    // only through their organisation READ policies.
    expect(
      await rows(`select c.relname f from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='r' and (c.relname like 'course_engine%' or c.relname like 'academy_%')
          and has_table_privilege('authenticated',c.oid,'SELECT') order by 1`),
    ).toEqual(["course_engine_memberships", "course_engine_organisations"]);
    expect(
      await rows(`select tablename||':'||policyname f from pg_policies
        where schemaname='public' and tablename in ('course_engine_memberships','course_engine_organisations')
          and (cmd<>'SELECT' or qual not like '%can_read_course_organisation%') `),
    ).toEqual([]);
    expect(
      await rows(`select tablename||':'||policyname f from pg_policies
        where schemaname='public' and tablename in ('course_engine_memberships','course_engine_organisations') order by 1`),
    ).toEqual([
      "course_engine_memberships:member_read",
      "course_engine_organisations:org_read",
    ]);
  });
});
