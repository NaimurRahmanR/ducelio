"use server";
import { revalidatePath } from "next/cache";
import {
  sarahRequestSchema,
  type SarahGuideResult,
  type SarahProposalOutcome,
} from "@/domain/sarah";
import {
  decideSarahProposal,
  executeSarahGuide,
  type SarahDecisionOutcome,
} from "@/server/sarah";

export type SarahActionState = {
  status?: SarahGuideResult["status"];
  reply?: string;
  proposal?: SarahProposalOutcome;
  error?: string;
};

// The learner chooses only the intent, the message and an idempotency key.
// Learner identity, mode, capabilities, role, profile, provider, model and
// budget are all derived server-side (src/server/sarah). Any other form
// field is ignored. A raw exception never reaches the learner.
export async function askSarahAction(
  _previous: SarahActionState,
  form: FormData,
): Promise<SarahActionState> {
  const parsed = sarahRequestSchema.safeParse({
    intent: form.get("intent"),
    message: form.get("message"),
    idempotencyKey: form.get("idempotencyKey"),
  });
  if (!parsed.success)
    return { error: "Choose what you need and enter 1 to 1,000 characters." };
  let result: SarahGuideResult;
  try {
    result = await executeSarahGuide(parsed.data);
  } catch {
    return { status: "RETRY_LATER" };
  }
  if (result.status !== "SUCCEEDED") return { status: result.status };
  if (result.proposal === "PENDING_CONFIRMATION")
    revalidatePath("/student/sarah");
  return {
    status: "SUCCEEDED",
    reply: result.reply,
    proposal: result.proposal,
  };
}

export type SarahDecisionState = { outcome?: SarahDecisionOutcome };

// Only the signed-in learner confirms or declines their own proposal. The
// database derives ownership from the session; the browser supplies only
// the proposal handle and the decision.
export async function decideSarahProposalAction(
  _previous: SarahDecisionState,
  form: FormData,
): Promise<SarahDecisionState> {
  let outcome: SarahDecisionOutcome;
  try {
    outcome = await decideSarahProposal({
      proposalId: form.get("proposalId"),
      decision: form.get("decision"),
    });
  } catch {
    outcome = "UNAVAILABLE";
  }
  revalidatePath("/student/sarah");
  if (outcome === "CONFIRMED") {
    revalidatePath("/student");
    revalidatePath("/student/support");
  }
  return { outcome };
}
