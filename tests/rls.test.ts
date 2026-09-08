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

describe("transactional support services",()=>{
 it("creates a learner's own plan item and an audit record",async()=>{
  await asUser(1);const result=await db.query<{id:string}>("select public.create_study_plan_item('60000000-0000-4000-8000-000000000001',$1,'Read chapter two','2026-09-12') as id",[id(1)]);
  await db.exec("reset role");const audit=await db.query<{actor_id:string;after_state:Record<string,unknown>}>("select actor_id,after_state from public.audit_events where target_id=$1",[result.rows[0].id]);expect(audit.rows[0].actor_id).toBe(id(1));expect(audit.rows[0].after_state).not.toHaveProperty("title");
 });
 it("denies another student calling the RPC directly",async()=>{await asUser(3);await expect(db.query("select public.create_study_plan_item('60000000-0000-4000-8000-000000000001',$1,'Bad item','2026-09-12')",[id(1)])).rejects.toThrow("Access denied");});
 it("does not allow a learner to create a counsellor follow-up",async()=>{await asUser(1);await expect(db.query("select public.create_support_followup($1,null,'Bad follow-up','2026-09-12')",[id(1)])).rejects.toThrow("Access denied");});
 it("allows assigned counsellor follow-up and private interaction without copying prose to audit",async()=>{
  await asUser(2);await db.query("select public.create_support_followup($1,null,'Discuss study routine','2026-09-12')",[id(1)]);
  const result=await db.query<{id:string}>("select public.record_counsellor_interaction($1,'PRIVATE TEST SUMMARY') as id",[id(1)]);
  await db.exec("reset role");const audit=await db.query<{after_state:Record<string,unknown>}>("select after_state from public.audit_events where target_id=$1",[result.rows[0].id]);expect(audit.rows[0].after_state).not.toHaveProperty("summary");
 });
 it("rejects cross-learner event references",async()=>{await db.query("insert into public.support_events(id,student_id,kind,source_reference,deduplication_key) values('70000000-0000-4000-8000-000000000003',$1,'MILESTONE','other','other:milestone')",[id(3)]);await asUser(2);await expect(db.query("select public.create_support_followup($1,'70000000-0000-4000-8000-000000000003','Cross-learner','2026-09-12')",[id(1)])).rejects.toThrow();});
 it("requires an actual COUNSELLOR role on assignment",async()=>{await db.query("insert into public.staff_profiles(user_id,title) values($1,'Instructor')",[id(3)]);await expect(db.query("insert into public.counsellor_assignments(student_id,counsellor_id) values($1,$2)",[id(1),id(3)])).rejects.toThrow("COUNSELLOR role");});
 it("deduplicates deterministic event conditions",async()=>{await expect(db.query("insert into public.support_events(student_id,kind,source_reference,deduplication_key) values($1,'MILESTONE','duplicate','demo:student1:milestone1')",[id(1)])).rejects.toThrow();});
 it("revokes former counsellor access after audited reassignment",async()=>{
  await db.query("insert into public.role_grants values($1,'PLATFORM_ADMIN'),($2,'COUNSELLOR')",[id(2),id(3)]);await asUser(2);
  await db.query("select public.assign_counsellor($1,$2,'Reviewed transfer of learner support')",[id(1),id(3)]);
  expect((await db.query("select * from public.counsellor_interactions")).rows).toHaveLength(0);
  await expect(db.query("select public.record_counsellor_interaction($1,'Former counsellor')",[id(1)])).rejects.toThrow("Access denied");
  await db.exec("reset role");expect((await db.query("select * from public.counsellor_assignments where ended_at is null")).rows).toHaveLength(1);
 });
});
