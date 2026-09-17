# PR15 — Governed Course Test-Before-Publish Gate

PR15 starts from merged main `77887b84c81b6d2d658c1aa756fc85fdce1ce430` (PR #16,
Commercial V1 PR14 course engineering admin). PR14 is CLOSED GREEN. This
checkpoint closes the one deliberate gap PR14 left open: the frozen
`upload → validate → preview → configure agents → test → publish` contract's
dedicated governed `test` stage. Migration
`202609170035_commercial_v1_course_prepublication_test.sql` is additive/
corrective only; migrations 001–034 are unmodified.

## What this "test" is, and is not

The invariant this checkpoint enforces: **a course package may not publish
unless a persisted successful pre-publication test exists for the exact
package/version/configuration state being published.**

`run_course_package_test` is a deterministic governed **integrity/readiness**
check, never a live model/provider call. It proves: the stored package
remains independently valid; the exact package/version binding holds; the
current materialised institutional state (programme metadata and the
applied module/lesson/objective/resource tree) still corresponds exactly to
that package, not merely a matching content hash (V2 correction — see
below); all five agent-role configurations are explicitly saved; those
saved configurations match the reviewed package proposal, using migration
027's exact comparison semantics; and the resulting publication-state
fingerprint is durably recorded. It is **not** model-output quality
evaluation, provider availability acceptance, hosted runtime smoke testing,
or production infrastructure acceptance — those remain separate Commercial
V1 release gates. The database itself derives PASS/FAIL every time; no
caller-supplied outcome, fingerprint or report is ever accepted.

## Publication surface correction

The prior `publish_programme_version` (migration 006) is directly
`authenticated`-callable and completely bypasses `course_package_imports`.
Gating only `publish_course_package` would have left that direct path fully
exploitable against any package-linked version. `publish_programme_version`
is therefore redefined (via `create or replace function`, the same pattern
already used for `start_assessment_attempt` etc. across this codebase) to
fail closed — with a bounded error naming the correct authority — whenever
the target version has a linked `course_package_imports` row, whether or not
a valid PASS exists for it. Every ProgrammeVersion with **no** linked
package (the phase-2 test fixtures, `tests/programme-publication.test.ts`)
keeps its exact prior behaviour, verified by a direct regression. Shared
lock/status/audit/update logic is factored into a private
`course_engineering_private.publish_version_unconditional` helper so neither
entry point duplicates it. `publish_course_package` is now the only
authority able to publish a package-linked version, and transitions both
`programme_versions.status` and `course_package_imports.status` atomically
in the same function invocation/transaction.

