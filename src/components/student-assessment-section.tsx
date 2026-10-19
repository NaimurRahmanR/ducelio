import { getStudentAssessments } from "@/server/assessments";
import { StudentAssessments } from "./student-assessments";

export async function StudentAssessmentSection({ page }: { page: number }) {
  const data = await getStudentAssessments({ page });
  return (
    <StudentAssessments
      assessments={data.assessments}
      activeAssessment={data.activeAssessment}
      attempts={data.attempts}
      activityState={data.activityState}
      activeQuestions={data.activeQuestions}
      serverNow={data.serverNow}
      pagination={data.pagination}
    />
  );
}
