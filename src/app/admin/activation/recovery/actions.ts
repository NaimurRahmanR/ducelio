"use server";
import { recoverExaminerTarget } from "@/server/commercial-v1-examiner-recovery/operations";
import { revalidatePath } from "next/cache";

export type RecoveryActionState = {
  status?:
    | "RECOVERED"
    | "ALREADY_RECOVERED"
    | "ESCALATED"
    | "UNAVAILABLE"
    | "RETRY_LATER"
    | "TARGET_NOT_ELIGIBLE"
    | "TARGET_NOT_FOUND";
  error?: string;
};

// The ONLY input this action accepts from the browser is sourceExecutionId
// (a hidden field, populated from the server-rendered list -- never typed)
// and a bounded reason. targetKind/capability/provider/model/marks have no
// field here at all; recoverExaminerTarget resolves routing strictly from
// authoritative server state (independent-review Finding 1).
export async function recoverExaminerTargetAction(
  _state: RecoveryActionState,
  form: FormData,
): Promise<RecoveryActionState> {
  try {
    const result = await recoverExaminerTarget({
      sourceExecutionId: form.get("sourceExecutionId"),
      reason: form.get("reason"),
    });
    revalidatePath("/admin/activation/recovery");
    revalidatePath("/admin", "layout");
    return { status: result.status };
  } catch {
    return { error: "This recovery action could not be completed." };
  }
}
