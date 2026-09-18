import { notFound } from "next/navigation";
import { z } from "zod";
import { AcademyShell } from "@/components/academy-shell";
import { Card, Badge, ButtonLink, EmptyState } from "@/components/ui";
import { ProfessorClassroomPanel } from "@/components/professor-classroom-panel";
import { getStudentAcademy } from "@/server/academy";
import {
  openProfessorClassroom,
  getClassroomLessonContent,
} from "@/server/professor-classroom";
import { ClassroomDenied } from "@/domain/professor-classroom";

// This route is deliberately separate from the existing dynamic
// /student/[section] route (which never collides with it): the classroom is
// product/UX state anchored to one specific, ownership-verified class
// session, not another academy section. classSessionId is untrusted input
// from the URL; openProfessorClassroom independently re-derives and
// re-verifies every ownership relationship server-side before anything
// else here runs.
export default async function ClassroomPage({
  params,
}: {
  params: Promise<{ classSessionId: string }>;
}) {
  const { classSessionId: rawId } = await params;
  const parsedId = z.uuid().safeParse(rawId);
  if (!parsedId.success) notFound();

  const { actor } = await getStudentAcademy();

  let context;
  try {
    context = await openProfessorClassroom({
      classSessionId: parsedId.data,
    });
  } catch (error) {
    const message =
      error instanceof ClassroomDenied && error.code === "NOT_YET_STARTED"
        ? "This class has not started yet. Check Classes for its scheduled time."
        : error instanceof ClassroomDenied && error.code === "CANCELLED"
          ? "This class has been cancelled."
          : "This classroom is not available.";
    return (
      <AcademyShell name={actor.displayName} roles={actor.roles}>
        <div className="page-heading">
          <div>
            <p className="eyebrow">CLASSROOM</p>
            <h1>Not available</h1>
            <p>{message}</p>
          </div>
        </div>
        <ButtonLink href="/student/classes" secondary>
          ← Back to Classes
        </ButtonLink>
      </AcademyShell>
    );
  }

  const content = await getClassroomLessonContent({
    enrolmentId: context.enrolmentId,
    lessonId: context.lessonId,
  });

  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            {context.mode === "LIVE" ? "LIVE CLASS" : "CATCH-UP CLASSROOM"}
          </p>
          <h1>{context.lessonTitle}</h1>
          <p>
            {context.programmeTitle} · {context.programmeVersionLabel} ·{" "}
            {context.cohortTitle}
          </p>
        </div>
        <Badge tone={context.mode === "LIVE" ? "green" : "gold"}>
          {context.mode === "LIVE" ? "LIVE" : "CATCH UP"}
        </Badge>
      </div>
      <div className="section-content">
        <Card>
          <h2>Class schedule</h2>
          <p>
            {new Date(context.scheduledStart).toLocaleString()} –{" "}
            {new Date(context.scheduledEnd).toLocaleString()}
          </p>
          <p className="muted">Module: {context.moduleTitle}</p>
        </Card>

        {content.available ? (
          <>
            <Card>
              <h2>Lesson objectives</h2>
              {content.objectives.objectives.length ? (
                content.objectives.objectives.map((objective) => (
                  <p key={objective.objectiveId}>{objective.description}</p>
                ))
              ) : (
                <p className="muted">
                  No objectives are recorded for this lesson yet.
                </p>
              )}
            </Card>
            <Card>
              <h2>Approved resources</h2>
              {content.resources.resources.length ? (
                content.resources.resources.map((resource) => (
                  <div className="support-record" key={resource.resourceId}>
                    <Badge
                      tone={resource.kind === "LECTURE_NOTE" ? "blue" : "muted"}
                    >
                      {resource.kind.replace("_", " ")}
                    </Badge>
                    <h3>{resource.title}</h3>
                    {resource.body && (
                      <div className="lesson-resource-body">{resource.body}</div>
                    )}
                    {resource.url && (
                      <a
                        className="text-link"
                        href={resource.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open approved reference →
                      </a>
                    )}
                  </div>
                ))
              ) : (
                <p className="muted">
                  No approved resources are published for this lesson yet.
                </p>
              )}
            </Card>
            <Card>
              <div className="section-heading">
                <h2>Continue learning</h2>
                <Badge tone="muted">PRACTICE</Badge>
              </div>
              <p>
                Apply this lesson with the governed exercises and labs in
                Practicals. Tutor and Lab Instructor support stay scoped to
                your enrolled course and the selected activity.
              </p>
              <ButtonLink href="/student/practicals" secondary>
                Open practicals →
              </ButtonLink>
            </Card>
            <Card>
              <div className="section-heading">
                <h2>Your mastery</h2>
                <Badge tone="blue">MASTERY_V1</Badge>
              </div>
              {content.mastery.records.length ? (
                content.mastery.records.map((record) => (
                  <div className="support-record" key={record.objectiveId}>
                    <Badge
                      tone={
                        record.state === "DEMONSTRATED"
                          ? "green"
                          : record.state === "NEEDS_REINFORCEMENT"
                            ? "gold"
                            : record.state === "DEVELOPING"
                              ? "blue"
                              : "muted"
                      }
                    >
                      {record.state.replaceAll("_", " ")}
                    </Badge>
                    <p className="muted">
                      {record.evidenceCount} evidence records
                    </p>
                  </div>
                ))
              ) : (
                <p className="muted">
                  No objective mastery state yet for this lesson.
                </p>
              )}
            </Card>
          </>
        ) : (
          <Card>
            <EmptyState title="Content unavailable">
              Lesson content and Professor are temporarily unavailable while a
              controlled assessment is active.
            </EmptyState>
          </Card>
        )}

        <ProfessorClassroomPanel
          classSessionId={context.classSessionId}
          disabled={!content.available}
        />
      </div>
      <ButtonLink href="/student/classes" secondary>
        ← Back to Classes
      </ButtonLink>
    </AcademyShell>
  );
}
