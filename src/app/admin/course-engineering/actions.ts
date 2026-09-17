"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getAuthenticatedActor } from "@/server/identity";
import {
  importCoursePackage,
  validateStagedCoursePackage,
  listCoursePackages,
  applyCoursePackage,
  publishCoursePackage,
  rejectCoursePackage,
  getCoursePackagePreview,
} from "@/server/course-engineering";
import {
  listAgentConfigs,
  setAgentConfig,
} from "@/server/academic-agent-config";
import { agentConfigInputSchema } from "@/domain/academic-agent-config";
import {
  MAX_COURSE_UPLOAD_BYTES,
  agentConfigsMatchProposal,
  operatorPreviewSchema,
  packageActionInputSchema,
  packageActions,
  safeValidationIssues,
  type CourseEngineeringState,
} from "@/domain/course-engineering-admin";

async function authorized() {
  const actor = await getAuthenticatedActor();
  if (
    !actor?.roles.some((r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN")
  )
    throw new Error("Access denied");
}
function refresh() {
  revalidatePath("/admin/course-engineering");
}
export async function importPackageAction(
  _state: CourseEngineeringState,
  data: FormData,
): Promise<CourseEngineeringState> {
  try {
    await authorized();
    const reason = z.string().trim().min(5).max(300).parse(data.get("reason"));
    const file = data.get("package");
    if (
      !(file instanceof File) ||
      !file.name.toLowerCase().endsWith(".json") ||
      file.size === 0
    )
      return { error: "Choose a non-empty JSON course package file." };
    if (file.size > MAX_COURSE_UPLOAD_BYTES)
      return { error: "Course package files must be no larger than 512 KiB." };
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        ),
      );
    } catch {
      return {
        error:
          "The file must contain valid UTF-8 JSON. Its contents have not been imported.",
      };
    }
    const importId = await importCoursePackage(parsed, reason);
    refresh();
    return {
      importId,
      message:
        "Package imported. Open its review to validate the staged content.",
    };
  } catch {
    return {
      error:
        "Import was not completed. Check your access, package identity, revision and administrative reason.",
    };
  }
}
export async function packageLifecycleAction(
  _state: CourseEngineeringState,
  data: FormData,
): Promise<CourseEngineeringState> {
  try {
    await authorized();
    const p = packageActionInputSchema.parse({
      importId: data.get("importId"),
      operation: data.get("operation"),
      reason: data.get("reason"),
    });
    const current = (await listCoursePackages()).find(
      (row) => row.id === p.importId,
    );
    if (!current) return { error: "Package not found or unavailable." };
    if (
      !packageActions(current.status).some((action) => action === p.operation)
    )
      return {
        error:
          "This action is unavailable for the current package state. Refresh the review.",
      };
    if (p.operation === "validate") {
      const result = await validateStagedCoursePackage(p.importId, p.reason);
      refresh();
      // A successful validation result contains the FULL package. Return none of it.
      return result.valid
        ? { message: "Validation passed. The package is ready to apply." }
        : {
            error:
              "Validation failed. The existing authority has rejected this revision; correct the file and import a new revision.",
            issues: safeValidationIssues(result.errors),
          };
    }
    if (p.operation === "apply") await applyCoursePackage(p.importId, p.reason);
    else if (p.operation === "publish") {
      if (!current.programme_version_id)
        return {
          error:
            "Save all five role configurations exactly as reviewed in the package proposal before publishing.",
        };
      const [rawPreview, configs] = await Promise.all([
        getCoursePackagePreview(p.importId),
        listAgentConfigs(current.programme_version_id),
      ]);
      const preview = operatorPreviewSchema.safeParse(rawPreview.preview);
      if (
        rawPreview.id !== current.id ||
        rawPreview.programme_version_id !== current.programme_version_id ||
        !preview.success ||
        !agentConfigsMatchProposal(preview.data.agentConfiguration, configs)
      )
        return {
          error:
            "Save all five role configurations exactly as reviewed in the package proposal before publishing.",
        };
      await publishCoursePackage(p.importId, p.reason);
    } else await rejectCoursePackage(p.importId, p.reason);
    refresh();
    return {
      message:
        p.operation === "apply"
          ? "Package applied. Review and save each role configuration for the new programme version."
          : p.operation === "publish"
            ? "Package published. Continue to course activation."
            : "Package rejected. Its history remains preserved.",
    };
  } catch {
    return {
      error:
        "The package operation was not completed. Refresh its state and check your access and reason.",
    };
  }
}
export async function saveCourseAgentAction(
  _state: CourseEngineeringState,
  data: FormData,
): Promise<CourseEngineeringState> {
  try {
    await authorized();
    const id = z.uuid().parse(data.get("importId"));
    const current = (await listCoursePackages()).find((row) => row.id === id);
    if (!current) return { error: "Package not found or unavailable." };
    if (
      !["APPLIED", "PUBLISHED"].includes(current.status) ||
      !current.programme_version_id
    )
      return { error: "Apply this package before configuring its agents." };
    const enabled = z.enum(["true", "false"]).parse(data.get("enabled"));
    const input = agentConfigInputSchema.parse({
      programmeVersionId: current.programme_version_id,
      role: data.get("role"),
      enabled: enabled === "true",
      modelProfileRef: data.get("modelProfileRef") || null,
      instructionalNotes: data.get("instructionalNotes") || null,
      capabilities: data.getAll("capabilities"),
      escalationPolicy: data.get("escalationPolicy"),
      reason: data.get("reason"),
    });
    await setAgentConfig(input);
    refresh();
    return {
      message:
        "Governed role configuration saved. Runtime and activation checks still apply.",
    };
  } catch {
    return {
      error:
        "Configuration was not saved. Check access, the applied package, role, reviewed capabilities and reason.",
    };
  }
}
