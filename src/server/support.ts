import "server-only";
import { z } from "zod";
import { createSupabase } from "./supabase";
import { requireActor } from "./identity";
import { canAccessSupport,AccessDenied } from "@/domain/policy";
import { studyPlanItemSchema,followupSchema,assignmentSchema } from "@/domain/academy";
const profileSchema=z.object({study_goal:z.string(),weekly_hours:z.number(),preferred_contact:z.string()});
const planSchema=z.object({id:z.uuid(),title:z.string(),status:z.string()});
const itemSchema=z.object({id:z.uuid(),title:z.string(),due_on:z.string(),status:z.string()});
const eventSchema=z.object({id:z.uuid(),kind:z.string(),occurred_at:z.string(),status:z.string()});
const interactionSchema=z.object({id:z.uuid(),summary:z.string(),occurred_at:z.string()});
export async function supportContext(studentId:string,privateRecord=false){
 z.uuid().parse(studentId);
 const actor=await requireActor();
 const client=await createSupabase();
 let assigned=false;
 if(actor.roles.includes("COUNSELLOR")){
  const {data,error}=await client.rpc("is_assigned_counsellor",{learner:studentId});
  if(error)throw new Error("Support permissions could not be checked.");
  assigned=data===true;
 }
 if(!canAccessSupport(actor,studentId,assigned,privateRecord))throw new AccessDenied();
 return {actor,client};
}
export async function getStudentSupportProfile(studentId:string){
 const {client}=await supportContext(studentId);
 const {data,error}=await client.from("student_support_profiles").select("study_goal,weekly_hours,preferred_contact").eq("student_id",studentId).maybeSingle();
 if(error)throw new Error("Support profile could not be loaded.");
 return data?profileSchema.parse(data):null;
}
export async function getStudyPlan(studentId:string){
 const {client}=await supportContext(studentId);
 const {data,error}=await client.from("study_plans").select("id,title,status").eq("student_id",studentId).eq("status","ACTIVE").maybeSingle();
 if(error)throw new Error("Study plan could not be loaded.");
 if(!data)return {plan:null,items:[]};
 const plan=planSchema.parse(data);
 const result=await client.from("study_plan_items").select("id,title,due_on,status").eq("plan_id",plan.id).eq("student_id",studentId).order("due_on");
 if(result.error)throw new Error("Study plan items could not be loaded.");
 return {plan,items:z.array(itemSchema).parse(result.data)};
}
export async function getOpenSupportEvents(studentId:string){
 const {client}=await supportContext(studentId);
 const {data,error}=await client.from("support_events").select("id,kind,occurred_at,status").eq("student_id",studentId).eq("status","OPEN").order("occurred_at",{ascending:false}).limit(50);
 if(error)throw new Error("Support events could not be loaded.");
 return z.array(eventSchema).parse(data);
}
export async function getSupportFollowups(studentId:string){
 const {client}=await supportContext(studentId);
 const {data,error}=await client.from("support_followups").select("id,title,due_on,status").eq("student_id",studentId).eq("status","OPEN").order("due_on").limit(50);
 if(error)throw new Error("Follow-ups could not be loaded.");
 return z.array(itemSchema).parse(data);
}
export async function getPrivateInteractions(studentId:string){
 const {client}=await supportContext(studentId,true);
 const {data,error}=await client.from("counsellor_interactions").select("id,summary,occurred_at").eq("student_id",studentId).order("occurred_at",{ascending:false}).limit(20);
 if(error)throw new Error("Interactions could not be loaded.");
 return z.array(interactionSchema).parse(data);
}
export async function getAssignedCounsellor(studentId:string){
 const {client}=await supportContext(studentId);
 const {data,error}=await client.from("counsellor_assignments").select("counsellor_id").eq("student_id",studentId).is("ended_at",null).lte("starts_at",new Date().toISOString()).maybeSingle();
 if(error)throw new Error("Counsellor assignment could not be loaded.");
 if(!data)return null;
 const name=await client.from("app_users").select("display_name").eq("id",data.counsellor_id).single();
 if(name.error)throw new Error("Counsellor profile could not be loaded.");
 return z.object({display_name:z.string()}).parse(name.data);
}
export async function createStudyPlanItem(input:unknown){
 const p=studyPlanItemSchema.parse(input);const {client}=await supportContext(p.studentId);
 const {data,error}=await client.rpc("create_study_plan_item",{p_plan_id:p.planId,p_student_id:p.studentId,p_title:p.title,p_due_on:p.dueOn});
 if(error)throw new Error("Study plan item could not be saved.");
 return z.uuid().parse(data);
}
export async function createSupportFollowup(input:unknown){
 const p=followupSchema.parse(input);const {client}=await supportContext(p.studentId,true);
 const {data,error}=await client.rpc("create_support_followup",{p_student_id:p.studentId,p_event_id:p.eventId,p_title:p.title,p_due_on:p.dueOn});
 if(error)throw new Error("Follow-up could not be saved.");
 return z.uuid().parse(data);
}
export async function recordCounsellorInteraction(input:unknown){
 const p=z.object({studentId:z.uuid(),summary:z.string().trim().min(1).max(2000)}).parse(input);
 const {client}=await supportContext(p.studentId,true);
 const {data,error}=await client.rpc("record_counsellor_interaction",{p_student_id:p.studentId,p_summary:p.summary});
 if(error)throw new Error("Interaction could not be saved.");
 return z.uuid().parse(data);
}
export async function assignCounsellor(input:unknown){
 const p=assignmentSchema.parse(input);const actor=await requireActor("admin");
 if(!actor.roles.some(r=>r==="ACADEMIC_ADMIN"||r==="PLATFORM_ADMIN"))throw new AccessDenied();
 const client=await createSupabase();
 const {data,error}=await client.rpc("assign_counsellor",{p_student_id:p.studentId,p_counsellor_id:p.counsellorId,p_reason:p.reason});
 if(error)throw new Error("Counsellor assignment could not be saved.");
 return z.uuid().parse(data);
}
