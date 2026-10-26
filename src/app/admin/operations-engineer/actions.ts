"use server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import {
  executeOperation,
  interpretOperationRequest,
  prepareOperation,
  readAttachment,
  type InterpretResult,
  type PrepareResult,
  type Receipt,
} from "@/server/operations-engineer";
import { AccessDenied } from "@/domain/policy";

// Thin server-action wrappers. Authority, validation, state reads and
// execution all live in src/server/operations-engineer.ts; these only turn
// a refusal into a message instead of an error page.
export type ActionError = { status: "FORBIDDEN" | "ERROR"; message: string };

function failure(error: unknown): ActionError {
  unstable_rethrow(error);
  return error instanceof AccessDenied
    ? {
        status: "FORBIDDEN",
        message: "Your roles do not allow this operation.",
      }
    : {
        status: "ERROR",
        message: "The request could not be processed. Nothing was changed.",
      };
}

// The optional FormData carries only an attached course package file.
export async function prepareOperationAction(
  actionId: string,
  raw: Record<string, string>,
  upload?: FormData,
): Promise<PrepareResult | ActionError> {
  try {
    return await prepareOperation(
      actionId,
      raw,
      upload ? await readAttachment(upload.get("package")) : null,
    );
  } catch (error) {
    return failure(error);
  }
}

export async function interpretRequestAction(
  text: string,
): Promise<InterpretResult | ActionError> {
  try {
    return await interpretOperationRequest(text);
  } catch (error) {
    return failure(error);
  }
}

export async function executeOperationAction(
  request: {
    actionId: string;
    raw: Record<string, string>;
    issuedAt: string;
    nonce: string;
    proposalId: string;
    confirmed: boolean;
  },
  upload?: FormData,
): Promise<Receipt | ActionError> {
  try {
    const receipt = await executeOperation(
      request,
      upload ? await readAttachment(upload.get("package")) : null,
    );
    if (receipt.status === "SUCCEEDED") {
      revalidatePath("/admin", "layout");
      revalidatePath("/courses");
    }
    return receipt;
  } catch (error) {
    return failure(error);
  }
}
