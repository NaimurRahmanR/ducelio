import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  executionContentCapabilitySchema,
  type ProfessorExecutionResult,
  type ExecutionErrorCode,
  type ExecutionSnapshot,
} from "@/domain/academic-execution";
import { AuthenticationRequired, AccessDenied } from "@/domain/policy";
import { requireStudentPrincipal } from "../identity";
import { withValidatedProfessorContent } from "../academic-capabilities";
import { attestExecutionCommand, ExecutionDenied } from "./authority";

const requestSchema = z.strictObject({
  capability: executionContentCapabilitySchema,
  input: z.unknown(),
});
function failed(code: ExecutionErrorCode): ProfessorExecutionResult {
  return {
    ok: false,
    error: { code, message: "Professor execution could not be completed." },
  };
}
function normalize(error: unknown): ExecutionErrorCode {
  if (error instanceof AuthenticationRequired) return "UNAUTHENTICATED";
  if (error instanceof AccessDenied) return "FORBIDDEN";
  return error instanceof ExecutionDenied ? error.code : "SERVICE_UNAVAILABLE";
}

// No executor/provider is installed. The production B1 path deliberately ends in
// ABSTAINED/POLICY_BLOCKED and returns metadata only, never an academic answer.
export async function executeProfessorRead(
  request: unknown,
): Promise<ProfessorExecutionResult> {
  let terminal: ExecutionSnapshot | null = null;
  let controllerFailure: ExecutionErrorCode | null = null;
  try {
    await requireStudentPrincipal();
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) return failed("INVALID_INPUT");
    const executionId = randomUUID();
    const { result, releaseFinalizationFailed } =
      await withValidatedProfessorContent(parsed.data, async ({ release }) => {
        let admitted = false;
        try {
          await attestExecutionCommand(executionId, release, {
            operation: "AUTHORIZE",
            state: "AUTHORIZED",
            reason: "NONE",
          });
          admitted = true;
          await attestExecutionCommand(executionId, release, {
            operation: "START",
            state: "RUNNING",
            reason: "NONE",
          });
          terminal = await attestExecutionCommand(executionId, release, {
            operation: "FINALIZE",
            state: "ABSTAINED",
            reason: "POLICY_BLOCKED",
          });
        } catch (error) {
          controllerFailure = normalize(error);
          if (
            admitted &&
            !(error instanceof ExecutionDenied && error.databaseTerminal)
          ) {
            try {
              await attestExecutionCommand(executionId, release, {
                operation: "FINALIZE",
                state: "FAILED",
                reason: "INTERNAL_ERROR",
              });
            } catch (cleanupError) {
              // A DB policy terminal also establishes cleanup. Uncertain or
              // failed persistence must still discard the result as unavailable.
              controllerFailure =
                cleanupError instanceof ExecutionDenied &&
                cleanupError.databaseTerminal
                  ? cleanupError.code
                  : "SERVICE_UNAVAILABLE";
            }
          }
          throw new ExecutionDenied(controllerFailure);
        }
      });
    if (!result.ok) {
      // A release/audit close failure takes precedence over a controller outcome.
      if (releaseFinalizationFailed) return failed("SERVICE_UNAVAILABLE");
      if (controllerFailure) return failed(controllerFailure);
      if (result.error.code === "SERVICE_UNAVAILABLE")
        return failed("SERVICE_UNAVAILABLE");
      if (result.error.code === "NOT_FOUND_OR_FORBIDDEN")
        return failed("CONTENT_RELEASE_UNAVAILABLE");
      if (result.error.code === "CAPABILITY_UNAVAILABLE")
        return failed("INVALID_INPUT");
      return failed(result.error.code);
    }
    if (!terminal) return failed("SERVICE_UNAVAILABLE");
    return { ok: true, execution: terminal };
  } catch (error) {
    return failed(normalize(error));
  }
}
