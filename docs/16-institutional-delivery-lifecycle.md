# Institutional delivery lifecycle — Checkpoint 2A

Baseline: `52720f51848bfdcf93d03d709820b44d788911d9`, merged main through Phase 3 1D-B1. PR #2 and post-merge main CI passed. Checkpoint 2A implementation completed final second review and was committed at `afc6ba2` on `phase-3-delivery-lifecycle`; PR #3 carries the checkpoint toward main. No provider/model, endpoint, UI, academic evidence writer, mastery recalculation or official course-completion workflow is introduced.

## Institutional authority and records

Migration `202609110023_phase3_delivery_lifecycle.sql` adds six RLS-enabled tables:

- `delivery_study_plans`: one enrolment-specific DRAFT/CONFIRMED plan, bound through the existing composite Enrolment/student/cohort/ProgrammeVersion identity. This is separate from private Counsellor `study_plans`.
- `delivery_schedule_revisions`: append-only confirmed preference/effective-date history.
- `scheduled_learning_occurrences`: immutable learner-specific lesson dates and latest-start boundaries, with explicit replacement references. These do not invent or replace instructor/cohort `ClassSession` timetable authority.
- `delivery_occurrence_starts`: immutable, bounded start receipts created only by the explicit learner `start_scheduled_learning()` path with `LEARNER_START` provenance. LessonProgress never creates a start receipt. A receipt is not an official cohort `AttendanceRecord`, academic completion, mastery, or a continuing runtime permission.
- `delivery_catch_up`: durable missed-start requirements, preserved after resolution and reopened only when the existing progress authority invalidates a previous resolution.
- `delivery_handoffs`: bounded learner-requested routing records with fixed codes and generated summaries.

No direct authenticated/anonymous/service-role table access is granted. Private helpers are in `delivery_private`, with explicit schema/function revokes including service_role. Narrow authenticated RPCs independently derive the actor and check their institutional role and owned enrolment. A multi-role STUDENT's self-service requests never inherit staff visibility. Separate admin read RPCs require existing academic-admin/Registrar/Platform Admin read authority or an assigned Counsellor relationship. They return logistics metadata, never private support records or academic prose.

All new mutations audit into existing `audit_events` with fixed `DELIVERY_V1` source/reason. The audit contains institutional identifiers, constrained preferences/status/routing metadata and timestamps; the summary is excluded. It ignores caller audit-reason settings. Audit persistence failure rolls back the mutation. These events prove governed human requests or deterministic database observations; they do not claim agent execution, HMAC controller execution, model calls or delivered teaching.

## DELIVERY_V1 scheduling policy

During DRAFT setup the learner selects distinct ISO weekdays (`1=Monday` through `7=Sunday`), preferred local `HH:mm` start time and a recognized IANA timezone. Cadence is the derived number of selected days, from one to seven; it is not independently mutable. Institution defaults are Monday/Wednesday/Friday at 19:00, using the authoritative StudentProfile timezone. The learner may override all three preferences before confirming. The database validates the IANA name, weekdays and minute precision; browser clocks and browser timezone guesses are not authoritative. ProgrammeVersion currently has no reviewed expected-duration/end-date metadata, so DELIVERY_V1 fixes expected class duration at **60 minutes** and uses the final hypothetical-slot rule below.

Confirmation captures one authoritative database timestamp and selects the first chosen local cadence slot strictly after that instant, never before `cohort.starts_on`. A selected slot later on the same local day is therefore valid; no retroactive occurrence or missed class is created. It walks the exact enrolled curriculum by module position, lesson position and ID. Each subsequent occurrence is on the next selected local weekday at the selected local time. Dates are converted through PostgreSQL `AT TIME ZONE` and stored as `timestamptz` instants. No latest-version shortcut or UTC-midnight scheduling default is used.

For each occurrence:

```text
available from = scheduled_at
next_scheduled_at = the following selected class slot
latest_start_at = next_scheduled_at - 60 elapsed minutes
```

For the last lesson, `next_scheduled_at` is the next hypothetical slot using the same preferences. It creates no extra lesson. There is no existing explicit programme-end boundary to shorten it.

For London daily 19:00, Monday's latest start is Tuesday 18:00 local. For Monday/Wednesday/Friday 19:00, Monday's latest start is Wednesday 18:00 and Wednesday's is Friday 18:00. The start window varies with cadence and DST; it is not a completion deadline. Across London's spring transition a daily 19:00 start window spans 22 elapsed hours; across autumn it spans 24. Ordinary daily days span 23.

IANA DST conversion is database-owned. An ambiguous local timestamp uses PostgreSQL's standard-time occurrence (tested for London's autumn 01:30). A nonexistent local timestamp, such as London's spring 01:30, rejects the entire confirmation/change with `INVALID_LOCAL_TIME`; the learner must choose another time. It is never silently shifted. This is a deliberate policy choice for review. Hosted timezone-database acceptance remains required.

