import "server-only";
import type { z } from "zod";
import {
  ACADEMIC_RESULTS_PAGE_SIZE,
  AcademicResultsError,
  academicEnrolmentCompletionInput,
  academicEnrolmentRecordSchema,
  academicResultDetailSchema,
  academicResultFilterOptionsSchema,
  academicResultFiltersSchema,
  academicResultPageSchema,
  academicResultRegradeInput,
  academicResultsRefusalCode,
  type AcademicResultFilters,
} from "@/domain/commercial-v1-academic-results";
import type { RegradeResult } from "@/domain/commercial-v1-examiner-regrade";
import type { CommercialV1CourseProgress } from "@/domain/commercial-v1-results-completion";
import { getAuthenticatedActor, requireAnyRole } from "./identity";
import { createSupabase } from "./supabase";
import {
  attemptCommercialV1CourseCompletion,
  getCommercialV1CourseProgress,
} from "./commercial-v1-results-completion";
import {
  regradeControlledAssessment,
  regradePracticalLab,
} from "./commercial-v1-examiner-regrade";

// Academic results operations (migration 202610020048). Only a currently
// authenticated ACADEMIC_ADMIN or PLATFORM_ADMIN with an ACTIVE account may
// read results. The role check here only avoids a pointless round trip:
// every read RPC re-derives the actor from the current session and re-checks
// the account and role in the database. Nothing here writes a
// result. Regrade and completion delegate to their existing governed
// authorities (migrations 032 and 030) with only an id and a reason.
const OPERATORS = ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"] as const;

async function requireOperator() {
  const actor = await getAuthenticatedActor();
  if (!actor || !OPERATORS.some((role) => actor.roles.includes(role)))
    throw new AcademicResultsError("FORBIDDEN");
  return actor;
}

async function resultsRpc<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    await requireOperator();
    const { data, error } = await (await createSupabase()).rpc(name, args);
    if (error)
      throw new AcademicResultsError(academicResultsRefusalCode(error.message));
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AcademicResultsError("SERVICE_UNAVAILABLE");
    return parsed.data;
  } catch (error) {
    if (error instanceof AcademicResultsError) throw error;
    throw new AcademicResultsError("SERVICE_UNAVAILABLE");
  }
}

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AcademicResultsError("INVALID_INPUT");
  return parsed.data;
}

export function parseAcademicResultFilters(
  searchParams: Record<string, string | string[] | undefined>,
): AcademicResultFilters {
  const single = Object.fromEntries(
    Object.entries(searchParams).map(([k, v]) => [
      k,
      Array.isArray(v) ? v[0] : v,
    ]),
  );
  return academicResultFiltersSchema.parse(single);
}

export async function listAcademicResults(filters: AcademicResultFilters) {
  return resultsRpc(
    "list_commercial_v1_academic_results",
    {
      p_query: filters.q || null,
      p_kind: filters.kind ?? null,
      p_cohort_id: filters.cohort ?? null,
      p_programme_version_id: filters.version ?? null,
      p_component: filters.component ?? null,
      p_practical_id: filters.practical ?? null,
      p_current_only: filters.history !== "1",
      p_completion: filters.completion ?? null,
      p_offset: filters.offset ?? 0,
    },
    academicResultPageSchema,
  );
}

export async function getAcademicResult(resultId: unknown) {
  return resultsRpc(
    "get_commercial_v1_academic_result",
    { p_result_id: input(academicResultRegradeInput.shape.resultId, resultId) },
    academicResultDetailSchema,
  );
}

export async function getAcademicEnrolmentRecord(enrolmentId: unknown) {
  return resultsRpc(
    "get_commercial_v1_academic_enrolment_record",
    {
      p_enrolment_id: input(
        academicEnrolmentCompletionInput.shape.enrolmentId,
        enrolmentId,
      ),
    },
    academicEnrolmentRecordSchema,
  );
}

async function settle<T>(run: () => Promise<T>) {
  try {
    return { value: await run(), error: null };
  } catch (error) {
    return {
      value: null,
      error:
        error instanceof AcademicResultsError
          ? error
          : new AcademicResultsError("SERVICE_UNAVAILABLE"),
    };
  }
}

export async function getAcademicResultsWorkspace(
  filters: AcademicResultFilters,
) {
  const actor = await requireAnyRole(OPERATORS);
  const [page, options] = await Promise.all([
    listAcademicResults(filters),
    resultsRpc(
      "get_commercial_v1_academic_results_filters",
      {},
      academicResultFilterOptionsSchema,
    ),
  ]);
  const selected = filters.result
    ? await settle(() => getAcademicResult(filters.result))
    : null;
  // The learner record follows the selected result, or an explicit enrolment.
  const enrolmentId = selected?.value?.enrolmentId ?? filters.enrolment;
  let record = null;
  let progress: CommercialV1CourseProgress | null = null;
  if (enrolmentId) {
    record = await settle(() => getAcademicEnrolmentRecord(enrolmentId));
    // Progress is the canonical get_commercial_v1_course_progress authority,
    // read only once the operator's record access has been re-checked.
    if (record.value)
      progress = await getCommercialV1CourseProgress(enrolmentId).catch(
        () => null,
      );
  }
  return {
    actor,
    page,
    options,
    pageSize: ACADEMIC_RESULTS_PAGE_SIZE,
    selected,
    record,
    progress,
  };
}

// Regrade through the existing institutional authority (migration 032). The
// kind (assessment vs lab) and current/valid state are re-read from the
// database for the named revision; the regrade authority then re-resolves
// every target and policy value and re-checks current/valid/ACTIVE under its
// own locks. A learner-admin's own record is refused before (detail RPC) and
// by the database (migration 048's regrade actor guard).
export async function regradeAcademicResult(
  value: unknown,
): Promise<RegradeResult> {
  const p = input(academicResultRegradeInput, value);
  const detail = await getAcademicResult(p.resultId);
  if (!detail.isCurrent) return { status: "NOT_CURRENT_RESULT" };
  if (!detail.isValid) return { status: "CURRENT_RESULT_INVALID" };
  // One claim per source revision (migration 032): an existing claim, in
  // progress or terminal, is reported instead of replayed through the
  // provider-backed path. This adds no retry or alternative authority.
  if (detail.regradeClaim)
    throw new AcademicResultsError("REGRADE_CLAIM_EXISTS");
  const command = { resultRevisionId: detail.resultId, reason: p.reason };
  return detail.kind === "ASSESSMENT"
    ? regradeControlledAssessment(command)
    : regradePracticalLab(command);
}

// Admin completion through the existing completion authority (migration
// 030), which re-derives every gate from persisted state. No second
// completion authority exists; viewing never completes.
export async function completeAcademicEnrolment(value: unknown) {
  const p = input(academicEnrolmentCompletionInput, value);
  await getAcademicEnrolmentRecord(p.enrolmentId);
  try {
    return await attemptCommercialV1CourseCompletion({
      enrolmentId: p.enrolmentId,
      reason: p.reason,
    });
  } catch {
    throw new AcademicResultsError("SERVICE_UNAVAILABLE");
  }
}
