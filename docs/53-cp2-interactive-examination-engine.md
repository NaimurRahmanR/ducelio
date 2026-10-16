# CP2: interactive examination engine

Status: implemented locally on `feat/cp2-interactive-exam-engine` from `main`
`dd5e27a`. **Not committed, not pushed, not deployed.** Migration 059 is not
applied to any hosted Supabase project. No real course content was generated or
imported: all test and preview material is synthetic and labelled as such.

## 1. Lifecycle (as implemented)

Course package (`COURSE_PACKAGE_V1`, additive question extension) → TypeScript
validation (`validateCoursePackage`) → staging (`import_course_package`) →
database validation (`mark_course_package_validated` →
`assert_full_package_valid`) → apply → pre-publication test → publication →
cohort activation (`activate_course_package` materialises each question through
`add_assessment_question` and, for objective questions, attaches the protected
definition and key while the assessment is still DRAFT) → component binding and
grading policy → learner attempt (`start_assessment_attempt`, unchanged
database timing) → question display (`get_active_assessment_questions`
plus `get_active_assessment_exam_state`) → response persistence (existing
append-only `assessment_responses`, validated against the published definition)
→ submission (`submit_assessment_attempt`, unchanged) → grading (the single
existing Examiner chain: initial grade, regrade, recovery, human academic
review) → governed result revision → existing result release.

Manual authoring follows the same rules through
`add_objective_assessment_question` (DRAFT assessments only; admin or the
assigned instructor, reusing `add_assessment_question`'s authority).

## 2. Question types

| Type                | Learner interaction                                                             | Scoring rules (author selects; shown to learners) |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `FREE_TEXT`         | Text answer (existing)                                                          | Governed Examiner / human review (unchanged)      |
| `SINGLE_SELECT`     | Radio group                                                                     | `ALL_OR_NOTHING`                                  |
| `MULTIPLE_SELECT`   | Checkboxes; "select exactly N" or "select all that apply"                       | `ALL_OR_NOTHING`, `NET_PROPORTIONAL`              |
| `PBQ_MATCHING`      | One labelled select per item (no drag-and-drop required); optional target reuse | `ALL_OR_NOTHING`, `PER_ITEM_PROPORTIONAL`         |
| `PBQ_ORDERING`      | Ordered list with Move up / Move down buttons and a live announcement           | `ALL_OR_NOTHING`, `PER_POSITION_PROPORTIONAL`     |
| `PBQ_CONFIGURATION` | Bounded scenario text plus one select per setting; nothing is executed          | `ALL_OR_NOTHING`, `PER_FIELD_PROPORTIONAL`        |

A question without `questionType` is `FREE_TEXT`, so every existing package,
question, response and result keeps its exact meaning.

### Package format (synthetic example)

```json
{
  "position": 1,
  "prompt": "Synthetic demo question (not real exam content).",
  "maxMarks": 4,
  "expectedAnswer": "Protected rationale shown only to staff reviewers.",
  "markingGuidance": null,
  "objectiveRefs": ["obj-1"],
  "questionType": "MULTIPLE_SELECT",
  "interaction": {
    "options": [
      { "id": "c7a1", "label": "Synthetic option A" },
      { "id": "c2f9", "label": "Synthetic option B" },
      { "id": "c0b3", "label": "Synthetic option C" }
    ],
    "requiredSelections": 2,
    "scoringRule": "NET_PROPORTIONAL"
  },
  "answerKey": { "correctOptionIds": ["c7a1", "c0b3"] }
}
```

Key shapes: `SINGLE_SELECT {correctOptionId}`, `MULTIPLE_SELECT
{correctOptionIds}`, `PBQ_MATCHING {mapping: {itemId: targetId}}` (every item),
`PBQ_ORDERING {correctOrder}` (permutation that must differ from the displayed
`steps` order), `PBQ_CONFIGURATION {values: {fieldId: optionId}}` (every field).

Identifiers (`^[a-z0-9][a-z0-9_-]{0,39}$`) are learner-visible. **Authors must not
encode correctness or order in them** (for example `correct`, or ordering steps
numbered in their correct sequence). The admin editor generates random
identifiers; the validators cannot detect a meaningful identifier in uploaded
JSON, so this remains an authoring rule.

## 3. Compatibility decisions

- No schema-version change. Following migration 037's precedent (optional
  `lessonRef`), the extension is three optional question keys. The live 037
  database validator is retained unchanged (renamed
  `assert_full_package_valid_v037`) and receives the package with only those
  three keys removed; the extension is validated separately. Legacy packages
  are therefore checked by exactly the previous code.
- The persisted validation report shape is unchanged.
- `expectedAnswer` stays required for every question (protected rationale for
  objective questions), so no existing NOT NULL contract changes.
