import { getStudentAssessments } from "@/server/assessments";
import { StudentAssessments } from "./student-assessments";

export async function StudentAssessmentSection() {
  const data = await getStudentAssessments();
  return (
    <StudentAssessments
      assessments={data.assessments}
      attempts={data.attempts}
      responses={data.responses}
      activityState={data.activityState}
      activeQuestions={data.activeQuestions}
    />
  );
}
