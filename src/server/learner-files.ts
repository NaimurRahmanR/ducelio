import "server-only";
import { z } from "zod";
import { callLearnerRpc, LearnerServiceError } from "./learner-profile";

// PostgreSQL-backed private files (docs/61 section 4). The content type is
// decided by the bytes, never by the browser's declaration; the database
// repeats the size, type and signature checks in CHECK constraints.
export const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;
export const MAX_LAB_EVIDENCE_FILES = 5;
export const MAX_LAB_CODE_CHARACTERS = 20000;
export const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const LAB_EVIDENCE_TYPES = [
  ...PHOTO_TYPES,
  "application/pdf",
  "text/plain",
] as const;
export type PrivateFileType = (typeof LAB_EVIDENCE_TYPES)[number];
export type PrivateFilePurpose = "PROFILE_PHOTO" | "LAB_EVIDENCE";

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((b, i) => bytes[offset + i] === b);

// Magic-byte sniffing. Plain text must be valid UTF-8 without NUL or other
// binary control bytes (tab, line feed, carriage return and form feed are
// ordinary text).
export function sniffContentType(bytes: Uint8Array): PrivateFileType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return "image/webp";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]))
    return "application/pdf";
  for (const b of bytes)
    if (b === 0 || b === 0x7f || (b < 0x20 && ![9, 10, 12, 13].includes(b)))
      return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "text/plain";
  } catch {
    return null;
  }
}

export type FileCheck =
  | { ok: true; contentType: PrivateFileType }
  | {
      ok: false;
      code:
        "EMPTY_FILE" | "FILE_TOO_LARGE" | "UNSUPPORTED_TYPE" | "TYPE_MISMATCH";
    };

const GENERIC_TYPES = new Set(["", "application/octet-stream"]);
export function checkPrivateFile(
  purpose: PrivateFilePurpose,
  bytes: Uint8Array,
  declaredType = "",
): FileCheck {
  if (bytes.length === 0) return { ok: false, code: "EMPTY_FILE" };
  if (bytes.length > MAX_PRIVATE_FILE_BYTES)
    return { ok: false, code: "FILE_TOO_LARGE" };
  const sniffed = sniffContentType(bytes);
  const allowed: readonly string[] =
    purpose === "PROFILE_PHOTO" ? PHOTO_TYPES : LAB_EVIDENCE_TYPES;
  if (!sniffed || !allowed.includes(sniffed))
    return { ok: false, code: "UNSUPPORTED_TYPE" };
  const declared = declaredType.split(";")[0].trim().toLowerCase();
  if (!GENERIC_TYPES.has(declared) && declared !== sniffed)
    return { ok: false, code: "TYPE_MISMATCH" };
  return { ok: true, contentType: sniffed };
}

export function sanitizeFileName(name: string) {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._() -]/g, "_")
    .trim()
    .slice(0, 120);
  return cleaned || "file";
}

export type UploadInput = {
  purpose: PrivateFilePurpose;
  enrolmentId?: string | null;
  name: string;
  type: string;
  bytes: Uint8Array;
};
const uploadResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    fileId: z.uuid(),
    fileName: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    sha256: z.string(),
  }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);
export type UploadResult = z.infer<typeof uploadResultSchema>;

export async function uploadMyPrivateFile(
  input: UploadInput,
): Promise<UploadResult> {
  const checked = checkPrivateFile(input.purpose, input.bytes, input.type);
  if (!checked.ok) return checked;
  const enrolmentId =
    input.purpose === "LAB_EVIDENCE" ? z.uuid().parse(input.enrolmentId) : null;
  return uploadResultSchema.parse(
    await callLearnerRpc("upload_my_private_file", {
      p_purpose: input.purpose,
      p_enrolment_id: enrolmentId,
      p_file_name: sanitizeFileName(input.name),
      p_content_type: checked.contentType,
      p_content_base64: Buffer.from(input.bytes).toString("base64"),
    }),
  );
}

const storedFileSchema = z.object({
  fileId: z.uuid(),
  fileName: z.string(),
  contentType: z.enum(LAB_EVIDENCE_TYPES),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  createdAt: z.string(),
  contentBase64: z.string(),
});
export type StoredPrivateFile = Omit<
  z.infer<typeof storedFileSchema>,
  "contentBase64"
> & { bytes: Uint8Array };

