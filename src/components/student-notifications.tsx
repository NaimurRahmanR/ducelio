"use client";

import { useActionState } from "react";
import {
  markAcademyNotificationRead,
  type StudentNotificationActionState,
} from "@/app/student/notification-actions";
import { Badge, Card, EmptyState } from "./ui";

type Notification = {
  id: string;
  kind:
    | "MISSED_CLASS"
    | "ASSIGNMENT_DEADLINE"
    | "PLAN_OVERDUE"
    | "MASTERY_REINFORCEMENT"
    | "SUPPORT_FOLLOWUP";
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
};

function NotificationRecord({ notification }: { notification: Notification }) {
  const [state, action, pending] = useActionState<
    StudentNotificationActionState,
    FormData
  >(markAcademyNotificationRead, {});

  return (
    <div className="support-record">
      <Badge tone={notification.read_at ? "muted" : "blue"}>
        {notification.read_at ? "READ" : "NEW"}
      </Badge>
      <h3>{notification.title}</h3>
      <p>{notification.body}</p>
      <p className="muted">
        {notification.kind.replaceAll("_", " ")} ·{" "}
        {new Date(notification.created_at).toLocaleString()}
      </p>
      {!notification.read_at && (
        <form action={action}>
          <input type="hidden" name="notificationId" value={notification.id} />
          {state.error && <p className="notice error">{state.error}</p>}
          {state.message && <p className="notice">{state.message}</p>}
          <button className="button secondary" disabled={pending}>
            {pending ? "Saving…" : "Mark as read"}
          </button>
        </form>
      )}
    </div>
  );
}

export function StudentNotificationList({
  notifications,
}: {
  notifications: Notification[];
}) {
  const unread = notifications.filter(
    (notification) => !notification.read_at,
  ).length;
  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">INSTITUTIONAL NOTIFICATIONS</p>
            <h2>Your academy notifications</h2>
          </div>
          <Badge tone={unread ? "blue" : "muted"}>{unread} unread</Badge>
        </div>
        <p className="muted">
          These notices are generated from explicit academy records and support
          rules. They do not change grades, deadlines, attendance or mastery
          state.
        </p>
        {notifications.length ? (
          notifications.map((notification) => (
            <NotificationRecord
              key={notification.id}
              notification={notification}
            />
          ))
        ) : (
          <EmptyState title="No academy notifications">
            When a deterministic institutional or support rule produces a
            learner notice, it will appear here.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
