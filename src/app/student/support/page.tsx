import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { listMyLearnerCourses } from "@/server/learner-academics";
import { AcademyShell } from "@/components/academy-shell";
import { SupportFormView } from "@/components/learner/support-form";
// INTEGRATION: Lane C's support server action (outbox delivery state).
import { sendMySupportMessageAction } from "@/app/student/support/actions";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const courses = await listMyLearnerCourses().catch(() => []);
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <SupportFormView
        courses={courses}
        sendSupportAction={sendMySupportMessageAction}
      />
    </AcademyShell>
  );
}
