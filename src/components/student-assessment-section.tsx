import { getStudentAssessments } from "@/server/assessments";
import { StudentAssessments } from "./student-assessments";

export async function StudentAssessmentSection({ page }: { page: number }) {
  const data = await getStudentAssessments({ page });
  return (
    <StudentAssessments
      assessments={data.assessments}
      attempts={data.attempts}
      responses={data.responses}
      activityState={data.activityState}
      activeQuestions={data.activeQuestions}
      pagination={data.pagination}
    />
  );
}
