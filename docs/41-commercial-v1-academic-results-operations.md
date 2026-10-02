# Commercial V1 academic results operations

Migration `202610020048_commercial_v1_academic_results_operations.sql`. Admin surface `/admin/academic-results`. This checkpoint is an operations console over the existing result model. It adds no new grading, correction or completion authority.

## What the console does

- **Discovery.** Bounded, server-filtered listing of assessment and lab result revisions:
  - 50 per page, offset at most 100 000, `hasMore` paging;
  - filters: learner name / student number (substring, at most 100 characters), result kind, cohort, programme version, assessment component, practical, current-only (default) vs all revisions, and completion (a completion receipt exists or not).
  - Filter options (cohorts, programme versions, practicals) come from a bounded database projection of at most 200 each.
  - The browser never reads result tables directly.
- **Result detail.** For one revision:
  - learner, cohort, programme/version, activation and component/practical;
  - attempt or lab submission identity and submission time;
  - revision number, earned/max marks, `score_bp` (assessments), weight/contribution, weighted contribution and finalisation time;
  - current/historical state and validity;
  - per-question awarded/max marks (position only, no prompt);
  - objective outcomes with objective descriptions, and whether remediation is open for each objective;
  - provenance;
  - the revision history of the same target, bounded to its newest 100 revisions (see "Revision history read bound"), with links between revisions;
  - the revision's existing outgoing regrade claim, if any (see "Outgoing regrade claim").
- **Learner record.** Enrolment status, cohort and programme, canonical course progress, and the completion receipt.
- **Regrade.** Delegates to the existing institutional regrade (migration 032).
- **Completion.** Delegates to the existing completion authority (migration 030).

## Authority

Only a currently authenticated `ACADEMIC_ADMIN` or `PLATFORM_ADMIN` with an ACTIVE account may use the console. Role and account state are re-checked on every request; authentication age and MFA are not checked. The page calls `requireAnyRole`, and every server function re-checks the actor before any RPC. Every RPC re-derives the actor from `current_app_user()` (ACTIVE accounts only) and re-checks the role in the database.

- `INSTRUCTOR`, `COUNSELLOR`, `REGISTRAR` and `STUDENT` are refused (`FORBIDDEN`).
- `anon` and `service_role` have no `EXECUTE` privilege, and the private schema `commercial_v1_results_ops_private` is unusable by `anon`, `authenticated` and `service_role`. The migration self-verifies these effective privileges.
- The authority was not widened. `REGISTRAR` holds official-record correction authority, which is not academic teaching/grading authority, so it stays excluded.

**Own record.** As in migration 047, an operator never operates on their own academic record. A learner who also holds an admin role:

- does not see their own results in the list;
- gets `SELF_RECORD_FORBIDDEN` from the detail and enrolment-record reads;
- is refused a regrade of their own result by a new database insert guard on `commercial_v1_examiner_regrade_executions` (`SELF_REGRADE_FORBIDDEN`). This guard tightens migration 032, which admitted any academic admin including the learner. It applies to every regrade caller, not only this console.

## Result, revision and provenance model

Result revisions remain append-only (migration 030 guards; no UPDATE/DELETE for any role, including the table owner). The **current** result of a target (enrolment + component, or enrolment + practical) is its highest revision. That revision is what progress, completion, the leaderboard and regrade use, **if it passes `assessment_result_is_valid` / `lab_result_is_valid`**. An invalid highest revision makes the target PENDING. Progress never falls back to an earlier revision. The console shows `isCurrent` (highest revision) and `isValid` separately, so this state is visible.

Provenance is derived only from governed records that reference the revision, matched on target kind. The execution tables store `result_revision_id` without a foreign key, so the kind match matters. Precedence:

| Origin                  | Source of truth                                    | Shown                                                                                   |
| ----------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `HUMAN_ACADEMIC_REVIEW` | `commercial_v1_academic_review_decisions` (047)    | reviewer name, case kind, reason, decision time                                         |
| `EXAMINER_REGRADE`      | `commercial_v1_examiner_regrade_executions` (032)  | requesting admin, reason, source revision (linked), completion time                     |
| `EXAMINER_RECOVERY`     | `commercial_v1_examiner_recovery_executions` (040) | requesting admin, recovery reason, source execution, completion time                    |
| `EXAMINER_INITIAL`      | `commercial_v1_examiner_executions` (031)          | completion time                                                                         |
| `UNATTRIBUTED`          | none                                               | "No recorded grading claim" (for example, pre-provenance or seeded data); never guessed |

