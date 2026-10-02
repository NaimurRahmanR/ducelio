import "server-only";
import { z } from "zod";
import {
  cohortCreateInput,
  cohortRosterSchema,
  cohortStatusInput,
  cohortStatusSchema,
  cohortUpdateInput,
  cohortWorkspaceSchema,
} from "@/domain/admin-control-plane";
import { requireAnyRole } from "./identity";
import { adminControlRpc, adminInput } from "./admin-control-rpc";

// Cohort control plane: ACADEMIC_ADMIN or PLATFORM_ADMIN (curriculum/
// delivery authority). REGISTRAR correction authority is not cohort
// authority. The roster reads the canonical enrolments table through a
// bounded projection; there is no second enrolment source of truth.
const COHORT_ADMIN = ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"] as const;

export async function getCohortWorkspace(selectedCohortId?: string | null) {
  const actor = await requireAnyRole(COHORT_ADMIN);
  const selected = z.uuid().safeParse(selectedCohortId);
  const [workspace, roster] = await Promise.all([
    adminControlRpc(
      COHORT_ADMIN,
      "admin_cohort_workspace",
      {},
      cohortWorkspaceSchema,
    ),
    selected.success
      ? adminControlRpc(
          COHORT_ADMIN,
          "admin_cohort_roster",
          { p_cohort_id: selected.data },
          cohortRosterSchema,
        ).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { actor, workspace, roster };
}

export async function createCohort(value: unknown) {
  const p = adminInput(cohortCreateInput, value);
  return adminControlRpc(
    COHORT_ADMIN,
    "admin_create_cohort",
    {
      p_programme_version_id: p.programmeVersionId,
      p_title: p.title,
      p_starts_on: p.startsOn,
      p_ends_on: p.endsOn,
      p_capacity: p.capacity,
      p_reason: p.reason,
    },
    z.uuid(),
  );
}

export async function updateCohort(value: unknown) {
  const p = adminInput(cohortUpdateInput, value);
  return adminControlRpc(
    COHORT_ADMIN,
    "admin_update_cohort",
    {
      p_cohort_id: p.cohortId,
      p_title: p.title,
      p_starts_on: p.startsOn,
      p_ends_on: p.endsOn,
      p_capacity: p.capacity,
      p_reason: p.reason,
    },
    z.uuid(),
  );
}

export async function changeCohortStatus(value: unknown) {
  const p = adminInput(cohortStatusInput, value);
  return adminControlRpc(
    COHORT_ADMIN,
    "admin_change_cohort_status",
    { p_cohort_id: p.cohortId, p_status: p.status, p_reason: p.reason },
    z.object({
      cohortId: z.uuid(),
      status: cohortStatusSchema,
      changed: z.boolean(),
      archivedOfferIds: z.array(z.uuid()),
    }),
  );
}
