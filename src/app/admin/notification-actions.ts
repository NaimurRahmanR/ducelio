"use server";

import { revalidatePath } from "next/cache";
import { refreshDeterministicSupportTriggers } from "@/server/notifications";

export type NotificationActionState = {
  error?: string;
  message?: string;
};

export async function runDeterministicSupportScan(
  _state: NotificationActionState,
  form: FormData,
): Promise<NotificationActionState> {
  try {
    const result = await refreshDeterministicSupportTriggers(form.get("reason"));
    revalidatePath("/admin");
    revalidatePath("/support");
    revalidatePath("/student/notifications");
    revalidatePath("/student/support");
    return {
      message: `${result.policyVersion} evaluated: ${result.openSupportEvents} open deterministic support events and ${result.unreadNotifications} unread notifications.`,
    };
  } catch {
    return {
      error:
        "Unable to evaluate deterministic support rules. Check your role and the bounded operational reason.",
    };
  }
}