A latent gap was found and closed in the same migration: migration 006's
original grant only ever revoked `publish_programme_version` from `public`,
never explicitly from `service_role`, so `service_role` (which has
`BYPASSRLS` in this project's Supabase-like setup) held ambient EXECUTE on
programme publication since migration 006. Both `publish_programme_version`
and `publish_course_package` are now explicitly revoked from
`public,anon,authenticated,service_role` and re-granted to `authenticated`
only, closed by this migration's own effective-ACL assertion.

## Fingerprint

`course_engineering_private.compute_publication_fingerprint(p_import_id)` is
private and derives every input itself from current database state — a
caller supplies only the import id, never a hash, config JSON or
materialised-state projection. It binds, as one SHA-256 digest: the literal
test-policy identity `COURSE_PREPUBLICATION_TEST_V1`; the import id; the
programme-version id; the package's own immutable `content_hash`; the
current **materialised-state hash** (below); and, for each of the five
roles in fixed order (PROFESSOR, TUTOR, LAB_INSTRUCTOR, EXAMINER,
COUNSELLOR), the current `academic_agent_configs` row's
`policy_version`/`enabled`/`model_profile_ref`/`instructional_notes`/
order-independent sorted `capabilities`/`escalation_policy`, or an explicit
"not configured" marker when no row exists. `created_at`/`updated_at`/audit
reason/actor/row id are deliberately excluded — none is semantic
publication state, and including any of them would make an unrelated
timestamp change silently invalidate an otherwise-identical PASS. The
literal policy version is a genuine input to the digest, not a decorative
column, so a future stronger V2 test implementation cannot accidentally
treat an old V1 PASS as current — it would carry a different (and
CHECK-constraint-rejected, until such a policy is reviewed) policy identity,
so no old-policy-tested state can collide with a new one.

### Materialised-state binding (V2 correction)

The package's `content_hash` covers only the raw _uploaded_ JSON, never what
`apply_course_package` actually **materialises** into institutional tables.
`apply_course_package` also updates the _shared_ `programmes` row
(`title`/`examination_body`/`qualification_name`) on every later revision of
the same `package_key`, while `prepare_programme_publication` (migration 006) reads that current live row at publish time rather than a per-version
snapshot taken at Apply. Binding only `content_hash` therefore let a later
revision's Apply silently change what an _earlier_, already-tested revision
would snapshot at publish — the tested state and the published state could
diverge, without either agent configuration or the raw package ever
changing.

`course_engineering_private.compute_materialized_state_hash(p_import_id)`
closes this: it binds `programmes.id`/`slug`, `programme_versions.id`/
`programme_id`/`status`, together with a position-ordered canonical content
tree — programme title/examination body/qualification name, curriculum
label, and every materialised module/lesson/objective/resource's
title/position/description/body/url/kind — read directly from the live
`programmes`/`programme_versions`/`modules`/`lessons`/`lesson_objectives`/
`learning_resources` tables (`materialized_content_hash_from_live`).
Module/lesson/objective/resource row ids are deliberately excluded: they
are random UUIDs assigned at apply time with no package semantics
(`COURSE_PACKAGE_V1` identifies them by key, never institutionally), so
hierarchy identity is position-ordered, matching the package's own
key/position addressing. Assignment/assessment templates and practical
activities are correctly absent too, since `apply_course_package` never
materialises them.

`course_engineering_private.evaluate_materialized_readiness(p_import_id)` is
the independent package↔materialised **equality** check
`run_course_package_test` runs: it computes the identical content-only
canonical tree twice — once from the live tables
(`materialized_content_hash_from_live`), once from the package's own
immutable `raw_package` (`materialized_content_hash_from_package`) — and
compares the two hashes. Any drift anywhere in the tree (a changed title,
body, url or position — never merely a changed count) makes them differ and
fails closed with the closed failure code `MATERIALIZED_STATE_MISMATCH`,
persisted exactly like every other expected readiness failure (FAIL row,
return normally, no raised exception).

### Identity-binding verification (V3 correction)

Content equality alone cannot detect every form of drift: a privileged
mutation that repoints the bound `programme_versions.programme_id` at a
DIFFERENT, otherwise entirely valid programme, or that repoints the shared
`programmes` row's `slug` away from this import's `package_key`, leaves
every `modules`/`lessons`/`lesson_objectives`/`learning_resources` row (and
therefore the content-only hash) completely unchanged, because that content
is keyed by `programme_version_id`, never by `programme_id` or `slug`.
`evaluate_materialized_readiness` therefore also independently re-verifies,
every time it runs, that `programme_record.id = import_record.programme_id`,
`programme_record.slug = import_record.package_key`,
`version_record.id = import_record.programme_version_id` and
`version_record.programme_id = import_record.programme_id` — never trusting
the foreign keys already stored on `course_package_imports` as proof of the
live binding. Any mismatch returns `false`, exactly like a content mismatch,
and `run_course_package_test` persists the same
`MATERIALIZED_STATE_MISMATCH` failure code either way.

`publish_course_package` adds the identical check as defense in depth,
re-fetching the locked `programmes` and `programme_versions` rows and
verifying the same four equalities before it ever accepts the current PASS,
rather than relying solely on the fingerprint recomputation to notice
identity drift indirectly. A mismatch here raises and blocks publication
outright, since publication is not expected to reach this state through any
governed RPC — only a privileged direct-row mutation, exactly like the V2
materialised-content-drift regressions.

## Test ledger and the latest-current-result rule

`public.course_package_test_runs` is append-only (`id`, `run_sequence
generated always as identity`, `import_id`, `programme_version_id`,
`test_policy_version`, `fingerprint`, `outcome` PASS|FAIL, a closed
`failure_code` — `PACKAGE_REVALIDATION_FAILED` / `MATERIALIZED_STATE_MISMATCH`
/ `CONFIGURATION_INCOMPLETE` / `CONFIGURATION_MISMATCH`, only present on FAIL
— `failed_roles`, `run_by`, `run_at`), immutable by an unconditional BEFORE
UPDATE OR DELETE trigger (no role, including the owning connection, can
mutate history), and carries no free-text diagnostic content: only bounded,
closed-vocabulary columns. `testFailureCodeSchema` (`src/domain/course-
engineering-admin.ts`) mirrors this exact closed vocabulary, including
`MATERIALIZED_STATE_MISMATCH`, so a genuine database result for that code
parses and renders a bounded operator message via `describeTestFailure`
rather than falling through to a generic default.

`run_course_package_test` never raises for an expected readiness failure —
package revalidation failure, incomplete configuration, semantic mismatch —
it derives the closed failure code, appends the immutable FAIL row, and
**returns normally**, exactly like `mark_course_package_validated` records a
content-free pass/fail rather than treating an invalid package as an API
error. Only genuine API/system errors (unauthorized, malformed reason,
unknown import, wrong lifecycle state, an uncaught database fault) raise.
`assert_full_package_valid` is invoked inside a bounded nested exception
block that maps any failure to `PACKAGE_REVALIDATION_FAILED` without ever
exposing `SQLERRM`.

Publication does **not** check "does any historical PASS exist for this
fingerprint" — it recomputes the current fingerprint fresh, then selects the
row with the greatest `run_sequence` among rows matching that exact
`(import_id, programme_version_id, test_policy_version, fingerprint)`, and
requires that latest row's outcome to be PASS. This is deliberately
stricter: if identical state is tested PASS and a later run for that same
exact fingerprint is FAIL, the newer FAIL blocks publication. Because the
fingerprint is a pure function of current state, a config mutation after a
PASS changes the fingerprint and makes that PASS stale automatically with no
special-cased staleness bookkeeping; restoring the exact prior semantic
state reverts the fingerprint to what it was, so an earlier PASS becomes
current again on its own, provided no later run under that exact fingerprint
is FAIL — no re-test and no special restoration logic required.

## Concurrency

Lock order for package flows (V2 correction, matching `apply_course_package`'s
own order): **`course_package_imports` row → shared `programmes` row →
`programme_versions` row.** `run_course_package_test` and
`publish_course_package` both take all three locks, in that order, before
reading or recomputing anything materialisation-related; the
`programme_versions` lock is the same one migration 027's
`lock_config_version` trigger already takes before every
`academic_agent_configs` write, so config writes, test runs and publication
all serialize against each other through it. The V2 correction adds the
`programmes` row to that protection: without it, a concurrent
`apply_course_package` for a later revision could mutate the shared row
between `publish_course_package`'s fingerprint check and
`prepare_programme_publication`'s snapshot read. Both locks are held
continuously by `publish_course_package` through
`publish_version_unconditional`'s UPDATE, so that snapshot read is
guaranteed to see exactly the row state the fingerprint was just checked
against. Whichever of a concurrent config write, test run, later-revision
Apply or publish attempt commits its lock acquisition first is
authoritative; the loser always observes the winner's already-committed
state when it proceeds. No application-side check is relied on for this
guarantee.

### Materialised curriculum writes also serialize on the `programme_versions` lock (V4 correction)

The materialised-state projection `run_course_package_test`/
`publish_course_package` read (`materialized_content_hash_from_live`) is
sourced from `public.modules`/`lessons`/`lesson_objectives`/
`learning_resources`. For the `programme_versions` lock above to actually
be a snapshot boundary for those reads, every write to those four tables
must itself take the identical lock before the write is allowed, and
re-check `PUBLISHED`/enrolled status only **after** acquiring it — never
relying on a check performed before a possible wait, since status can
change while blocked on the lock. Migration 001/005's existing
`freeze_content`/`guard_curriculum_version` trigger already takes exactly
this lock-then-check path on these same four tables. This migration adds
its own dedicated trigger,
`course_engineering_private.lock_materialized_curriculum_version`
(`materialized_curriculum_serialization`, on all four tables), rather than
relying on that inference across migrations or editing the historical one:
it takes the identical `programme_versions` lock (rows ordered by `id` when
an `UPDATE` moves a row between two version ids, avoiding deadlock) and
re-checks `PUBLISHED`/enrolled status only after acquiring it, exactly
mirroring `lock_config_version`'s role for `academic_agent_configs`. Firing
alongside the pre-existing trigger is intentionally redundant, not
conflicting — both reach the identical lock and the identical check. The
intended serialization is now: **configuration writes → `programme_versions`
lock**, **materialised curriculum writes → `programme_versions` lock**,
**`run_course_package_test` → `programme_versions` lock**,
**`publish_course_package` → `programme_versions` lock** — all four
contending for the same single row lock, so whichever commits its
acquisition first is authoritative and the loser always observes the
winner's already-committed state, exactly like the config/Apply/publish
races above.

This local test suite runs against PGlite, a single embedded Postgres
instance with no genuine concurrent sessions. A direct probe against it (two
overlapping `begin; select ... for update` sequences issued concurrently on
the one PGlite connection) confirmed the second acquires the "locked" row
immediately instead of blocking on the first's uncommitted transaction, so
PGlite cannot faithfully exercise two independent transactions contending
for the same row lock. `tests/course-prepublication-test-gate.test.ts`
therefore proves this trigger is installed on all four tables and that it
fails closed (`INSERT`/`UPDATE`/`DELETE`) once the version is `PUBLISHED` —
the same outcome true lock contention would produce once the winning side
commits — rather than claiming a genuine concurrent-transaction blocking/wake
regression. That specific claim (a materialised write and `run_course_
package_test`/`publish_course_package` genuinely contending for the same row
lock under real PostgreSQL MVCC) remains part of hosted Supabase/PostgreSQL
acceptance; the common-lock architecture itself is structurally enforced and
exercised locally, but true concurrent contention is not.

## `run_course_package_test` state and admin surface

Allowed only while the import is `APPLIED` and its bound `programme_versions`
row is still `DRAFT` — never before Apply (no version to test) and never
against an already-`PUBLISHED` package (no re-testing a live version).
`/admin/course-engineering` gains a "Pre-publication test" step between
explicit agent configuration and Publish, and a database-derived safe status
(`NOT_TESTED` / `FAILED` / `PASSED_CURRENT` / `PASSED_STALE`) via
`get_course_package_test_status` — a read-only projection that recomputes
the fingerprint fresh but never itself gates publication. The Server Action
publish branch re-checks this status before delegating (better UX on a
forged/stale attempt), but the database's own gate inside
`publish_course_package` is what actually enforces the invariant regardless
of what the browser or Server Action believe.

Pre-publication readiness is meaningful, and is only ever fetched/displayed,
while `course_package_imports.status` is `APPLIED`; it gates the
APPLIED → Publish action only. `compute_publication_fingerprint` binds
`programme_versions.status`, so a pre-publication PASS — necessarily
recorded while that status is still `DRAFT` — stops matching the current
fingerprint the instant publication succeeds and the status becomes
`PUBLISHED`; recomputing readiness after publication would therefore always
report the just-published state as `PASSED_STALE`, never `PASSED_CURRENT`.
The admin page does not recompute or require pre-publication readiness once
`course_package_imports.status` is `PUBLISHED` — that status is itself the
proof that `publish_course_package`'s own database test gate already
passed, so `/admin/activation` is exposed on `PUBLISHED` status alone.

## Tests and scope

`tests/course-prepublication-test-gate.test.ts` (38 direct-RPC/DB tests) proves
the publication-surface correction (including with a valid PASS), FAIL
persistence-without-raising, PACKAGE_REVALIDATION_FAILED with no leaked
SQL/exception text, the fixed policy identity and its CHECK-constraint
protection, fingerprint sensitivity to semantic config change while being
capability-order-independent, migration-027-identical instructional-note
normalization, the latest-run-wins rule (including a structurally
constructed later-FAIL-overrides-earlier-PASS case, since the deterministic
design makes that scenario otherwise unreachable through the normal RPC
surface), exact-state-restoration PASS reuse, every lifecycle-state
rejection, rejection of any extra RPC argument, ledger immutability, and
anon/service_role ACL denial on the table and every new/corrected RPC. The
V2 correction adds: a full two-revision regression proving a later
revision's Apply invalidates an earlier revision's PASS via the shared
`programmes` row, blocks that earlier revision's publication until the
shared metadata is restored (at which point the original PASS becomes
current again with no re-test, and the resulting snapshot is proven to
equal the _original_ metadata, never the intervening one); three privileged
direct-row drift regressions (module title, lesson-objective description,
learning-resource body) proving a DRAFT materialised mutation invisible to
any RPC still makes the PASS stale and blocks publication; and a direct
assertion that `run_course_package_test` itself reports
`MATERIALIZED_STATE_MISMATCH` (not merely that publish later fails). The V3
correction adds two direct identity-binding drift regressions (a privileged
`programme_versions.programme_id` repoint to a different, otherwise-valid
programme, and a privileged `programmes.slug` repoint away from the bound
`package_key`), each proving `run_course_package_test` persists/returns
`MATERIALIZED_STATE_MISMATCH`, `publish_course_package` fails closed, no
foreign programme metadata is ever snapshotted, and restoring the exact
original identity binding makes the original PASS current again with no
re-test required -- the same deterministic-restoration rule already proven
for agent configuration (V1) and shared programme metadata (V2). The V4
correction adds five tests: one proving the new
`materialized_curriculum_serialization` trigger is actually installed, wired
to `lock_materialized_curriculum_version`, on all four materialised
curriculum tables (queried directly from `pg_trigger`); and one per table
(module, lesson, lesson_objective, learning_resource) proving direct
`INSERT`/`UPDATE`/`DELETE` remains allowed while the owning version is
`DRAFT` and fails closed with "Published or enrolled curriculum is
immutable" on every one of those three paths once it is `PUBLISHED`. As
documented in the Concurrency section above, these prove the trigger's
installation and its fail-closed behavior, not genuine concurrent
transaction contention, which PGlite cannot faithfully exercise and which
remains part of hosted acceptance.

`tests/course-engineering-admin.test.ts` adds a schema-level proof that
`testFailureCodeSchema`/`testRunResultSchema` accept a real
`MATERIALIZED_STATE_MISMATCH` database result (rather than rejecting it),
and that `describeTestFailure` and `runCourseTestAction` produce a bounded,
specific operator message for it, never the generic default. It also
replaces a V2 test that mocked an impossible `PUBLISHED` +
`get_course_package_test_status` `PASSED_CURRENT` combination with a
realistic regression proving a successfully published package exposes
`/admin/activation` without the page ever calling
`getCoursePackageTestStatus`, plus a regression proving an `APPLIED`
package never exposes activation regardless of test status.

Every existing fixture/test file that previously published a course package
directly (`tests/course-engineering-workflow.test.ts`,
`tests/course-activation-workflow.test.ts`,
`tests/course-activation-server.test.ts`,
`tests/commercial-v1-assessment-policy-fixture.ts`,
`tests/commercial-v1-commerce-fixture.ts`, `tests/tutor-lab-fixture.ts`) was
updated to save all five roles explicitly disabled and record a passing test
before publishing, exactly the sequence the admin UI now requires.

`npm run check` passed lint, typecheck and 1,755 tests across 78 files;
production build, `format:check` and `git diff --check` passed. Migrations
001–034 remain byte-for-byte unchanged; migration 035 (corrected in place
for the V4 review) is the only migration this checkpoint adds. This
checkpoint remains locally validated only; PR-head CI, review, merge and
post-merge main CI are still required, and hosted Supabase/JWT/PostgREST and
production infrastructure acceptance are unaffected and still outstanding.