**Never returned:**

- question prompts, answer keys, marking or lab grading guidance;
- learner responses and lab submission bodies;
- provider output, grade digests, MACs, controller/HMAC material, budgets and usage;
- audit JSON.

The UI contracts are strict Zod objects, so a payload carrying an unexpected field is rejected rather than rendered.

## Regrade integration

The console exposes the existing regrade only (`regradeControlledAssessment` / `regradePracticalLab`, migration 032). The browser posts exactly two fields: the revision id from the server-rendered detail and a bounded reason (5–300 characters). The server then:

1. re-checks the operator role;
2. re-reads the revision through the admin detail RPC (which also refuses the operator's own record);
3. refuses a non-current (`NOT_CURRENT_RESULT`) or invalid (`CURRENT_RESULT_INVALID`) revision before calling regrade;
4. chooses the assessment or lab regrade from the database `kind`;
5. calls it with `{ resultRevisionId, reason }` only.

The regrade authority then re-resolves the learner, enrolment, activation, attempt/submission, component/practical, weights, max marks, revision number, runtime profile and budget. Under its learner/enrolment locks it re-checks the role, current, valid and ACTIVE enrolment. On success it appends the next revision, which becomes current while the earlier revision stays in the history with `EXAMINER_REGRADE` provenance linking back. The regrade form is rendered only for a current, valid revision of an ACTIVE enrolment that has **no existing regrade claim**. Otherwise the page explains why, and links a historical revision to the current one. The server also refuses a revision that already has a claim (`REGRADE_CLAIM_EXISTS`) without re-entering the regrade path.

Existing regrade semantics are unchanged:

- one regrade claim per source revision (a repeat request replays the earlier outcome);
- `ESCALATED` or failed regrades create no revision;
- rate limits and the ACTIVE-only admission still apply.

## Outgoing regrade claim

Migration 032 allows exactly one regrade claim per source revision and target kind. A claim that ends `FAILED`, `ESCALATED`, `BUDGET_BLOCKED`, `TIMEOUT` or `CANCELLED` produces no revision. A later request for the same source replays that terminal outcome. To keep this visible after reload, the detail returns the selected revision's outgoing claim. It is looked up by `source_result_revision_id` and matching target kind, so there is at most one. The claim is returned as `regradeClaim` (or `null`):

| Field                      | Meaning                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `executionId`              | the existing regrade execution                                                                                         |
| `state`                    | `AUTHORIZED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `ESCALATED`, `BUDGET_BLOCKED`, `TIMEOUT` or `CANCELLED`                |
| `reasonCode`               | the execution's reason code (null while active)                                                                        |
| `requestReason`            | the original bounded request reason                                                                                    |
| `actorName`                | display name of the requesting admin                                                                                   |
| `createdAt`, `terminalAt`  | claim and end times                                                                                                    |
| `producedResultRevisionId` | the produced revision (SUCCEEDED only)                                                                                 |
| `expired`                  | an AUTHORIZED/RUNNING claim past its execution window; the regrade authority records it as `TIMEOUT` on its next check |

It never returns the grade digest, MAC/controller data, provider output, protected context, budgets, usage/tokens/cost or review path.

UI behaviour:

- **No claim** on a current, valid, ACTIVE revision: the regrade form is shown.
- **AUTHORIZED/RUNNING:** the regrade is already in progress (or past its window, awaiting TIMEOUT). No form is shown.
- **FAILED / BUDGET_BLOCKED / TIMEOUT / CANCELLED:** the durable terminal state is shown. The current one-claim policy does not permit another claim for this revision, and the result is unchanged. No form is shown.
- **ESCALATED:** the same, and the page states that no authority currently resolves an escalated regrade. Migration 047 human review covers ungraded first grades only, not regrade escalations.
- **SUCCEEDED** (shown on the superseded source revision): a link to the produced revision.

This adds no retry, human-regrade or alternative result-writing authority. It only reports durable state the existing authority already holds.

## Revision history read bound

Successful regrades can form an arbitrarily long append-only chain, so one detail response returns at most the **newest 100 revisions** of the target. The window always includes the current revision and is ordered ascending. It comes with `historyHasMore` (older revisions exist) and `historyLimit` (100).

- This bounds the read only. Revision 101 and beyond are legitimate: they are never rejected, deleted or invalidated.
- The selected revision's own detail always loads, even when it is older than the window.
- When the history is truncated, the page says so and points to "Include historical (superseded) revisions" in the paginated listing (50 per page), where every revision remains discoverable.
- 100 matches the repository's other operational read bounds (100 questions per assessment, 100 diagnostics per page). It also comfortably exceeds any realistic regrade chain, while keeping a detail response bounded in size.

## Correction and void semantics

**Voiding or excluding a current result is prohibited.** Results are corrected only by regrade. The reasons:

- **Voiding strands the target.** Excluding the current revision would make the target PENDING (no fallback). Nothing could then fill it:
  - human review (047) needs a result-free escalated case;
  - regrade needs a current valid source;
  - recovery (040) needs a terminal result-free original.
  - Voiding would therefore silently turn a graded component into an ungradeable one and block completion forever.
- **Falling back to an earlier revision is not a correction.** It would resurrect a grade the institution already replaced, which is the opposite of append-only intent.
- **Voiding would require a new replacement authority.** A safe void would need a new first-grade authority for already-graded targets, which this checkpoint must not add.

No correction-request table was added. It would only be a second, unenforced queue in front of the existing regrade, and would add no authority or audit that regrade does not already record (actor, reason, source revision, produced revision).

Revision rows, question marks and objective outcomes cannot be updated or deleted. The UI has no edit or delete control, and no client-supplied provenance exists. Migration 048 itself contains no INSERT/UPDATE/DELETE of institutional data; its only new write-path object is the self-regrade refusal trigger.

## Completion behaviour

The learner record shows:

- enrolment status, stated truthfully (a non-ACTIVE, non-completed enrolment is explained);
- canonical progress from `get_commercial_v1_course_progress`, never recomputed in TypeScript or React: per-component and per-lab status, score and weighted contribution, course score (or "not yet available" with the pending count), pass mark (or "no result policy published") and open remediation count;
- the completion receipt: final score, pass mark, completion time, who completed it and the receipt id.

A `COMPLETED` enrolment without a receipt is flagged as `COMPLETION_RECEIPT_MISSING`.

Viewing never completes. For an ACTIVE enrolment without a receipt, the page offers "Attempt course completion". This is the existing `attempt_commercial_v1_course_completion` authority (learner or academic/platform admin), which re-derives every gate. Its refusal is shown as a plain-language reason (`COMPONENTS_INCOMPLETE`, `BELOW_PASS_MARK`, `REMEDIATION_NOT_CLEAR`, `RESULT_POLICY_REQUIRED`, `ENROLMENT_NOT_ACTIVE`, …). No second completion authority exists.

## Database objects (migration 048)

- `commercial_v1_results_ops_private` schema containing:
  - `require_results_admin()`;
  - the `result_revisions` union view (no client privileges);
  - `is_valid`, `origin` and `summary` helpers;
  - `guard_regrade_actor()` and its trigger.
- Public read RPCs, granted `EXECUTE` to `authenticated` only:
  - `list_commercial_v1_academic_results`;
  - `get_commercial_v1_academic_results_filters`;
  - `get_commercial_v1_academic_result`;
  - `get_commercial_v1_academic_enrolment_record`.
- Partial indexes on `result_revision_id` of the initial, recovery and regrade execution tables.
- Every function is `SECURITY DEFINER` with `set search_path=''`. All grants were explicitly revoked from `public`, `anon`, `authenticated` and `service_role` before the single grant, followed by self-verification. RLS is unchanged.

## Known limitations

- Deterministic single-connection PGlite tests only. No multi-connection PostgreSQL concurrency acceptance was run (for example, regrade vs completion from the console). The concurrency guarantees are those of the existing regrade and completion authorities.
- Hosted Supabase/PostgREST/JWT acceptance of migration 048 has not been run.
- Discovery filters scan current-revision state per request. This is acceptable at Commercial V1 volumes, but it has not been load-tested.
- The learner-name filter is a case-insensitive substring match. It is not fuzzy and not indexed.
- Pre-provenance or seeded result revisions show `UNATTRIBUTED`.
- Existing regrade semantics carry over: one regrade claim per source revision. A current revision whose claim escalated or ended without a result cannot be regraded again, and no authority resolves an escalated regrade. The console shows that state durably; it does not add a retry or a second regrade path.
- Regrade remains provider-backed. Without a configured provider it returns `UNAVAILABLE`, and no revision is created.
- The detail view is not blind: operators see learner names and student numbers.
