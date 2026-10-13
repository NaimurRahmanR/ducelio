import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

type TestDatabaseOptions = {
  throughMigration?: number;
  supabaseDefaultPrivileges?: boolean;
};

// Roles are cluster-wide on a real PostgreSQL server (they outlive any one
// test database), so creation is idempotent; PGlite behaves identically.
const role = (name: string, attributes: string) =>
  `do $$ begin create role ${name} ${attributes}; exception when duplicate_object then null; end $$;`;

// The exact SQL sequence every test database is built from: preamble,
// migrations in order, then the seed. PGlite (testDatabase) and the
// optional real-PostgreSQL concurrency suite apply the same statements.
export async function testDatabaseStatements(
  options: TestDatabaseOptions = {},
) {
  const statements = [
    [
      role("anon", "nologin"),
      role("authenticated", "nologin"),
      role("service_role", "nologin bypassrls"),
    ].join("\n"),
  ];
  // Hosted Supabase (verified on the acceptance project's pg_default_acl)
  // grants every new public table, sequence and function to anon,
  // authenticated and service_role explicitly, for both the migration role
  // (postgres) and supabase_admin. `revoke ... from public` does not remove
  // those explicit grants, so suites that make privilege claims opt in to
  // this exact shape. The supabase_admin context exists so a suite can show
  // that Ducelio's migrations leave it untouched.
  if (options.supabaseDefaultPrivileges)
    statements.push(`
 ${role("supabase_admin", "nologin")}
 grant create, usage on schema public to supabase_admin;
 alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
 alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
 alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
 alter default privileges for role supabase_admin in schema public grant all on tables to postgres, anon, authenticated, service_role;
 alter default privileges for role supabase_admin in schema public grant all on sequences to postgres, anon, authenticated, service_role;
 alter default privileges for role supabase_admin in schema public grant execute on functions to postgres, anon, authenticated, service_role;`);
  statements.push(`
 -- Deliberately broad Supabase-like defaults, including private objects. The
 -- migration must revoke these rather than pass only under empty local ACLs.
 alter default privileges grant all on tables to service_role;
 alter default privileges grant all on functions to service_role;
 alter default privileges grant all on schemas to service_role;
 grant usage on schema public to service_role;
 create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const root = resolve("supabase/migrations");
  for (const file of (await readdir(root))
    .filter(
      (f) =>
        f.endsWith(".sql") &&
        Number(f.slice(8, 12)) <= (options.throughMigration ?? Infinity),
    )
    .sort()) {
    if (file.startsWith("202609100022"))
      statements.push(`
      grant insert (id), update (source) on public.audit_events to service_role;
      grant insert (id), update (state) on public.academic_content_releases to service_role;
    `);
    statements.push(await readFile(resolve(root, file), "utf8"));
  }
  statements.push(await readFile(resolve("supabase/seed.sql"), "utf8"));
  return statements;
}

export async function testDatabase(options: TestDatabaseOptions = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  for (const sql of await testDatabaseStatements(options)) await db.exec(sql);
  return db;
}
