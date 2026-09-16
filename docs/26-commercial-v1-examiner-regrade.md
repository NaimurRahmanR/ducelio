# Commercial V1 PR11B2 — governed Examiner regrade

Status: implemented locally on `commercial-v1-examiner-regrade`, based on
`ff11bf1af239535afbe7fa35a32ee784eb1c96dc`. Independent V2 patch review is
GREEN FOR COMMIT. The implementation remains uncommitted and unpushed; PR11B2
is not closed until PR-head CI, merge and post-merge main CI are verified.
PR11B1 is closed green through PR #12, its merge and post-merge main CI.

## Authority and scope

The two server-only entrypoints, `regradeControlledAssessment` and
`regradePracticalLab`, accept only `{ resultRevisionId, reason }`. The reason is
trimmed, non-empty and at most 300 characters. It is institutional review context
stored on the execution record, never grading instructions or provider context.
Only fresh authenticated `ACADEMIC_ADMIN` or `PLATFORM_ADMIN` principals can
authorize execution. A STUDENT role alone, other staff roles, anon and
`service_role` confer no regrade authority. There is no public route or UI.

Migration `202609160032_commercial_v1_examiner_regrade.sql` is additive. Migrations
001–031 and the initial-grade authority remain unchanged. Initial grading still
claims an attempt/submission once and writes revision 1. Regrade has separate
execution and usage tables and a separate private schema.

The database resolves the source result's learner, enrolment, activation,
component/practical and original attempt/submission. It checks the highest
revision first, then invokes migration 030's existing result validator. An older
source returns `NOT_CURRENT_RESULT`; an invalid highest source returns
`CURRENT_RESULT_INVALID`. There is no fallback or automatic repair. The enrolment
must be ACTIVE. The provider grades the same immutable learner work, with the
original authoritative questions, maxima and published weights. Retakes,
replacement submissions, manual marks and post-completion appeals are absent.

## Claim, lifecycle and locking

`commercial_v1_examiner_regrade_executions` binds the institutional actor, source
revision identity/number, learner, enrolment, activation, original work,
capability, policy, execution kind, fixed runtime profile, request reason,
timestamps and budget. These fields are immutable. Terminal rows cannot change
or be deleted. The usage ledger is append-only.

A unique `(target_kind, source_result_revision_id)` claim is admitted before any
provider call. An active claim returns `REPLAY_REJECTED`; successful replay returns
the same execution and produced result even though its source is now older.
Replay is institutional: any currently authorized `ACADEMIC_ADMIN` or
`PLATFORM_ADMIN` may receive the bounded active replay denial or the existing
terminal snapshot. The persisted `actor_id` remains the immutable initiating
administrator, and only that actor may continue START / CONTEXT_READ / FINALIZE
for the admitted execution. Failed, escalated, timed-out or budget-blocked
claims occupy their source slot permanently. A later
intentional regrade can target a successfully produced new current revision,
supporting revision 1 → 2 → 3 without mutating history.

Lifecycle: AUTHORIZED → RUNNING → SUCCEEDED / FAILED / ESCALATED / BUDGET_BLOCKED /
CANCELLED. Expired AUTHORIZED/RUNNING rows become TIMEOUT. A zero-usage
INTERNAL_ERROR cleanup may close AUTHORIZED after an uncertain START transport
failure. Timeouts are lazy, enforced on subsequent governance calls; expiry does
not imply a background worker exists.

Each operation locks the target learner's `student_profiles` row for admission
accounting, then its `enrolments` row `FOR UPDATE`. Current source and ACTIVE
status are re-read under that enrolment lock. This is the same lock used by
`attempt_commercial_v1_course_completion`. If completion commits first, regrade
cannot create a new result. If regrade commits first, completion uses the new
highest revision. Regrade never completes or reopens an enrolment and never
rewrites a completion receipt. PGlite tests exercise sequential orderings, not
true multi-connection PostgreSQL blocking.

Admission preserves conservative security ceilings: one active regrade per
learner, five admissions per rolling 60 seconds, thirty per rolling hour, and a
20-second execution lifetime. These are regrade security ceilings, not commercial
quotas or a new combined budget across other agent subsystems.

## Controller protocol and protected context

Policy: `COMMERCIAL_V1_EXAMINER_REGRADE_V1`. Execution kind:
`PROVIDER_BACKED_REGRADE_V1`. Capabilities: `regrade_controlled_assessment` and
`regrade_practical_lab`. The fixed profile remains `EXAMINER_COMMERCIAL_V1`.

The existing migration-022 private controller key store and server-only
`ACADEMIC_EXECUTION_KEY_ID` / `ACADEMIC_EXECUTION_HMAC_KEY_HEX` provisioning are
reused. No new secret mechanism or service-role credential exists. The key is
never passed to the provider or returned to the caller.

The HMAC-SHA256 canonical message has exactly 32 UTF-8 LF-separated fields:

