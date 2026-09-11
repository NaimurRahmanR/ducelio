# Academic capabilities — Phase 3 Checkpoints 1A–1D-B1

This checkpoint introduces a provider-independent, server-only Professor read boundary. It does not integrate an AI model. The authenticated human Ducelio user remains the institutional principal; `PROFESSOR` is a fixed server-selected capability profile, never a RoleGrant or database principal.

## Entry point and authority

`src/server/academic-capabilities/index.ts` exports `invokeProfessorCapability(request)` and the typed `professorCapabilities.invoke` port. Runtime input is untrusted. There is no route, Server Action, public tool endpoint, provider SDK, prompt framework or chat UI attached to this port.

The pure contracts live in `src/domain/academic-capabilities.ts`. They define strict Zod input/output schemas, a capability input/output type map, a provider-independent invocation interface, a result union and provenance. A future adapter can translate a provider's tool format into this JSON contract without changing institutional policy. That adapter must invoke the trusted server entry point; it must never receive a Supabase client, credentials or permission to select an arbitrary service/RPC.

Every capability requires a verified authenticated principal holding STUDENT. Identity comes from the existing Supabase Auth → stable app-user mapping → protected role-grant lookup. `getAuthenticatedActor()` is the uncached form of the existing identity lookup; existing UI services retain the cached `getCurrentActor()` wrapper. New Academy OS reads use the non-redirecting `requireStudentPrincipal()` helper.

Multi-role users retain only their own STUDENT scope on this surface. Extra INSTRUCTOR, COUNSELLOR, ACADEMIC_ADMIN, REGISTRAR or PLATFORM_ADMIN grants neither expand the returned role projection nor authorize another learner's enrolment. The gateway revalidates the principal before releasing a result.

## Enabled catalogue

All UUIDs and pagination values are runtime validated. Objects reject unknown fields, including actor IDs, roles, agent profiles, programme-version overrides, objective overrides and caller-selected firewall actions.

| Capability                       | Input                                       | Output                                                                                    | Scope and activity requirement                                                                            |
| -------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `get_actor_context`              | `{}`                                        | Human `actor_user_id` and effective institutional role STUDENT                            | Authenticated STUDENT; self only; no learning content                                                     |
| `get_activity_permissions`       | `{}`                                        | Server activity state and nine informational capability permission flags                  | Authenticated STUDENT; self only; no assessment identifiers/content                                       |
| `get_current_learner_context`    | `{ enrolmentId }`                           | Enrolment/cohort/version references, enrolment status, bounded programme/cohort snapshots | Explicit owned enrolment; fixed EXPLAIN firewall                                                          |
| `get_lesson_context`             | `{ enrolmentId, lessonId }`                 | Enrolment/version/lesson/module references, bounded title and position                    | Owned enrolment → exact programme version → lesson; fixed EXPLAIN firewall                                |
| `get_lesson_objectives`          | `{ enrolmentId, lessonId, afterPosition? }` | Same scope references, ordered bounded objective page and next position cursor            | Same lesson relationship; each objective belongs to that lesson and exact version; fixed EXPLAIN firewall |
| `get_current_class_session`      | `{ enrolmentId }`                           | Explicit NONE/CURRENT/UPCOMING selection with minimal session timing and lesson reference | Owned enrolment → exact cohort/version; ACTIVE/PAUSED only; fixed EXPLAIN firewall                        |
| `get_learning_resources`         | `{ enrolmentId, lessonId, cursor? }`        | Ordered page of reviewed lecture notes/reference links and next cursor                    | Owned exact-version lesson; five resources per page; fixed EXPLAIN firewall                               |
| `get_permitted_learning_history` | `{ enrolmentId, objectiveId?, cursor? }`    | Privacy-minimised evidence-event summaries and stable cursor                              | Owned enrolment/version; optional exact-version objective; fixed EXPLAIN firewall                         |
| `get_current_mastery_state`      | `{ enrolmentId, lessonId }`                 | Persisted-only ObjectiveMastery state/counters for the exact lesson                       | Owned exact-version lesson; no recalculation or mutation; fixed EXPLAIN firewall                          |

`afterPosition` is an optional integer from 0 through 2147483647. Objective reads fetch at most 51 rows and return at most 50; the extra row determines whether a next page exists. Every page independently reauthorizes. An authorized empty page is successful; inaccessible parent context is denied. Objective descriptions are limited to 4,000 characters each. Context titles are limited to 500 characters and version labels to 200. Oversized/malformed service output fails closed; it is not silently truncated into changed academic content.

