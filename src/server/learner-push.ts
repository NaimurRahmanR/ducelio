import "server-only";
import webpush from "web-push";
import { z } from "zod";
import { learnerServicesConfig } from "@/lib/env";
import { callLearnerRpc } from "./learner-profile";
import {
  anonymousLearnerRpc,
  dispatchController,
  LearnerDispatchUnavailable,
  signDispatch,
  type DispatchController,
  type LearnerRpc,
} from "./learner-email";

// Push reminders (docs/61 section 4): 15 minutes before each occupied
// interval of the learner's CURRENT schedules. The database materialises
// reminders idempotently per (schedule item, subscription), cancels those of
// a superseded schedule, and records SENT only after the push service
// accepted the message. The text is privacy-safe: no course, lesson or
// assessment content ever leaves in a notification. Live delivery has not
// been verified on a real device.

// Mirrors the endpoint CHECK of learner_push_subscriptions.
const PUSH_ENDPOINT =
  /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)\/\S+$/;
export const isAllowedPushEndpoint = (endpoint: string) =>
  endpoint.length >= 20 &&
  endpoint.length <= 1000 &&
  PUSH_ENDPOINT.test(endpoint);

// PushSubscription.toJSON() from the browser.
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().refine(isAllowedPushEndpoint),
  expirationTime: z.number().int().positive().nullable().optional(),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_+/-]{40,200}={0,2}$/),
    auth: z.string().regex(/^[A-Za-z0-9_+/-]{8,100}={0,2}$/),
  }),
});

export async function subscribeMyPush(subscription: unknown) {
  const s = pushSubscriptionSchema.safeParse(subscription);
  if (!s.success) return { ok: false as const, code: "INVALID_SUBSCRIPTION" };
  return z
    .union([
      z.object({
        ok: z.literal(true),
        subscriptionId: z.uuid(),
        remindersScheduled: z.number().int(),
      }),
      z.object({ ok: z.literal(false), code: z.string() }),
    ])
    .parse(
      await callLearnerRpc("subscribe_my_push", {
        p_endpoint: s.data.endpoint,
        p_p256dh: s.data.keys.p256dh,
        p_auth: s.data.keys.auth,
        p_expires_at: s.data.expirationTime
          ? new Date(s.data.expirationTime).toISOString()
          : null,
      }),
    );
}

export async function unsubscribeMyPush(endpoint: unknown) {
  return z.object({ ok: z.literal(true), removed: z.boolean() }).parse(
    await callLearnerRpc("unsubscribe_my_push", {
      p_endpoint: z.string().max(1000).parse(endpoint),
    }),
  );
}

export async function refreshMyActivityReminders() {
  return z
    .object({
      ok: z.literal(true),
      created: z.number().int(),
      pending: z.number().int(),
      subscriptions: z.number().int(),
    })
    .parse(await callLearnerRpc("refresh_my_activity_reminders"));
}

export const upcomingRemindersSchema = z.object({
  serverTime: z.string(),
  pushEnabled: z.boolean(),
  items: z.array(
    z.object({
      itemId: z.uuid(),
      enrolmentId: z.uuid(),
      courseTitle: z.string(),
      kind: z.enum(["LESSON", "LAB", "REVISION", "ASSESSMENT"]),
      ref: z.string(),
      part: z.number().int(),
      parts: z.number().int(),
      startsAt: z.string(),
      endsAt: z.string(),
      remindAt: z.string(),
      dueNow: z.boolean(),
      pushScheduled: z.boolean(),
    }),
  ),
});
export type UpcomingReminders = z.infer<typeof upcomingRemindersSchema>;

// In-app fallback: shown whether or not push is enabled or delivered.
export async function listMyUpcomingReminders(days = 7) {
  return upcomingRemindersSchema.parse(
    await callLearnerRpc("list_my_upcoming_reminders", {
      p_days: Math.min(Math.max(Math.trunc(days), 1), 14),
    }),
  );
}