1. `DUCELIO_COMMERCIAL_V1_EXAMINER_REGRADE_HMAC_SHA256_V1`
2. `COMMERCIAL_V1_EXAMINER_REGRADE_V1`
3. `EXAMINER`
4. `EXAMINER_COMMERCIAL_V1`
5. key UUID
6. database-derived authenticated institutional actor UUID
7. execution UUID
8. source result UUID
9. UTF-8 hex encoding of the bounded request reason
10. capability
11. target kind
12. student UUID or `NONE`
13. attempt UUID or `NONE`
14. submission UUID or `NONE`
15. enrolment UUID or `NONE`
16. activation UUID or `NONE`
17. operation: AUTHORIZE / START / CONTEXT_READ / FINALIZE
18. requested lifecycle state
19. terminal reason code or `NONE`
20. budget stage or `NONE`
21. maximum provider calls
22. maximum output tokens
23. maximum estimated cost in integer micro-USD
24. observed provider calls
25. observed attempts
26. observed input tokens
27. observed output tokens
28. observed estimated cost in integer micro-USD
29. observed elapsed milliseconds
30. normalized grade digest or `NONE`
31. issued epoch seconds
32. expiry epoch seconds

UUIDs are lowercase. Decimal integer fields have no padding. Reason hex prevents
embedded newlines from shifting fields; no arbitrary JSON is signed. AUTHORIZE
requires fields 12–16 to be absent and derives them from the source. Later calls
bind those derived values exactly. FINALIZE independently checks the grade
payload against its signed digest. Initial-grade attestations cannot authorize
this protocol.

Attestations expire exactly ten seconds after issue. Database time is
authoritative, allowing up to five seconds of forward server clock skew and no
expired attestation. Verification is repeated after lock acquisition. The
database rechecks administrator authority and uses the existing pgcrypto trust
root with fixed-length byte comparison.

The authenticated-callable `govern_commercial_v1_examiner_regrade` RPC is not
gateway-only. Its CONTEXT_READ operation needs a fresh, separately signed
operation-bound command and the correct actor, RUNNING execution and unexpired
deadline. Knowing an execution UUID is insufficient. No standalone verifier or
signing oracle is exposed. Private helpers and all direct table/column mutation
privileges are explicitly revoked from public, anon, authenticated and
`service_role`, including ambient grants in the local Supabase-like fixture.

Context reuses B1's strict schemas. It contains authoritative grading material
and persisted work only: no previous marks, score, objective outcomes,
contribution, grade digest, pass status or administrator reason. Assessment
context includes answered questions only. The database assigns zero to all
unanswered authoritative questions during finalization.

## Provider, result and audit semantics

The existing HTTP_JSON profile and runtime are reused unchanged: one call, one
attempt, 128000 input-context bytes, 1200 output tokens, 15000 ms total deadline,
and 50000 micro-USD estimated cost ceiling. No configured adapter means no
provider call and a terminal NO_PROVIDER_CONFIGURED failure. No SDK, new model
profile or generic EXAMINER route is introduced. Generic EXAMINER remains
`NO_EXECUTION_PATH`.

B1's provider parsers, mark validation, digest helpers and usage-to-finalize
mapping are reused. Only strict GRADED marks or ESCALATE are accepted. Known
usage is never erased or clamped. Malformed known usage prevents a fabricated
FINALIZE ledger; database expiry remains the safety backstop. A transport/runtime
exception after entering the provider without known usage likewise cannot be
recorded as a synthetic zero-call execution.

Successful FINALIZE independently validates digest, answered-question set,
integer marks and maxima. It inserts source revision number + 1, the complete
question-mark set or lab mark, then invokes migration 030's existing objective
derivation and validity helpers. The SUCCEEDED transition and produced result
are in the same subtransaction. Integrity failure rolls result writes back and
records FAILED / RESULT_INTEGRITY_FAILED while retaining observed usage. Audit
persistence failure aborts the operation and no successful result is delivered.

Migration 030 alone continues to own highest-revision projections, objective
diagnostics, remediation reconciliation and completion. New CORRECT outcomes may
resolve result-driven remediation when no negative current outcomes remain;
they never write LearningEvidence or ObjectiveMastery or imply DEMONSTRATED.

Audit stores bounded lifecycle/identity/profile/source/produced-result/digest and
usage metadata. No protected context, answer keys, raw responses, lab bodies,
provider output, MAC or secret is stored there. The bounded request reason lives
only on the protected execution row and is not copied into generic audit JSON.
A valid attestation proves possession of an active controller key authorized that
operation. Lifecycle audit does not independently prove provider-side execution,
grading correctness or content delivery. Key IDs are not persisted for historical
rotation attribution; events do not identify which active key signed a transition.

## Validation and limitations

Focused B1/B2 tests cover SQL HMAC enforcement, the real production TypeScript
signer, role/scope/ACL rejection, strict input/context/output contracts, replay
chains, timeout and admission limits, mixed and empty answered sets, rollback,
append-only history, remediation, completion/projection use of revision 2 and
observed usage preservation. Exact final local counts are recorded in
`implementation-progress.md` after the gates finish.

Hosted Supabase ACL/JWT/PostgREST acceptance, production secret provisioning,
live provider acceptance and true multi-connection PostgreSQL concurrency remain
unproven. No live provider call was used in local validation. Terminal unsuccessful
claims have no retry/appeal policy. Retention duration remains an institutional
governance decision; this migration adds no delete endpoint. Learner-facing
integration is separate. PR12 remains future leaderboard snapshots/ranking/UI.
