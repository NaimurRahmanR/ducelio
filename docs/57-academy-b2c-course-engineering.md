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

## 9. Checkpoint ACADEMY-B2C-2 (migration 061)

Migration `202610230061_academy_controls_commerce_evidence.sql` (001–060
unchanged). Local only; not reviewed, merged or deployed.

**Academic controls (corrections).**

- One controlled assessment at a time across both exam systems, through the
  existing student-level authority rather than a new one: Academy starts now
  take the learner profile row lock first (the lock `start_assessment_attempt`,
  every AI content release and Tutor note write already take), then the
  enrolment; refuse while an AI content-release lease is open; finalise stale
  attempts in both systems; and refuse while any controlled attempt is active
  (`ANOTHER_ASSESSMENT_ACTIVE`). A trigger on `assessment_attempts` refuses an
  institutional attempt while an Academy attempt is active, and a unique index
  allows one active Academy attempt per learner.
- `current_academic_activity_state()` and
  `academic_content_release_explain_allowed()` (same signatures and ACLs) now
  include active Academy attempts, so the Professor, Tutor, Lab Instructor,
  handoff and Tutor-note firewalls all close during an Academy sitting.
- Lesson release: lesson content opens from the start of the learner's own
  first scheduled session for that lesson; it, study confirmation and practical
  submission are refused during any active controlled assessment
  (`ACTIVITY_BLOCKED`) and after access is revoked (`ACCESS_REVOKED`). The
  timetable and results stay readable.

**Academic policy gate.** `pendingDecisions` in the package (validated; a
graded lab may lack a rubric only while `LAB_RUBRICS` is pending). While any
remains: the offer is `REVIEW_ONLY` (absent from the catalogue, no checkout),
labs without rubrics cannot be marked (`RUBRIC_PENDING`) and no official
completion receipt is written (results are labelled provisional).
`enable_academy_public_sale` requires zero pending decisions, every graded lab
rubric present, and an explicit, audited owner-approval confirmation. The
Security+ artefact is now revision 2 with the published 20% lab weight
(`WITH_LABS`) and seven pending decisions; no rubric, pass mark, resit rule or
missed-sitting penalty is invented.

**Checkout and paid access.** Reuses the existing Stripe adapter, webhook
route and receipt queue, controller keys, evidence checks and expired-session
recovery. `create_academy_order` snapshots the approved per-format price;
`fulfill_academy_order` and `apply_academy_commerce_operation` verify
purpose-separated HMAC claims (a cohort claim can never fulfil an Academy
order); fulfilment is idempotent per order and per provider event; the
entitlement records the purchased format, which scheduling cannot change; a
verified full refund revokes only that payment's access (complimentary access
is untouched), partial refunds go to review, and refunded orders cannot be
re-fulfilled or re-bought without support. Stripe sessions carry
`metadata.orderKind = ACADEMY`; the existing webhook processor routes them to
the Academy authority. Admin revocation: `admin_revoke_academy_entitlement`
(RPC and server function; no admin list UI yet).

**Evidence, mastery, progress.** Each database-scored sitting writes one
`RETRIEVAL_CHECK` observation per assessed objective, and each recorded lab
mark one `PRACTICAL_TASK` observation per objective the practical addresses
(CORRECT = full marks, PARTIAL = some, INCORRECT = none), evaluated by
MASTERY_V1's exact transition rule (two correct sessions of two kinds for
DEMONSTRATED). Learner-confirmed study (`record_my_academy_lesson_studied`)
is recorded separately, only for released lessons, and never counts toward
mastery or completion. Page reads create nothing.

**AI teaching and grading — not connected (blocker).** Professor classroom
sessions, Tutor/Lab Instructor content releases and executions, DELIVERY_V1
occurrences and handoffs, Examiner executions and agent-behaviour provenance
all hold NOT NULL foreign keys to the cohort `enrolments` table (and the
Professor to instructor `class_sessions`). Connecting Academy enrolments
safely needs a reviewed enrolment abstraction across those authorities and
their HMAC-attested execution governance; it is not attempted here, and the
learner UI says AI-led classes are not connected. The AI firewall itself does
cover Academy sittings. Examiner lab grading is likewise not connected; labs
are marked by an academic administrator against an approved package rubric.
Objective questions are scored only by the migration 059 database scorer.