Checkpoint 1C adds four bounded reads without introducing a provider or write surface. Current-session selection uses server time, exact owned cohort/version scope, SCHEDULED rows only, and returns CURRENT when an eligible session is in progress, otherwise the nearest UPCOMING session, otherwise NONE. Learning resources return at most five items per page; LECTURE_NOTE bodies remain bounded by the existing 12,000-character curriculum invariant and REFERENCE_LINK values must be credential-free HTTPS URLs. Permitted learning history returns at most 25 events per page in descending recorded-at/UUID order and deliberately excludes evidence_reference, idempotency keys, recorder identity and free-text/private prose. Current mastery returns only persisted ObjectiveMastery rows for the exact owned enrolment/lesson/version, never invokes mastery policy evaluation, and fails closed if more than 200 records would make the non-paginated result incomplete.

The gateway orchestrates `getOwnedStudentEnrolment()` in the existing Academy service, the narrow Academy OS learning-context reads and the activity service. It performs no database queries itself. No institutional mutation or mastery calculation has moved into the capability layer.

## Curriculum and ownership

`getOwnedStudentEnrolment()` applies both enrolment-ID and authenticated-student-ID filters in addition to RLS, and validates the returned identity. Lesson reads filter by lesson ID and the programme-version ID derived from that owned enrolment. Objective reads additionally filter by the validated lesson and version. Output projections validate those relationships before release.

The service does not apply a generic current-publication filter or assume the learner's most recent enrolment is their only context. ACTIVE, PAUSED, WITHDRAWN and COMPLETED owned enrolment history follows the existing read relationship. Published/enrolled curriculum immutability remains enforced by the existing database guards. The capability cannot author curriculum, rewrite history or supply an alternative curriculum version.

## Controlled-assessment firewall

Professor learning reads use the existing `assert_academic_action_allowed('EXPLAIN')` RPC. The server fixes the action; input cannot select `EXAMINER_DELIVERY` or `COUNSELLOR_LOGISTICS`. The new activity service also wraps `current_academic_activity_state()` and `academic_action_allowed('EXPLAIN')` for introspection.

All seven academic-content capabilities check the firewall before retrieval and again before returning. Lesson/objective Academy OS services independently enforce it too, including when called directly by trusted server code. An active controlled assessment returns `ACTIVITY_BLOCKED` without content retrieval. Identity and permission introspection remain available without learning content. A prior permission snapshot grants no authority to a later call; the snapshot is explicitly marked `informational_only: true`.

These checks reuse the current caller-scoped policy. Staff/agent execution on behalf of another learner is not enabled. Separate firewall RPC reads alone do not serialize assessment start and content release. Checkpoint 1D-A adds the database authorization lifecycle below. Stored context or conversation is never a continuing permission grant; future generation/delivery points will need their own reviewed boundary.

## Serialized content release authorization (1D-A)

Migration `202609090021_phase3_academic_content_release.sql` adds `academic_content_releases` and two narrow SECURITY DEFINER RPCs with explicit empty search paths. The gateway delegates to `src/server/academic-content-release.ts`; the existing Academy OS services still own content, enrolment, curriculum and mastery logic. The nine public JSON contracts remain `PROFESSOR_READ_V2`: the execution mechanism changes, with no new request/result fields or capabilities.

Both release operations and `start_assessment_attempt()` acquire `student_profiles WHERE user_id = current_app_user() FOR UPDATE`. The shared learner lock orders the authorization decisions:

1. Begin derives the authenticated STUDENT, takes the lock, validates the seven-name content allowlist and V2 contract, finalizes stale releases, checks fixed EXPLAIN activity, and inserts ACTIVE or terminal BLOCKED. Its transaction commits before gateway content reads run.
2. The gateway holds the logical lease through service execution, strict output parsing, context verification, fresh principal validation and the final EXPLAIN check.
3. Close takes the same lock and atomically records a terminal state and its audit event. A successful response requires a fresh ACTIVE → COMPLETED transition before content returns.
4. Assessment start takes the same lock, finalizes stale releases, and refuses to proceed while any unexpired ACTIVE release remains. The bounded message is `Academic activity is busy. Retry shortly.` It contains no release, capability or academic-context metadata. The complete migration 020 assessment workflow follows this check unchanged, including stale attempt finalization, windows/enrolment checks, same-attempt idempotency, void accounting, attempt limits and numbering.

The linearization decisions are the grant/completion transition and assessment-start exclusion decision under the shared lock, made durable by commit. A valid ACTIVE content release prevents a controlled assessment from starting; an active controlled assessment prevents a release grant. After a successful close, assessment start may proceed before the network response physically arrives: the content was validly released first. Bytes already sent cannot be retracted, and this does not authorize reuse of content for later model execution.

