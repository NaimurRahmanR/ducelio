import { StaffShell } from "@/components/staff-shell";
import { CounsellorWorkspace } from "@/components/counsellor-workspace";
import { getCounsellorCaseload } from "@/server/staff";
import { getStudentSupportProfile,getStudyPlan,getSupportFollowups,getOpenSupportEvents,getPrivateInteractions,getStudentProgrammeMembership } from "@/server/support";
export default async function Page({searchParams}:{searchParams:Promise<{student?:string}>}){
 const {actor,learners}=await getCounsellorCaseload();const params=await searchParams;
 const selected=params.student?learners.find(l=>l.id===params.student):learners[0];
 let record=null;
 if(selected){const [profile,study,followups,events,interactions,programmes]=await Promise.all([getStudentSupportProfile(selected.id),getStudyPlan(selected.id),getSupportFollowups(selected.id),getOpenSupportEvents(selected.id),getPrivateInteractions(selected.id),getStudentProgrammeMembership(selected.id)]);record={profile,...study,followups,events,interactions,programmes};}
 return <StaffShell kind="counsellor" name={actor.displayName}><CounsellorWorkspace learners={learners} selected={selected} record={record}/></StaffShell>;
}

