"use client";
import { useRef, useState, useTransition, type ChangeEvent } from "react";
import { formatDateTime } from "./learner-format";

// Practical evidence for one scheduled lab (docs/61 §4): code, screenshots
// and files. Each file uploads in its own request (the Server Action body
// limit), then one submit attaches up to five files and the code. The
// database decides the file type from the bytes and refuses late, foreign
// or duplicate evidence; this form only reports what the service said.
export type LabFile = {
  fileId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

export type SubmittedLabEvidence = {
  evidenceId: string;
  createdAt: string;
  codeText: string | null;
  files: LabFile[];
};

type ActionResult = {
  ok?: boolean;
  error?: string;
  file?: LabFile;
  evidenceId?: string;
};
type Action = (previous: ActionResult, form: FormData) => Promise<ActionResult>;

export const LAB_FILE_ACCEPT =
  "image/png,image/jpeg,image/webp,application/pdf,text/plain,.txt";
export const LAB_FILE_MAX_BYTES = 1024 * 1024;
export const LAB_FILES_MAX = 5;
export const LAB_CODE_MAX = 20000;

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`;

export function LabEvidenceForm({
  enrolmentId,
  labRef,
  canSubmit,
  alreadySubmitted = false,
  evidence,
  unattached,
  timeZone = "UTC",
  uploadAction,
  removeAction,
  submitAction,
}: {
  enrolmentId: string;
  labRef: string;
  canSubmit: boolean; // the practical has started and access is active
  alreadySubmitted?: boolean; // a governed submission exists (any form)
  evidence: SubmittedLabEvidence | null;
  unattached: LabFile[];
  timeZone?: string;
  uploadAction: Action;
  removeAction: Action;
  submitAction: Action;
}) {
  const [files, setFiles] = useState<LabFile[]>(unattached);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const key = useRef<string | null>(null);

  if (evidence)
    return (
      <div className="ln-lab-submitted">
        <p role="status">
          Evidence submitted {formatDateTime(evidence.createdAt, timeZone)}.
          Submitted evidence cannot be changed.
        </p>
        {evidence.files.length > 0 && (
          <ul className="ln-file-list">
            {evidence.files.map((f) => (
              <li key={f.fileId}>
                <a
                  href={`/api/learner/files/${f.fileId}`}
                  target="_blank"
                  rel="noopener"
                >
                  {f.fileName}
                </a>{" "}
                <span className="ln-muted">({size(f.sizeBytes)})</span>
              </li>
            ))}
          </ul>
        )}
        {evidence.codeText && (
          <pre className="ln-code" aria-label="Submitted code">
            {evidence.codeText}
          </pre>
        )}
      </div>
    );

  if (alreadySubmitted)
    return (
      <p role="status">
        Your work for this practical has been submitted. Submitted work cannot
        be changed.
      </p>
    );

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = "";
    setMessage(null);
    startTransition(async () => {
      const problems: string[] = [];
      for (const file of chosen) {
        if (file.size > LAB_FILE_MAX_BYTES) {
          problems.push(`${file.name}: each file must be 1 MB or smaller.`);
          continue;
        }
        const form = new FormData();
        form.set("enrolmentId", enrolmentId);
        form.set("file", file);
        const result = await uploadAction({}, form);
        const added = result.file;
        if (result.ok && added) setFiles((list) => [...list, added]);
        else
          problems.push(
            `${file.name}: ${result.error ?? "the file could not be uploaded."}`,
          );
      }
      setErrors(problems);
    });
  };

  const remove = (fileId: string) => {
    setMessage(null);
    startTransition(async () => {
      const form = new FormData();
      form.set("fileId", fileId);
      const result = await removeAction({}, form);
      if (result.ok) {
        setFiles((list) => list.filter((f) => f.fileId !== fileId));
        setErrors([]);
      } else setErrors([result.error ?? "The file could not be removed."]);
    });
  };

  const submit = (form: FormData) => {
    setMessage(null);
    // One key per evidence submission: a retry after a lost response
    // replays the saved evidence instead of being refused as a duplicate.
    key.current ??= crypto.randomUUID();
    form.set("requestKey", key.current);
    form.set("enrolmentId", enrolmentId);
    form.set("labRef", labRef);
    for (const f of files) form.append("fileIds", f.fileId);
    startTransition(async () => {
      const result = await submitAction({}, form);
      if (result.ok) {
        setErrors([]);
        setMessage("Evidence submitted.");
      } else
        setErrors([result.error ?? "The evidence could not be submitted."]);
    });
  };

  const tooMany = files.length > LAB_FILES_MAX;
  return (
    <form action={submit} className="ln-form ln-lab-form">
      <fieldset disabled={pending || !canSubmit} className="ln-fieldset">
        {!canSubmit && (
          <p className="ln-blocked">
            Evidence can be submitted once the practical has started.
          </p>
        )}
        <div className="ln-field">
          <label htmlFor={`ln-lab-files-${labRef}`} className="ln-label">
            Screenshots and files
          </label>
          <p className="ln-muted" id={`ln-lab-files-hint-${labRef}`}>
            PNG, JPEG, WebP, PDF or plain text; up to {LAB_FILES_MAX} files of 1
            MB each.
          </p>
          <input
            id={`ln-lab-files-${labRef}`}
            type="file"
            multiple
            accept={LAB_FILE_ACCEPT}
            onChange={upload}
            aria-describedby={`ln-lab-files-hint-${labRef}`}
          />
        </div>
        {files.length > 0 && (
          <ul className="ln-file-list" aria-label="Files to submit">
            {files.map((f) => (
              <li key={f.fileId}>
                <span>{f.fileName}</span>{" "}
                <span className="ln-muted">({size(f.sizeBytes)})</span>{" "}
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => remove(f.fileId)}
                  aria-label={`Remove ${f.fileName}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="ln-field">
          <label htmlFor={`ln-lab-code-${labRef}`} className="ln-label">
            Code (optional)
          </label>
          <textarea
            id={`ln-lab-code-${labRef}`}
            name="codeText"
            className="ln-code-input"
            rows={8}
            maxLength={LAB_CODE_MAX}
            spellCheck={false}
          />
        </div>
        <button className="button" disabled={tooMany}>
          {pending ? "Saving…" : "Submit evidence"}
        </button>
        {tooMany && (
          <p className="ln-blocked">
            Remove files so that at most {LAB_FILES_MAX} remain.
          </p>
        )}
      </fieldset>
      <div aria-live="polite">
        {errors.map((e) => (
          <p key={e} className="ln-feedback is-error" role="alert">
            {e}
          </p>
        ))}
        {message && (
          <p className="ln-feedback" role="status">
            {message}
          </p>
        )}
      </div>
    </form>
  );
}
