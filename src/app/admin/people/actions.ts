"use server";
import { revalidatePath } from "next/cache";
import {
  grantStaffRole,
  revokeStaffRole,
  setAccountStatus,
  setStaffProfile,
} from "@/server/people";
import {
  adminRefusalMessage,
  staffRoleLabels,
  type StaffRole,
} from "@/domain/admin-control-plane";

// Every action re-enters the governed server layer, which re-derives the
// actor from the session; the database RPC re-verifies PLATFORM_ADMIN and
// every safety rule. Refusals are surfaced as bounded, explained messages.
export type PeopleActionState = { error?: string; message?: string };

function text(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

function roleLabel(role: unknown) {
  return staffRoleLabels[role as StaffRole] ?? "Role";
}

export async function saveStaffProfileAction(
  _state: PeopleActionState,
  form: FormData,
): Promise<PeopleActionState> {
  try {
    const result = await setStaffProfile({
      userId: text(form, "userId"),
      title: text(form, "title"),
      reason: text(form, "reason"),
    });
    revalidatePath("/admin/people");
    return {
      message: result.created
        ? "Staff profile created."
        : result.changed
          ? "Staff title updated."
          : "No change: the staff title was already set.",
    };
  } catch (error) {
    return { error: adminRefusalMessage(error) };
  }
}

export async function grantRoleAction(
  _state: PeopleActionState,
  form: FormData,
): Promise<PeopleActionState> {
  try {
    const result = await grantStaffRole({
      userId: text(form, "userId"),
      role: text(form, "role"),
      reason: text(form, "reason"),
    });
    revalidatePath("/admin/people");
    return {
      message: result.changed
        ? `${roleLabel(result.role)} granted.`
        : `No change: ${roleLabel(result.role)} was already held.`,
    };
  } catch (error) {
    return { error: adminRefusalMessage(error) };
  }
}

export async function revokeRoleAction(
  _state: PeopleActionState,
  form: FormData,
): Promise<PeopleActionState> {
  try {
    const result = await revokeStaffRole({
      userId: text(form, "userId"),
      role: text(form, "role"),
      reason: text(form, "reason"),
    });
    revalidatePath("/admin/people");
    return {
      message: result.changed
        ? `${roleLabel(result.role)} revoked.`
        : `No change: ${roleLabel(result.role)} was not held.`,
    };
  } catch (error) {
    return { error: adminRefusalMessage(error) };
  }
}

export async function setAccountStatusAction(
  _state: PeopleActionState,
  form: FormData,
): Promise<PeopleActionState> {
  try {
    const result = await setAccountStatus({
      userId: text(form, "userId"),
      status: text(form, "status"),
      reason: text(form, "reason"),
    });
    revalidatePath("/admin/people");
    return {
      message: !result.changed
        ? "No change: the account already had that status."
        : result.status === "DEACTIVATED"
          ? "Account deactivated. It no longer holds any application authority."
          : "Account reactivated. Its existing roles apply again.",
    };
  } catch (error) {
    return { error: adminRefusalMessage(error) };
  }
}
