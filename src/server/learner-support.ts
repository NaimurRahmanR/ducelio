import "server-only";
import { z } from "zod";
import { callLearnerRpc, hasControlCharacters } from "./learner-profile";

// Support & Feedback (docs/61 section 4). The message is stored and queued
// for support@ducelio.com through the outbox, with the learner's VERIFIED
// address (read by the database, never from the form) as reply-to. A
// database rate limit allows 5 messages per learner per rolling hour. The
// delivery state reported back is the outbox state, never assumed.
export const SUPPORT_CATEGORIES = [
  "COURSE_CONTENT",
  "TECHNICAL",
  "BILLING",
  "ACCOUNT",
  "FEEDBACK",
  "OTHER",
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export const SUPPORT_RATE_LIMIT_PER_HOUR = 5;

export const supportMessageInputSchema = z.strictObject({
  category: z.enum(SUPPORT_CATEGORIES),
  subject: z
    .string()
    .trim()
    .min(3)
    .max(150)
    .refine((s) => !hasControlCharacters(s, false), "Use a single line."),
  message: z
    .string()
    .trim()
    .min(10)
    .max(5000)
    .refine((s) => !hasControlCharacters(s, true), "Remove control characters."),
  enrolmentId: z.uuid().nullable().optional().default(null),
  activityRef: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .optional()
    .transform((s) => s || null),
  requestKey: z.uuid(),
});

export type DeliveryState = "QUEUED" | "SENT" | "FAILED" | "NOT_QUEUED";
const delivery = z.enum(["QUEUED", "SENT", "FAILED", "NOT_QUEUED"]);
export type SupportSubmitResult =
  | {
      ok: true;
      messageId: string;
      delivery: DeliveryState;
      replayed: boolean;
    }
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "RATE_LIMITED"
        | "EMAIL_NOT_VERIFIED"
        | "SERVICE_UNAVAILABLE";
      retryAfterSeconds?: number;
      fieldErrors?: Record<string, string>;
    };

export async function submitMySupportMessage(
  input: unknown,
): Promise<SupportSubmitResult> {
  const parsed = supportMessageInputSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues)
      fieldErrors[issue.path.join(".") || "form"] ??= issue.message;
    return { ok: false, code: "INVALID_INPUT", fieldErrors };
  }
  const p = parsed.data;
  const data = await callLearnerRpc("submit_my_support_message", {
    p_category: p.category,
    p_subject: p.subject,
    p_message: p.message,
    p_enrolment_id: p.enrolmentId,
    p_activity_ref: p.enrolmentId ? p.activityRef : null,
    p_request_key: p.requestKey,
  });
  const result = z
    .union([
      z.object({
        ok: z.literal(true),
        messageId: z.uuid(),
        delivery,
        replayed: z.boolean(),
      }),
      z.object({
        ok: z.literal(false),
        code: z.enum(["INVALID_INPUT", "RATE_LIMITED", "EMAIL_NOT_VERIFIED"]),
        retryAfterSeconds: z.number().int().optional(),
      }),
    ])
    .parse(data);
  return result;
}

export async function listMySupportMessages() {
  return z
    .array(
      z.object({
        messageId: z.uuid(),
        category: z.enum(SUPPORT_CATEGORIES),
        subject: z.string(),
        enrolmentId: z.uuid().nullable(),
        activityRef: z.string().nullable(),
        createdAt: z.string(),
        delivery,
      }),
    )
    .parse(await callLearnerRpc("list_my_support_messages"));
}

// Honest wording for the UI: QUEUED is "delivery pending", never "sent".
export function deliveryLabel(state: DeliveryState) {
  switch (state) {
    case "SENT":
      return "Sent to Ducelio support.";
    case "FAILED":
      return "Email delivery failed. Your message is saved; you can also write to support@ducelio.com.";
    case "QUEUED":
      return "Received. Email delivery is pending.";
    default:
      return "Received. Email delivery is not available.";
  }
}
