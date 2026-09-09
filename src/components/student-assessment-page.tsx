import { AcademyShell } from "./academy-shell";
import { StudentAssessmentSection } from "./student-assessment-section";
import { getStudentAcademy } from "@/server/academy";

export async function StudentAssessmentPage() {
  const { actor } = await getStudentAcademy();
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR ACADEMY</p>
          <h1>Assessments</h1>
          <p>Controlled assessment delivery with server-owned activity state.</p>
        </div>
      </div>
      <div className="section-content">
        <StudentAssessmentSection />
      </div>
    </AcademyShell>
  );
}