// Owner, or a reviewer of the course's own organisation for attached lab
// evidence (decided by the database). Returns null when not visible.
export async function readPrivateFile(
  fileId: unknown,
): Promise<StoredPrivateFile | null> {
  const id = z.uuid().safeParse(fileId);
  if (!id.success) return null;
  try {
    const { contentBase64, ...file } = storedFileSchema.parse(
      await callLearnerRpc("read_private_file", { p_file_id: id.data }, "any"),
    );
    return {
      ...file,
      bytes: new Uint8Array(Buffer.from(contentBase64, "base64")),
    };
  } catch (error) {
    if (
      error instanceof LearnerServiceError &&
      ["NOT_FOUND_OR_FORBIDDEN", "FORBIDDEN"].includes(error.code)
    )
      return null;
    throw error;
  }
}

export async function deleteMyPrivateFile(fileId: unknown) {
  return z.object({ ok: z.boolean(), code: z.string().optional() }).parse(
    await callLearnerRpc("delete_my_private_file", {
      p_file_id: z.uuid().parse(fileId),
    }),
  );
}

const evidenceSchema = z.object({
  evidenceId: z.uuid(),
  enrolmentId: z.uuid(),
  labRef: z.string(),
  codeText: z.string().nullable(),
  createdAt: z.string(),
  files: z.array(
    z.object({
      fileId: z.uuid(),
      fileName: z.string(),
      contentType: z.string(),
      sizeBytes: z.number().int(),
      sha256: z.string(),
    }),
  ),
});
export type LabEvidence = z.infer<typeof evidenceSchema>;

export const labEvidenceInputSchema = z.strictObject({
  enrolmentId: z.uuid(),
  labRef: z.string().min(1).max(80),
  fileIds: z.array(z.uuid()).max(MAX_LAB_EVIDENCE_FILES).default([]),
  // Code keeps its exact formatting (indentation and blank lines).
  codeText: z
    .string()
    .max(MAX_LAB_CODE_CHARACTERS)
    .nullable()
    .optional()
    .transform((s) => (s && s.trim() ? s : null)),
  requestKey: z.uuid(),
});

export async function submitMyLabEvidence(input: unknown) {
  const p = labEvidenceInputSchema.parse(input);
  return z
    .union([
      z.object({
        ok: z.literal(true),
        replayed: z.boolean(),
        evidence: evidenceSchema,
      }),
      z.object({ ok: z.literal(false), code: z.string() }),
    ])
    .parse(
      await callLearnerRpc("submit_my_lab_evidence", {
        p_enrolment_id: p.enrolmentId,
        p_lab_ref: p.labRef,
        p_file_ids: p.fileIds,
        p_code_text: p.codeText,
        p_request_key: p.requestKey,
      }),
    );
}

const evidenceEnvelope = z.object({ evidence: evidenceSchema.nullable() });
export async function getMyLabEvidence(enrolmentId: unknown, labRef: unknown) {
  return evidenceEnvelope.parse(
    await callLearnerRpc("get_my_lab_evidence", {
      p_enrolment_id: z.uuid().parse(enrolmentId),
      p_lab_ref: z.string().min(1).max(80).parse(labRef),
    }),
  ).evidence;
}

// For a reviewer of the course's own organisation. The calling page must
// still check the actor holds a reviewer role; the database refuses others.
export async function getLabEvidenceForReview(
  enrolmentId: unknown,
  labRef: unknown,
) {
  return evidenceEnvelope.parse(
    await callLearnerRpc(
      "get_lab_evidence_for_review",
      {
        p_enrolment_id: z.uuid().parse(enrolmentId),
        p_lab_ref: z.string().min(1).max(80).parse(labRef),
      },
      "any",
    ),
  ).evidence;
}

const unattachedSchema = z.array(
  z.object({
    fileId: z.uuid(),
    fileName: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int(),
  }),
);
export type UnattachedLabFile = z.infer<typeof unattachedSchema>[number];

// The caller's uploads for this enrolment not yet attached to evidence
// (metadata only), so the lab form can resume or remove them.
export async function listMyUnattachedLabFiles(enrolmentId: unknown) {
  return unattachedSchema.parse(
    await callLearnerRpc("list_my_unattached_lab_files", {
      p_enrolment_id: z.uuid().parse(enrolmentId),
    }),
  );
}
