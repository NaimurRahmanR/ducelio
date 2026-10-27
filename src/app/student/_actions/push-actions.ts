"use server";
import {
  refreshMyActivityReminders,
  subscribeMyPush,
  unsubscribeMyPush,
} from "@/server/learner-push";

// Called from a client component after PushManager.subscribe() with
// JSON.parse(JSON.stringify(subscription)) (endpoint, expirationTime, keys).
// The browser key is NEXT_PUBLIC_VAPID_PUBLIC_KEY; when it is unset the UI
// must not offer push and should show the in-app reminders only.
export async function subscribePushAction(
  subscription: unknown,
): Promise<{ ok: boolean; code?: string; remindersScheduled?: number }> {
  try {
    const result = await subscribeMyPush(subscription);
    return result.ok
      ? { ok: true, remindersScheduled: result.remindersScheduled }
      : { ok: false, code: result.code };
  } catch {
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
}

export async function unsubscribePushAction(
  endpoint: unknown,
): Promise<{ ok: boolean; removed?: boolean }> {
  try {
    const result = await unsubscribeMyPush(endpoint);
    return { ok: true, removed: result.removed };
  } catch {
    return { ok: false };
  }
}

export async function refreshRemindersAction(): Promise<{
  ok: boolean;
  pending?: number;
}> {
  try {
    const result = await refreshMyActivityReminders();
    return { ok: true, pending: result.pending };
  } catch {
    return { ok: false };
  }
}
