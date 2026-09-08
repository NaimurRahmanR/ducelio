"use client";

import { useActionState } from "react";
import {
  publishProgramme,
  type ProgrammeActionState,
} from "@/app/admin/actions";
import { Badge, Card, EmptyState } from "./ui";

type ProgrammeVersion = {
  id: string;
  label: string;
  status: "DRAFT" | "PUBLISHED";
  is_demo: boolean;
  published_at: string | null;
  programmes: {
    title: string;
    examination_body: string;
  };
};

export function ProgrammePublication({
  versions,
  canPublish,
}: {
  versions: ProgrammeVersion[];
  canPublish: boolean;
}) {
  const [state, formAction, pending] = useActionState<
    ProgrammeActionState,
    FormData
  >(publishProgramme, {});

  if (!versions.length) {
    return (
      <Card>
        <EmptyState title="No programme versions available">
          Create and validate a draft programme version before publication.
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card>
      <div className="section-heading">
        <div>
          <p className="eyebrow">GOVERNED PUBLICATION</p>
          <h2>Programme versions</h2>
        </div>
        <Badge tone="blue">PHASE 2</Badge>
      </div>

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

      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Programme</th>
              <th>Version</th>
              <th>Status</th>
              <th>Publication</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.id}>
                <td>
                  <strong>{version.programmes.title}</strong>
                  <div className="muted">
                    {version.programmes.examination_body}
                  </div>
                </td>
                <td>{version.label}</td>
                <td>
                  <Badge tone={version.status === "PUBLISHED" ? "green" : "muted"}>
                    {version.status}
                  </Badge>
                </td>
                <td>
                  {version.status === "PUBLISHED" ? (
                    <span className="muted">
                      {version.published_at
                        ? new Date(version.published_at).toLocaleString()
                        : "Published"}
                    </span>
                  ) : canPublish ? (
                    <form action={formAction} className="support-form">
                      <input
                        type="hidden"
                        name="programmeVersionId"
                        value={version.id}
                      />
                      <label htmlFor={`reason-${version.id}`}>
                        Publication reason
                      </label>
                      <input
                        id={`reason-${version.id}`}
                        name="reason"
                        minLength={5}
                        maxLength={300}
                        placeholder="Reviewed and approved for publication"
                        required
                      />
                      <button className="button" disabled={pending}>
                        {pending ? "Publishing…" : "Publish version"}
                      </button>
                    </form>
                  ) : (
                    <span className="muted">Publication permission required</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Published curriculum is immutable. Amendments require a new programme
        version.
      </p>
    </Card>
  );
}