Plans freeze at confirmation. A later explicit future-effective change creates a new revision and replacement occurrences; original dates remain readable through revision-history services. It can replace only a future suffix after every opened, started or completed occurrence. Earlier items, including upcoming items before that protected suffix, stay unchanged. Effective dates must advance in both local-date and absolute-time order, be after today in the selected timezone and within 365 days.

The first replacement keeps its previous opening as an explicit `transitionAnchor`. This preserves the immutable preceding class's next-slot/latest-start boundary. The new preferences take effect on a later local date after that anchor; no second class is scheduled on its local day. The anchor's future latest-start boundary may change through its replacement record. No past/opened/completed/missed occurrence is rewritten. A change with no eligible suffix is explicitly refused. At most 250 lessons and 50 revisions are supported; larger requests fail instead of truncating curriculum. These are reviewed implementation bounds, not commercial quotas.

## Start, completion and catch-up

`start_scheduled_learning(occurrence_id)` requires the authenticated STUDENT, own ACTIVE enrolment and a current occurrence. Its first-start decision takes the existing learner `student_profiles` lock before the enrolment lock, so it orders against assessment start. A new start also checks the existing fixed EXPLAIN firewall. It returns no learning content.

- Before `scheduled_at`: `NOT_OPEN`.
- Exactly at `scheduled_at`, through **and including** `latest_start_at`: a first valid start is accepted and persisted as `STARTED`.
- One microsecond after `latest_start_at`, without a valid start: `MISSED`, with durable catch-up. This denial returns structured metadata so its audit is not rolled back by an exception.
- Repeating an accepted start returns `ALREADY_STARTED` and the original timestamp. It never renews runtime authority or changes history.

Already-completed work with no missed requirement needs no new start; attempting one is `POLICY_BLOCKED`. Existing early academic completion therefore does not acquire a fabricated attendance or missed-start claim.

The current occurrence projection is UPCOMING, DUE, STARTED, COMPLETED or MISSED. STARTED means a valid start is recorded and planned progress is incomplete; it does not mean an application/model session is still running. A valid receipt prevents a later deadline crossing from marking the class missed. Completion relies on at least one planned LessonSegment and **all** those segments being COMPLETED through the existing instructor/admin-governed LessonProgress workflow for the exact enrolment/lesson/version. Its `completedAt` is the latest current authoritative segment-progress timestamp, not a claim about reading time or the first historical completion instant. No planned segments means no inferred completion. There is no completion from a page visit, chat, attendance-only record, handoff or AI assertion, and no mastery inference/recalculation.

Before a governed progress write, the delivery hook never creates a learner start receipt. If `latest_start_at` has already passed and no legitimate learner start exists, it preserves or materialises the `MISSED` state and durable catch-up while the old progress is still visible. After the write it reconciles legitimate completion and catch-up resolution. Thus late progress cannot erase a missed-start fact. A later valid completion may display COMPLETED/RESOLVED while the missed requirement remains stored. Reaffirming COMPLETED does not rewrite an existing resolution timestamp. An authorised progress correction can reopen an existing requirement; audit retains that transition.

Time-derived state is immediate at read/decision time. Catch-up materializes idempotently during delivery reads, start decisions, schedule changes and before/after governed progress writes. There is no background timer or delivery notification worker in 2A. A dormant account's missing rows are materialized when an authorised operation next observes it. No backlog is silently deleted. Pausing/withdrawing does not silently cancel or rewrite dated items; a separate reviewed pause/excusal policy remains necessary if the product requires one.

The deterministic recovery order is curriculum ordinal, oldest first. The projection preserves every missed requirement and returns earlier incomplete lesson references, including previously started but unfinished material, plus the current/next scheduled lesson. There is no authored prerequisite graph in the current curriculum, so these are recovery candidates, not invented prerequisite claims. Objective descriptions/resources are fetched through the existing exact-version capabilities. Extended practice routes to Tutor; no automatic lecture concatenation or AI sequencing is implemented.

## Agent and Counsellor boundaries

The server/database agent-access projection makes Professor, Tutor and Lab Instructor AVAILABLE only for an ACTIVE owned enrolment with current EXPLAIN permission. Paused, withdrawn and completed enrolments close these roles. Examiner remains ASSESSMENT_CONTROLLED while active and CLOSED otherwise; the projection never grants assessment access. Counsellor stays AVAILABLE. Historical exact-version learning-material permissions remain unchanged.

`getProfessorDeliveryContext` composes logistics references inside the existing nine-capability gateway's validated learner-context release. It checks course eligibility before and after the read, verifies the enrolled version, and retains the gateway's final principal/firewall and reliable release-close requirements. Existing `PROFESSOR_READ_V2` JSON contracts are unchanged. Ordinary logistics projections contain no teaching/resource/objective/support prose and do not require a content lease. A future Professor runtime must use start/admission services before delivering a scheduled class; a future lesson reference is not permission to start that class early.