**Evidence (local, Node 22, PostgreSQL 16.15).** New suites:
`academy-controls-db` 10 (PGlite, a real institutional Commercial V1 exam and
an Academy enrolment for the same learner), `academy-commerce-db` 7,
`academy-commerce-server` 4 (real checkout, webhook and reconciliation code,
fake Stripe adapter), `academy-controls-pg-concurrency` 4 (real PostgreSQL:
institutional-vs-Academy start, two Academy sittings, Academy start-vs-AI
release, webhook-vs-success-page fulfilment — each admits exactly one).

## 10. Checkpoint ACADEMY-B2C-3 (migration 062): AI Professor classes

Migration `202610240062_academy_ai_teaching.sql` (001–061 unchanged except
`get_my_academy_timetable` and `get_my_academy_progress`, replaced with the
same signatures and ACLs to add fields). Local only; not reviewed, merged or
deployed. This supersedes the "not connected" note in §9 for the Professor
only.

**Execution pathway.** A learner enters a scheduled lesson's AI class from
their own timetable ("Enter AI class" / "Resume AI class" / "Catch up with
Professor"). `open_my_academy_professor_classroom(enrolment, schedule item)`
takes the shared lock order (learner profile, then enrolment) and refuses
unless the enrolment is the learner's own, ACTIVE and unrevoked; the item is
a LESSON of the current timetable whose own start time has passed; and no
controlled assessment is active in either exam system. A classroom is keyed
by the root scheduled session (a revision carries started sessions
unchanged), so retries and re-entry resume the same classroom. The governed
request then runs `executeAcademyProfessorClassroom`
(`src/server/academic-runtime/academy-professor.ts`), composed from the same
reviewed parts as the cohort classroom with no second provider engine:

1. the database classroom state (ownership, release under the CURRENT
   timetable, revocation, firewall), shaped like the cohort classroom state so
   `buildProfessorTeachingContext` is reused unchanged;
2. the programme version's stored Professor configuration (enabled,
   capabilities, model profile; an ACADEMIC_REVIEW escalation policy does not
   teach, because an Academy course has no reviewer) and the behaviour
   binding frozen at publication, validated by the same
   `verifiedLearnerBehaviourBinding` as the cohort read;
3. the role-bound runtime profile;
4. the reviewed PROFESSOR_READ_V2 reads (lesson, the complete published
   objectives, and resources and persisted Academy mastery when the
   configuration authorises them), each under its own existing content
   release, nested so the provider runs while every release is ACTIVE.
   `read_my_academy_professor_context` returns the reviewed capability output
   shapes and consumes the release; it reads only the published curriculum,
   never questions, answer keys, rubrics or marking guidance;
5. migration 025's AUTHORIZE (rate limits, hard budget ceiling, expiry),
   attested Academy provenance that re-proves admission and binds the
   context manifest to consumed releases of this classroom, START,
   `runGovernedProviderExecution`, then FINALIZE with the real usage after
   every release is closed;
6. the learner-visible turn, attested and bound to the execution.

Provenance and memory use the existing controller key and verifier with new
protocol tags (`DUCELIO_ACADEMY_PROFESSOR_PROVENANCE_HMAC_SHA256_V1`,
`DUCELIO_ACADEMY_CLASSROOM_TURN_HMAC_SHA256_V1`), so no cohort attestation can
authorise an Academy write. Learner actions reserve an idempotency key before
any provider call. The cohort runtime, classroom tables and behaviour are
unchanged; the cohort classroom panel takes an optional `actions` prop
defaulting to the existing cohort actions.

**Distinct states.** Class scheduled (schedule item), class opened
(`academy_professor_classrooms`), teaching interaction completed
(`academy_professor_classroom_turns`), study confirmed by the learner
(`academy_lesson_progress`), assessment graded, objective mastery
(MASTERY_V1 from evidence only) and course completed remain separate records.
Opening a class or talking with the Professor writes no evidence, mastery,
progress, grade, attendance or completion. The timetable shows "class opened"
and the number of Professor exchanges per lesson; progress shows classes
opened, Professor exchanges and confirmed study separately.

**Not connected in this checkpoint.**

- Tutor and Lab Instructor: their runtime (`src/server/tutor-lab-execution`)
  is admitted by DELIVERY_V1 handoffs with NOT NULL foreign keys to the
  cohort `enrolments` and `delivery_handoffs` tables in its own content
  release and execution tables. An Academy path needs its own reviewed
  handoff/release authority; it was not attempted, so no Tutor/Lab support
  exists for Academy courses and the classroom page says so.
