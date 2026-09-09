import "server-only";
import { z } from "zod";
import { AccessDenied } from "@/domain/policy";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

const notificationSchema = z.object({
  id: z.uuid(),
  student_id: z.uuid(),
  kind: z.enum([
    "MISSED_CLASS",
    "ASSIGNMENT_DEADLINE",
    "PLAN_OVERDUE",
    "MASTERY_REINFORCEMENT",
    "SUPPORT_FOLLOWUP",
  ]),
  title: z.string(),
  body: z.string(),
  source_type: z.enum(["SUPPORT_EVENT", "SUPPORT_FOLLOWUP"]),
  source_id: z.uuid(),
  created_at: z.string(),
  read_at: z.string().nullable(),
});

const refreshResultSchema = z.object({
  openSupportEvents: z.number().int().nonnegative(),
  unreadNotifications: z.number().int().nonnegative(),
  policyVersion: z.literal("SUPPORT_V1"),
});

export async function getStudentNotifications() {
  const actor = await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client
    .from("institutional_notifications")
    .select(
      "id,student_id,kind,title,body,source_type,source_id,created_at,read_at",
    )
    .eq("student_id", actor.id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new Error("Your academy notifications could not be loaded.");
  return {
    actor,
    notifications: z.array(notificationSchema).parse(data),
  };
}

export async function markNotificationRead(input: unknown) {
  const notificationId = z.uuid().parse(input);
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client.rpc("mark_institutional_notification_read", {
    p_notification_id: notificationId,
  });
  if (error) throw new Error("Notification could not be marked as read.");
  return z.uuid().parse(data);
}

export async function getNotificationOperationsWorkspace() {
  const actor = await requireActor("admin");
  const canManage = actor.roles.some(
    (role) => role === "ACADEMIC_ADMIN" || role === "PLATFORM_ADMIN",
  );
  if (!canManage)
    return { actor, canManage: false, notifications: [], summary: null };

  const client = await createSupabase();
  const { data, error } = await client
    .from("institutional_notifications")
    .select(
      "id,student_id,kind,title,body,source_type,source_id,created_at,read_at",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error("Institutional notifications could not be loaded.");

  const notifications = z.array(notificationSchema).parse(data);
  return {
    actor,
    canManage: true,
    notifications,
    summary: {
      total: notifications.length,
      unread: notifications.filter((notification) => !notification.read_at).length,
    },
  };
}

export async function refreshDeterministicSupportTriggers(input: unknown) {
  const reason = z.string().trim().min(5).max(300).parse(input);
  const actor = await requireActor("admin");
  if (
    !actor.roles.some(
      (role) => role === "ACADEMIC_ADMIN" || role === "PLATFORM_ADMIN",
    )
  )
    throw new AccessDenied();

  const client = await createSupabase();
  const { data, error } = await client.rpc("refresh_deterministic_support_triggers", {
    p_reason: reason,
  });
  if (error)
    throw new Error("Deterministic support rules could not be evaluated.");
  return refreshResultSchema.parse(data);
}
