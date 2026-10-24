"use server";
import { revalidatePath } from "next/cache";
import {
  requestMyRecovery,
  reviewCourseRecovery,
} from "@/server/unified-course-activation";
export type RecoveryState = { error?: string; message?: string };
const messages: Record<string, string> = {
  RECOVERY_NOT_ELIGIBLE:
    "Recovery is available only for a missed, unsubmitted activity. Recorded attempts, submissions and progress are preserved.",
  INVALID_RECOVERY_TIME:
    "Choose a UTC start at least five minutes and no more than seven days ahead. A delayed request may need a new proposed time.",
  RECOVERY_ALREADY_REQUESTED:
    "This activity already has a pending or approved recovery request.",
  REQUEST_CONFLICT:
    "This request already records different details. Reload before trying again.",
  ACTIVITY_BLOCKED:
    "Finish the controlled assessment before requesting recovery.",
};
export async function requestRecoveryAction(
  _s: RecoveryState,
  f: FormData,
): Promise<RecoveryState> {
  try {
    const local = String(f.get("opensAt") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
      return { error: "Enter a recovery start in UTC." };
    await requestMyRecovery({
      enrolmentId: f.get("enrolmentId"),
      itemId: f.get("itemId"),
      requestKey: f.get("requestKey"),
      opensAt: local + ":00Z",
      reasonCode: f.get("reasonCode"),
    });
    revalidatePath("/student/academy");
    return {
      message:
        "Recovery requested. It opens only after academic approval, at the approved timestamp.",
    };
  } catch (e) {
    return {
      error:
        messages[e instanceof Error ? e.message : ""] ??
        "The recovery request could not be recorded.",
    };
  }
}
export async function reviewRecoveryAction(
  _s: RecoveryState,
  f: FormData,
): Promise<RecoveryState> {
  try {
    const choice = f.get("approve");
    if (choice !== "true" && choice !== "false")
      return { error: "Choose approve or deny." };
    await reviewCourseRecovery(
      f.get("requestId"),
      choice === "true",
      f.get("reason"),
    );
    revalidatePath("/admin/course-engineering");
    revalidatePath("/student/academy");
    return {
      message:
        "Recovery decision recorded. Original schedule, grades and progress are preserved.",
    };
  } catch (e) {
    return {
      error:
        messages[e instanceof Error ? e.message : ""] ??
        "The recovery decision could not be recorded.",
    };
  }
}
