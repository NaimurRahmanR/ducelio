import { randomUUID } from "node:crypto";
import { SessionOperationsConsole } from "@/components/session-operations-console";
import {
  listSessionOperations,
  getSessionBatchOptions,
} from "@/server/session-operations";
import Link from "next/link";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import { AdminWorkspace } from "@/components/admin-workspace";
import { ProgrammePublication } from "@/components/programme-publication";
import { LearningResourceWorkspace } from "@/components/learning-resource-workspace";
import { LearningEvidenceWorkspace } from "@/components/learning-evidence-workspace";
import { ObjectiveMasteryWorkspace } from "@/components/objective-mastery-workspace";
import { AssignmentWorkspace } from "@/components/assignment-workspace";
import { AssessmentWorkspace } from "@/components/assessment-workspace";
import { NotificationWorkspace } from "@/components/notification-workspace";
import { RegistrarWorkspace } from "@/components/registrar-workspace";
import { EnrolmentWorkspace } from "@/components/enrolment-workspace";
import { CounsellorAssignmentWorkspace } from "@/components/counsellor-assignment-workspace";
import { ClassSessionWorkspace } from "@/components/class-session-workspace";
import { AttendanceWorkspace } from "@/components/attendance-workspace";
import { LessonProgressWorkspace } from "@/components/lesson-progress-workspace";
import { getAdminOverview } from "@/server/staff";
import { getProgrammeVersions } from "@/server/programmes";
import { getLearningResourceWorkspace } from "@/server/learning-resources";
import { getLearningEvidenceWorkspace } from "@/server/learning-evidence";
import { getObjectiveMasteryWorkspace } from "@/server/objective-mastery";
import { getAssignmentWorkspace } from "@/server/assignments";
import { getAssessmentWorkspace } from "@/server/assessments";
import { getNotificationOperationsWorkspace } from "@/server/notifications";
import { getRegistrarWorkspace } from "@/server/registrar";
import { getEnrolmentWorkspace } from "@/server/enrolments";
import { getCounsellorAssignmentWorkspace } from "@/server/counsellor-assignments";
import { getClassSessionWorkspace } from "@/server/class-sessions";
import { getAttendanceWorkspace } from "@/server/attendance";
import { getLessonProgressWorkspace } from "@/server/lesson-progress";
import { getTeachingQuality } from "@/server/session-feedback";
import { TeachingQualityPanel } from "@/components/teaching-quality-panel";
import { notFound } from "next/navigation";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    section?: string;
    cohortId?: string;
    status?: string;
    from?: string;
    until?: string;
    offset?: string;
    activationId?: string;
    activationOffset?: string;
    lessonOffset?: string;
    sessionId?: string;
    tqInstructorId?: string;
    tqCohortId?: string;
    tqFrom?: string;
    tqUntil?: string;
    tqOffset?: string;
  }>;
}) {
  const data = await getAdminOverview();
  const params = await searchParams;
  const sections = adminSectionsForRoles(data.actor.roles);
  const section = sections.find(
    (s) => s.toLowerCase() === (params.section ?? "overview"),
  );
  if (!section) notFound();

  const versions = section === "Programmes" ? await getProgrammeVersions() : [];
  const resourceWorkspace =
    section === "Resources" ? await getLearningResourceWorkspace() : null;
  const [evidenceWorkspace, masteryWorkspace] =
    section === "Evidence"
      ? await Promise.all([
          getLearningEvidenceWorkspace(),
          getObjectiveMasteryWorkspace(),
        ])
      : [null, null];
  const assignmentWorkspace =
    section === "Assignments" ? await getAssignmentWorkspace() : null;
  const assessmentWorkspace =
    section === "Assessments" ? await getAssessmentWorkspace() : null;
  const notificationWorkspace =
    section === "Notifications"
      ? await getNotificationOperationsWorkspace()
      : null;
  const registrarWorkspace =
    section === "Registry" ? await getRegistrarWorkspace() : null;
  const enrolmentWorkspace =
    section === "Students" ? await getEnrolmentWorkspace() : null;
  const counsellorWorkspace =
    section === "Counsellors" ? await getCounsellorAssignmentWorkspace() : null;
  const classSessionWorkspace =
    section === "Sessions" ? await getClassSessionWorkspace() : null;
  const attendanceWorkspace =
    section === "Sessions" ? await getAttendanceWorkspace() : null;
  const lessonProgressWorkspace =
    section === "Sessions" ? await getLessonProgressWorkspace() : null;
  const sessionOperations =
    section === "Sessions"
      ? await listSessionOperations({
          cohortId: params.cohortId || undefined,
          status: params.status || undefined,
          from: params.from || undefined,
          until: params.until || undefined,
          offset: Number(params.offset || 0),
          sessionId: params.sessionId || undefined,
        })
      : null;
  const sessionBatchOptions =
    section === "Sessions"
      ? await getSessionBatchOptions({
          activationId: params.activationId || undefined,
          activationOffset: params.activationOffset || undefined,
          lessonOffset: params.lessonOffset || undefined,
        })
      : null;
  // AC-6: aggregate teaching quality. The Sessions section is already
  // limited to Academic and Platform Admin; the server and database check
  // those roles again.
  const teachingQuality =
    section === "Sessions"
      ? await getTeachingQuality({
          instructorId: params.tqInstructorId || undefined,
          cohortId: params.tqCohortId || undefined,
          from: params.tqFrom || undefined,
          until: params.tqUntil || undefined,
          offset: params.tqOffset || undefined,
        })
      : null;
  const canPublish = data.actor.roles.some(
    (role) => role === "ACADEMIC_ADMIN" || role === "PLATFORM_ADMIN",
  );

  return (
    <StaffShell
      kind="admin"
      name={data.actor.displayName}
      section={section}
      sections={sections}
      roles={data.actor.roles}
    >
      <AdminWorkspace
        section={section}
        counts={data.counts}
        programmes={data.programmes}
        audit={data.audit}
        canAudit={data.actor.roles.includes("PLATFORM_ADMIN")}
      />
      {section === "Programmes" && (
        <>
          {canPublish && (
            <Link className="button secondary" href="/admin/course-engineering">
              Course &amp; Agent Engineering
            </Link>
          )}
          {canPublish && (
            <Link className="button secondary" href="/admin/activation">
              Activate course delivery
            </Link>
          )}
          {canPublish && (
            <Link className="button secondary" href="/admin/activation/policy">
              Commercial V1 policy setup
            </Link>
          )}
          {canPublish && (
            <Link
              className="button secondary"
              href="/admin/activation/recovery"
            >
              Examiner grade recovery
            </Link>
          )}
          {canPublish && (
            <Link className="button secondary" href="/admin/commerce">
              Manage commercial offers
            </Link>
          )}
          <ProgrammePublication versions={versions} canPublish={canPublish} />
        </>
      )}
      {section === "Resources" && resourceWorkspace && (
        <LearningResourceWorkspace
          lessons={resourceWorkspace.lessons}
          resources={resourceWorkspace.resources}
        />
      )}
      {section === "Evidence" && evidenceWorkspace && (
        <LearningEvidenceWorkspace
          sessions={evidenceWorkspace.sessions}
          enrolments={evidenceWorkspace.enrolments}
          objectives={evidenceWorkspace.objectives}
          evidence={evidenceWorkspace.evidence}
        />
      )}
      {section === "Evidence" && evidenceWorkspace && masteryWorkspace && (
        <ObjectiveMasteryWorkspace
          enrolments={evidenceWorkspace.enrolments}
          mastery={masteryWorkspace.mastery}
          history={masteryWorkspace.history}
        />
      )}
      {section === "Assignments" && assignmentWorkspace && (
        <AssignmentWorkspace
          assignments={assignmentWorkspace.assignments}
          submissions={assignmentWorkspace.submissions}
          cohorts={assignmentWorkspace.cohorts}
          lessons={assignmentWorkspace.lessons}
          instructors={assignmentWorkspace.instructors}
        />
      )}
      {section === "Assessments" && assessmentWorkspace && (
        <AssessmentWorkspace
          assessments={assessmentWorkspace.assessments}
          attempts={assessmentWorkspace.attempts}
          questionsByAssessment={assessmentWorkspace.questionsByAssessment}
          cohorts={assessmentWorkspace.cohorts}
          lessons={assessmentWorkspace.lessons}
          instructors={assessmentWorkspace.instructors}
        />
      )}
      {section === "Notifications" && notificationWorkspace && (
        <NotificationWorkspace
          notifications={notificationWorkspace.notifications}
          canManage={notificationWorkspace.canManage}
          summary={notificationWorkspace.summary}
        />
      )}
      {section === "Registry" && registrarWorkspace && (
        <RegistrarWorkspace
          enrolments={registrarWorkspace.enrolments}
          attendance={registrarWorkspace.attendance}
          corrections={registrarWorkspace.corrections}
        />
      )}
      {section === "Students" && enrolmentWorkspace && (
        <EnrolmentWorkspace
          learners={enrolmentWorkspace.learners}
          cohorts={enrolmentWorkspace.cohorts}
          enrolments={enrolmentWorkspace.enrolments}
        />
      )}
      {section === "Counsellors" && counsellorWorkspace && (
        <CounsellorAssignmentWorkspace
          learners={counsellorWorkspace.learners}
          counsellors={counsellorWorkspace.counsellors}
          assignments={counsellorWorkspace.assignments}
        />
      )}
      {section === "Sessions" && classSessionWorkspace && (
        <ClassSessionWorkspace
          cohorts={classSessionWorkspace.cohorts}
          lessons={classSessionWorkspace.lessons}
          instructors={classSessionWorkspace.instructors}
          sessions={classSessionWorkspace.sessions}
          showRegister={false}
        />
      )}
      {section === "Sessions" &&
        sessionOperations &&
        sessionBatchOptions &&
        classSessionWorkspace && (
          <SessionOperationsConsole
            key={`${params.activationId || "session-register"}:${sessionBatchOptions.lessonOffset}`}
            discovery={sessionOperations}
            options={sessionBatchOptions}
            activationId={params.activationId}
            instructors={classSessionWorkspace.instructors}
            cohorts={classSessionWorkspace.cohorts}
            requestIds={Object.fromEntries(
              sessionOperations.rows.map((x) => [x.id, randomUUID()]),
            )}
            batchRequestId={randomUUID()}
            filters={{
              cohortId: params.cohortId,
              status: params.status,
              from: params.from,
              until: params.until,
              offset: params.offset,
              activationId: params.activationId,
              activationOffset: params.activationOffset,
              lessonOffset: params.lessonOffset,
              sessionId: params.sessionId,
            }}
          />
        )}
      {section === "Sessions" && teachingQuality && classSessionWorkspace && (
        <TeachingQualityPanel
          page={teachingQuality}
          instructors={classSessionWorkspace.instructors}
          cohorts={classSessionWorkspace.cohorts}
          filters={{
            tqInstructorId: params.tqInstructorId,
            tqCohortId: params.tqCohortId,
            tqFrom: params.tqFrom,
            tqUntil: params.tqUntil,
            tqOffset: params.tqOffset,
          }}
        />
      )}
      {section === "Sessions" && attendanceWorkspace && (
        <AttendanceWorkspace
          sessions={attendanceWorkspace.sessions}
          enrolments={attendanceWorkspace.enrolments}
          attendance={attendanceWorkspace.attendance}
        />
      )}
      {section === "Sessions" && lessonProgressWorkspace && (
        <LessonProgressWorkspace
          sessions={lessonProgressWorkspace.sessions}
          enrolments={lessonProgressWorkspace.enrolments}
          segments={lessonProgressWorkspace.segments}
          progress={lessonProgressWorkspace.progress}
        />
      )}
    </StaffShell>
  );
}
