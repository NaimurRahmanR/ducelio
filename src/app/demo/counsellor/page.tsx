import { StaffShell } from "@/components/staff-shell";
import { CounsellorWorkspace } from "@/components/counsellor-workspace";
import { demo } from "@/demo/academy";
export default function Page() {
  const learner = {
    id: "10000000-0000-4000-8000-000000000001",
    display_name: demo.student.name,
  };
  return (
    <StaffShell kind="counsellor" demo name={demo.counsellor.name}>
      <CounsellorWorkspace
        demo
        learners={[learner]}
        selected={learner}
        record={{
          programmes: [
            {
              title: demo.programme.title,
              version: demo.programme.version,
              status: "ACTIVE",
            },
          ],
          profile: {
            study_goal: demo.counsellor.goal,
            weekly_hours: 6,
            preferred_contact: "ACADEMY",
          },
          plan: {
            id: "demo-plan",
            title: "September study plan",
            status: "ACTIVE",
          },
          items: demo.tasks.map((t, i) => ({
            id: String(i),
            title: t.title,
            due_on: t.due,
            status: t.done ? "DONE" : "PLANNED",
          })),
          followups: [
            {
              id: "demo-followup",
              title: demo.followups[0].title,
              due_on: demo.followups[0].due,
              status: "OPEN",
            },
          ],
          events: [{ id: "demo-event", kind: "MILESTONE", status: "OPEN" }],
          interactions: [],
        }}
      />
    </StaffShell>
  );
}
