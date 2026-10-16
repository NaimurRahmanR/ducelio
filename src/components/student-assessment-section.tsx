import { getStudentAssessments } from "@/server/assessments";
import { StudentAssessments } from "./student-assessments";

export async function StudentAssessmentSection() {
  const data = await getStudentAssessments();
  return (
    <StudentAssessments
      assessments={data.assessments}
      attempts={data.attempts}
      activityState={data.activityState}
      activeQuestions={data.activeQuestions}
      serverNow={data.serverNow}
    />
  );
}
