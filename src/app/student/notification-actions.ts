"use server";

import { revalidatePath } from "next/cache";
import { markNotificationRead } from "@/server/notifications";

export type StudentNotificationActionState = {
  error?: string;
  message?: string;
};

export async function markAcademyNotificationRead(
  _state: StudentNotificationActionState,
  form: FormData,
): Promise<StudentNotificationActionState> {
  try {
    await markNotificationRead(form.get("notificationId"));
  } catch {
    return { error: "Unable to mark this notification as read." };
  }
  revalidatePath("/student/notifications");
  return { message: "Notification marked as read." };
}