- `activate_course_package` is re-created verbatim from migration 037 plus three
  lines (verified by diff during implementation).
- Existing RPC signatures are unchanged. New behaviour is added through
  migration 045's wrapper pattern (originals moved, unchanged, behind
  same-signature public wrappers).

## 4. Scoring policy

Integer arithmetic only. Proportional rules award `floor(maxMarks × earned ÷ total)`.

- `ALL_OR_NOTHING`: `maxMarks` only for a completely correct answer.
- `NET_PROPORTIONAL`: earned = correct selections − incorrect selections
  (minimum 0); total = number of correct options.
- `PER_ITEM_PROPORTIONAL` / `PER_POSITION_PROPORTIONAL` /
  `PER_FIELD_PROPORTIONAL`: earned = items matched correctly / steps in their
  correct position / settings configured correctly; total = items / steps /
  fields.
- A missing or invalid response scores 0. The mark is computed from the
  attempt's final saved response (responses are accepted only while the
  attempt is ACTIVE and before its database deadline).

The authoritative scorer is `assessment_interaction_private.score_response`
(SQL). `scoreObjectiveResponse` in `src/domain/assessment-question-types.ts` is
a reference implementation used to cross-check it (360 randomized cases in the
test suite); no runtime path awards marks from TypeScript.

## 5. Institutional authority and security

- **Protected storage.** `assessment_question_interactions` (learner-visible
  definition) and `assessment_question_objective_keys` (answer key): RLS on, no
  privilege for `anon`, `authenticated` or `service_role` (asserted at migration
  time). Insert-only while the parent assessment is DRAFT; every update/delete
  is refused (even for the owner). Definitions and keys are validated at the
  table boundary; a deferred constraint guarantees no definition commits
  without its key. Audit rows carry identifiers and type only.
- **Release.** `get_active_assessment_exam_state` first runs
  `get_active_assessment_questions` (STUDENT, published, inside the window,
  own unexpired ACTIVE attempt, revoked commercial access refused), then returns
  type, definition and the caller's own latest saved answer. Keys are never
  returned to learners by any path.
- **Responses.** `record_assessment_response` and
  `record_commercial_v1_assessment_response` validate an objective body against
  the published definition before the unchanged writers run (invalid → raise /
  `INVALID_INPUT`, no row written). Ownership is resolved first, so nothing new
  is revealed. Append-only revisions, idempotency, deadline and
  `AUTO_TIMEOUT` finalisation are unchanged.
- **One grading chain.** A `BEFORE INSERT` guard on
  `commercial_v1_assessment_question_marks` requires every objective mark to equal
  the scorer's result. It binds all five existing writers (Examiner initial
  grade 031/036, regrade 032, recovery 040, human review 047) and any future one.
  Inside Examiner FINALIZE a mismatch becomes a durable
  `FAILED / RESULT_INTEGRITY_FAILED` execution with no partial result.
- **Mixed assessments.** The three Examiner context functions are wrapped:
  objective questions are removed from the provider context and replaced by
  `objectiveMarks` / `objectiveQuestionCount` computed in the database. The
  TypeScript orchestrators send the provider exactly the pre-CP2 context shape
  (`examinerProviderContext`), merge the provider's free-text marks with the
  database's objective marks, and sign one grade digest. When no free-text
  answer exists, FINALIZE runs with truthful zero provider usage and no
  provider call. Budget, digest, attestation, one-claim-per-target, regrade
  and recovery semantics are unchanged.
- **Human review.** The review case is annotated with each objective question's
  definition and locked deterministic mark; the form submits that fixed value
  and the database rejects any other.
- **Browser authority.** The browser supplies only identifiers, a response body
  and an idempotency key. It cannot choose a scoring rule, supply a key or a
  mark, or reach a grading operation. The declared question type in the save
  form only selects the canonical serialiser; the database validates against
  the real published type.

## 6. Learner experience

`src/components/exam-workspace.tsx`: per-question navigation with
answered / unsaved / not-answered state; a countdown calibrated to server time
and anchored to the database expiry (display only); explicit **Save answer**
per question (no auto-save is claimed); drafts are kept while navigating; saved
answers resume exactly after refresh; time-up state disables answering and
explains automatic submission; a confirmation step lists unanswered and unsaved
questions before **Submit final answers**; native keyboard-operable controls,
visible focus, labelled inputs, live announcements at 10/5/1 minutes and on
ordering moves; responsive layout down to phone width. All content renders as
React text.

Not implemented (and not claimed): auto-save, time extensions, drag-and-drop,
immediate learner-visible grades beyond the existing result release, answer
reveal to learners.

## 7. Verification

### Automated suites

