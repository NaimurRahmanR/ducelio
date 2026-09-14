# Commercial V1 — Assessment Policy + One-Sitting Controlled Assessment Lifecycle

## Starting state and scope

Started from clean `commercial-v1-assessment-policy` at `b20f603346e615ab268af6833dca3449ca3e4a7c`, the PR #9 Governed Tutor + Lab Instructor Execution merge. Working tree verified clean and `HEAD` verified equal to that SHA before any change. Migrations 001–028 are untouched (verified: zero diff). The final V3 implementation passed independent diff review before commit.

This checkpoint is deliberately narrower than the eventual Examiner/results/leaderboard system. It does **not** implement provider-backed Examiner execution, AI grading, finalized numeric institutional results, numeric lab grading, assessment-derived mastery mutation, remediation, course completion, or leaderboard snapshots/ranking/UI/notifications. Those are separate, independently reviewed future checkpoints. This checkpoint establishes: explicit Quiz/Midterm/Final component identity; deterministic WITH_LABS/NO_LABS weighting; correct assessment availability/latest-start semantics; full-duration one-sitting attempts; deterministic submission provenance (including administrative closure and unclassified legacy history) — the secure foundation later checkpoints will consume.

**Correction pass (independent review):** the first implementation's expired-response handling did not satisfy the frozen contract — it refused a late write via a raised exception, but a prior attempt to durably finalize AUTO_TIMEOUT in that same call was silently rolled back by that same exception (PostgreSQL rolls back an entire statement's effects when the function that performed them later raises). Fixed by introducing a dedicated governed surface, `record_commercial_v1_assessment_response`, which returns a deterministic jsonb result instead of raising for the expired case, so the refusal and the durable AUTO_TIMEOUT transition commit together in one governed operation. The legacy `record_assessment_response` now refuses outright for any Commercial V1-governed attempt (and the new RPC refuses outright for any non-governed attempt), so neither surface can be used to bypass the other. The finalizer/scheduler and submission-provenance-persistence claims in the original report were also clarified/verified, and the migration-021 Professor-content-release exclusion invariant was re-confirmed by direct SQL inspection. See the relevant sections below.

## Migration 029 and why it corrects (not replaces) existing functions

Migration 029 adds two tables, a private schema and one provenance column. It replaces the existing start, submit and legacy response functions without changing their signatures. Governed Commercial V1 assessments use full-duration/latest-start timing; legacy assessments retain their existing timing policy. Provenance applies to all submissions, so every reachable writer satisfies the new constraint. Administrative closure and expired learner submissions are now classified explicitly. Migrations 001–028 remain immutable.

One small, deliberate, **global** correctness tightening applies regardless of governance: the response-write deadline check was `now() > expires_at` (allowing a write in the exact same instant as expiry); it is now `stamp >= expires_at` (refused at or after the deadline), and `start_assessment_attempt` now captures one `stamp := clock_timestamp()` at the top and reuses it for every gate and both persisted timestamps, rather than several separate `now()`/`clock_timestamp()` calls across the transaction. Both are narrowings (fail-closed), never widenings, and are covered by the existing regression suites plus new tests below.

**Migration-021 invariant, independently re-confirmed by direct SQL inspection (not only by regression tests):** `start_assessment_attempt`'s `CREATE OR REPLACE` body was re-read line-by-line after the correction pass. In order, it still contains exactly: the learner-profile row lock (`perform 1 from public.student_profiles where user_id = actor for update`), then `perform public.expire_my_academic_content_releases()`, then the denial `if exists(select 1 from public.academic_content_releases where student_id=actor and state='ACTIVE' and expires_at>clock_timestamp()) then raise exception 'Academic activity is busy. Retry shortly.'` — migration 021's own Professor-content-release mutual-exclusion check, unchanged in position, condition, and wording. `tests/academic-content-release.test.ts` (which reads the live function definition back from the database) and `tests/academic-execution-db.test.ts` both pass, corroborating this but not the sole basis for the claim.

## New database objects

