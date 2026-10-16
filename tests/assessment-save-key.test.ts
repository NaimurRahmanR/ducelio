import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { answerSaveIdempotencyKey } from "@/server/assessment-save-key";

// CP2C regression: the CP2 exam workspace derived its save idempotency key
// from a 32-bit FNV-1a checksum, so different answers could share a key and
// the second, genuinely different answer would be refused as a conflict.
const attemptId = "11111111-1111-4111-8111-111111111111";
const questionId = "22222222-2222-4222-8222-222222222222";
const COLLIDING = ["d27g1xbhlordy", "rae2hl0i00jow"] as const;

// The removed client checksum, kept here only to document the defect.
function legacyFnv1a(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
const key = (body: string, revisionSlot: number | string = 1, q = questionId) =>
  answerSaveIdempotencyKey({ attemptId, questionId: q, revisionSlot, body });

describe("answer save idempotency key", () => {
  it("reproduces the reported FNV-1a collision that CP2C removes", () => {
    expect(legacyFnv1a(COLLIDING[0])).toBe("09475f50");
    expect(legacyFnv1a(COLLIDING[1])).toBe("09475f50");
  });

  it("gives the two colliding answers different keys in the same slot", () => {
    expect(key(COLLIDING[0])).not.toBe(key(COLLIDING[1]));
  });

  it("is stable for an identical retry, including a slot posted as form text", () => {
    expect(key(COLLIDING[0], 3)).toBe(key(COLLIDING[0], "3"));
  });

  it("separates slots and questions", () => {
    expect(key("same answer", 1)).not.toBe(key("same answer", 2));
    expect(
      key("same answer", 1, "33333333-3333-4333-8333-333333333333"),
    ).not.toBe(key("same answer", 1));
  });

  it("embeds the full SHA-256 of the exact body and fits the database bound", () => {
    const body = '{"optionIds":["o1","o3"]}';
    const value = key(body, 999999);
    expect(value).toBe(
      `assessment:${attemptId}:question:${questionId}:revision:999999:` +
        createHash("sha256").update(body, "utf8").digest("hex"),
    );
    expect(value.length).toBeLessThanOrEqual(200);
    expect(value.length).toBeGreaterThanOrEqual(8);
  });

  it("distinguishes bodies that differ only by whitespace or Unicode form", () => {
    expect(key("answer")).not.toBe(key("answer "));
    expect(key("café")).not.toBe(key("café"));
  });

  it.each([
    { attemptId: "x", questionId, revisionSlot: 1, body: "a" },
    { attemptId, questionId, revisionSlot: 0, body: "a" },
    { attemptId, questionId, revisionSlot: "1.5", body: "a" },
    { attemptId, questionId, revisionSlot: 1, body: "" },
    { attemptId, questionId, revisionSlot: 1, body: "x".repeat(20001) },
  ])("rejects malformed input %#", (input) => {
    expect(() => answerSaveIdempotencyKey(input)).toThrow();
  });
});
