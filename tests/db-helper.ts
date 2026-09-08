import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
export async function testDatabase() {
 const db=new PGlite();
 await db.exec(`create role anon nologin; create role authenticated nologin;
 create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
 const root=resolve("supabase/migrations");
 for(const file of (await readdir(root)).filter(f=>f.endsWith(".sql")).sort()) await db.exec(await readFile(resolve(root,file),"utf8"));
 await db.exec(await readFile(resolve("supabase/seed.sql"),"utf8"));
 return db;
}
