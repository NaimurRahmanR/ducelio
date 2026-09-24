import { requireAnyRole } from "@/server/identity";
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
};

// Independent-review Finding 1: the smallest usable admin surface making
// migration 040's already-governed recovery authority operationally
// reachable -- no manual SQL, no copying internal IDs out of an audit log.
// Deliberately minimal: this is a bounded operational worklist, not final
// visual polish.
export default async function Page() {
  const actor = await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const targets = await listRecoverableExaminerTargets().catch(() => null);
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Programmes"
      sections={adminSectionsForRoles(actor.roles)}
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
            </Card>
          ))
        )}
      </Card>
    </StaffShell>
  );
}
