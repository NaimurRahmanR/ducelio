# Commercial V1 PR11 pass 11A - Results, Labs, Objective Outcomes, Remediation and Completion

## Scope

PR11A starts from canonical base `a6d492d37f044ebd539204489205133912dbc7a0` on `commercial-v1-examiner-results`.

This pass implements deterministic Commercial V1 result policy, explicit lab policy and learner lab submission, append-only assessment/lab result storage, objective outcomes, remediation, learner-safe projections and deterministic course completion.

It does **not** implement provider-backed Examiner execution, AI grading, the trusted result-finalization writer, or leaderboards. Those remain 11B/PR12 work. No public PR11A RPC accepts arbitrary learner-supplied marks.

Migrations 001-029 remain unchanged. The only migration added by this checkpoint is `202609150030_commercial_v1_results_completion.sql`.

## Result policy

`COMMERCIAL_V1_RESULTS_V1` requires the PR10 grading policy first.

`publish_commercial_v1_result_policy` accepts only:

- activation id;
- pass mark in basis points;
- whether remediation must be clear for completion;
- reason.

The pass mark is explicit and bounded to 1..10000. There is no universal hard-coded Ducelio pass mark.

The policy snapshots activation/cohort/programme identity, becomes immutable once published and allows only an identical idempotent replay.

## Lab policy

Lab weighting is explicit and never inferred.

Each legitimate `PRACTICAL_LAB` can be configured with:

- `max_marks` 1..100;
- `contribution_bp` 0..2000;
- bounded grading guidance when contribution is positive.

`EXERCISE` is not eligible.

For WITH_LABS, every materialised lab must have an explicit policy row and the total contribution must equal exactly 2000 bp. A zero-weight lab is allowed and remains explicitly configured, but it is not required for completion.

For NO_LABS, no positive lab contribution is permitted.

The corrected test fixture includes two real labs: one weighted at 2000 bp and one at 0 bp. Publication succeeds without any equal-weight inference, and completion does not require a result for the zero-weight lab.

## Lab submission

`submit_commercial_v1_lab_work` is self-STUDENT scoped to an ACTIVE enrolment and the matching activation.

The final text is trimmed and bounded to 1..20000 characters.

There is one final submission per enrolment/practical. Identical replay is idempotent; a conflicting second final submission fails. Lab submissions are append-only.

PR11A stores submissions but does not grade them. Trusted grading/finalization is deferred to 11B.

## Result storage and integrity

Assessment and lab result history is append-only and revision-numbered.

PR11A deliberately exposes no public arbitrary result writer.

Assessment result validity proves the authoritative identity chain across activation, enrolment, student, formal component, bound assessment and submitted attempt.

A valid assessment result must also prove:

- the stored component weight equals the immutable PR10 grading policy;
- the exact assessment question set is present;
- no foreign question is included;
- every `max_marks_snapshot` equals the real question max;
- header earned/max totals equal the child question-mark sums;
- derived objective outcomes exactly match the real question-to-objective mappings.

Lab result validity proves the matching activation, enrolment, student, practical, final submission and published lab policy, including exact `max_marks` and `contribution_bp`.

Fixed result version/provenance values are database constrained.

The first-draft unconstrained `supersedes_revision_id` field was removed. PR11A therefore does not leave arbitrary cross-lineage or cyclic supersession metadata for 11B to inherit.

### Current-result rule

For each component or lab, the highest revision number is selected first.

That exact highest revision must pass validation. If it is malformed or incomplete, there is no authoritative current result.

The system never falls back to an older valid revision.

This fail-closed rule is used by projections, remediation and completion.

Adversarial tests cover foreign questions, fake max snapshots, wrong header totals, wrong component weights, mismatched earned totals, wrong attempts, wrong lab max/contribution values and foreign lab submissions.

## Objective outcomes

Objective outcomes are deterministic:

- 0 marks -> `INCORRECT`;
- full marks -> `CORRECT`;
- otherwise -> `PARTIAL`.

No percentage threshold is invented.

A real multi-objective question is exercised end-to-end. It fans out to two diagnostic objective outcomes while its marks are counted only once in the numeric assessment/course score.

The earlier multi-objective integration coverage gap is therefore closed.

## Integer scoring

Institutional scoring is database-generated with PostgreSQL NUMERIC arithmetic.

Assessment contribution:

```text
round(earned_marks_total * component_weight_bp / max_marks_total)
```

Assessment score:

