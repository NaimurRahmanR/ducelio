import { beforeAll,afterAll,describe,expect,it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import { assertMatchingVersion,assignmentSchema,studyPlanItemSchema } from "@/domain/academy";
let db:PGlite;
beforeAll(async()=>{db=await testDatabase();}); afterAll(async()=>{await db?.close();});
describe("PostgreSQL migrations and constraints",()=>{
 it("seeds five demo objectives",async()=>{expect((await db.query<{count:number}>("select count(*)::int as count from public.lesson_objectives")).rows[0].count).toBe(5);});
 it("prevents duplicate active counsellors",async()=>{await expect(db.exec("insert into public.counsellor_assignments(student_id,counsellor_id) values ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002')")).rejects.toThrow();});
 it("freezes published objectives",async()=>{await expect(db.exec("update public.lesson_objectives set description='Changed'")).rejects.toThrow("immutable"); await expect(db.exec("insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','Extra',6)")).rejects.toThrow("immutable");});
 it("rejects cross-version enrolment",async()=>{await db.exec("insert into public.programme_versions(id,programme_id,label) values ('20000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','Other demo')"); await expect(db.exec("insert into public.enrolments(student_id,cohort_id,programme_version_id) values ('10000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000003')")).rejects.toThrow();});
 it("rejects cross-student plan items",async()=>{await expect(db.exec("insert into public.study_plan_items(plan_id,student_id,title,due_on,created_by) values ('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','Bad','2026-09-09','10000000-0000-4000-8000-000000000003')")).rejects.toThrow();});
});
describe("domain validation",()=>{
 it("rejects mismatched versions",()=>{expect(()=>assertMatchingVersion("a","b")).toThrow();});
 it("rejects self assignment",()=>{expect(assignmentSchema.safeParse({studentId:"10000000-0000-4000-8000-000000000001",counsellorId:"10000000-0000-4000-8000-000000000001",reason:"test reason"}).success).toBe(false);});
 it("rejects invalid dates and empty plan items",()=>{expect(studyPlanItemSchema.safeParse({planId:"60000000-0000-4000-8000-000000000001",studentId:"10000000-0000-4000-8000-000000000001",title:" ",dueOn:"2026-02-31"}).success).toBe(false);});
});
