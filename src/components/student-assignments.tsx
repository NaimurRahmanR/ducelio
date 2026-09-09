import { AcademyShell } from "./academy-shell";
import { Card, Badge } from "./ui";
import { StudentAssignmentList } from "./student-assignment-list";
import { getStudentAcademy } from "@/server/academy";
import { getStudentAssignments } from "@/server/assignments";

export async function StudentAssignments() {
  const [{ actor }, data] = await Promise.all([
    getStudentAcademy(),
    getStudentAssignments(),
  ]);

  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">COURSEWORK</p>
          <h1>Assignments</h1>
          <p>
            Published coursework, submission windows and your attempt history.
          </p>
        </div>
      </div>
      <div className="section-content">
        <Card>
          <div className="section-heading">
            <h2>Your assignments</h2>
            <Badge tone="muted">NOT CONTROLLED ASSESSMENT</Badge>
          </div>
          <p className="muted">
            Assignment submissions are stored as coursework attempts. They do
            not automatically become grades, learning evidence or mastery.
          </p>
          <StudentAssignmentList
            assignments={data.assignments}
            submissions={data.submissions}
          />
        </Card>
      </div>
    </AcademyShell>
  );
}
