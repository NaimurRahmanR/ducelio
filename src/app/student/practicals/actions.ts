"use server";
import { requestPracticalSupport } from "@/server/course-activation";
export async function requestPracticalSupportAction(
  value: unknown,
): Promise<{ ok: boolean }> {
  try {
    await requestPracticalSupport(value);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