Each release has a fixed **30-second** DB-clock lifetime, no renewal, immutable identity, and states ACTIVE, COMPLETED, ABORTED, EXPIRED or BLOCKED. Terminal rows cannot be updated or deleted. An expired ACTIVE row is finalized as EXPIRED with `terminal_at = expires_at` on the next committing begin/close/start operation. No scheduler is needed for exclusion: expired rows never qualify as valid ACTIVE releases. Cleanup in a rolled-back assessment-start transaction also rolls back and is retried on a later operation.

Begin uses the existing EXPLAIN policy and additionally denies any unexpired ACTIVE attempt on a published assessment using the live DB clock after lock acquisition. This conservative check avoids a transaction-start `now()` from before a lock wait overlooking an attempt across an assessment opening. It does not grant a broader action or change Phase 2 activity policy.

Begin accepts only invocation UUID, allowlisted capability name and reviewed contract version; the server adapter supplies these, and the database derives the learner and fixed PROFESSOR profile. Reusing an invocation never renews/reopens a release and returns CONTEXT_CONFLICT. Close accepts only the release UUID and a completion boolean. It derives ownership, hides foreign/missing IDs identically, and returns the existing terminal state with `transitioned: false` on replay without rewriting history. Revoked STUDENT authority permits abort cleanup but cannot complete a release. The gateway rejects replayed completion, expiry, malformed RPC output and any failure to persist closure/audit with SERVICE_UNAVAILABLE and no content. Service, context, principal and firewall failures run through the same finalizer as ABORTED. If cleanup cannot reach the database, an ACTIVE row may remain until its fixed expiry; content is discarded.

The table has RLS, no authenticated table privileges, and an index on learner/expiry for ACTIVE rows. No direct authenticated insert/update/delete or inspection path is added, even for a multi-role student. Private cleanup/audit helpers are not executable by authenticated or anonymous roles. There is no service-role path. Identity/permission introspection does not obtain a release, and permission flags remain informational.

## Provenance and deterministic errors

Every invocation returns server-created metadata:

- `invocation_id`: a new UUID for each invocation, including retries;
- `actor_user_id`: the authenticated human principal, or null when unavailable;
- `agent_profile`: the fixed PROFESSOR profile;
- `capability_name`: an allowlisted name, or null for malformed/unavailable names;
- `capability_contract_version`: `PROFESSOR_READ_V2`;
- `authorized_scope`: verified self/enrolment/version/lesson references only;
- `outcome`: SUCCESS, DENIED or ERROR;
- `denial_code`: a stable code or null on success;
- `server_timestamp`: UTC timestamp when the result is formed.

Foreign requested identifiers are not copied into denial scope. Principal changes clear the authorized scope. A failed final firewall check releases no successful content or lesson scope. A subsequent close failure also discards content; its error provenance may retain the already verified scope references.

Checkpoint 1D-A persists **release authorization lifecycle audit**, not trusted gateway/provider execution audit. A dedicated trigger writes `CONTENT_RELEASE_ACTIVE`, `CONTENT_RELEASE_COMPLETED`, `CONTENT_RELEASE_ABORTED`, `CONTENT_RELEASE_EXPIRED` or `CONTENT_RELEASE_BLOCKED` into existing `audit_events` in the same transaction as the release state. BLOCKED is a structured RPC denial, so the audit survives instead of being rolled back by an exception. Invalid capability/contract or unauthenticated/non-STUDENT requests create no release; introspection and pre-release gateway validation failures are not durable lifecycle events.

The trigger constructs an explicit metadata allowlist: authenticated learner, fixed PROFESSOR profile, allowlisted capability/version, invocation/release UUIDs, state, start/expiry/terminal times, and database event time. It ignores caller-controlled `app.audit_reason`, uses a fixed reason/source, and stores no arbitrary JSON input. It copies no enrolment/lesson prose, objectives, resource bodies, evidence references, assessment prompts/answers/guidance, responses, private support prose, credentials, prompts or generated text. Institutional mutation audits remain unchanged. Authenticated table writes cannot forge these records; the existing Platform Admin audit read policy remains the separate institutional review surface.

**Direct authenticated invocation of both release RPCs remains possible.** `createSupabase()` uses a publishable key and the user's authenticated session. The RPCs are not gateway-only or internal-only: the database proves that an authenticated learner requested an allowlisted authorization lifecycle, and COMPLETED means that the owner closed it as complete. Neither a caller-supplied invocation correlation nor a completion request proves TypeScript gateway execution, validated content delivery, or AI/model execution. Trusted provider execution identity/audit and retention require the separately reviewed 1D-B boundary.

| Code                     | Meaning                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `UNAUTHENTICATED`        | Verified authenticated identity is unavailable                          |
| `FORBIDDEN`              | Principal lacks STUDENT authority                                       |
| `INVALID_INPUT`          | Malformed request, unknown fields or invalid input values               |
| `CAPABILITY_UNAVAILABLE` | Capability name is outside the nine-name allowlist                      |
| `NOT_FOUND_OR_FORBIDDEN` | Parent resource is absent/inaccessible or relationships do not match    |
| `ACTIVITY_BLOCKED`       | Existing controlled-activity firewall denies the read                   |
| `CONTEXT_CONFLICT`       | Principal or returned request identity changed/mismatched               |
| `SERVICE_UNAVAILABLE`    | Service/database/firewall check failed, or output violates its contract |

