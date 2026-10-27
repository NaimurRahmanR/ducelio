"use server";
import { revalidatePath } from "next/cache";
import {
  deleteMyPrivateFile,
  MAX_PRIVATE_FILE_BYTES,
  submitMyLabEvidence,
  uploadMyPrivateFile,
} from "@/server/learner-files";

// Practical evidence. Files upload ONE PER CALL (each request stays within
// the 1200 kB Server Action body limit), then submitLabEvidenceAction attaches
// up to five uploaded file ids plus optional code text to one practical.
export type LabArtifactActionState = {
  ok?: boolean;
  error?: string;
  code?: string;
  file?: {
    fileId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  };
  evidenceId?: string;
};

const MESSAGES: Record<string, string> = {
  EMPTY_FILE: "Choose a file to upload.",
  FILE_TOO_LARGE: "Each file must be 1 MB or smaller.",
  UNSUPPORTED_TYPE: "Use PNG, JPEG, WebP, PDF or plain text files.",
  TYPE_MISMATCH: "The file content does not match its type.",
  INVALID_FILE: "That file cannot be attached.",
  QUOTA_EXCEEDED: "Remove unattached uploads before adding more.",
  TOO_MANY_FILES: "Attach at most five files.",
  EMPTY_EVIDENCE: "Add at least one file or your code.",
  EVIDENCE_EXISTS: "Evidence for this practical has already been submitted.",
  LAB_NOT_OPEN: "This practical is not open yet.",
  ACCESS_REVOKED: "Your access to this course has ended.",
  REQUEST_CONFLICT: "Reload the page and try again.",
  INVALID_INPUT: "Check your evidence and try again.",
};
const failed = (code: string): LabArtifactActionState => ({
  ok: false,
  code,
  error: MESSAGES[code] ?? "The evidence could not be saved. Try again later.",
});

// Form fields: enrolmentId, file (File).
export async function uploadLabEvidenceFileAction(
  _previous: LabArtifactActionState,
  form: FormData,
): Promise<LabArtifactActionState> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return failed("EMPTY_FILE");
  if (file.size > MAX_PRIVATE_FILE_BYTES) return failed("FILE_TOO_LARGE");
  try {
    const result = await uploadMyPrivateFile({
      purpose: "LAB_EVIDENCE",
      enrolmentId: String(form.get("enrolmentId") ?? ""),
      name: file.name,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    if (!result.ok) return failed(result.code);
    return {
      ok: true,
      file: {
        fileId: result.fileId,
        fileName: result.fileName,
        contentType: result.contentType,
        sizeBytes: result.sizeBytes,
      },
    };
  } catch {
    return failed("SERVICE_UNAVAILABLE");
  }
}

// Form field: fileId (an uploaded, not yet attached file).
export async function removeLabEvidenceFileAction(
  _previous: LabArtifactActionState,
  form: FormData,
): Promise<LabArtifactActionState> {
  try {
    const result = await deleteMyPrivateFile(form.get("fileId"));
    return result.ok ? { ok: true } : failed(result.code ?? "INVALID_FILE");
  } catch {
    return failed("SERVICE_UNAVAILABLE");
  }
}

// Form fields: enrolmentId, labRef, requestKey (a UUID generated once per
// form so a resubmission replays), fileIds (repeated), codeText (optional,
// formatting preserved).
export async function submitLabEvidenceAction(
  _previous: LabArtifactActionState,
  form: FormData,
): Promise<LabArtifactActionState> {
  try {
    const code = form.get("codeText");
    const result = await submitMyLabEvidence({
      enrolmentId: form.get("enrolmentId"),
      labRef: form.get("labRef"),
      requestKey: form.get("requestKey"),
      fileIds: form.getAll("fileIds").map(String),
      codeText: typeof code === "string" ? code : null,
    });
    if (!result.ok) return failed(result.code);
    revalidatePath(`/student/courses/${result.evidence.enrolmentId}`);
    return { ok: true, evidenceId: result.evidence.evidenceId };
  } catch {
    return failed("INVALID_INPUT");
  }
}
