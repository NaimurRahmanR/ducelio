import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
export async function testDatabase(
  options: {
    throughMigration?: number;
    supabaseDefaultPrivileges?: boolean;
  } = {},
) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon nologin; create role authenticated nologin;
 create role service_role nologin bypassrls;`);
  // Hosted Supabase (verified on the acceptance project's pg_default_acl)
  // grants every new public table, sequence and function to anon,
  // authenticated and service_role explicitly, for both the migration role
  // (postgres) and supabase_admin. `revoke ... from public` does not remove
  // those explicit grants, so suites that make privilege claims opt in to
  // this exact shape. The supabase_admin context exists so a suite can show
  // that Ducelio's migrations leave it untouched.
  if (options.supabaseDefaultPrivileges)
    await db.exec(`
 create role supabase_admin nologin;
 grant create, usage on schema public to supabase_admin;
 alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
 alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
 alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
 alter default privileges for role supabase_admin in schema public grant all on tables to postgres, anon, authenticated, service_role;
 alter default privileges for role supabase_admin in schema public grant all on sequences to postgres, anon, authenticated, service_role;
 alter default privileges for role supabase_admin in schema public grant execute on functions to postgres, anon, authenticated, service_role;`);
  await db.exec(`
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
      await db.exec(`
      grant insert (id), update (source) on public.audit_events to service_role;
      grant insert (id), update (state) on public.academic_content_releases to service_role;
    `);
    await db.exec(await readFile(resolve(root, file), "utf8"));
  }
  await db.exec(await readFile(resolve("supabase/seed.sql"), "utf8"));
  return db;
}
