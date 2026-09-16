# Commercial V1 PR12 — Leaderboard Snapshots, Ranking & UI

## Scope

PR12 starts from canonical base `c8baec1e0eb092ff179214f6703cce8a4eba8c7a` on
`commercial-v1-leaderboard` (the merged PR11B2 head, PR #13). Migrations
001-032 are byte-for-byte unchanged; the only migration this checkpoint adds
is `202609160033_commercial_v1_leaderboard.sql`.

PR12 introduces immutable leaderboard snapshots, deterministic dense
ranking, publication authority, a competitive learner UI page and one
bounded deterministic nudge string. It creates and modifies **no marks**:
every ranked value is derived from the authoritative Commercial V1 result
state PR11A (migration 030) / PR11B1 (031) / PR11B2 (032) already
established, reusing those existing helpers directly rather than
reimplementing a competing definition of "current".

## V2 correction pass

Independent review of the V1 patch (`pr12-leaderboard-review-v1.patch`,
SHA-256 `25d4bc04850e7e90d593c9cda9c4766fecea2eb6f498d26361d8a822dba7eaf9`)
was **not green** and required six architectural corrections (A-F), plus
separate server/page acceptance coverage (G), all implemented in this same
migration (033 has no separate "V2" file — the frozen contract does
not gain a second migration for a correction pass):

- **A — Publication serialization**: the activation row, owning cohort row,
  and complete eligible-enrolment scope are locked `FOR UPDATE`, in that
  order; the enrolment rows are locked in deterministic id order before any
  `course_progress`/`current_*_result` read. See "Snapshot, never live
  mutable ranking" below.
- **B — Frozen leaderboard population**: the ranking scope is now `ACTIVE`,
  `PAUSED` or `COMPLETED` (previously `ACTIVE`/`COMPLETED` only) — a
  PAUSED learner is still institutionally enrolled. See "Publication
  eligibility" below.
- **C — Formal assessment window closure**: publication now also fails
  closed while any bound formal component's real assessment window has not
  yet closed, reusing migration 029's own component-binding/window data.
  See "Publication eligibility" below.
- **D — Learner-facing peer identity minimisation**: the learner projection
  no longer exposes a real `app_users.display_name` or a peer enrolment id
  — only a deterministic, non-academic, rank-independent pseudonymous
  label, with the caller's own row always labelled `You`. See "Learner
  projection" below.
- **E — Learner read authorization enforced in the RPC**: the database RPC
  itself now requires current `STUDENT` authority, self-ownership, and
  snapshot membership — not merely the Next.js page. See "Learner
  projection" below.
- **F — Deterministic snapshot/provenance ordering**: latest-snapshot
  selection now uses a true monotonic secondary key
  (`publication_sequence`), never `published_at` alone; lab provenance
  iteration is now ordered by practical identity. See "Provenance" below.

## V3 final correction pass

Independent review of V2 found one remaining transaction-boundary gap: row
locks on already-existing enrolments could not prevent a brand-new enrolment
from being inserted into the cohort while publication was capturing its
membership set. V3 completes item A by locking the owning `cohorts` row
`FOR UPDATE` before the eligible-enrolment scan; canonical `create_enrolment`
(migration 007) already takes `FOR SHARE` on that same cohort row before its
insert, so membership creation now serializes with publication without any
historical-migration change. V3 also widens friendly peer aliases from 4 to
12 hexadecimal characters and materializes dense ranks with one set-based
`dense_rank()` insert instead of the V2 per-learner O(n^2) higher-score scan.
These changes do not alter ranking policy, privacy authority, grading state
or snapshot immutability.

## Tie rule (explicit decision)

The tie-rank rule was not defined anywhere in the existing repository
evidence (`docs/17-commercial-v1-contract.md`, `docs/12-roadmap.md`, and
every prior "leaderboard" mention across the codebase are all "explicitly
not implemented here" notes, never a specification). Per the project's own
stop-condition instruction for this exact gap, the ambiguity was reported
and the requester confirmed: **dense ranking (1,2,2,3)** — no rank number is
ever skipped by a tie. This is PostgreSQL's own `dense_rank()` semantics,
materialized directly with one set-based `dense_rank() over (order by
score_bp desc)` insert. No secondary academic tiebreaker exists.

## Snapshot, never live mutable ranking

`public.commercial_v1_leaderboard_snapshots` / `commercial_v1_leaderboard_entries`
are both append-only (a dedicated `commercial_v1_private.leaderboard_append_only()`
trigger rejects every `UPDATE`/`DELETE`). Publication **materializes** the
eligible cohort ranking into these immutable rows at that moment; nothing
recomputes ranks in place when underlying results later change (e.g. a
PR11B2 regrade). A later institutional process that wants a fresh ranking
publishes a **new**, separate snapshot — the old one remains historical
truth forever, provably unaffected (tested directly: publishing twice, and
publishing across a genuine intervening regrade-shaped result change, both
leave the first snapshot's own entries byte-identical).

**Serialization (V2 item A, completed by V3)**:
`publish_commercial_v1_leaderboard_snapshot` locks the `course_activations`
row `FOR UPDATE` first, then the owning `cohorts` row `FOR UPDATE`, then the
_complete_ eligible-enrolment scope in deterministic id order before any
readiness/score/result derivation. Canonical `create_enrolment` (migration 007) already takes `FOR SHARE OF c, v` on that same cohort row before
inserting a member, so a concurrent new enrolment either completes before
publication captures membership or waits until publication commits.
`change_enrolment_status` (migration 007) and PR11B2 regrade finalization
(migration 032) already take the same per-row `FOR UPDATE` enrolment lock,
so status changes/regrades similarly serialize. True multi-connection
PostgreSQL blocking remains a hosted-acceptance fact PGlite cannot prove;
static-source tests prove the lock order/conflicting canonical cohort lock,
and sequential tests cover immutable old snapshots across later result
changes.

## Source of truth: reused, never reimplemented

Publication reuses, unmodified:

- `commercial_v1_private.course_progress(enrolment_id)` for both the
  readiness signal (`pending` must be empty) and the exact integer
  `courseScoreBp` used as the ranking score;
- `commercial_v1_private.current_assessment_result` /
  `current_lab_result` for per-component/per-lab provenance (the exact
  result revision id that produced each contribution);
- migration 029's `commercial_v1_component_bindings` joined to
  `public.assessments` for the formal-window-closure check (V2, item C) —
  the same institutional binding/window data `publish_commercial_v1_grading_policy`
  itself already validated at grading-policy publication time.

All three already implement PR11A's fail-closed "highest revision must
independently validate, no fallback to an older revision" rule (migration
030, further exercised by PR11B1/B2's regrade authority) — this migration
adds no parallel validity logic, so a malformed highest revision is
invisible to the leaderboard for exactly the same reason it is invisible to
course completion.

## Ranking measure

The ranking score is `course_progress`'s own `courseScoreBp` — the sum of
the six current formal-component weighted contributions plus every current
positively-weighted lab contribution, exactly as PR11A's grading/result
policy already defines it. No bonus marks, penalties, attendance points,
mastery points, completion-speed points, submission-speed points, streaks
or instructor discretion are introduced. Unchanged by V2.

## Publication eligibility

**Ranking scope (V2, item B — frozen)** is every `enrolments` row in the
activation's cohort with status `ACTIVE`, `PAUSED` or `COMPLETED`. Only
`WITHDRAWN` is excluded — a paused learner is still institutionally
enrolled (pausing delivery does not erase academic standing), while a
withdrawn learner is no longer part of the cohort. No new eligibility field
or status was introduced; `enrolments.status` is unmodified since migration 001.

**Readiness**: publication fails closed (`COHORT_NOT_READY`, no snapshot
written) unless _every_ enrolment in scope — ACTIVE, PAUSED or COMPLETED
alike — has zero pending requirements per its own `course_progress`.
`GRADING_POLICY_REQUIRED`/`RESULT_POLICY_REQUIRED` gate identically to
every other Commercial V1 publish RPC. An empty ranking scope fails closed
with `NO_ELIGIBLE_LEARNERS`.

**Formal window closure (V2, item C)**: `course_progress().pending=[]` is
necessary but not sufficient. Publication also fails closed with
`FORMAL_WINDOW_OPEN` (no snapshot written) while any of the six formal
components bound via migration 029's `commercial_v1_component_bindings`
still has a real assessment `closes_at` in the future — reusing that
existing institutional binding/window data directly, never a second
calendar or a caller-supplied date. Labs remain governed exclusively by
their own result-policy readiness (already folded into `course_progress`);
no separate lab calendar exists.

## Labs

`NO_LABS` activations rank using only the six formal components — no lab
row is ever fabricated. `WITH_LABS` activations include every
_positively-weighted_ lab's current result in provenance/score; a
zero-weight lab configured but never submitted does not block publication
and does not distort any score (tested directly with two real labs, one at
2000bp and one at 0bp). Unchanged by V2.

## Provenance

Each entry's `source_provenance` is a frozen `jsonb` array of
`{kind:"ASSESSMENT",component,resultRevisionId}` /
`{kind:"LAB",practicalId,resultRevisionId}`, computed once at publication
time and never re-derived later. No protected assessment content, marking
guidance, lab body, provider output or unnecessary PII is stored — only
identifiers.

**Determinism (V2, item F)**: lab provenance iteration is now ordered by
`practical_id` (practical identity order), never insertion/configuration
order, so equivalent published state always produces canonical provenance
ordering — proven directly by configuring two labs in reverse identity
order and asserting the provenance array still comes out in identity order.

## Publication authority

`public.publish_commercial_v1_leaderboard_snapshot(activationId, reason)`
reuses `course_activation_private.require_admin()` — the exact same
`ACADEMIC_ADMIN`/`PLATFORM_ADMIN` authority every other Commercial V1
publish RPC already uses (`publish_commercial_v1_grading_policy`,
`publish_commercial_v1_result_policy`, `set_commercial_v1_lab_policy`). No
new role is introduced. The input schema accepts only `activationId` and a
bounded `reason` — there is structurally no score/rank/enrolment-list/
result-revision parameter to accept from a caller. Unchanged by V2.

## Learner projection

`public.get_commercial_v1_leaderboard(enrolmentId)` mirrors
`get_commercial_v1_course_progress`'s self-or-admin, per-enrolment-scoped
pattern, corrected in V2:

**Authorization (V2, item E)**, enforced in the RPC itself, never only by
the Next.js page: a learner read is allowed only when the authenticated
actor currently holds `STUDENT` authority (`public.has_role` re-checks
`role_grants` live — a removed `STUDENT` grant loses access immediately
even though the old enrolment row still references the same user id) AND
the requested enrolment belongs to that actor AND the enrolment is a
_member_ of the latest published snapshot selected by this RPC (membership
is read from immutable `commercial_v1_leaderboard_entries`, never inferred
from the enrolment's _current_ status). A learner who participated in that
latest snapshot may still read it after later withdrawal; an enrolment that
was never a member cannot act as a gateway to its peer data. PR12 does not
add arbitrary historical-snapshot navigation. `ACADEMIC_ADMIN`/
`PLATFORM_ADMIN` retain a separate institutional read path, unbound by the
membership check.

**Peer identity (V2, item D)**: no real `app_users.display_name` and no
peer enrolment id is ever returned (the `app_users` join was removed
entirely). Each entry instead carries `rank`/`scoreBp`/a deterministic,
non-academic, rank-independent pseudonymous `label` (12 hexadecimal
characters derived from the immutable snapshot id + enrolment id — fixed
for a given snapshot and never derived from rank)/`isSelf`. This is a
friendly pseudonymous identifier rather than a cryptographic anonymity
boundary. The caller's own row is always labelled `"You"`.
`selfEnrolmentId` remains at the top level only (the caller's own state),
never per peer entry. No expected answer, marking guidance, lab body,
provider output, administrator regrade reason, grade digest or execution
metadata is ever part of this contract (enforced by
`commercialV1LeaderboardEntrySchema`'s `z.strictObject`).

## Nudge

`get_commercial_v1_leaderboard` also returns one bounded, deterministic
`nudge` string derived only from the caller's own rank/score within this
published snapshot (e.g. "3 learner(s) rank above you."). No new AI/provider
runtime is introduced; the message is plain SQL string composition over
already-permitted data, never a fabricated promise about future rank.
Unchanged by V2.

## UI

`src/app/student/leaderboard/page.tsx` — a new route integrated into the
existing `AcademyShell` navigation (mirrors `/student/practicals/page.tsx`
exactly: a course selector `<form method="get">`, `Card` components, no new
application shell). Renders an honest empty/unpublished state, the
learner's own rank/score/nudge, and the full ranked table with ties shown
identically. No client-side ranking recomputation — every value displayed,
including each row's `label` (V2: pseudonymous for peers, `"You"` for
self), is exactly what the server RPC returned, in the order returned.

## Hard boundaries preserved

No change to PR11A grading/result semantics, PR11B1 initial-grade
authority, PR11B2 regrade/supersession authority, `MASTERY_V1`, result
revision validity rules, completion receipt semantics, result weighting,
assessment content security, the provider runtime, or any
HMAC/controller protocol. No retakes/appeals/grading UI/social
messaging/cross-cohort leaderboard/badges-XP system/new AI agent were
added. Migrations 001-032 remain byte-for-byte unchanged.

## Tests

68 focused tests: 42 database-level
(`tests/commercial-v1-leaderboard-db.test.ts` — a real git-diff
migration-integrity regression against the canonical base; publication by
an authorized admin, denial for student/anon/service_role/unrelated
instructor-only staff, the publish RPC's own arity proving no
score/rank/revision parameter exists; `COHORT_NOT_READY`/policy-missing
fail-closed with zero snapshot rows; duplicate publication producing a
second independent snapshot without mutating the first; append-only
immutability for both tables; an old snapshot proven unchanged both after a
no-op second publication and across a genuine regrade-shaped intervening
result change; static-source proof of the activation -> cohort -> complete
enrolment locking order plus canonical create_enrolment's conflicting
cohort `FOR SHARE` lock (V3 completion of item A); PAUSED-included/
WITHDRAWN-excluded population
scope and a PAUSED-but-pending cohort still blocking publication (V2, item
B); formal-window-open rejection, formal-window-closed success, and
window-closed-but-one-learner-pending rejection (V2, item C); dense-rank
arithmetic proven directly against a synthetic `[90,80,80,70]→[1,2,2,3]`
distribution; NO_LABS and WITH_LABS (two real labs, one positive, one
zero-weight) ranking correctness and the missing-positive-lab
`COHORT_NOT_READY` case; full activation/cohort/programme-version/
enrolment/result-revision provenance verification plus deterministic
practical-identity-ordered lab provenance (V2, item F); self/foreign
learner projection scope; pseudonymous/deterministic/rank-independent peer
12-hex labels with the self row always `"You"` (V3 strengthening of item D);
STUDENT-role-removal
denial and excluded/non-member-enrolment denial, with the positive
historical-access-after-withdrawal counterpart (V2, item E); protected-
content absence; no direct table privilege for `authenticated`; PR11A
validity, course completion and `MASTERY_V1` regression) and 15
domain-level (`tests/commercial-v1-leaderboard-domain.test.ts` — policy
identity, the publish input contract's rejection of caller-supplied
score/rank/enrolment-list/result-revision fields, the entry/projection
contracts' rejection of protected fields including a real display name and
a peer enrolment id (V2, item D), static-source proof that migration 033
adds no provider/HMAC call and grants `authenticated` execute on exactly
the two governed RPCs, and six further static-source proofs — one per V2
correction item A-F), plus a V3 static proof of set-based `dense_rank()`
materialisation. Server/page behavior (V2, item G) is covered
separately: 6 tests in `tests/commercial-v1-leaderboard-server.test.ts`
(RPC name/argument forwarding, no result recomputation, fail-closed on RPC
error, malformed-input rejection before any RPC call, admin authority, and
strict-schema rejection of a malformed publish input) and 5 tests in
`tests/commercial-v1-leaderboard-page.test.ts` (unpublished state,
published rendering with server-returned order/ties/labels/nudge preserved
verbatim, no fetch for a forged/unowned enrolment id, denial for a learner
without STUDENT authority, an honest unavailable state when the server
denies the read).

## Known limitations

- **PGlite cannot prove true multi-connection PostgreSQL concurrency** for
  concurrent publication races — the same limitation already documented for
  every prior Commercial V1 checkpoint. The V3 serialization mechanism
  (item A) is proven present by static-source assertions covering activation,
  cohort and enrolment lock order plus canonical create_enrolment's
  conflicting cohort `FOR SHARE` lock, and exercised sequentially (publish →
  genuine intervening regrade-shaped change → publish); this remains the
  strongest proof available inside PGlite;
  true concurrent-connection blocking remains a hosted-acceptance fact.
- **No hosted provider/Supabase acceptance** was performed; this checkpoint
  makes no provider call at all, so this is inherited scope, not new risk.
- The nudge message is intentionally minimal (one deterministic sentence);
  no broader notification/messaging integration was attempted.
- Do not claim PR12 closed: the V3 corrections are implemented locally,
  uncommitted and unpushed. Local validation and independent V3 implementation
  review are complete; commit, PR-head CI, merge and post-merge main CI are
  still required.