export function reminderPayload(kind: string) {
  return JSON.stringify({
    title: "Ducelio",
    body:
      kind === "LESSON"
        ? "Your class starts in 15 minutes"
        : "Your scheduled activity starts in 15 minutes",
    url: "/student/timetable",
    tag: "ducelio-activity-reminder",
  });
}

export type PushTarget = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
export interface PushSender {
  // Resolves when the push service accepted the message; rejects with an
  // object carrying the HTTP statusCode otherwise.
  send(target: PushTarget, payload: string): Promise<void>;
}
export function createWebPushSender(
  settings = learnerServicesConfig().push,
): PushSender | null {
  if (!settings.configured) return null;
  return {
    async send(target, payload) {
      await webpush.sendNotification(target, payload, {
        vapidDetails: {
          subject: settings.subject,
          publicKey: settings.publicKey,
          privateKey: settings.privateKey,
        },
        TTL: 900,
        urgency: "high",
        timeout: 10000,
      });
    },
  };
}

const claimedReminderSchema = z.object({
  reminderId: z.uuid(),
  attempt: z.number().int().min(1),
  kind: z.enum(["LESSON", "LAB", "REVISION", "ASSESSMENT"]),
  startsAt: z.string(),
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

export type PushDispatchSummary = {
  configured: boolean;
  claimed: number;
  sent: number;
  gone: number;
  retrying: number;
  failed: number;
};

export async function dispatchActivityReminders(options: {
  rpc: LearnerRpc;
  controller: DispatchController | null;
  sender: PushSender | null;
  limit?: number;
  now?: () => number;
}): Promise<PushDispatchSummary> {
  const summary: PushDispatchSummary = {
    configured: Boolean(options.sender && options.controller),
    claimed: 0,
    sent: 0,
    gone: 0,
    retrying: 0,
    failed: 0,
  };
  if (!options.sender || !options.controller) return summary;
  const { sender, controller, rpc } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const claim = z
    .union([
      z.object({
        ok: z.literal(true),
        reminders: z.array(claimedReminderSchema),
      }),
      z.object({ ok: z.literal(false), code: z.string() }),
    ])
    .parse(
      await rpc("claim_learner_push_batch", {
        p_limit: limit,
        ...signDispatch(controller, `CLAIM_PUSH\n${limit}`, now()),
      }),
    );
  if (!claim.ok) throw new LearnerDispatchUnavailable(claim.code);
  summary.claimed = claim.reminders.length;
  for (const r of claim.reminders) {
    let outcome: "SENT" | "GONE" | "FAILED" = "SENT";
    let failure: string | null = null;
    try {
      await sender.send(
        { endpoint: r.endpoint, keys: r.keys },
        reminderPayload(r.kind),
      );
    } catch (error) {
      const status =
        typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 0;
      outcome = status === 404 || status === 410 ? "GONE" : "FAILED";
      failure = status ? `PUSH_HTTP_${status}` : "PUSH_UNREACHABLE";
    }
    const recorded = z
      .object({ ok: z.boolean(), status: z.string().optional() })
      .parse(
        await rpc("complete_learner_push", {
          p_reminder_id: r.reminderId,
          p_attempt: r.attempt,
          p_outcome: outcome,
          p_error: outcome === "SENT" ? null : failure,
          ...signDispatch(
            controller,
            [
              "COMPLETE_PUSH",
              r.reminderId,
              String(r.attempt),
              outcome,
              outcome === "SENT" ? "" : (failure ?? ""),
            ].join("\n"),
            now(),
          ),
        }),
      );
    if (!recorded.ok) continue;
    if (recorded.status === "SENT") summary.sent += 1;
    else if (recorded.status === "GONE") summary.gone += 1;
    else if (recorded.status === "FAILED") summary.failed += 1;
    else summary.retrying += 1;
  }
  return summary;
}

export async function runActivityReminderDispatch() {
  return dispatchActivityReminders({
    rpc: anonymousLearnerRpc(),
    controller: dispatchController(),
    sender: createWebPushSender(),
  });
}
