import "server-only";
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import {
  isStorableTutorClassNoteBody,
  learnerTutorClassNoteListSchema,
  tutorClassNoteListRequestSchema,
  tutorClassNoteRecordResultSchema,
  type LearnerTutorClassNote,
  type TutorClassNoteRefusal,
} from "@/domain/tutor-class-notes";
import { getAuthenticatedActor, requireStudentPrincipal } from "./identity";
import { createSupabase } from "./supabase";

// AC-4 (migration 053): supplementary Tutor class notes.
//
// * recordTutorClassNote is the trusted controller's write, called only by
//   the governed Tutor runtime (src/server/tutor-lab-execution) after a
//   Tutor execution's FINALIZE has been confirmed SUCCEEDED, with that
//   execution's server-generated id and its exact learner-visible output. It
//   is attested with the SAME controller key as migrations 022/025/028/051
//   under its OWN protocol tag, and the MAC covers the body's SHA-256, so no
//   browser can submit, substitute or forge note text. The database derives
//   and verifies everything else (role, learner, release, handoff,
//   enrolment, lesson, version, provenance, firewall, revision number).
// * listMyTutorClassNotes is the learner-safe, owner-only, firewall-gated
//   read. It carries no execution, provenance, handoff or series identifier.
// No key material, MAC or canonical message ever leaves this module.

export class TutorClassNoteRefused extends Error {
  constructor(readonly code: TutorClassNoteRefusal | "SERVICE_UNAVAILABLE") {
    super("Tutor class note was not recorded.");
    this.name = "TutorClassNoteRefused";
  }
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

export async function recordTutorClassNote(input: {
  executionId: string;
  body: string;
}): Promise<{ revisionNumber: number; duplicate: boolean }> {
  const actor = await getAuthenticatedActor();
  if (!actor || !actor.roles.includes("STUDENT"))
    throw new TutorClassNoteRefused("FORBIDDEN");
  if (!isStorableTutorClassNoteBody(input.body))
    throw new TutorClassNoteRefused("INVALID_INPUT");
  const keyId = z.uuid().safeParse(process.env.ACADEMIC_EXECUTION_KEY_ID);
  const keyHex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .safeParse(process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX);
  if (!keyId.success || !keyHex.success)
    throw new TutorClassNoteRefused("SERVICE_UNAVAILABLE");
  const executionId = z.uuid().parse(input.executionId).toLowerCase();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 10;
  const canonical = [
    "DUCELIO_TUTOR_CLASS_NOTE_HMAC_SHA256_V1",
    "TUTOR",
    keyId.data.toLowerCase(),
    actor.id.toLowerCase(),
    executionId,
    sha256(input.body),
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  const mac = createHmac("sha256", Buffer.from(keyHex.data, "hex"))
    .update(canonical, "utf8")
    .digest("hex");
  const client = await createSupabase();
  const { data, error } = await client.rpc("record_tutor_class_note", {
    p_key_id: keyId.data.toLowerCase(),
    p_execution_id: executionId,
    p_body: input.body,
    p_issued_at: issuedAt,
    p_expires_at: expiresAt,
    p_mac: mac,
  });
  if (error) throw new TutorClassNoteRefused("SERVICE_UNAVAILABLE");
  const parsed = tutorClassNoteRecordResultSchema.safeParse(data);
  if (!parsed.success) throw new TutorClassNoteRefused("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new TutorClassNoteRefused(parsed.data.code);
  return {
    revisionNumber: parsed.data.revisionNumber,
    duplicate: parsed.data.duplicate,
  };
}

export type TutorClassNotePage =
  | {
      status: "OK";
      page: number;
      hasMore: boolean;
      notes: LearnerTutorClassNote[];
    }
  | { status: "ACTIVITY_BLOCKED" }
  | { status: "UNAVAILABLE" };

// The learner's own notes for one of their enrolments. Any refusal other
// than the firewall, and any malformed result, is UNAVAILABLE.
export async function listMyTutorClassNotes(
  input: unknown,
): Promise<TutorClassNotePage> {
  await requireStudentPrincipal();
  const request = tutorClassNoteListRequestSchema.safeParse(input);
  if (!request.success) return { status: "UNAVAILABLE" };
  const client = await createSupabase();
  const { data, error } = await client.rpc("list_my_tutor_class_notes", {
    p_enrolment_id: request.data.enrolmentId,
    p_page: request.data.page,
  });
  if (error) return { status: "UNAVAILABLE" };
  const parsed = learnerTutorClassNoteListSchema.safeParse(data);
  if (!parsed.success) return { status: "UNAVAILABLE" };
  if (!parsed.data.ok)
    return parsed.data.code === "ACTIVITY_BLOCKED"
      ? { status: "ACTIVITY_BLOCKED" }
      : { status: "UNAVAILABLE" };
  if (parsed.data.page !== request.data.page) return { status: "UNAVAILABLE" };
  return {
    status: "OK",
    page: parsed.data.page,
    hasMore: parsed.data.hasMore,
    notes: parsed.data.notes,
  };
}
