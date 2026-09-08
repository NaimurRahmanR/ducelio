import { beforeAll,afterAll,afterEach,describe,it,expect } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
let db:PGlite;
const id=(n:number)=>"10000000-0000-4000-8000-"+String(n).padStart(12,"0");
const auth=(n:number)=>"80000000-0000-4000-8000-"+String(n).padStart(12,"0");
beforeAll(async()=>{
 db=await testDatabase();
 // Map synthetic verified auth identities to demo fixtures only inside this test database.
 await db.exec("alter table auth.users disable trigger academy_identity");
 for(let n=1;n<=3;n++){await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())",[auth(n)]);await db.query("update public.app_users set auth_user_id=$1,is_demo=false where id=$2",[auth(n),id(n)]);}
 await db.exec("alter table auth.users enable trigger academy_identity");
});
afterEach(async()=>{await db.exec("reset role; reset request.jwt.claim.sub");});
afterAll(async()=>{await db?.close();});
async function asUser(n:number){await db.query("select set_config('request.jwt.claim.sub',$1,false)",[auth(n)]);await db.exec("set role authenticated");}
describe("PostgreSQL row-level security",()=>{
 it("returns no academic rows to anonymous clients",async()=>{await db.exec("set role anon");await expect(db.query("select * from public.enrolments")).rejects.toThrow();});
 it("allows only a student's own support profile and no private notes",async()=>{await asUser(1);expect((await db.query("select * from public.student_support_profiles")).rows).toHaveLength(1);expect((await db.query("select * from public.counsellor_interactions")).rows).toHaveLength(0);});
 it("hides another student's support and enrolment",async()=>{await asUser(3);expect((await db.query("select * from public.student_support_profiles")).rows).toHaveLength(0);expect((await db.query("select * from public.enrolments")).rows).toHaveLength(0);});
 it("allows assigned counsellor notes and academic context",async()=>{await asUser(2);expect((await db.query("select * from public.counsellor_interactions")).rows).toHaveLength(1);expect((await db.query("select * from public.enrolments")).rows).toHaveLength(1);});
 it("denies instructor access to private support",async()=>{await db.query("insert into public.role_grants values($1,'INSTRUCTOR')",[id(3)]);await asUser(3);expect((await db.query("select * from public.counsellor_interactions")).rows).toHaveLength(0);expect((await db.query("select * from public.student_support_profiles")).rows).toHaveLength(0);});
 it("prevents direct role escalation and academic writes",async()=>{await asUser(1);await expect(db.query("insert into public.role_grants values($1,'PLATFORM_ADMIN')",[id(1)])).rejects.toThrow();await expect(db.exec("update public.enrolments set status='COMPLETED'")).rejects.toThrow();});
});
