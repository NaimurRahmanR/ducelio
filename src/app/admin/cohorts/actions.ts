"use server";
import { revalidatePath } from "next/cache";
import {
  changeCohortStatus,
  createCohort,
  updateCohort,
} from "@/server/cohorts";
import { adminRefusalMessage } from "@/domain/admin-control-plane";

// Governed cohort mutations. The server layer re-derives the actor and the
// database RPC re-verifies ACADEMIC_ADMIN/PLATFORM_ADMIN and every
// lifecycle rule; refusals come back as bounded, explained messages.
export type CohortActionState = { error?: string; message?: string };

function text(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}
function optionalText(form: FormData, name: string) {
  const value = text(form, name)?.trim();
  return value ? value : null;
}
function optionalInteger(form: FormData, name: string) {
  const value = optionalText(form, name);
  return value === null ? null : Number(value);
}

function fields(form: FormData) {
  return {
    title: text(form, "title"),
    startsOn: text(form, "startsOn"),
    endsOn: optionalText(form, "endsOn"),
    capacity: optionalInteger(form, "capacity"),
    reason: text(form, "reason"),
  };
}

function refresh() {
  revalidatePath("/admin/cohorts");
  revalidatePath("/admin");
}

export async function createCohortAction(
  _state: CohortActionState,
  form: FormData,
): Promise<CohortActionState> {
  try {
    await createCohort({
      programmeVersionId: text(form, "programmeVersionId"),
      ...fields(form),
    });
    refresh();
    return { message: "Cohort created and open for enrolment." };
  } catch (error) {
    return { error: adminRefusalMessage(error) };
  }
}

export async function updateCohortAction(
  _state: CohortActionState,
  form: FormData,
): Promise<CohortActionState> {
  try {
    await updateCohort({ cohortId: text(form, "cohortId"), ...fields(form) });
    refresh();
    return { message: "Cohort details saved." };
  } catch (error) {
    return { error: adminRefusalMessage(error) };
  }
}

export async function changeCohortStatusAction(
  _state: CohortActionState,
  form: FormData,
): Promise<CohortActionState> {
  try {
    const result = await changeCohortStatus({
      cohortId: text(form, "cohortId"),
      status: text(form, "status"),
      reason: text(form, "reason"),
    });
    refresh();
    revalidatePath("/admin/commerce");
    revalidatePath("/courses");
    if (!result.changed)
      return { message: "No change: the cohort already had that status." };
    const archived = result.archivedOfferIds.length;
    return {
      message:
        result.status === "CLOSED"
          ? `Cohort closed to new enrolment.${archived ? ` ${archived} published offer${archived === 1 ? " was" : "s were"} archived.` : ""}`
          : result.status === "COMPLETED"
            ? "Cohort completed. Learner records are unchanged."
            : "Cohort reopened for enrolment.",
    };
  } catch (error) {
    return { error: adminRefusalMessage(error) };
  }
}
