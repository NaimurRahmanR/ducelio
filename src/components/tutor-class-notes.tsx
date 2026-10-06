import { Badge, Card, EmptyState } from "./ui";
import {
  TUTOR_CLASS_NOTE_ACTIVITY_BLOCKED,
  TUTOR_CLASS_NOTE_DISCLOSURE,
  TUTOR_CLASS_NOTE_LABEL,
  TUTOR_CLASS_NOTE_REASON_LABEL,
  TUTOR_CLASS_NOTE_UNAVAILABLE,
  type LearnerTutorClassNote,
} from "@/domain/tutor-class-notes";
import type { TutorClassNotePage } from "@/server/tutor-class-notes";

// AC-4: the learner's own supplementary Tutor notes. Presentation only: the
// database decides what is returned (owner-only, firewall-gated). Every note
// is labelled as supplementary Tutor support, distinct from published course
// material, and never as a mark, attendance, progress, completion or mastery
// record. Note text is rendered as React text, never as HTML.
function NoteRevision({
  revision,
}: {
  revision: LearnerTutorClassNote["revisions"][number];
}) {
  return (
    <div className="support-record">
      <p className="muted">
        Revision {revision.revisionNumber}{" "}
        {revision.current ? "(current)" : "(earlier)"} · Kept{" "}
        {new Date(revision.createdAt).toLocaleString()}
      </p>
      <div className="engineering-prose">{revision.body}</div>
    </div>
  );
}

export function TutorClassNotes({ page }: { page: TutorClassNotePage }) {
  return (
    <Card>
      <div className="section-heading">
        <h2>Supplementary Tutor notes</h2>
        <Badge tone="muted">NOT COURSE MATERIAL</Badge>
      </div>
      <p>{TUTOR_CLASS_NOTE_DISCLOSURE}</p>
      {page.status === "ACTIVITY_BLOCKED" ? (
        <p role="alert">{TUTOR_CLASS_NOTE_ACTIVITY_BLOCKED}</p>
      ) : page.status === "UNAVAILABLE" ? (
        <p role="alert">{TUTOR_CLASS_NOTE_UNAVAILABLE}</p>
      ) : page.notes.length === 0 ? (
        <EmptyState title="No Tutor notes kept yet">
          When you ask the Tutor for support you can choose to keep the answer
          as a supplementary Tutor note.
        </EmptyState>
      ) : (
        page.notes.map((note, index) => {
          const [current, ...earlier] = note.revisions;
          return (
            <article
              className="support-record"
              key={`${note.createdAt}-${index}`}
              aria-label={`${TUTOR_CLASS_NOTE_LABEL}: ${note.lessonTitle}`}
            >
              <Badge tone="blue">{TUTOR_CLASS_NOTE_LABEL.toUpperCase()}</Badge>
              <h3>{note.lessonTitle}</h3>
              <p className="muted">
                {TUTOR_CLASS_NOTE_REASON_LABEL[note.reasonCode]}
                {note.objectiveDescription
                  ? ` · Objective: ${note.objectiveDescription}`
                  : ""}{" "}
                · {note.revisionCount}{" "}
                {note.revisionCount === 1 ? "revision" : "revisions"}
              </p>
              <NoteRevision revision={current} />
              {earlier.length > 0 && (
                <details>
                  <summary>
                    Earlier revisions ({earlier.length}). Each is an earlier
                    Tutor answer, kept unchanged.
                  </summary>
                  {earlier.map((revision) => (
                    <NoteRevision
                      key={revision.revisionNumber}
                      revision={revision}
                    />
                  ))}
                </details>
              )}
            </article>
          );
        })
      )}
    </Card>
  );
}
