import { cohortPurpose } from "./admin-course-lifecycle";

// Acceptance-test traffic in a shared environment. There is NO recorded
// "test" flag in the schema, so these records are recognised only by the
// fixed naming the acceptance harness uses (scripts/acceptance): package key
// "acceptance-<run>", programme "Acceptance Run <run>", examination body
// "Ducelio Acceptance", cohort "Acceptance cohort <run>" and offer slug
// "acceptance-<label>-<run>". Business figures exclude them; the screens say
// they were excluded and how they were recognised. A recorded flag would
// replace this naming rule (see the required database changes).
const ACCEPTANCE_KEY = /^acceptance-/i;
const ACCEPTANCE_TITLE = /^acceptance run\b/i;

export const isAcceptancePackageKey = (key: string) => ACCEPTANCE_KEY.test(key);
export const isAcceptanceOfferSlug = (slug: string) =>
  ACCEPTANCE_KEY.test(slug);
export const isAcceptanceTitle = (title: string) =>
  ACCEPTANCE_TITLE.test(title.trim());

export function isAcceptanceCourse(course: {
  packageKey: string;
  title: string;
}) {
  return (
    isAcceptancePackageKey(course.packageKey) || isAcceptanceTitle(course.title)
  );
}

// A cohort whose enrolments are not business enrolments: demo cohorts, and
// cohorts named as staging or acceptance cohorts.
export function isNonBusinessCohort(cohort: {
  title: string;
  isDemo: boolean;
}) {
  return cohortPurpose(cohort) !== "UNVERIFIED";
}

// An offer or activation sold to an acceptance course or a staging cohort.
export function isAcceptanceOffer(offer: {
  slug: string | null;
  course: string;
  cohort: string;
}) {
  return (
    (offer.slug !== null && isAcceptanceOfferSlug(offer.slug)) ||
    isAcceptanceTitle(offer.course) ||
    isNonBusinessCohort({ title: offer.cohort, isDemo: false })
  );
}

export const TEST_RECORD_NOTE =
  "Acceptance-test and staging records are recognised by naming: the acceptance harness's “Acceptance Run …” courses and “acceptance-…” package keys and offer slugs, and cohorts named as acceptance, staging, sandbox or smoke-test cohorts. The database has no test flag, so this is a naming rule, not a recorded fact.";
