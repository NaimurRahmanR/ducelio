"use server";
import { requestPracticalSupport } from "@/server/course-activation";
import {
  tutorLabSupportRequestSchema,
  type TutorLabRole,
} from "@/domain/tutor-lab-execution";
import { executeTutorLabSupport } from "@/server/tutor-lab-execution";

export async function requestPracticalSupportAction(
  value: unknown,
): Promise<{ ok: boolean; handoffId?: string }> {
  try {
    const handoffId = await requestPracticalSupport(value);
    return { ok: true, handoffId };
  } catch {
    return { ok: false };
  }
}

export type TutorLabSupportActionState = {
  status?:
    | "SUCCEEDED"
    | "ACTIVITY_BLOCKED"
    | "UNAVAILABLE"
    | "ESCALATED"
    | "RETRY_LATER"
    | "DUPLICATE";
  text?: string;
  role?: TutorLabRole;
  error?: string;
};

// The learner never selects a role, provider, model or budget: the exact
// destination (TUTOR or LAB_INSTRUCTOR) is derived server-side from the
// owning handoff itself (see src/server/tutor-lab-execution). This Server
// Action only validates the bounded message/idempotency-key shape before
// handing off to the governed entrypoint, and never propagates a raw
// exception to the learner.
export async function requestTutorLabSupportAction(
  _previous: TutorLabSupportActionState,
  form: FormData,
): Promise<TutorLabSupportActionState> {
  const parsed = tutorLabSupportRequestSchema.safeParse({
    handoffId: form.get("handoffId"),
    message: form.get("message"),
    idempotencyKey: form.get("idempotencyKey"),
  });
  if (!parsed.success)
    return { error: "Enter a message between 1 and 2,000 characters." };
  try {
    const result = await executeTutorLabSupport(parsed.data);
    return result.status === "SUCCEEDED"
      ? { status: "SUCCEEDED", text: result.text, role: result.role }
      : { status: result.status };
  } catch {
    return { status: "RETRY_LATER" };
  }
}
