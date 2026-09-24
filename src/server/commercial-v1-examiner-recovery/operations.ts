import "server-only";
import {
  recoveryInputSchema,
  recoveryTargetSchema,
  recoveryTargetListSchema,
  type RecoveryTarget,
  type AdminRecoveryActionResult,
} from "@/domain/commercial-v1-examiner-recovery";
import { requireRecoveryActor } from "./authority";
import { createSupabase } from "../supabase";
import {
  recoverControlledAssessmentGrade,
  recoverPracticalLabGrade,
} from "./index";

// Independent-review Finding 1: the bounded admin discovery/action surface
// that makes migration 040's already-governed recovery authority
// operationally reachable. This module adds NO new grading/recovery
// authority of its own -- it composes migration 202609240041's two bounded
// reads with the exact two entrypoints Checkpoint A already built and
// tested (recoverControlledAssessmentGrade/recoverPracticalLabGrade in
// ./index), never re-implementing any admission/eligibility/HMAC logic.

// Bounded worklist for an ACADEMIC_ADMIN/PLATFORM_ADMIN: every stranded
// target eligible for recovery, plus the correct status for a target that
// already has a recovery claim (see recoveryTargetStatusSchema). Admin-gated
// twice -- here, and again independently inside the RPC itself -- exactly
// mirroring every other admin server wrapper in this codebase (e.g.
// bindCommercialV1AssessmentComponent).
export async function listRecoverableExaminerTargets(): Promise<
  RecoveryTarget[]
> {
  await requireRecoveryActor();
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "list_commercial_v1_examiner_recovery_targets",
  );
  if (error) throw new Error("Recovery targets could not be loaded.");
  return recoveryTargetListSchema.parse(data).targets;
}

// Resolves ONE target's authoritative capability/targetKind from the
// database -- never from caller input. This is the server-owned routing
// decision the review requires: the composed action below dispatches to the
// correct existing recovery entrypoint strictly based on what this lookup
// returns, never on anything a form could supply.
async function resolveRecoveryTarget(
  sourceExecutionId: string,
): Promise<RecoveryTarget | null> {
  try {
    const client = await createSupabase();
    const { data, error } = await client.rpc(
      "get_commercial_v1_examiner_recovery_target",
      { p_source_execution_id: sourceExecutionId },
    );
    if (error) return null;
    return recoveryTargetSchema.parse(data);
  } catch {
    return null;
  }
}

// THE single institutional recovery composition. Input is ONLY
// {sourceExecutionId, reason} -- recoveryInputSchema is reused verbatim, the
// exact same strictObject Checkpoint A already validated, so there is no
// separate, possibly-drifting input contract for this admin-facing entry.
// A browser cannot supply targetKind/capability/provider/model/marks: the
// schema has no such field, and even a caller bypassing this schema in
// TypeScript could not smuggle one through, because resolveRecoveryTarget
// above is the ONLY source this function ever reads capability/targetKind
// from.
export async function recoverExaminerTarget(
  input: unknown,
): Promise<AdminRecoveryActionResult> {
  const parsed = recoveryInputSchema.safeParse(input);
  if (!parsed.success) return { status: "UNAVAILABLE" };
  try {
    await requireRecoveryActor();
  } catch {
    return { status: "UNAVAILABLE" };
  }
  const target = await resolveRecoveryTarget(parsed.data.sourceExecutionId);
  if (!target) return { status: "TARGET_NOT_FOUND" };
  return target.capability === "grade_controlled_assessment"
    ? recoverControlledAssessmentGrade(parsed.data)
    : recoverPracticalLabGrade(parsed.data);
}
