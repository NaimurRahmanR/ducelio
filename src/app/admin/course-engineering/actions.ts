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
  runCoursePackageTest,
  getCoursePackageTestStatus,
  getCoursePackagePreview,
} from "@/server/course-engineering";
import {
  AgentConfigRefused,
  setAgentConfig,
} from "@/server/academic-agent-config";
import {
  agentConfigInputSchema,
  agentRoleSchema,
} from "@/domain/academic-agent-config";
import {
  AgentBehaviourRefused,
  setAgentBehaviourConfig,
} from "@/server/agent-behaviour-config";
import {
  MAX_COURSE_UPLOAD_BYTES,
  describeTestFailure,
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
  revalidatePath("/admin", "layout");
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
          error: "Apply this package before it can be tested or published.",
        };
      // Operator-workflow readiness only, re-derived server-side. The
      // database publication authority (publish_course_package) is the
      // real gate: it independently recomputes the current fingerprint and
      // fails closed on its own even if this pre-check were ever bypassed
      // by a forged direct call.
      const status = await getCoursePackageTestStatus(p.importId);
      if (status.status !== "PASSED_CURRENT")
        return {
          error:
            "Run a pre-publication test that passes for the exact current package, materialised institutional state and agent-configuration state before publishing.",
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
    const role = agentRoleSchema.parse(data.get("role"));
    // AGENT-CONTROL-1: the browser never supplies a model profile reference.
    // It is taken from this package's own validated proposal, which can only
    // be null or the role's single code-owned profile (migration 036), so a
    // saved row can still match the proposal exactly for activation.
    const preview = await getCoursePackagePreview(id);
    if (preview.programme_version_id !== current.programme_version_id)
      return { error: "Package not found or unavailable." };
    const proposal = operatorPreviewSchema.parse(preview.preview)
      .agentConfiguration[role];
    const reason = data.get("reason");
    // The academic COUNSELLOR role has no execution path. Its row exists only
    // so the programme version matches its package, so it is recorded
    // exactly as proposed and never edited field by field.
    const input =
      role === "COUNSELLOR"
        ? agentConfigInputSchema.parse({
            programmeVersionId: current.programme_version_id,
            role,
            enabled: proposal.enabled,
            modelProfileRef: proposal.modelProfileRef,
            instructionalNotes: proposal.instructionalNotes,
            capabilities: proposal.capabilities,
            escalationPolicy: proposal.escalationPolicy,
            reason,
          })
        : agentConfigInputSchema.parse({
            programmeVersionId: current.programme_version_id,
            role,
            enabled:
              z.enum(["true", "false"]).parse(data.get("enabled")) === "true",
            modelProfileRef: proposal.modelProfileRef,
            instructionalNotes: data.get("instructionalNotes") || null,
            capabilities: data.getAll("capabilities"),
            escalationPolicy: data.get("escalationPolicy"),
            reason,
          });
    await setAgentConfig(input);
    refresh();
    return {
      message:
        role === "COUNSELLOR"
          ? "COUNSELLOR package proposal recorded for publication matching. It is not executable and does not launch Sarah or any Counsellor AI."
          : "Governed role configuration saved. Runtime and activation checks still apply.",
    };
  } catch (error) {
    if (error instanceof AgentConfigRefused)
      return {
        error:
          error.code === "AGENT_CONFIG_BINDING_CLOSED"
            ? "Not saved: learners are already enrolled on this programme version, so a role without a saved configuration cannot be added. Use a new programme version."
            : error.code === "AGENT_CONFIG_PACKAGE_MISMATCH"
              ? "Not saved: this programme version is published, so a role without a saved configuration can only be recorded exactly as the published course package proposes."
              : error.code === "AGENT_CONFIG_PACKAGE_AUTHORITY_UNAVAILABLE"
                ? "Not saved: this programme version is published and has no single published course package to record a role configuration from. Use a new programme version."
                : "Not saved: this programme version is published or has enrolments. Instructional notes, the profile reference and escalation policy are fixed, and capabilities can only be removed. You can still change availability. Use a new programme version for anything else.",
      };
    return {
      error:
        "Configuration was not saved. Check access, the applied package, role, reviewed capabilities and reason.",
    };
  }
}
// AC-2 LEVEL-3 behaviour configuration. Only the four reviewed enums and the
// bounded course context notes are accepted: there is no prompt, model,
// provider, endpoint, key or budget field, and the database (migration 051)
// refuses any change once the programme version is published or enrolled.
export async function saveAgentBehaviourAction(
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
      return { error: "Apply this package before configuring behaviour." };
    const notes = data.get("courseContextNotes");
    await setAgentBehaviourConfig({
      programmeVersionId: current.programme_version_id,
      role: data.get("role"),
      config: {
        responseDepth: data.get("responseDepth"),
        teachingApproach: data.get("teachingApproach"),
        understandingCheckFrequency: data.get("understandingCheckFrequency"),
        challengeLevel: data.get("challengeLevel"),
        courseContextNotes:
          typeof notes === "string" && notes.trim() ? notes : null,
      },
      reason: data.get("reason"),
    });
    refresh();
    return {
      message:
        "Behaviour configuration saved for this draft programme version. It is fixed once the version is published or has enrolments.",
    };
  } catch (error) {
    if (error instanceof AgentBehaviourRefused)
      return {
        error:
          "Not saved: this programme version is published or has enrolments, so its behaviour configuration is fixed. Use a new programme version.",
      };
    return {
      error:
        "Behaviour configuration was not saved. Check access, the applied package, the selected options, the notes length and the reason.",
    };
  }
}
// Runs the deterministic governed pre-publication readiness check
// (package/version/configuration integrity only -- never an external
// model/provider call). The database itself derives PASS/FAIL and persists
// an immutable ledger row either way; this action only relays the safe
// result. A FAIL is not an application error: it is returned as a message
// describing the closed failure code, exactly like validation issues.
export async function runCourseTestAction(
  _state: CourseEngineeringState,
  data: FormData,
): Promise<CourseEngineeringState> {
  try {
    await authorized();
    const id = z.uuid().parse(data.get("importId"));
    const reason = z.string().trim().min(5).max(300).parse(data.get("reason"));
    const result = await runCoursePackageTest(id, reason);
    refresh();
    return result.outcome === "PASS"
      ? {
          message:
            "Pre-publication test passed for the exact current package, materialised institutional state and agent-configuration state.",
        }
      : { error: describeTestFailure(result.failureCode, result.failedRoles) };
  } catch {
    return {
      error:
        "The pre-publication test could not be run. Check access, package state and reason.",
    };
  }
}
