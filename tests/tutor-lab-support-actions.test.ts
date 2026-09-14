import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requestPracticalSupport: vi.fn(),
  executeTutorLabSupport: vi.fn(),
}));
vi.mock("@/server/course-activation", () => ({
  requestPracticalSupport: mocks.requestPracticalSupport,
}));
vi.mock("@/server/tutor-lab-execution", () => ({
  executeTutorLabSupport: mocks.executeTutorLabSupport,
}));

import {
  requestPracticalSupportAction,
  requestTutorLabSupportAction,
} from "@/app/student/practicals/actions";

const handoffId = "40000000-0000-4000-8000-000000000009";
const idempotencyKey = "40000000-0000-4000-8000-000000000010";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("requestPracticalSupportAction", () => {
  it("returns the handoff id on success so the follow-up support panel can bind to it", async () => {
    mocks.requestPracticalSupport.mockResolvedValue(handoffId);
    const result = await requestPracticalSupportAction({
      enrolmentId: "cccccccc-0000-4000-8000-000000000001",
      practicalId: "eeeeeeee-0000-4000-8000-000000000001",
      requestId: "ffffffff-0000-4000-8000-000000000001",
    });
    expect(result).toEqual({ ok: true, handoffId });
  });
  it("fails safely without leaking the raw error", async () => {
    mocks.requestPracticalSupport.mockRejectedValue(new Error("db exploded"));
    const result = await requestPracticalSupportAction({});
    expect(result).toEqual({ ok: false });
  });
});

describe("requestTutorLabSupportAction", () => {
  it("validates the bounded message/idempotency shape before ever calling the governed entrypoint", async () => {
    const result = await requestTutorLabSupportAction(
      {},
      form({ handoffId, message: "", idempotencyKey }),
    );
    expect(result.error).toBeTruthy();
    expect(mocks.executeTutorLabSupport).not.toHaveBeenCalled();
  });
  it("an overlong message is rejected before any call", async () => {
    const result = await requestTutorLabSupportAction(
      {},
      form({ handoffId, message: "x".repeat(2001), idempotencyKey }),
    );
    expect(result.error).toBeTruthy();
    expect(mocks.executeTutorLabSupport).not.toHaveBeenCalled();
  });
  it("a malformed (non-UUID) handoffId is rejected before any call", async () => {
    const result = await requestTutorLabSupportAction(
      {},
      form({ handoffId: "not-a-uuid", message: "hi", idempotencyKey }),
    );
    expect(result.error).toBeTruthy();
    expect(mocks.executeTutorLabSupport).not.toHaveBeenCalled();
  });
  it("a valid request reaches the governed entrypoint with exactly the reviewed shape -- no role/provider/model field can be smuggled in via extra form fields", async () => {
    mocks.executeTutorLabSupport.mockResolvedValue({
      status: "SUCCEEDED",
      text: "Here you go.",
      role: "TUTOR",
    });
    const result = await requestTutorLabSupportAction(
      {},
      form({
        handoffId,
        message: "  What is access control?  ",
        idempotencyKey,
        role: "LAB_INSTRUCTOR",
        provider: "attacker-controlled",
        model: "gpt-999",
        reasonCode: "PRACTICAL_HELP",
      }),
    );
    expect(result).toEqual({
      status: "SUCCEEDED",
      text: "Here you go.",
      role: "TUTOR",
    });
    expect(mocks.executeTutorLabSupport).toHaveBeenCalledExactlyOnceWith({
      handoffId,
      message: "What is access control?",
      idempotencyKey,
    });
  });
  it("an unexpected exception from the governed entrypoint becomes a safe RETRY_LATER, never a raw throw", async () => {
    mocks.executeTutorLabSupport.mockRejectedValue(
      new Error("postgres://controller:s3cr3t@db.internal/academy"),
    );
    const result = await requestTutorLabSupportAction(
      {},
      form({ handoffId, message: "hi", idempotencyKey }),
    );
    expect(result).toEqual({ status: "RETRY_LATER" });
    expect(JSON.stringify(result)).not.toMatch(/s3cr3t|postgres:\/\//i);
  });
  it.each([
    ["ACTIVITY_BLOCKED"],
    ["UNAVAILABLE"],
    ["ESCALATED"],
    ["RETRY_LATER"],
    ["DUPLICATE"],
  ] as const)("maps %s straight through as a safe status", async (status) => {
    mocks.executeTutorLabSupport.mockResolvedValue({ status });
    const result = await requestTutorLabSupportAction(
      {},
      form({ handoffId, message: "hi", idempotencyKey }),
    );
    expect(result).toEqual({ status });
  });
});
