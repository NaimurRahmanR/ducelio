# 57 — Academy (B2C) Course Engineering and individual delivery

Checkpoint ACADEMY-B2C-1, on branch `claude/sleepy-brahmagupta-pt0g9d` from
`main` `9ee85f2`. Migration `202610220060_academy_course_engineering.sql`
(001–059 unchanged). **Implemented and locally validated; not reviewed, not
merged, not deployed. No hosted Supabase, Stripe or AI provider was used.**

## 1. Two workflows

|          | Academy Course Engineering (new)                                      | Organisation Course Engineering (existing)                                                                                        |
| -------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Route    | `/admin/academy-course-engineering`                                   | `/admin/course-engineering`, `/admin/activation`, `/admin/cohorts`                                                                |
| Package  | `ACADEMY_COURSE_PACKAGE_V1` (embeds an unchanged `COURSE_PACKAGE_V1`) | `COURSE_PACKAGE_V1`                                                                                                               |
| Steps    | Upload → Validate → Review → Publish                                  | Import → validate → apply → agents → test → publish → activate (cohort, instructor, windows) → bind components → policies → offer |
| Delivery | Individual learner, own format and timetable                          | Cohort                                                                                                                            |

The organisation workflow, its routes, RPCs, policies and tables are
unchanged. The only edit to shared code is an optional, backward-compatible
`actions` prop on `ExamWorkspace` so both workflows use one exam interface.

## 2. Package contract (`src/domain/academy-course-package.ts`)

`ACADEMY_COURSE_PACKAGE_V1` = identity + `course` (description, qualification
preparation with mandatory disclaimer, source references, academic policies,
`demoContent`) + `curriculum` (an unchanged `COURSE_PACKAGE_V1` body,
validated by the existing `validateCoursePackage`) + `workload.lessons`
(teaching minutes and prerequisites for every lesson) + `labs` (every
practical activity: duration, placement, graded flag, rubric, protected
marking guidance) + `assessments` (every assessment template: component key,
kind, placement, required lessons, preparation minutes and gap, sitting
window, optional pass mark, attempt scoring) + `grading.components`
(basis-point weights, ASSESSMENT or LABS) + `completion` (course pass mark,
per-component rule) + `deliveryFormats` (format id, class length, study-day
range). The curriculum is defined once; formats only distribute its workload.

Validation is deterministic, path-addressed and never fills a gap:
identity match; every lesson has a workload; prerequisites taught earlier;
every practical activity and assessment scheduled exactly once; no
placement before teaching; **coverage** (an assessment may only assess
required lessons); deterministic question types only (free text needs
Examiner grading, not yet available for Academy enrolments); sitting window
at least the duration; at most one FINAL, placed last; weights total exactly
100%, each assessment component weighted, a LABS component iff graded labs;
graded labs need a rubric and marking guidance; a class must fit every lab
and assessment; **each format must be completable** at its maximum study
days and its declared minimum study days (otherwise `FORMAT_INFEASIBLE`), so
a valid package never offers an impossible choice. Warnings (e.g. no revision
before a Midterm/Final) are shown in the review.

## 3. Five formats and the planner

Stable ids `ACCELERATED_2W`, `INTENSIVE_4W`, `STANDARD_6W`, `EXTENDED_8W`,
`FLEXIBLE_12W` (labels Accelerated, Intensive, Standard, Extended, Flexible).
A course offers only the formats its package declares and the validator
proves feasible.

The planner (`academy_private.plan_units` in SQL — the authority — mirrored
by `src/domain/academy-scheduler.ts`) packs one fixed unit sequence: each
lesson, then the labs placed after it, then for each assessment placed after
it a preparation block and the sitting. Slots are the learner's chosen
weekdays from the start date to start + weeks×7 − 1, one class each. Lessons
and preparation may continue into the next class; labs and assessments are
never split; an assessment waits at least its gap after the last lesson and
is always sat before new material. Insufficient availability is reported
with an explanation and offered alternatives (more days, or another format),
never applied. Local times are converted in the learner's IANA timezone by
PostgreSQL; a time that does not exist on a session date (DST gap) is refused
(`INVALID_LOCAL_TIME`), as in DELIVERY_V1. The SQL and TypeScript planners
are compared on 90 format × weekday × start-date combinations of the real
Security+ blueprint.

## 4. Database authority (migration 060)

Tables (RLS on, **no** privileges for anon/authenticated/service_role,
append-only history guard): `academy_course_packages`, `academy_courses`
(immutable blueprint), `academy_course_lessons` (package lesson → materialised
lesson id), `academy_offers`, `academy_offer_formats` (approved price per
format), `academy_entitlements`, `academy_enrolments` (no cohort, no
instructor), `academy_schedules` (revisions), `academy_schedule_items`,
`academy_assessment_attempts`, `academy_assessment_responses`,
`academy_question_marks`, `academy_lab_submissions`, `academy_lab_marks`,
`academy_completions`. The existing `enrolments`/`assessments`/
`assessment_attempts` carry NOT NULL cohort and instructor foreign keys and
are deliberately untouched; the Academy attempt store is learner-scoped but
**reuses migration 059's validators and scorer** (`response_is_valid`,
`interaction_is_valid`, `answer_key_is_valid`, `score_response`).

RPCs (actor always from `auth.uid()`):

- Admin (ACADEMIC_ADMIN/PLATFORM_ADMIN): `upload_academy_course_package`,
  `mark_academy_course_package_validated` (re-checks invariants),
  `reject_academy_course_package`, `list_academy_course_packages`,
  `get_academy_course_package_review`, `get_academy_course_package_content`,
  `get_academy_course_package_curriculum`, `publish_academy_course`,
  `archive_academy_offer`, `grant_academy_entitlement`,
  `list_academy_lab_submissions_for_review`, `mark_academy_lab_submission`.
