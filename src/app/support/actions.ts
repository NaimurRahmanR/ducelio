"use server";
import { revalidatePath } from "next/cache";
import { createStudyPlanItem,createSupportFollowup,recordCounsellorInteraction } from "@/server/support";
export type SupportActionState={error?:string;message?:string};
export async function addPlanItem(_state:SupportActionState,form:FormData):Promise<SupportActionState>{
 try{await createStudyPlanItem(Object.fromEntries(form));}catch{return {error:"Unable to save. Check the fields and your permission to update this plan."};}
 revalidatePath("/student");revalidatePath("/support");
 return {message:"Study plan item saved."};
}
export async function addFollowup(_state:SupportActionState,form:FormData):Promise<SupportActionState>{
 try{await createSupportFollowup({...Object.fromEntries(form),eventId:form.get("eventId")||null});}catch{return {error:"Unable to save. Check the fields and your current learner assignment."};}
 revalidatePath("/support");revalidatePath("/student");
 return {message:"Follow-up saved."};
}
export async function addInteraction(_state:SupportActionState,form:FormData):Promise<SupportActionState>{
 try{await recordCounsellorInteraction(Object.fromEntries(form));}catch{return {error:"Unable to save. Check the fields and your current learner assignment."};}
 revalidatePath("/support");
 return {message:"Private interaction recorded."};
}
