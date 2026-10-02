# Commercial V1 human academic review — governed manual first grade

Migration `202610020047_commercial_v1_human_academic_review.sql`. Admin surface `/admin/academic-review`. This checkpoint adds only the missing human first-grade authority and its minimal operational surface.

## Why it exists

The automated grading chain deliberately leaves some targets result-free, with no automated path to a result:

- An initial Examiner execution reached `ESCALATED` / `HUMAN_REVIEW_REQUIRED`, either from the course's `escalationPolicy=ACADEMIC_REVIEW` (migration 036) or from a provider escalation. Migration 040 forbids automated recovery of it.
- The single permitted recovery execution (migration 040) itself reached `ESCALATED`.
- That recovery ended without a result (`FAILED`, `TIMEOUT`, `BUDGET_BLOCKED`, `CANCELLED`). The one-recovery ceiling forbids a second automated attempt.

Regrade (migration 032) cannot help, because it resolves its source from an existing result revision.

## Eligibility (database-derived)

A case is opened by the terminal claim above. The case id is that claim's id: the initial execution for `INITIAL_ESCALATION`, the recovery execution for `RECOVERY_ESCALATION` / `RECOVERY_EXHAUSTED`. A case appears only while its target (enrolment + component, or enrolment + practical) has no result revision.

Never included:

- `SUCCEEDED` or result-bearing targets;
- active `AUTHORIZED`/`RUNNING` initial or recovery claims;
- ordinary `FAILED`/`TIMEOUT`/`BUDGET_BLOCKED`/`CANCELLED` originals that still have their one automated recovery (they stay on `/admin/activation/recovery`).

## Authority

Only a freshly authenticated `ACADEMIC_ADMIN` or `PLATFORM_ADMIN` may list cases, read a case or record a grade. The server checks the role before calling the database, and the database re-derives the actor and re-checks the role under the write locks.

`STUDENT`, `INSTRUCTOR`, `COUNSELLOR` and `REGISTRAR` are refused (`FORBIDDEN`). `anon` and `service_role` have no `EXECUTE` privilege, and the migration self-verifies effective privileges. A reviewer never sees, reads or grades their own work: a learner who is also an admin gets `SELF_REVIEW_FORBIDDEN`, and their own cases are hidden from their list.

The browser supplies only the case id (a hidden field from the server-rendered case), the human marks and a bounded reason (5–300 characters). Everything else is resolved by the database from authoritative state:

- learner, enrolment, activation, attempt/submission, assessment, component/practical;
- question set, per-question max marks, component weight (grading policy), lab max marks and contribution (published lab policy);
- revision number and target kind.

No provider, model, runtime profile, budget, HMAC or controller secret is involved.

## Protected review context

`get_commercial_v1_academic_review_case(case_id)` returns, for an open case only:

- **Assessment:** every question of the attempt's assessment with prompt, authoritative max marks, answer key / marking guidance, whether it was answered, and the learner's latest response. Also the total, the component weight and the assessment instructions.
- **Lab:** practical instructions, the learner's submission body, the published max marks / contribution, grading guidance and mapped objective descriptions.

It never returns provider execution internals, MACs, budgets, recovery reason text or audit JSON. The worklist itself returns labels only: case kind, work, learner name/number, course/cohort and timestamps. It returns no bodies, answer keys or guidance.

The existing provider context readers are not reused: they require a fresh controller attestation for a `RUNNING` execution, and these executions are terminal.

## Manual first-grade semantics

- **Assessment** (`submit_commercial_v1_academic_review_assessment_grade`): marks must cover every question of the assessment exactly once, as whole numbers from 0 to that question's real max. An unanswered question can only receive 0 — the Examiner finalizer's own deterministic-zero rule.
  - Missing, foreign, duplicate, negative, fractional, over-max and over-specified entries are refused (`INCOMPLETE_QUESTION_MARKS`, `FOREIGN_QUESTION`, `DUPLICATE_QUESTION`, `MARKS_BELOW_ZERO`, `INVALID_MARKS`, `MARKS_EXCEED_MAX`, `UNANSWERED_QUESTION_GRADED`). An extra key such as `maxMarks` is `INVALID_MARKS`.
  - The database sums earned and max totals itself and uses the bound component and its grading-policy weight.
- **Lab** (`submit_commercial_v1_academic_review_lab_grade`): one whole-number mark from 0 to the published lab max. Max marks and contribution come only from the published lab policy (`LAB_POLICY_REQUIRED` if absent).
- **Both:** the function writes revision 1 through migration 030's unchanged insert guards. It derives objective outcomes and remediation with the existing `derive_and_insert_objective_outcomes` / `derive_and_insert_lab_objective_outcomes`, and requires `assessment_result_is_valid` / `lab_result_is_valid` to pass. Nothing is reimplemented in TypeScript.

