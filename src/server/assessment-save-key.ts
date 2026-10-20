import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";

// CP2C: the idempotency key for one learner answer save, derived on the
// server from the platform SHA-256 of the exact body that will be stored.
//
//   assessment:<attemptId>:question:<questionId>:revision:<slot>:<sha256 hex>
//
// - An identical retry (same attempt, question, revision slot and body)
//   always yields the same key, so the database replays it instead of
//   recording a second revision.
// - Different answers for the same slot get different keys (a full 256-bit
//   digest, not a short checksum), so neither is refused as a conflict.
// - The database's own idempotency authority is unchanged: a key bound to a
//   different body is still refused there.
// Maximum length is 11+36+10+36+10+6+1+64 = 174, inside the database's
// 8..200 bound.
const saveKeyInput = z.object({
  attemptId: z.uuid(),
  questionId: z.uuid(),
  revisionSlot: z.coerce.number().int().min(1).max(999999),
  body: z.string().min(1).max(20000),
});

export function answerSaveIdempotencyKey(input: unknown): string {
  const { attemptId, questionId, revisionSlot, body } =
    saveKeyInput.parse(input);
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  return `assessment:${attemptId}:question:${questionId}:revision:${revisionSlot}:${digest}`;
}