- `public.commercial_v1_component_bindings` — explicit, governed, post-activation binding of one real `assessments` row to exactly one formal component (`QUIZ_1`/`QUIZ_2`/`MIDTERM`/`QUIZ_3`/`QUIZ_4`/`FINAL`). `primary key(activation_id, component)` makes duplicate-component-per-activation structurally impossible; `unique(activation_id, assessment_id)` makes the same assessment bound to two components structurally impossible. Mutable (rebindable) only until a policy is published for the owning activation (mirroring migration 016's DRAFT-vs-PUBLISHED question/answer-key freeze pattern); never deletable.
- `public.commercial_v1_grading_policies` — one immutable row per activation: `resolved_profile` (`WITH_LABS`/`NO_LABS`), the seven basis-point weight columns (each individually CHECK-bounded to its exact spec value, plus a CHECK that they sum to exactly 10000), `published_by`/`published_at`. A trigger (`commercial_v1_private.immutable()`) rejects every UPDATE/DELETE unconditionally.
- `commercial_v1_private` schema — `guard_component_binding()` (the pre/post-publish mutability trigger), `audit_binding_change()` (content-minimised audit trigger), `governing_policy(assessment_id)` (resolves the published policy governing an assessment, or an all-null row), `finalize_expired_attempts_for_actor(actor, stamp, commercial_only)` (the shared timeout finalizer, see below). Schema and every function revoked from `public, anon, authenticated, service_role`; reachable only from within already-SECURITY-DEFINER `public` functions.
- `public.bind_commercial_v1_assessment_component(activation_id, component, assessment_id, reason)` / `public.publish_commercial_v1_grading_policy(activation_id, reason)` — the sole governed admin RPCs (ACADEMIC_ADMIN/PLATFORM_ADMIN, reusing `course_activation_private.require_admin()` from migration 027 rather than duplicating the check).
- `public.finalize_expired_commercial_v1_attempts()` — self-scoped lazy finalizer requiring STUDENT, restricted to explicitly bound assessments with a published Commercial V1 policy. Legacy attempts are untouched.
- `public.get_commercial_v1_active_attempt()` — the safe, bounded learner-facing resume DTO.
- `public.record_commercial_v1_assessment_response(attempt_id, question_id, body, idempotency_key) returns jsonb` — the dedicated Commercial V1 response surface (correction pass). Usable only for attempts governed by a published policy; returns `{ok:true,responseId}` or a deterministic `{ok:false,code,...}` — never raises for the EXPIRED case, so a refused write and a durable AUTO_TIMEOUT transition commit together in one governed operation. See "Response write boundary" below.

All new tables are RLS-enabled with `public`/`anon`/`authenticated`/`service_role` explicitly revoked at table, column, schema and function level, closed by an effective-ACL assertion that fails migration deployment on any unsafe inherited privilege (mirroring migrations 022/024–028 exactly) — and independently re-proven at runtime by a dedicated test attempting each new RPC and table read as `service_role`/`anon`.

## Formal component identity — how it is bound, never inferred

`bind_commercial_v1_assessment_component` proves, before accepting a binding: the activation exists; no policy is yet published for it (bindings frozen post-publish); the named `assessment_id` is legitimately bound to _this exact activation_ via `course_assessment_bindings` (which — because `activate_course_package` inserts every one of an activation's assessment bindings together with the same `cohort_id`/`programme_version_id` — structurally proves same-activation, same-cohort and same-programme-version simultaneously, in one check); `attempts_allowed = 1`. The component identity itself is an admin-supplied enum value from the fixed six, never derived from the assessment's title, its package `template_key`, its array position, or any string match.

## Grading policy publication

`publish_commercial_v1_grading_policy(activation_id, reason)` — **no weight, profile, or lab-presence parameter exists on this function's signature; a caller cannot supply one.** It validates, in order: the activation exists (row-locked); idempotent replay (a policy already published for this activation returns that same immutable policy, since publish has no mutable input at all — replay can never carry a different "institutional meaning"); exactly six bindings exist (any single missing component collapses to the same `INCOMPLETE_COMPONENT_BINDINGS` as multiple missing, since the six-name domain is PK-unique — "exactly 6 rows" and "all six required names present" are equivalent by pigeonhole); each bound assessment genuinely belongs to this activation/cohort/programme-version, is `PUBLISHED`, and has `attempts_allowed = 1`; the fixed institutional sequence (`QUIZ_1→QUIZ_2→MIDTERM→QUIZ_3→QUIZ_4→FINAL`) has each component's `closes_at` at or before the next component's `opens_at` — one check that simultaneously proves chronological order and non-overlap, evaluated in the _institutional_ order regardless of which order an admin happened to bind them. Lab presence is derived exclusively from `course_practicals` materialised for the activation's own `import_id`/`programme_version_id` (never title/metadata/caller input); the resolved profile and all seven weights are then inserted immutably, with a content-minimised audit event.

## Grading profiles — WITH_LABS / NO_LABS

Exact basis points, code/database-owned, never floating point:

| Component | WITH_LABS | NO_LABS   |
| --------- | --------- | --------- |
| QUIZ_1    | 500       | 500       |
| QUIZ_2    | 500       | 500       |
| MIDTERM   | 2000      | 2000      |
| QUIZ_3    | 500       | 500       |
| QUIZ_4    | 500       | 500       |
| LABS      | 2000      | 0         |
| FINAL     | 4000      | 6000      |
| **TOTAL** | **10000** | **10000** |

`src/domain/commercial-v1-assessment-policy.ts` carries the identical constants (`COMMERCIAL_V1_WEIGHTS_BP`) for TypeScript-side reuse by the future results checkpoint, plus a static test proving every weight is `Number.isInteger`.

## Pass mark

**Deferred, as instructed.** No universal Ducelio pass threshold has been approved. No percentage (40/50/60/70 or any other) is hard-coded anywhere in this checkpoint's SQL, TypeScript, or package defaults, and none is required for any behaviour this checkpoint implements (publication, timing, submission, response-writing). The future results/completion checkpoint will introduce a threshold only through explicit, bounded, institution-governed administrative authority, persisted immutably alongside the policy it belongs to — never browser-authoritative.

## Assessment availability window vs. one-sitting attempt duration

`opens_at`/`closes_at` (unchanged, institution-controlled) bound _when a learner may choose to begin_. Once started, the attempt is one continuous timed session governed by its own immutable `started_at`/`expires_at` — a structurally separate concept from the availability window.

## Latest-start and full-duration semantics (governed assessments only)

```
latest_start_at = closes_at - duration
```

A learner may begin a new attempt only when `stamp >= opens_at AND stamp <= latest_start_at` (both boundaries inclusive in the SQL comparison; local tests exercise broad and near-boundary windows, not an exact microsecond wall-clock race). On success, `started_at := stamp` and `expires_at := started_at + the full configured duration` — **never** `least(closes_at, started_at + duration)`, which is the legacy behaviour that can silently shorten a late-starting learner's allocated time. A direct regression test constructs the identical tight window/duration shape against two sibling assessments — one governed, one not — proving the legacy path grants a shortened attempt while the governed path refuses the start outright rather than shortening it. `stamp` is captured once (`clock_timestamp()`) and reused for every gate and both persisted timestamps, so boundary behaviour is deterministic within the transaction. The browser supplies neither `started_at` nor `expires_at` — `start_assessment_attempt` takes only an assessment id.

## One-sitting / resume semantics

The shared start RPC authenticates STUDENT, locks the learner profile, performs migration-021 release expiry/exclusion, captures database time, and runs generic stale-attempt cleanup. It then requires a PUBLISHED assessment, resolves policy/duration, and validates the matching ACTIVE enrolment before inspecting active attempts. An ACTIVE attempt for the same assessment returns immediately with its original id, started_at, expires_at and attempt_number. Another assessment's ACTIVE attempt produces the existing conflict denial. Only when no ACTIVE attempt exists are fresh-start opens_at/latest_start_at (Commercial V1) or opens_at/closes_at (legacy) limits applied, followed by attempt-count checks and insertion. Full-duration expiry is unchanged.

The replay regression inserts, as test owner, a production-reachable earlier attempt under an already-published policy: the initial-start boundary is about 30 minutes in the past, the legitimate start about 45 minutes in the past, and its full-duration expiry about 15 minutes in the future. SQL assertions prove these relationships against database time. Learner replay returns the same id, every persisted field remains identical, and exactly one attempt exists. No long sleep, trigger suspension or production authority weakening is used. The original immediate repeated-start test remains intact.

`get_commercial_v1_active_attempt()` is the new bounded resume DTO: attempt/assessment identifiers, `attemptNumber`, `title`, `startedAt`, `expiresAt` — nothing else (no question prompt, no answer key, no marking guidance, no other learner's data). It requires an explicit component binding and a published policy, and lazily finalizes only those governed attempts first, so a stale expired attempt is never reported as resumable, and derives entirely from database state (a foreign learner gets `null`, never another learner's attempt).

## Provenance and historical migration

The persisted column `assessment_attempts.submission_provenance` has four values:

| Value               | Meaning                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- |
| STUDENT_SUBMIT      | Learner submitted before expiry while the assessment remained PUBLISHED.               |
| AUTO_TIMEOUT        | The deadline elapsed; submitted_at is exactly expires_at.                              |
| ADMIN_CLOSED        | The assessment was administratively closed while the attempt was active and unexpired. |
| LEGACY_UNCLASSIFIED | Historical SUBMITTED row predating provenance tracking; its cause is unknown.          |

The database enforces `(state='SUBMITTED') = (submission_provenance is not null)`. ACTIVE and VOIDED rows have NULL provenance. When both expiry and closure are observed, elapsed expiry takes precedence; otherwise closure takes precedence over a learner submit. No governance RPC writes LEGACY_UNCLASSIFIED.

Migration 016 installs two user triggers on assessment_attempts: the immutable-history guard and the metadata audit trigger. Migration 029 adds the nullable column, then performs its one-time metadata backfill in an atomic DO block. It disables only guard_assessment_attempt_history, updates only submission_provenance on existing SUBMITTED rows, and immediately re-enables the exact original guard. The audit trigger remains enabled. PostgreSQL retains the table lock until the block/transaction commits; failure rolls back the suspension and update. No identity, timing, state or void field changes. Deployment must use the normal governed migration runner, not interleave manual application traffic between individual migration statements.

The staged database test applies only migrations 001–028, creates real attempts through pre-029 RPCs (including the old administrative-close finalizer), snapshots every original row field and trigger definition, and only then applies 029. It verifies legacy classifications, identical original rows, restored and functioning immutable-history protection, invalid state/provenance rejection and all three post-029 submission causes.

## Reachable submission writers and finalizer scope

Repository search found the original submit writer in migration 016 and stale/closed start writers in migrations 020 and 021. Migration 019's start function does not submit attempts. Migration 029 replaces the old submit/start definitions; none of those historical bodies remains reachable after upgrade.

The current SQL writers are:

- `submit_assessment_attempt`: AUTO_TIMEOUT, ADMIN_CLOSED or STUDENT_SUBMIT, deriving the outcome from database time and parent assessment state. The parent status is locked through the decision.
- `commercial_v1_private.finalize_expired_attempts_for_actor(actor, stamp, commercial_only default false)`: AUTO_TIMEOUT or ADMIN_CLOSED only. It updates only that actor's ACTIVE rows satisfying expiry/closure. With commercial_only=true, it additionally requires a component binding joined to a published grading policy.

The shared start RPC invokes generic cleanup (false) to preserve migration-020/021 behavior. The public Commercial V1 finalizer and resume RPC, and the dedicated response RPC, invoke scoped cleanup (true). Resume also independently filters its SELECT by binding and policy. A grading-policy row represents publication; there is no draft policy row/status to infer. The legacy response RPC never writes SUBMITTED; the dedicated response RPC delegates to the scoped primitive and returns without raising for timeout/closure so that terminalization persists. Generic start cleanup remains part of its enclosing statement and rolls back if that start subsequently fails, as before.

No bulk finalizer, scheduler or service-role path is introduced. A future scheduler requires separate reviewed authority. Row-locking is implemented; true concurrent PostgreSQL acceptance is not claimed.

## Publication guards added after review

Publication locks all six bound assessment rows in stable UUID order, sharing the assessment-row lock used by attempt start. It rejects ANY existing attempt against ANY bound assessment with ASSESSMENT_HISTORY_ALREADY_EXISTS, including ACTIVE, SUBMITTED and VOIDED history. No policy is inserted and history remains unchanged. Existing published-policy replay remains idempotent.

Every bound assessment must satisfy closes_at - opens_at >= duration_minutes. Shorter windows fail ASSESSMENT_WINDOW_TOO_SHORT; exact-duration and wider windows are valid. No additional commercial availability-window rule is invented. The test fixture's 90-minute midterm default was corrected to a 90-minute window.

## Response write boundary (independent review blocker — corrected)

**The frozen contract requires a single governed operation to both refuse an expired write and durably finalize AUTO_TIMEOUT in that same call, without a raised exception rolling the transition back.** The first implementation did not satisfy this: it called the finalizer, then raised — and PostgreSQL rolls back an entire statement's effects (including anything that same function already did) when it subsequently raises, so the finalizer's update never actually persisted. This is corrected by splitting the response-write surface in two:

- **`public.record_assessment_response`** (legacy, unchanged signature) now refuses outright — via a raised exception, exactly as for every other access-control failure in this function — for **any** Commercial V1-governed attempt, regardless of timing state. A learner cannot use this older RPC to dodge governed deadline/finalization semantics.
- **`public.record_commercial_v1_assessment_response`** (new, dedicated) is the only surface usable for a governed attempt. It refuses outright (`NOT_COMMERCIAL_V1_GOVERNED`) for a non-governed one — the symmetric exclusion, so neither RPC can bypass the other. For the expired case specifically, it **never raises**: it calls the shared finalizer (durably committing the `AUTO_TIMEOUT` transition, `submitted_at` anchored to the attempt's own `expires_at`) and then `return`s a deterministic `{ok:false,code:'EXPIRED',state,submittedAt,submissionProvenance}` — a plain `RETURN`, not a `RAISE`, so the finalizer's update commits together with this refusal in the very same statement rather than being undone by it. No response row is ever inserted for this path; no fake response id is ever returned. A repeat call against an already-terminal `AUTO_TIMEOUT` attempt is idempotent, returning the identical result without attempting the transition again or creating further history.

EXPIRED is a strict result with all five required fields: ok=false, code=EXPIRED, state=SUBMITTED, submittedAt (ISO timestamp), submissionProvenance=AUTO_TIMEOUT. Other denial results contain only ok=false and an allowlisted code. Unknown fields, missing terminal fields and impossible combinations fail runtime parsing.

Both functions keep the small, general boundary tightening from `>` to `stamp >= expires_at` (closing the exact-boundary write-acceptance gap) and the pre-existing append-only response history, answer-key/marking-guidance inaccessibility, and cross-student write protection (migration 016, unmodified) — re-verified directly against both RPCs.

## Accommodation / accessibility

Not implemented in this checkpoint, as instructed — no general extra-time system was added. No schema decision here forecloses a future institution-controlled accommodation mechanism (e.g., a per-learner adjustment row an admin explicitly grants, auditable, impossible for a learner to self-grant or supply client-side): `commercial_v1_grading_policies`/`commercial_v1_component_bindings` carry no per-learner timing fields at all, and `start_assessment_attempt`'s latest-start gate is a pure function of the assessment's own `closes_at`/`duration_minutes`, easily extendable later by a governed lookup without restructuring this checkpoint's tables.

## Labs in this checkpoint

Only whether the persisted policy is `WITH_LABS` or `NO_LABS` is determined here. No numeric lab grading, no conversion of `learning_evidence`/`PRACTICAL_TASK` records into a mark, no per-lab weighting scheme. The 20%/0% LABS basis-point slot is reserved and persisted; how it is populated is a future results checkpoint's responsibility.

## Objective mastery

`MASTERY_V1` is completely untouched by this checkpoint — no migration statement, function, or TypeScript module in this diff references `objective_mastery`, `learning_evidence`, `class_session` provenance, or `evidence_kind`. No assessment score is merged into it, fabricated as evidence, or otherwise connected.

## Examiner

Still non-executing. This migration preserves the existing Professor content-release exclusion in assessment start; it does not add any provider execution or change the existing Professor/Tutor/Lab runtime. No model/provider call or Examiner execution is introduced.

## Leaderboard — future contract only

No leaderboard table, ranking, snapshot, notification, or UI exists in this diff. The policy identity this checkpoint establishes (`policyVersion`, `resolvedProfile`, the seven persisted weights, the six explicit component bindings) is exactly what a future leaderboard/results checkpoint needs to compute a weighted cumulative score _after_ grading — grading always flows one direction into results, never the reverse.

## Course package / activation compatibility

COURSE_PACKAGE_V1 is untouched — no schema-version bump, no new package field. Option B from the checkpoint brief was used: an explicit, governed, **post-activation** admin binding (`bind_commercial_v1_assessment_component`), never inferred from package template keys. Every existing course-activation test (`tests/course-activation-workflow.test.ts`, `tests/course-activation-server.test.ts`, `tests/course-package.test.ts`) is unmodified and passes.

## Security

Reviewed directly against the checkpoint's own list: cross-student/cross-cohort/cross-programme-version/foreign-activation access — proven by the "foreign activation's assessment cannot be bound" and "foreign learner cannot read/resume/write another learner's attempt" tests (including against the new dedicated response RPC, and its identical bounded outcome for a foreign attempt vs. a nonexistent one); duplicate/caller-controlled component identity — structurally impossible (PK/unique constraints) and never inferred from title/position; caller-controlled profile/weights — structurally impossible (no such parameter exists on the publish RPC, proven by a `strictObject` domain schema and a static source-text test); timer reset/extension/replay — proven by the one-sitting replay tests; response/timeout lifecycle — same-statement persistence and sequential exclusion are tested locally; independent concurrent PostgreSQL sessions remain untested; **neither response RPC can bypass the other's governed/non-governed semantics** — proven directly (the legacy RPC raises for a governed attempt; the dedicated RPC returns `NOT_COMMERCIAL_V1_GOVERNED` for a non-governed one); client-clock trust — every institutional timestamp is server-derived (`clock_timestamp()`), never client-supplied, proven by an arity test; answer-key/marking-guidance leakage — pre-existing RLS reused unmodified, re-verified against the governed path; mutable historical policy — an unconditional immutability trigger, proven directly; `service_role` shortcuts — proven absent both at migration-deploy time (the ACL do-block, which now also covers `record_commercial_v1_assessment_response`) and at runtime (a dedicated test attempting each new RPC/table as `service_role`/`anon`); unsafe `SECURITY DEFINER search_path` — every new function sets `search_path=''`; overbroad grants — the same effective-ACL assertion pattern as migrations 022/024–028.

## Concurrency

Reasoned about and tested where feasible within a single PGlite connection: repeated/replayed starts (row-locked, proven not to duplicate); start exactly at/after the latest-start boundary (proven via the tight-window comparison test, plus a static assertion on the exact `>` operator, since a literal wall-clock-exact-instant race is not deterministically reproducible without a clock-injection test helper this harness does not provide); the timeout finalizer's idempotency under repeated calls (proven); policy publication idempotent replay (proven). **What this checkpoint does NOT prove:** true concurrent PostgreSQL sessions (two genuinely simultaneous connections racing a start, a submit-vs-timeout, or a policy publication) — PGlite is single-connection, exactly the same limitation already documented for migrations 025–028. The unique-index/row-lock/CHECK-constraint patterns relied on are PostgreSQL's own well-established atomic primitives, not novel to this checkpoint, but hosted concurrent-connection acceptance remains outstanding.

## Tests

Actual focused Vitest output: 95 tests passed across the three policy suites (48 database, 27 domain/static, 20 database review tests). This replay correction adds one database test; earlier correction-pass totals are not restated. The new replay test first reproduced the old failure and passed after moving the fresh-start checks. The original immediate repeated-start test remains unchanged and passing. The existing late-start comparison now explicitly verifies the other-active-attempt denial before voiding that fixture attempt and checking fresh-start rejection. The staged 028→029 upgrade and all verified V2 correction regressions remain included.

With bundled Node v24.19.0, npm run check passed lint, type checking and all 1195 tests across 56 files, preserving the 1100-test base. Final formatting/build/whitespace checks are recorded in implementation-progress.md. PGlite tests demonstrate sequential database behavior and migration execution, not independent concurrent connections.

## Known limitations

Hosted Supabase/PostgREST/JWT acceptance: not performed (unchanged from every prior checkpoint). Real concurrent-connection PostgreSQL acceptance: not proven (PGlite single-connection). No UI/Server Action wiring exists yet for the three new admin/learner RPCs (`bindCommercialV1AssessmentComponent`/`publishCommercialV1GradingPolicy`/`recordCommercialV1AssessmentResponse` exist as `src/server/commercial-v1-assessment-policy.ts` wrappers, callable, but no page invokes them yet) or for the learner resume DTO — this checkpoint is database/domain-first by design, per its own scope statement. The exact-instant latest-start and expired-response boundaries (`stamp == latest_start_at`/`stamp == expires_at` to the microsecond) are proven via a static comparison-operator assertion plus a near-boundary forced test, rather than a literal wall-clock-exact race, for the reason given under Concurrency (no clock-injection helper in this harness). No production scheduler exists; the finalizer/scheduler design is documented precisely above rather than claimed beyond what is actually shipped.