Calling the wrong writer for a case is `TARGET_KIND_MISMATCH`. Any failure rolls back the whole call, leaving no partial result, marks, outcomes, decision or audit row.

## Question-set size

Neither the review contracts nor the writer impose a question or objective count ceiling: the writer validates every question of the authoritative assessment exactly once, whatever its size. The only size bound is the repository's own. A review case requires a component-bound assessment, and component binding accepts only activation-materialised assessments. The database package validator (`assert_full_package_valid`, migrations 024/036/037, re-run inside activation) refuses more than 100 questions per assessment template. Activation publishes each assessment immediately, and `guard_assessment_question_history` freezes a published assessment's questions for every writer. So 100 questions is the largest assessment a case can have. The 101-question regression is proven in the TypeScript contracts and the server path; the database regression runs at the 100-question maximum.

## Academic-record policy: first grade after withdrawal

An already-submitted piece of work whose grading escalated or exhausted its recovery still receives its legitimate first academic grade if the enrolment later becomes PAUSED or WITHDRAWN. The work was assessed while the learner was enrolled, and the grade completes that academic record. It does not reopen learning. This matches the existing chain: the result insert guards, the validators and remediation reconciliation do not depend on enrolment status, and Examiner FINALIZE itself writes results without re-checking it.

The review never writes the enrolment, so it stays PAUSED or WITHDRAWN and no access is reactivated. Course completion stays unavailable through the existing completion rule (`ENROLMENT_NOT_ACTIVE` for any non-ACTIVE enrolment). Regrade and automated recovery keep their own ACTIVE-only admission; this policy covers only the missing first grade.

## Result and provenance model

The produced row is an ordinary result revision. Progress (`get_commercial_v1_course_progress`), completion, remediation, the leaderboard and regrade read it like any other current valid result. Regrade's source resolver accepts it as current and valid, so a later institutional regrade uses the normal regrade authority. There is no second manual regrade system.

The result tables' `provenance` CHECK (`COMMERCIAL_V1_RESULTS_V1` only) is not weakened. Human origin is recorded instead in `commercial_v1_academic_review_decisions`, an append-only row (updates and deletes refused, RLS on, no client privileges) that holds:

- the actor, the case kind and case state/reason;
- the original execution (unique) and the recovery execution (unique, when present);
- the full target identity;
- the produced result revision (unique);
- revision number 1, decision kind `MANUAL_FIRST_GRADE`, status `RESULT_CREATED`, the reason, and the case-opened and decided timestamps.

An audit event `COMMERCIAL_V1_ACADEMIC_REVIEW_FIRST_GRADE` with source `HUMAN_ACADEMIC_REVIEW` records the identifiers and totals only. It contains no response or submission body, answer key, guidance or secret.

Terminal Examiner and recovery executions are never updated. Their history stays as it was.

## Locking and concurrency

Each write:

1. locks the learner's `student_profiles` row, then the enrolment (regrade's order; completion and Examiner FINALIZE take the same enrolment lock);
2. re-checks reviewer authority (and self-review) under those locks;
3. returns the existing decision (`ALREADY_RESOLVED`) if one exists for this original target claim;
4. otherwise re-resolves the case and requires it to still be open (result-free), else `CASE_NOT_OPEN`;
5. validates, writes, validates the result, and records the decision and audit — all in one transaction.

A concurrent second submission therefore waits for the first, then answers idempotently. A case resolved by any other path fails closed. Independently of the function, migration 030's `unique(enrolment_id, component|practical_id, revision_number)` and revision-1 guard, plus the decision table's unique keys, make a second revision 1 impossible.

Tests are deterministic and single-connection (PGlite). No multi-connection PostgreSQL race was run for this authority.

## Relationship to automated recovery and regrade

Recovery remains the only path for an ordinary failed original, and it is never converted into manual grading. When a human grade resolves an escalated or exhausted recovery, `list_commercial_v1_examiner_recovery_targets` reports `RESOLVED_BY_ACADEMIC_REVIEW` instead of `RECOVERY_ESCALATED`/`RECOVERY_EXHAUSTED`. That status comes from a view-only change; the recovery execution is untouched. The recovery page links escalated and exhausted rows to their review case.

Regrade is unchanged and applies to the human-created result exactly as to any other result.

## Known limitations

- No multi-connection concurrency acceptance was run. Hosted Supabase/PostgREST acceptance of migration 047 has not been run.
- The review case is not blind: the reviewer sees the learner's name and student number.
- One decision per original target claim; a target is never graded twice manually. Corrections go through regrade.
- No reviewer-assignment, second-marker or moderation workflow exists yet.
