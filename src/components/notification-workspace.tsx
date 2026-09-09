"use client";

import { useActionState } from "react";
import {
  runDeterministicSupportScan,
  type NotificationActionState,
} from "@/app/admin/notification-actions";
import { Badge, Card, EmptyState } from "./ui";

type Notification = {
  id: string;
  student_id: string;
  kind:
    | "MISSED_CLASS"
    | "ASSIGNMENT_DEADLINE"
    | "PLAN_OVERDUE"
    | "MASTERY_REINFORCEMENT"
    | "SUPPORT_FOLLOWUP";
  title: string;
  body: string;
  source_type: "SUPPORT_EVENT" | "SUPPORT_FOLLOWUP";
  source_id: string;
  created_at: string;
  read_at: string | null;
};

export function NotificationWorkspace({
  notifications,
  canManage,
  summary,
}: {
  notifications: Notification[];
  canManage: boolean;
  summary: { total: number; unread: number } | null;
}) {
  const [state, action, pending] = useActionState<NotificationActionState, FormData>(
    runDeterministicSupportScan,
    {},
  );

  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <Badge tone="gold">SUPPORT_V1</Badge>
            <h2>Deterministic support operations</h2>
          </div>
          {summary && (
            <Badge tone="blue">
              {summary.unread} unread / {summary.total} recent
            </Badge>
          )}
        </div>
        <p>
          Support conditions are derived from authoritative academy records only:
          recorded absence, approaching assignment deadlines without a submission,
          overdue study-plan items and objectives marked NEEDS_REINFORCEMENT by the
          deterministic mastery policy.
        </p>
        <p className="muted">
          The rule set does not infer disengagement from clicks, page views, elapsed
          time, prompt sentiment or other behavioural proxies.
        </p>
        {canManage ? (
          <form action={action} className="support-form">
            <div className="field">
              <label htmlFor="support-scan-reason">Operational reason</label>
              <textarea
                id="support-scan-reason"
                name="reason"
                rows={2}
                minLength={5}
                maxLength={300}
                defaultValue="Evaluate deterministic learner-support rules"
                required
              />
            </div>
            {state.error && <p className="notice error">{state.error}</p>}
            {state.message && <p className="notice">{state.message}</p>}
            <button className="button" disabled={pending}>
              {pending ? "Evaluating…" : "Evaluate support rules"}
            </button>
          </form>
        ) : (
          <div className="notice">
            Academic Administrator or Platform Administrator authority is required to
            evaluate institutional support rules.
          </div>
        )}
      </Card>

      <Card>
        <h2>Recent institutional notifications</h2>
        {notifications.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Notification</th>
                  <th>Learner</th>
                  <th>State</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {notifications.map((notification) => (
                  <tr key={notification.id}>
                    <td>{notification.kind.replaceAll("_", " ")}</td>
                    <td>
                      <strong>{notification.title}</strong>
                      <div className="muted">{notification.body}</div>
                    </td>
                    <td>{notification.student_id}</td>
                    <td>{notification.read_at ? "READ" : "UNREAD"}</td>
                    <td>{new Date(notification.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No institutional notifications generated">
            Evaluate SUPPORT_V1 after authoritative records exist. Re-running the
            same rules is idempotent and does not duplicate existing notifications.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