- Examiner practical grading: Academy labs have no approved rubric
  (`LAB_RUBRICS` pending), so automated grading stays disabled and labs
  cannot be marked at all until rubrics are approved. Objective questions
  remain scored only by the deterministic database scorer.

**Evidence (local, Node 22, PostgreSQL 16.15, stub provider, no paid AI
call).** `academy-ai-teaching` 13 (PGlite, real runtime and database
authority): entry before the scheduled time refused; own class opened and
resumed; another learner's class, forged enrolment/session ids, a scheduled
assessment and an unreleased lesson refused (with zero provider calls);
end-to-end governed teaching with the lesson's published objectives in the
provider context and no protected assessment fields, SUCCEEDED execution and
usage, the four-release manifest and every release COMPLETED; continuation
from stored memory; distinct progress states with no evidence, mastery,
study, attempt or completion written; provider refusal recorded as FAILED
with its usage and no memory; duplicate learner action refused; forged
release reuse, cross-capability reads, another learner's read, an invalid
or cross-protocol attestation and direct table access refused; an active
Academy sitting closing class state, memory, reservation and Professor
teaching (zero executions); revocation blocking entry, state, agent read and
teaching while the classroom history stays; a timetable revision resuming
the same classroom from the carried session and refusing the superseded
entry, with immutable classroom history; cohort enrolment, class-session,
classroom, turn and provenance tables untouched.
`academy-ai-teaching-pg-concurrency` 3 (real PostgreSQL): six parallel entries
create one classroom; parallel identical submissions reserve once; two
overlapping Professor requests through the real runtime run exactly one
governed execution (the other is BLOCKED by migration 025's one-active-
execution rule), with one provider call, one turn and no release left open.
Full gates: `npm run check` (lint, typecheck, 4,835 tests in 213 files with
the real-PostgreSQL suites enabled), `npm run format:check` and
`npm run build` pass. Not exercised: a real AI provider, hosted Supabase
JWT/PostgREST, and an authenticated browser journey.

### 10.1 Audit corrections (ACADEMY-B2C-3a)

An independent audit of migration 062 and the Academy Professor path found
no cross-learner read or write path and no critical or high issue. Every
public RPC binds to `current_app_user()`. Each release is read once, for its
own capability and classroom. The attestation strings match field for field
between TypeScript and SQL, and the protocol tags are distinct. Corrections,
each with a regression test:

- **Timezone.** The classroom page used the host timezone. It now renders
  in the learner's current timetable timezone (`view.timezone` from the
  database) through `formatAcademySessionTime`. Each instant gets its own
  offset across daylight-saving changes, and an unknown zone falls back to
  labelled UTC.
- **Refused after AUTHORIZE.** Migration 025's FINALIZE is accepted only from
  RUNNING, so an execution refused by the provenance admission re-check
  stayed AUTHORIZED. That held the learner's one active execution for up to
  20 seconds. `record_my_academy_professor_provenance` now terminalises it
  FAILED in the same transaction; no provider call happened, so there is no
  usage.
- **Admission after the provider call.** Classroom admission (revocation,
  enrolment status, release under the current timetable, exam firewall) is
  re-proven after the provider returns, while every release is still ACTIVE.
  A refund during a reply discards the reply, records no turn and still
  FINALIZEs the real usage.
- **Release lifecycle.** An inner failure now aborts every enclosing release,
  so a release is COMPLETED only when the whole governed use succeeded.
- **Two-way provenance exclusion.** Insert triggers on the cohort provenance
  tables refuse an Academy-bound execution or release. The Academy function
  already refused cohort-bound executions. Legitimate cohort writes are
  unaffected.
- **Reservation bounds.** At most 20 new reservations per classroom per
  minute and 1,000 in total; replays still return `duplicate`.
- **Firewall on the agent read.** `get_my_academy_professor_agent` refuses
  during a controlled assessment.
- **Persisted mastery.** Persisted mastery records are read in the reviewed
  capability shape, now tested with a real record.

**Known limitation, not changed (shared migration 025 governance).** If
FINALIZE reaches the database after an execution's 20-second expiry, the
database records TIMEOUT and no usage row, so real provider usage of such a
late execution is missing from the durable ledger. The cohort classroom
behaves the same way. A fix belongs in a reviewed change to the shared
governance, not in this Academy checkpoint.