- `tests/assessment-question-types.test.ts` (32): definitions, keys, responses,
  canonical bodies, the scoring policy and `COURSE_PACKAGE_V1` compatibility.
- `tests/interactive-exam-engine-db.test.ts` (18, PGlite): activation, ACLs,
  immutability, gated release, hostile input, idempotency, deterministic and
  mixed grading through the real Examiner orchestrator with HMAC attestation,
  forged-mark refusal, human review, package validation, preview redaction,
  authoring authority, and a 360-case SQL-versus-reference scorer comparison.
- `tests/interactive-exam-ui.test.ts` (15): static rendering of the real
  components, server action canonicalisation, save-key derivation and
  authoring refusal.
- `tests/assessment-save-key.test.ts` (11): CP2C save-key regression (see
  below).
- `tests/interactive-exam-pg-concurrency.test.ts` (9, **real PostgreSQL**):
  independent `pg.Client` connections; each scenario uses a database cloned
  from a migrated template, and overlap is proven by `pg_stat_activity`
  lock waits before the holder releases. Scenarios: simultaneous starts;
  same-key saves; conflicting saves (reused key refused, distinct keys
  serialised into ordered revisions, last answer scored); save racing final
  submission (both orders); saves racing expiry (exactly one `AUTO_TIMEOUT`
  transition); simultaneous grading of an objective attempt (one claim, one
  deterministic result, no provider call); simultaneous mixed grading (one
  provider call, one combined result, replay never regrades); competing human
  reviews (a forged objective mark never lands; one result keeps the
  deterministic marks). Skipped without `DUCELIO_TEST_POSTGRES_URL`; fails
  outright when `DUCELIO_REQUIRE_PG_CONCURRENCY=1` and no server is set.

### CP2C: answer-save idempotency key

CP2/CP2B derived the save idempotency key in the browser from a 32-bit FNV-1a
checksum of the body, so different answers could share a key (for example
`d27g1xbhlordy` and `rae2hl0i00jow` both hash to `09475f50`); the second,
genuinely different answer for the same revision slot would then be refused as
`IDEMPOTENCY_CONFLICT`. The browser now posts only the revision slot it is
answering; the save server action derives
`assessment:<attempt>:question:<question>:revision:<slot>:<sha256(body)>`
from the exact (canonical) body with the platform SHA-256
(`src/server/assessment-save-key.ts`). Identical retries keep the same key;
different answers never share one. The database idempotency rule and
migration 059 are unchanged. Regressions: unit, server action, PGlite and a
real-PostgreSQL concurrent scenario using the colliding pair.

### Defect found only by real PostgreSQL

The deferred constraint trigger `require_objective_key` originally ran without
`SECURITY DEFINER`. A deferred trigger fires at COMMIT, after the definer RPC
has returned, so it ran as the calling role and was refused access to the key
table: every activation containing objective questions would have failed on
real PostgreSQL. PGlite did not reproduce this. It is now `SECURITY DEFINER`
(existence check only).

### Continuous integration

`.github/workflows/ci.yml` adds a `postgres-concurrency` job: a disposable
`postgres:16` service with a CI-only credential, a hard reachability check,
both real-PostgreSQL suites with `DUCELIO_REQUIRE_PG_CONCURRENCY=1`, and
`scripts/ci/assert-pg-concurrency-report.mjs`, which fails unless both files
executed, nothing was skipped or failed, and at least 14 tests passed. The
existing `quality` job is unchanged. **This job has not yet run in GitHub
Actions.**

### Browser verification (component harness, not end to end)

The real `ExamWorkspace` client component was bundled and driven in real
Chrome through the DevTools Protocol with real key events (Tab traversal,
arrow keys, Space, Enter): every question type, navigation, a visible focus
indicator, reload restoration, submission confirmation with focus management,
the expired state, and a true 390px viewport (no overflow; controls at least
44px tall). Server actions were replaced by an in-memory stand-in applying the
real domain validation and canonical serialisation. **No authenticated
end-to-end browser journey was run**: that needs Supabase Auth and PostgREST,
which are not available locally without Docker, and hosted Supabase was out of
scope.

## 8. Known limitations

- PostgreSQL CI has not yet run in GitHub Actions (local real-PostgreSQL runs
  used a disposable PostgreSQL 16.14 server; see the checkpoint report).
- No authenticated end-to-end browser journey; no axe audit.
- No hosted Supabase/PostgREST acceptance of migration 059.
- Objective questions in non-Commercial-V1 (legacy Phase 2) assessments are
  validated and saved, but those assessments have no automated grading path,
  exactly as before.
- A flawed published key cannot be corrected in place (published keys are
  immutable by design); correction requires a new assessment version.
- Learner-visible identifiers must not encode correctness; the editor
  randomises them, but uploaded JSON cannot be checked for this.