Authentication and STUDENT checks precede request execution. Input-schema failures use INVALID_INPUT; malformed backend output uses SERVICE_UNAVAILABLE. Error messages are fixed and exclude SQL, PostgREST/Supabase diagnostics, validation payloads and stack traces. Output objects use strict allowlists. Unavailable capability names are not echoed into provenance. Denials do not masquerade as empty successful academic records.

## Verification and remaining boundary

`academic-capabilities.test.ts` exercises authentication/role gates, forged/unknown requests, the exact nine-capability allowlist, fixed profile, strict V2 contracts, output bounds/minimisation, service failure normalization, provenance, identity changes and fresh firewall checks. `academic-capability-workflow.test.ts` invokes the real identity, capability and Academy OS services against all repository migrations/seed under authenticated PostgreSQL RLS, using a small test-only client adapter. It covers own and foreign enrolments, multi-role isolation, wrong versions, objective/resource/history pagination, historical statuses, curriculum immutability, role revocation, deterministic current/upcoming/none session selection, privacy-minimised learning history, persisted mastery reads, fail-closed malformed/oversized projections and actual controlled attempts. The two capability suites contain 94 tests in the completed local 1C gate.

Checkpoint 1D-A preserves all 94 existing capability tests and extends the focused total to **171 tests**: 116 contract/gateway, 29 real-service/RLS workflow, and 26 database release lifecycle tests. Tests cover all seven begin/service/validation/close paths, abort and close failures, direct premature completion replay, role revocation, metadata exclusion, durable BLOCKED denial, audit-failure rollback, stale expiry and terminal immutability. The full local suite passes **323 tests across 27 files**.

PGlite exercises the actual SQL functions, learner row lock statements, RLS, triggers, committed denial audit and sequential exclusion/lifecycle semantics. **Two independent concurrent PostgreSQL transactions were not run.** Hosted Supabase Auth/JWT/PostgREST acceptance and true concurrent PostgreSQL acceptance remain mandatory production prerequisites; local results do not prove hosted concurrent behavior. Review both lock orderings, expiry while a service runs, connection loss and aborted transactions there.

## Trusted execution governance (1D-B1)

Migration `202609100022_phase3_trusted_execution_governance.sql` adds a separate metadata-only execution lifecycle under `PROFESSOR_EXECUTION_V1`. The nine read contracts remain `PROFESSOR_READ_V2`. The server-only controller composes with the existing gateway through `withValidatedProfessorContent`, after strict Academy OS output/context validation and while the original release is ACTIVE. It attests admission, start and terminal state, then the gateway retains its fresh principal/firewall and release-close checks. Introspection cannot enter this execution path.

An authenticated Supabase session alone remains insufficient. Execution commands additionally require a short-lived HMAC-SHA256 attestation; the database reconstructs its canonical typed message, derives the learner, verifies the bound release, enforces admission/state constraints and writes lifecycle audit atomically. No standalone generic verifier or signing oracle is exposed. The govern_professor_execution RPC necessarily validates a MAC only for its fixed, typed execution-governance protocol. The private key store has no authenticated access; production secrets must be provisioned out of band. Direct RPC invocation remains possible, but without the controller secret it cannot forge an accepted trusted lifecycle. This does not prove model execution or content delivery.

B1's executable path intentionally ends ABSTAINED/POLICY_BLOCKED and returns only execution metadata, with zero provider calls/input/output budget and zero estimated spend. No provider or executor implementation is registered. Pre-production ceilings are one concurrent execution, five admissions per 60 seconds, 30 per hour and a 20-second execution lifetime capped by the unchanged 30-second release. These are security ceilings, not commercial quotas. Exact canonical signing, replay, provisioning, audit, failure and retention semantics are in [Academic execution governance](15-academic-execution-governance.md).

Learning evidence writes, mastery evaluation requests, handoffs and support/private-record capabilities are not registered. `MASTERY_V1`, validated evidence requirements, institutional records, support permissions and RBAC remain unchanged. No provider/model call, prompt/chat surface or public capability endpoint exists. Provider integration remains blocked. B2 still requires trusted provider execution/usage evidence, actual adapter/process isolation, reviewed nonzero budgets and reconciliation, retention decisions, provider failure/abstention/escalation and human-review delivery policy, plus hosted concurrency acceptance. Direct users can consume their own bounded releases and audit storage; production perimeter abuse controls remain required.
