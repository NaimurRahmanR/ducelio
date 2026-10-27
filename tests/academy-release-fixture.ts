import type { Query } from "./academy-fixture";

// Release fixtures for migration 075 (docs/61 section 3). An assessment's
// results are RELEASED only once its window has closed, so suites move the
// enrolment's CURRENT assessment item into the past as the database owner
// (the history guard is bypassed explicitly, which no RPC can do). Unified
// windows derive from starts_at (+1439 minutes); historical Academy sittings
// keep their stored opens_at/closes_at, so both are moved.
export async function closeSittingNow(
  q: Query,
  enrolmentId: string,
  ref: string,
) {
  await q(
    "alter table public.academy_schedule_items disable trigger guard_history",
  );
  try {
    await q(
      `update public.academy_schedule_items
         set starts_at = now() - interval '25 hours', ends_at = now() - interval '25 hours' + make_interval(mins => minutes),
             opens_at = now() - interval '25 hours', closes_at = now() - interval '1 second'
       where enrolment_id = $1 and kind = 'ASSESSMENT' and ref = $2
         and schedule_id = (select id from public.academy_schedules where enrolment_id = $1 and superseded_at is null)`,
      [enrolmentId, ref],
    );
  } finally {
    await q(
      "alter table public.academy_schedule_items enable trigger guard_history",
    );
  }
}

// Move one assessment's window so it closes at now() + p_closes_in while it
// opened in the past (historical sittings: stored window; unified sittings:
// derived from starts_at).
export async function sittingClosesIn(
  q: Query,
  enrolmentId: string,
  ref: string,
  closesIn: string,
) {
  await q(
    "alter table public.academy_schedule_items disable trigger guard_history",
  );
  try {
    await q(
      `update public.academy_schedule_items
         set starts_at = now() + $3::interval - interval '1439 minutes',
             ends_at = now() + $3::interval - interval '1439 minutes' + make_interval(mins => minutes),
             opens_at = now() + $3::interval - interval '1439 minutes', closes_at = now() + $3::interval
       where enrolment_id = $1 and kind = 'ASSESSMENT' and ref = $2
         and schedule_id = (select id from public.academy_schedules where enrolment_id = $1 and superseded_at is null)`,
      [enrolmentId, ref, closesIn],
    );
  } finally {
    await q(
      "alter table public.academy_schedule_items enable trigger guard_history",
    );
  }
}