```text
round(earned_marks_total * 10000 / max_marks_total)
```

Lab contribution:

```text
round(earned_marks * contribution_bp / max_marks)
```

Full marks yield the full configured weight, zero marks yield zero, and the tested half-up boundary is deterministic.

A full course across all six formal assessment components plus the positively weighted lab totals exactly 10000 bp.

## Remediation and MASTERY_V1

Commercial V1 remediation is separate from historical `MASTERY_V1`.

PR11A does not replace or redefine `record_learning_evidence` or `apply_objective_mastery_policy`.

A current `PARTIAL` or `INCORRECT` assessment/lab objective outcome opens or maintains remediation for the enrolment/objective.

A later authoritative revision that removes all current negative outcomes resolves the item as `SUPERSEDED_RESULT`.

A real later `MASTERY_V1` state of `DEMONSTRATED` can resolve remediation as `MASTERY_DEMONSTRATED` only when its evaluation time is after the remediation item opened.

A Commercial V1 `CORRECT` result never fabricates or mutates `objective_mastery`.

For multi-objective results, reconciliation runs across all mapped objectives after the complete revision validates, preventing stale remediation from partial derivation order.

## Projections

`get_commercial_v1_course_progress` returns bounded learner/admin-safe course status.

If the private authority returns `{ok:false, code:"NOT_FOUND_OR_FORBIDDEN"}`, the public RPC returns that exact denial object unchanged. It does not append success-only enrolment metadata.

`list_commercial_v1_objective_diagnostics` is a separate bounded source-level projection. It exposes only current valid diagnostic information:

- objective id;
- source kind;
- component or practical id;
- current `CORRECT` / `PARTIAL` / `INCORRECT`;
- whether remediation is open.

It is deterministically ordered, paginated and self/admin scoped.

Neither projection exposes answer keys, expected answers, prompts, marking guidance, raw learner responses, provider prompts/outputs or private execution metadata.

## Course completion

`attempt_commercial_v1_course_completion` is the dedicated Commercial V1 completion authority.

It transitions ACTIVE -> COMPLETED only when:

1. the PR10 grading policy exists;
2. the result policy exists;
3. all six formal components have valid authoritative current results;
4. every positive-weight lab has a valid authoritative current result;
5. course score is at least the configured pass mark; and
6. remediation is clear when the published policy requires it.

No lesson-progress, attendance, component-minimum or lab-minimum rule is invented.

Successful completion writes one immutable completion receipt containing the authoritative identity and score/policy snapshots.

Completion is idempotent.

A historical enrolment already marked `COMPLETED` but lacking a PR11 completion receipt fails closed with `COMPLETION_RECEIPT_MISSING`. PR11A never fabricates a receipt from historical status alone.

The generic migration-019 enrolment-status RPC remains untouched, cannot create `COMPLETED`, and cannot reopen/pause/withdraw a completed enrolment.

## Security

Cross-student and cross-activation access is denied.

`anon` and `service_role` cannot invoke the new authority RPCs or directly use the new institutional result tables under the tested effective ACL.

`authenticated` has no arbitrary result/mark/outcome mutation authority.

Completion audit data is metadata-only and does not include protected assessment or learner-submission content.

## Validation

Correction-pass validation is currently:

- focused PR11A tests: **70/70** (56 DB + 14 domain/static);
- full repository: **58/58 test files, 1265/1265 tests**;
- lint and typecheck: passed through `npm run check`;
- production build: passed;
- `git diff --check`: passed;
- migrations 001-029: zero diff against the canonical base;
- migration 030: the only changed migration;
- source encoding scan: `ENCODING_SCAN_OK`;
- Prettier over all eight PR11A changed files: passed.

Repository-wide `npm run format:check` still warns on unchanged `.github/workflows/ci.yml`. Git shows no PR11A diff for that file, and the canonical base blob formats identically under the installed Prettier. The PR11A changed-file formatting gate is green.

## Remaining limitations

Hosted Supabase/PostgREST/JWT acceptance and true multi-connection PostgreSQL concurrency acceptance have not been performed; the DB suite uses PGlite.

No learner UI flow consumes these surfaces yet beyond thin server wrappers.

Instructor-relationship-scoped result projection access remains deferred.

Trusted result finalization and provider-backed Examiner execution remain 11B.

Leaderboards remain PR12.

No commit, push, PR, merge or 11B implementation is authorized until the final independent V2 patch review is green.
