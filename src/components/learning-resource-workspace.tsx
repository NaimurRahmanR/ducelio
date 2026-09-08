"use client";

import { useActionState } from "react";
import {
  addLearningResource,
  type LearningResourceActionState,
} from "@/app/admin/actions";
import { Badge, Card, EmptyState } from "./ui";

type Lesson = {
  id: string;
  programme_version_id: string;
  title: string;
  position: number;
  modules: { title: string; position: number };
  programme_versions: {
    label: string;
    status: "DRAFT" | "PUBLISHED";
    title_snapshot: string | null;
  };
};

type Resource = {
  id: string;
  lesson_id: string;
  programme_version_id: string;
  kind: "LECTURE_NOTE" | "REFERENCE_LINK";
  title: string;
  body: string | null;
  url: string | null;
  position: number;
  lessons: { title: string };
  programme_versions: {
    label: string;
    status: "DRAFT" | "PUBLISHED";
    title_snapshot: string | null;
  };
};

export function LearningResourceWorkspace({
  lessons,
  resources,
}: {
  lessons: Lesson[];
  resources: Resource[];
}) {
  const [state, formAction, pending] = useActionState<
    LearningResourceActionState,
    FormData
  >(addLearningResource, {});
  const draftLessons = lessons.filter(
    (lesson) => lesson.programme_versions.status === "DRAFT",
  );

  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">VERSIONED LEARNING CONTENT</p>
            <h2>Add a lecture note or reference</h2>
          </div>
          <Badge tone="blue">PHASE 2</Badge>
        </div>
        <p className="muted">
          Resources belong to a curriculum version. Published or enrolled
          curriculum is immutable; amendments require a new draft version.
        </p>
        {state.error && (
          <p className="notice error" role="alert">
            {state.error}
          </p>
        )}
        {state.message && (
          <p className="notice" role="status">
            {state.message}
          </p>
        )}
        {!draftLessons.length ? (
          <EmptyState title="No draft lessons available">
            Create resources only while their programme version is still draft.
          </EmptyState>
        ) : (
          <form action={formAction} className="support-form">
            <div className="field">
              <label htmlFor="resource-lesson">Lesson</label>
              <select id="resource-lesson" name="lessonId" required>
                <option value="">Select lesson</option>
                {draftLessons.map((lesson) => (
                  <option key={lesson.id} value={lesson.id}>
                    {lesson.programme_versions.label} · {lesson.modules.title} ·{" "}
                    {lesson.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="resource-kind">Resource type</label>
              <select id="resource-kind" name="kind" required>
                <option value="LECTURE_NOTE">LECTURE NOTE</option>
                <option value="REFERENCE_LINK">REFERENCE LINK</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="resource-title">Title</label>
              <input id="resource-title" name="title" maxLength={200} required />
            </div>
            <div className="field">
              <label htmlFor="resource-body">Lecture-note body</label>
              <textarea
                id="resource-body"
                name="body"
                maxLength={12000}
                rows={8}
                placeholder="Required for lecture notes; leave blank for a reference link."
              />
            </div>
            <div className="field">
              <label htmlFor="resource-url">HTTPS reference URL</label>
              <input
                id="resource-url"
                name="url"
                type="url"
                placeholder="https://… — required only for reference links"
              />
            </div>
            <div className="field">
              <label htmlFor="resource-position">Position</label>
              <input
                id="resource-position"
                name="position"
                type="number"
                min={1}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="resource-reason">Curriculum-change reason</label>
              <input
                id="resource-reason"
                name="reason"
                minLength={5}
                maxLength={300}
                required
              />
            </div>
            <button className="button" disabled={pending}>
              {pending ? "Adding…" : "Add resource"}
            </button>
          </form>
        )}
      </Card>

      <Card>
        <div className="section-heading">
          <h2>Learning resource register</h2>
          <Badge tone="muted">VERSIONED</Badge>
        </div>
        {resources.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Lesson</th>
                  <th>Version</th>
                  <th>Position</th>
                </tr>
              </thead>
              <tbody>
                {resources.map((resource) => (
                  <tr key={resource.id}>
                    <td>
                      <strong>{resource.title}</strong>
                      <div className="muted">
                        {resource.kind.replace("_", " ")}
                      </div>
                    </td>
                    <td>{resource.lessons.title}</td>
                    <td>
                      {resource.programme_versions.title_snapshot ?? "Draft programme"}
                      <div className="muted">
                        {resource.programme_versions.label} ·{" "}
                        {resource.programme_versions.status}
                      </div>
                    </td>
                    <td>{resource.position}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No learning resources registered">
            Lecture notes and approved HTTPS references will appear here.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
