"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  beginControlledAssessment,
  type AssessmentActionState,
} from "@/app/student/actions";
import { ExamWorkspace, type ExamQuestion } from "./exam-workspace";
import { Badge, Card, EmptyState } from "./ui";

type Assessment = {
  id: string;
  title: string;
  instructions: string;
  opens_at: string;
  closes_at: string;
  duration_minutes: number;
  attempts_allowed: number;
  status: "PUBLISHED" | "CLOSED";
  lessons: { title: string };
  programme_versions: { label: string; title_snapshot: string | null };
};

type Attempt = {
  id: string;
  assessment_id: string;
  attempt_number: number;
  state: "ACTIVE" | "SUBMITTED" | "VOIDED";
  started_at: string;
  expires_at: string;
  submitted_at: string | null;
};

function ActionMessage({ state }: { state: AssessmentActionState }) {
  if (state.error) return <p className="notice error">{state.error}</p>;
  if (state.message) return <p className="notice">{state.message}</p>;
  return null;
}

type AssessmentPagination = {
  page: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
};

const assessmentPageHref = (page: number) =>
  page === 1 ? "/student/assessments" : `/student/assessments?page=${page}`;

// Newest assessments come first; older ones are one page away. An active
// attempt is shown below whichever page is open.
function AssessmentPageLinks({
  pagination,
}: {
  pagination?: AssessmentPagination;
}) {
  if (!pagination || (!pagination.hasPreviousPage && !pagination.hasNextPage))
    return null;
  return (
    <nav aria-label="Assessment pages" className="launch-actions">
      {pagination.hasPreviousPage && (
        <Link
          className="button secondary"
          href={assessmentPageHref(pagination.page - 1)}
        >
          Newer assessments
        </Link>
      )}
      {pagination.hasNextPage && (
        <Link
          className="button secondary"
          href={assessmentPageHref(pagination.page + 1)}
        >
          Older assessments
        </Link>
      )}
    </nav>
  );
}

export function StudentAssessments({
  assessments,
  activeAssessment: pageIndependentActiveAssessment = null,
  attempts,
  activityState,
  activeQuestions,
  serverNow,
  pagination,
}: {
  assessments: Assessment[];
  // The live attempt's assessment, read independently of the page, so the
  // exam workspace still renders when that assessment is on another page.
  activeAssessment?: Assessment | null;
  attempts: Attempt[];
  activityState: "NORMAL" | "CONTROLLED_ASSESSMENT_ACTIVE";
  activeQuestions: ExamQuestion[];
  serverNow: string;
  pagination?: AssessmentPagination;
}) {
  const [startState, startAction, starting] = useActionState<
    AssessmentActionState,
    FormData
  >(beginControlledAssessment, {});
  const activeAttempt =
    activityState === "CONTROLLED_ASSESSMENT_ACTIVE"
      ? attempts.find((attempt) => attempt.state === "ACTIVE")
      : undefined;
  const activeAssessment = activeAttempt
    ? pageIndependentActiveAssessment?.id === activeAttempt.assessment_id
      ? pageIndependentActiveAssessment
      : assessments.find((a) => a.id === activeAttempt.assessment_id)
    : undefined;

  return (
    <>
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">SERVER-CONTROLLED ACTIVITY STATE</p>
            <h2>Assessments</h2>
          </div>
          <Badge
            tone={
              activityState === "CONTROLLED_ASSESSMENT_ACTIVE"
                ? "gold"
                : "muted"
            }
          >
            {activityState.replaceAll("_", " ")}
          </Badge>
        </div>
        <p className="muted">
          Protected questions are released only after the backend creates an
          active attempt. During that attempt, normal academic-help actions are
          restricted by the deterministic activity firewall.
        </p>
        <ActionMessage state={startState} />
        {assessments.length ? (
          assessments.map((assessment) => {
            const ownAttempts = attempts.filter(
              (attempt) => attempt.assessment_id === assessment.id,
            );
            return (
              <div className="support-record" key={assessment.id}>
                <Badge
                  tone={assessment.status === "PUBLISHED" ? "green" : "muted"}
                >
                  {assessment.status}
                </Badge>
                <h3>{assessment.title}</h3>
                <p>
                  {assessment.lessons.title} ·{" "}
                  {assessment.programme_versions.label}
                </p>
                <p>{assessment.instructions}</p>
                <p className="muted">
                  {assessment.duration_minutes} minutes · up to{" "}
                  {assessment.attempts_allowed} attempt
                  {assessment.attempts_allowed === 1 ? "" : "s"} · opens{" "}
                  {new Date(assessment.opens_at).toLocaleString()} · closes{" "}
                  {new Date(assessment.closes_at).toLocaleString()}
                </p>
                <p className="muted">
                  {ownAttempts.length} attempt record
                  {ownAttempts.length === 1 ? "" : "s"}
                </p>
                {assessment.status === "PUBLISHED" && !activeAttempt && (
                  <form action={startAction}>
                    <input
                      type="hidden"
                      name="assessmentId"
                      value={assessment.id}
                    />
                    <button className="button" disabled={starting}>
                      {starting ? "Starting…" : "Start controlled assessment"}
                    </button>
                  </form>
                )}
              </div>
            );
          })
        ) : pagination && pagination.page > 1 ? (
          <EmptyState title="No older assessments">
            There are no assessments on this page.
          </EmptyState>
        ) : (
          <EmptyState title="No controlled assessments available">
            Published assessments for your enrolled cohort will appear here.
          </EmptyState>
        )}
        <AssessmentPageLinks pagination={pagination} />
      </Card>

      {activeAttempt && activeAssessment && (
        <ExamWorkspace
          key={activeAttempt.id}
          title={activeAssessment.title}
          instructions={activeAssessment.instructions}
          attempt={activeAttempt}
          questions={activeQuestions}
          serverNow={serverNow}
        />
      )}
    </>
  );
}
