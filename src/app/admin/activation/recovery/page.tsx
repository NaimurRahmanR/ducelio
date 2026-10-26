import { AdminForbidden } from "@/components/admin-shell";
import {
  adminWorkspaceAccess,
  COURSE_ADMIN_ROLES,
} from "@/server/admin-access";
import Link from "next/link";
import { listRecoverableExaminerTargets } from "@/server/commercial-v1-examiner-recovery/operations";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import { Card, Badge } from "@/components/ui";
import { ExaminerRecoveryForm } from "@/components/examiner-recovery-form";

const STATUS_LABEL: Record<string, string> = {
  ELIGIBLE: "Eligible for recovery",
  RECOVERY_IN_PROGRESS: "Recovery in progress",
  RECOVERED: "Recovered",
  RECOVERY_ESCALATED: "Escalated to academic review",
  RECOVERY_EXHAUSTED: "Recovery attempted, still stranded",
  RESOLVED_BY_ACADEMIC_REVIEW: "Resolved by academic review",
};

// Independent-review Finding 1: the smallest usable admin surface making
// migration 040's already-governed recovery authority operationally
// reachable -- no manual SQL, no copying internal IDs out of an audit log.
// Deliberately minimal: this is a bounded operational worklist, not final
// visual polish.
// Rendered per request: the role guard must see the signed-in session.
export const dynamic = "force-dynamic";

export default async function Page() {
  const access = await adminWorkspaceAccess(COURSE_ADMIN_ROLES);
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="academy"
        title="Examiner grade recovery"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const actor = access.actor;
  const targets = await listRecoverableExaminerTargets().catch(() => null);
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Grade recovery"
      sections={adminSectionsForRoles(actor.roles)}
      roles={actor.roles}
    >
      <Card>
        <h2>Examiner initial-grade recovery</h2>
        <p>
          Targets whose initial Examiner grading terminated without a result
          (failed, timed out, over budget, or cancelled). Each target ever gets
          exactly one governed recovery attempt.
        </p>
        {!targets ? (
          <p role="alert">Recovery targets are unavailable right now.</p>
        ) : targets.length === 0 ? (
          <p>No stranded targets.</p>
        ) : (
          targets.map((t) => (
            <Card key={t.sourceExecutionId}>
              <p>
                <Badge
                  tone={t.recoveryStatus === "ELIGIBLE" ? "gold" : "muted"}
                >
                  {STATUS_LABEL[t.recoveryStatus] ?? t.recoveryStatus}
                </Badge>{" "}
                {t.targetKind === "ASSESSMENT_ATTEMPT"
                  ? `Assessment · ${t.component}`
                  : "Practical lab"}
              </p>
              <p className="muted">
                Original outcome: {t.originalState}
                {t.originalReasonCode
                  ? ` (${t.originalReasonCode})`
                  : ""} · {new Date(t.terminalAt).toLocaleString()}
              </p>
              {t.recoveryStatus === "ELIGIBLE" && (
                <ExaminerRecoveryForm sourceExecutionId={t.sourceExecutionId} />
              )}
              {(t.recoveryStatus === "RECOVERY_ESCALATED" ||
                t.recoveryStatus === "RECOVERY_EXHAUSTED") &&
                t.recoveryExecutionId && (
                  <Link
                    className="text-link"
                    href={`/admin/academic-review/results?case=${t.recoveryExecutionId}`}
                  >
                    Open academic review
                  </Link>
                )}
            </Card>
          ))
        )}
      </Card>
    </StaffShell>
  );
}