The 30-second content-release lease in 021 and 20-second, zero-provider execution envelope in 022 are unchanged. A class-start receipt does not extend either, block assessment indefinitely or authorize future provider reuse of content. Runtime/session limits, cancellation and provider-latency handling remain separately reviewed prerequisites. No new running-class/model session is created.

Counsellor mode is account-level: ACTIVE_COURSE if any owned enrolment is ACTIVE/PAUSED, otherwise POST_COURSE if any is COMPLETED, otherwise PROSPECT. A verified account does not need an enrolment to obtain prospect mode. Anonymous homepage discovery can use the prospect domain policy without creating an institutional student record; there is no anonymous persistence or new route.

`COUNSELLOR_SCOPE_V1` allows only the mode-specific categories in `src/domain/delivery.ts`: admissions/profile/discovery/recommendation/purchase in prospect mode; onboarding/study planning/logistics/missed-class support/routing during a course; completion/next-course/discovery/recommendation/purchase after a course. Teaching, assignment solving, lab debugging, assessment help and general chat are excluded. There is no sentiment, motivation or risk inference.

ACTIVE/COOLDOWN/HIBERNATED conversation policy is domain-only in 2A. It affects only whether a future Counsellor conversation request is in scope; it does not mutate or ban an account or block browsing, materials, purchase or other academic services. No runtime can currently set a cooldown. Persistent enforcement, evidence of misuse, durations and review/recovery procedures remain deferred. Optional prospect discovery is a strict SKIP/SHARE domain boundary with minimal optional goal, experience, course interest and study availability; no CRM/profile storage or sensitive-field collection is added.

## Structured liaison and admin readiness

The enabled handoff path supports **learner-created referral requests only**. Every row records `initiator_kind=LEARNER`, `provenance=LEARNER_REQUEST` and `status=OPEN`. The bounded reason code deterministically selects `TUTOR` or `LAB_INSTRUCTOR` as the destination. No 2A path claims Professor, Tutor, Lab Instructor or Counsellor authorship. Genuine agent-originated referrals and receiving-agent acknowledgement remain deferred until separately reviewed trusted agent tools exist.

The request accepts only owned enrolment, matching lesson/optional objective, reason code and an idempotency reference; the server adapter generates that reference. It accepts no source/actor/profile, priority, summary, transcript, assessment text or arbitrary JSON. SQL derives one of four exact summaries (at most 120 characters), also checked by strict output validation. Priority is NORMAL. Status is OPEN only. Limits are 20 open and 250 total per enrolment, with ordered pages of 20. Exact database request replay is idempotent; a fresh server request ID represents a new request.

Separate bounded admin context, schedule-revision history and handoff pages expose plan/revisions, upcoming/due/started/missed state, recovery backlog, account Counsellor mode and course eligibility. `SUBJECT_TO_ACTIVITY` explicitly means an execution-time firewall check is still needed. Admin metadata access does not imply Counsellor private-note access or authority to edit enrolment, progress or dates. No full Admin Console is added.

## Delivery deadline and acceptance

The 15 September display deadline still needs separately reviewed UI work: learner preference/confirmation/start controls, schedule and backlog display, handoff navigation and administrative presentation. This checkpoint supplies the deterministic backend foundation. Proactive notifications, explicit prerequisite graphs, advanced recovery sequencing, course-end/certificate publication, pause/excusal scheduling, persistent prospect/cooldown storage and agent-originated liaison remain deferred. No provider/model was introduced.

Local acceptance uses Node v24.20.0, npm 11.19.0, PGlite and the real server adapters. Hosted Supabase/JWT/PostgREST and ACL/default-privilege acceptance, production migration rollout, IANA tzdata acceptance, true concurrent independent PostgreSQL connections, operational abuse controls and accessibility/device/UI acceptance remain outstanding. The user-confirmed main CI result applies to baseline `52720f5`; it does not claim CI for this uncommitted checkpoint.

Final local acceptance used Node **v24.20.0** and npm **11.19.0**. `npm run check` passed ESLint, route/type generation, TypeScript and **622 tests across 31 files**. The delivery suites comprise **184 tests**: 151 delivery-workflow tests and 33 delivery-server tests. `npm run build`, `npm run format:check` and `git diff --check` passed. Exact microsecond admission boundaries exercise the same private pure DB decision function called by the live-clock RPC. Historical start/completion fixtures use privileged setup with the real insert guard; no public clock override was added. Hosted Supabase, true-concurrency, production acceptance and checkpoint CI remain outstanding. No commit, push or merge is claimed for 2A.