- Public (anon too): `list_academy_catalogue`.
- Learner (own enrolment only): `list_my_academy_enrolments`,
  `preview_my_academy_schedule`, `confirm_my_academy_schedule`,
  `preview_my_academy_schedule_revision`, `revise_my_academy_schedule`,
  `get_my_academy_timetable`, `get_my_academy_lesson`,
  `start_my_academy_assessment`, `get_my_academy_attempt`,
  `record_my_academy_response`, `submit_my_academy_attempt`,
  `submit_my_academy_lab`, `get_my_academy_results`.

Publication requires the embedded curriculum to be PUBLISHED by the existing
pipeline (including its passing pre-publication test and agent configuration)
with byte-equal content, re-checks the package, re-checks each priced format's
feasibility and refuses a slug already used by a cohort (Commercial V1) offer or another Academy offer.

Sittings: an attempt starts only inside the learner's own window, with the
full fixed duration still before the window closes; one active attempt;
attempt limit from the package; expiry is server time; late answers are
ignored; scoring is the database scorer; submission is idempotent. Learner
reads never contain answer keys, expected answers or marking guidance.
Revisions keep every item before the cutover (including opened or sat
assessments) verbatim, re-plan only the rest, keep the purchased format and
end date, use optimistic `expectedRevision` and a request key, and leave
earlier revisions and attempts untouched. Completion is recorded once, only
when every weighted component is graded from database-scored attempts and
recorded lab marks and the pass rules hold. A missed sitting is not
auto-zeroed (owner policy needed, §8).

## 5. Admin and learner experience

Admin: one page with a four-step indicator: upload and automatic validation
(actionable issue list), review (workload, formats with classes per week and
peak week, assessments with durations, question types, preparation, windows
and weights, labs, curriculum, sources, warnings), an explicit approval that
runs the existing curriculum pipeline, and publication with explicitly
entered, confirmed per-format prices. After publication: archive, authorised
(complimentary) access by learner email, and a human lab-evaluation queue.
Linked from the Courses workspace; the organisation workflow is linked back.

Learner (`/student/academy`, in the student navigation): format cards, start
date, weekday chips, class time and timezone; a preview (start, expected
finish, window end, classes, weekly load, every assessment's window, full
sequence) before confirmation; the timetable by day with lesson links,
practical submission once a practical's session starts, and "Start
assessment" only inside a window (enforced again in the database); results by
component; revision of future dates. Lessons render as text from the
materialised curriculum. Sittings use the existing exam workspace.

Catalogue: `/courses` adds a "Ducelio Academy" section from
`list_academy_catalogue`; `/academy/<slug>` shows formats and approved
prices. No cohort date is shown for Academy offers.

## 6. Security+ reference

`content/courses/security-plus-sy0-701/academy-b2c-rev1.json` (see the
course README): revision 6 content unchanged, separate key, `NO_LABS`
weights, labs scheduled but ungraded (no rubric exists), Quiz 4 placement
corrected by coverage, delivery parameters labelled as proposals pending
owner approval. Hosted Security+ is untouched.

## 7. Evidence (local)

Gates on Node 22.22, Linux, with a disposable local PostgreSQL 16.15 server
(`DUCELIO_TEST_POSTGRES_URL` set, so no suite was skipped): `npm run check`
— lint and typecheck clean, **4,792/4,792 tests across 207 files**;
`npm run build` exit 0 (all new routes dynamic); `npm run format:check`
clean. The first full run failed 9 tests: 6 migration-integrity tests that
diff against canonical SHAs absent from the shallow clone (they passed after
`git fetch --unshallow`) and 3 deliberate allowlists (anon EXECUTE x2, Sarah
migration list) updated to name exactly the new reviewed
`list_academy_catalogue()` surface and migration 060. No browser run (§8).
Focused
suites: `academy-course-package` 15, `academy-course-engineering-db` 29
(PGlite, real Security+ artefact through the real existing pipeline),
`academy-pg-concurrency` 3 (real PostgreSQL 16.15, contention proven via
`pg_stat_activity`), `academy-ui` 10, access matrix extended to the new page.

## 8. Not done / required before production

- **Checkout for Academy formats is not connected.** Commercial orders,
  payments and entitlements are bound to cohort activations; a B2C order type
  needs a reviewed migration and Stripe acceptance. Only authorised
  (complimentary) entitlement works. The catalogue shows no buy control.
- **AI-led sessions for Academy enrolments are not connected.** Professor,
  Tutor, Lab Instructor, Examiner and Counsellor execution paths are
  enrolment/cohort-bound; the timetable is exposed as structured data, but no
  agent is wired to it and the UI says so. No agent can change schedules,
  marks or sittings (no such RPC exists).
- Lab grading is human (ACADEMIC_ADMIN/PLATFORM_ADMIN) against the package
  rubric; Examiner-assisted lab grading is not wired.
- Free-text questions are refused for Academy packages.
- Missed-sitting policy (re-sit, zero, or support case) needs an owner
  decision; today a missed window leaves the course in progress.
- Mastery/objective evidence and lesson progress are not recorded for
  Academy enrolments (the existing records are cohort-enrolment bound).
- No authenticated browser journey: Supabase Auth/PostgREST are not available
  locally. Hosted acceptance, accessibility/device audit and independent
  review are outstanding. Migration 060 is not applied anywhere hosted.
