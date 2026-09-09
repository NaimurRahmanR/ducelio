import { AcademyShell } from "./academy-shell";
import { StudentNotificationList } from "./student-notifications";
import { getStudentNotifications } from "@/server/notifications";

export async function StudentNotificationPage() {
  const { actor, notifications } = await getStudentNotifications();
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR ACADEMY</p>
          <h1>Notifications</h1>
          <p>
            Deterministic notices from your academy records and support rules.
          </p>
        </div>
      </div>
      <StudentNotificationList notifications={notifications} />
    </AcademyShell>
  );
}
