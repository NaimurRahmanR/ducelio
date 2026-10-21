"use server";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { AccessDenied } from "@/domain/policy";
import {
  rescheduleClassSession,
  generateClassSessionBatch,
} from "@/server/session-operations";
import {
  SessionOperationError,
  sessionRefusalMessages,
} from "@/domain/session-operations";
export type SessionActionState = { error?: string; message?: string };
export async function runSessionOperation(
  _state: SessionActionState,
  data: FormData,
): Promise<SessionActionState> {
  try {
    const common = {
      requestId: data.get("requestId"),
      reason: data.get("reason"),
    };
    const kind = data.get("operation");
    const result =
      kind === "reschedule"
        ? await rescheduleClassSession({
            ...common,
            sessionId: data.get("sessionId"),
            scheduledStart: data.get("scheduledStart"),
          })
        : kind === "batch"
          ? await generateClassSessionBatch({
              ...common,
              activationId: data.get("activationId"),
              instructorId: data.get("instructorId"),
              items: JSON.parse(String(data.get("items"))),
            })
          : null;
    if (!result) return { error: sessionRefusalMessages.INVALID_INPUT };
    revalidatePath("/admin", "layout");
    revalidatePath("/student");
    return {
      message: `${result.replay ? "Existing request confirmed" : "Operation completed"}: ${result.sessionIds.length} session(s). Historical records retained. Request ${result.requestId}.`,
    };
  } catch (error) {
    return {
      error:
        error instanceof AccessDenied
          ? sessionRefusalMessages.FORBIDDEN
          : error instanceof SessionOperationError
            ? sessionRefusalMessages[error.code]
            : error instanceof ZodError || error instanceof SyntaxError
              ? sessionRefusalMessages.INVALID_INPUT
              : sessionRefusalMessages.SERVICE_UNAVAILABLE,
    };
  }
}
