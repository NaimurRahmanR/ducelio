"use server";
import { activateCoursePackage } from "@/server/course-activation";
import { CourseActivationError } from "@/domain/course-activation";
export async function activateCourseAction(
  value: unknown,
): Promise<{ ok: boolean; code: string }> {
  try {
    await activateCoursePackage(value);
    return { ok: true, code: "ACTIVATED" };
  } catch (e) {
    return {
      ok: false,
      code: e instanceof CourseActivationError ? e.code : "SERVICE_UNAVAILABLE",
    };
  }
}
