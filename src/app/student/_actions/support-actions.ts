"use server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { submitMySupportMessage } from "@/server/learner-support";

// Support & Feedback: (state, FormData) => { delivery?, rateLimited?,
// reference?, error? }. delivery is the real outbox state: QUEUED means
// "received, email delivery pending", never "sent".
export type SupportActionState = {
  delivery?: "QUEUED" | "SENT" | "FAILED";
  rateLimited?: boolean;
  retryAfterSeconds?: number;
  reference?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

// Fields: category (TECHNICAL|COURSE|ACCOUNT|BILLING|FEEDBACK|OTHER),
// subject (3-120), message (10-4000), optional enrolmentId, optional
// activityRef (only with enrolmentId) and optional requestKey (a UUID made
// once per form; with it a double submit is a replay, not a second message).
export async function submitSupportMessageAction(
  _previous: SupportActionState,
  form: FormData,
): Promise<SupportActionState> {
  const optional = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const subject = optional("subject") ?? "";
  const message = optional("message") ?? "";
  if (subject.length > 120 || message.length > 4000)
    return { error: "Shorten your subject or message." };
  const key = z.uuid().safeParse(optional("requestKey"));
  try {
    const result = await submitMySupportMessage({
      category: form.get("category"),
      subject,
      message,
      enrolmentId: optional("enrolmentId"),
      activityRef: optional("activityRef"),
      requestKey: key.success ? key.data : randomUUID(),
    });
    if (result.ok)
      return {
        delivery:
          result.delivery === "NOT_QUEUED" ? undefined : result.delivery,
        reference: result.messageId,
        ...(result.delivery === "NOT_QUEUED"
          ? {
              error:
                "Your message was saved but email delivery is not available.",
            }
          : {}),
      };
    if (result.code === "RATE_LIMITED")
      return {
        rateLimited: true,
        retryAfterSeconds: result.retryAfterSeconds,
        error: `You have sent several messages in the last hour. Try again in about ${Math.ceil((result.retryAfterSeconds ?? 3600) / 60)} minutes.`,
      };
    if (result.code === "EMAIL_NOT_VERIFIED")
      return { error: "Verify your email address before contacting support." };
    return {
      error: "Check the highlighted fields.",
      fieldErrors: result.fieldErrors,
    };
  } catch {
    return { error: "Your message could not be sent. Try again later." };
  }
}
