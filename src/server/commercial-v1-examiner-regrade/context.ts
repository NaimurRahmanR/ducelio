import "server-only";
import { z } from "zod";
import {
  examinerAssessmentContextSchema,
  examinerLabContextSchema,
} from "@/domain/commercial-v1-examiner-grading";
import {
  RegradeDenied,
  type RegradeSnapshot,
} from "@/domain/commercial-v1-examiner-regrade";
import { attestRegradeContext } from "./authority";

export async function getRegradeContext(
  snapshot: RegradeSnapshot,
  requestReason: string,
) {
  const data = await attestRegradeContext({
    snapshot,
    requestReason,
    capability: snapshot.capability,
    sourceResultRevisionId: snapshot.sourceResultRevisionId,
  });
  // Strict B1 allowlist excludes old grades, outcomes, digest and admin reason.
  if (snapshot.targetKind === "ASSESSMENT_ATTEMPT") {
    const parsed = examinerAssessmentContextSchema
      .extend({ ok: z.literal(true) })
      .safeParse(data);
    if (
      !parsed.success ||
      parsed.data.attemptId !== snapshot.attemptId ||
      parsed.data.component !== snapshot.component
    )
      throw new RegradeDenied("SERVICE_UNAVAILABLE");
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
    throw new RegradeDenied("SERVICE_UNAVAILABLE");
  const context = examinerLabContextSchema.parse(
    Object.fromEntries(Object.entries(parsed.data).filter(([k]) => k !== "ok")),
  );
  return { kind: "LAB" as const, context };
}
