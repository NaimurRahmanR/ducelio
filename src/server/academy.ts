import "server-only";
import { z } from "zod";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";
const enrolmentSchema=z.object({id:z.uuid(),status:z.string(),programme_version_id:z.uuid(),cohorts:z.object({title:z.string()}),programme_versions:z.object({label:z.string(),programmes:z.object({title:z.string(),examination_body:z.string(),is_demo:z.boolean()})})});
export async function getStudentAcademy(){
 const actor=await requireActor("student");const client=await createSupabase();
 const {data,error}=await client.from("enrolments").select("id,status,programme_version_id,cohorts(title),programme_versions(label,programmes(title,examination_body,is_demo))").eq("student_id",actor.id).order("enrolled_at",{ascending:false});
 if(error)throw new Error("Your enrolment records could not be loaded.");
 const profile=await client.from("student_profiles").select("student_number,timezone").eq("user_id",actor.id).single();
 if(profile.error)throw new Error("Your student profile could not be loaded.");
 return {actor,enrolments:z.array(enrolmentSchema).parse(data),profile:z.object({student_number:z.string(),timezone:z.string()}).parse(profile.data)};
}
