import "server-only";
import { z } from "zod";
import {
  examinerAssessmentContextSchema,
  examinerLabContextSchema,
} from "@/domain/commercial-v1-examiner-grading";
import {
  RecoveryDenied,
  type RecoverySnapshot,
} from "@/domain/commercial-v1-examiner-recovery";
import { attestRecoveryContext } from "./authority";

// Strict B1 allowlist, identical to migration 202609240040's inline
// CONTEXT_READ query: authoritative questions/answer-keys/latest-response
// (assessment) or practical/policy/submission/objectives (lab) only -- never
// the original failure reason, previous marks/output, or this recovery's own
// bounded reason.
export async function getRecoveryContext(
  snapshot: RecoverySnapshot,
  recoveryReason: string,
) {
  const data = await attestRecoveryContext({
    snapshot,
    recoveryReason,
    capability: snapshot.capability,
    sourceExecutionId: snapshot.sourceExecutionId,
  });
  if (snapshot.targetKind === "ASSESSMENT_ATTEMPT") {
    const parsed = examinerAssessmentContextSchema
      .extend({ ok: z.literal(true) })
      .safeParse(data);
    if (
      !parsed.success ||
      parsed.data.attemptId !== snapshot.attemptId ||
      parsed.data.component !== snapshot.component
    )
      throw new RecoveryDenied("SERVICE_UNAVAILABLE");
    const context = examinerAssessmentContextSchema.parse(
      Object.fromEntries(
        Object.entries(parsed.data).filter(([k]) => k !== "ok"),
      ),
    );
    return { kind: "ASSESSMENT" as const, context };
  }
  const parsed = examinerLabContextSchema
    .extend({ ok: z.literal(true) })
    .safeParse(data);
  if (
    !parsed.success ||
    parsed.data.submissionId !== snapshot.submissionId ||
    parsed.data.practicalId !== snapshot.practicalId
  )
    throw new RecoveryDenied("SERVICE_UNAVAILABLE");
  const context = examinerLabContextSchema.parse(
    Object.fromEntries(Object.entries(parsed.data).filter(([k]) => k !== "ok")),
  );
  return { kind: "LAB" as const, context };
}
