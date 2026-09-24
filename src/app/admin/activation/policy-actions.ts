"use server";
import { revalidatePath } from "next/cache";
import {
  bindCommercialV1AssessmentComponent,
  publishCommercialV1GradingPolicy,
} from "@/server/commercial-v1-assessment-policy";
import {
  setCommercialV1LabPolicy,
  publishCommercialV1ResultPolicy,
} from "@/server/commercial-v1-results-completion";

export type PolicyActionState = { error?: string; message?: string };

function refresh(activationId: string) {
  revalidatePath("/admin/activation/policy?activationId=" + activationId);
}

// Binds one real assessment row to one of the six fixed formal components.
// Component identity is an explicit admin-chosen enum value (see the <select>
// in the accompanying page) -- never inferred from a title or template key.
export async function bindComponentAction(
  _state: PolicyActionState,
  form: FormData,
): Promise<PolicyActionState> {
  const activationId = String(form.get("activationId") ?? "");
  try {
    await bindCommercialV1AssessmentComponent({
      activationId,
      component: form.get("component"),
      assessmentId: form.get("assessmentId"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to bind this component. Check that the assessment belongs to this activation, has exactly one attempt allowed, and that no policy is published yet.",
    };
  }
  refresh(activationId);
  return { message: "Component bound." };
}

// No weight/profile/lab-presence parameter exists on this form -- the
// published policy is always server-derived from the activation's own
// bindings and practical content.
export async function publishGradingPolicyAction(
  _state: PolicyActionState,
  form: FormData,
): Promise<PolicyActionState> {
  const activationId = String(form.get("activationId") ?? "");
  try {
    await publishCommercialV1GradingPolicy({
      activationId,
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to publish the grading policy. All six components must be bound with no existing attempt history, in the correct non-overlapping institutional sequence.",
    };
  }
  refresh(activationId);
  return { message: "Grading policy published." };
}

export async function setLabPolicyAction(
  _state: PolicyActionState,
  form: FormData,
): Promise<PolicyActionState> {
  const activationId = String(form.get("activationId") ?? "");
  try {
    await setCommercialV1LabPolicy({
      activationId,
      practicalId: form.get("practicalId"),
      maxMarks: Number(form.get("maxMarks")),
      contributionBp: Number(form.get("contributionBp")),
      gradingGuidance: form.get("gradingGuidance") || null,
      reason: form.get("reason"),
    });
  } catch {
    return { error: "Unable to save this lab policy." };
  }
  refresh(activationId);
  return { message: "Lab policy saved." };
}

// No universal pass mark exists anywhere in Ducelio -- passMarkBp is
// explicit, bounded, institution-supplied input, never a hardcoded default.
export async function publishResultPolicyAction(
  _state: PolicyActionState,
  form: FormData,
): Promise<PolicyActionState> {
  const activationId = String(form.get("activationId") ?? "");
  try {
    await publishCommercialV1ResultPolicy({
      activationId,
      passMarkBp: Number(form.get("passMarkBp")),
      requireRemediationClearForCompletion:
        form.get("requireRemediationClear") === "on",
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to publish the result policy. A grading policy must exist first, and every PRACTICAL_LAB in this course needs its own lab policy summing to the fixed 20% contribution.",
    };
  }
  refresh(activationId);
  return { message: "Result policy published." };
}
