# Academic capabilities — Phase 3 Checkpoint 1A/1B

This checkpoint introduces a provider-independent, server-only Professor read boundary. It does not integrate an AI model. The authenticated human Ducelio user remains the institutional principal; `PROFESSOR` is a fixed server-selected capability profile, never a RoleGrant or database principal.

## Entry point and authority

`src/server/academic-capabilities/index.ts` exports `invokeProfessorCapability(request)` and the typed `professorCapabilities.invoke` port. Runtime input is untrusted. There is no route, Server Action, public tool endpoint, provider SDK, prompt framework or chat UI attached to this port.

The pure contracts live in `src/domain/academic-capabilities.ts`. They define strict Zod input/output schemas, a capability input/output type map, a provider-independent invocation interface, a result union and provenance. A future adapter can translate a provider's tool format into this JSON contract without changing institutional policy. That adapter must invoke the trusted server entry point; it must never receive a Supabase client, credentials or permission to select an arbitrary service/RPC.

Every capability requires a verified authenticated principal holding STUDENT. Identity comes from the existing Supabase Auth → stable app-user mapping → protected role-grant lookup. `getAuthenticatedActor()` is the uncached form of the existing identity lookup; existing UI services retain the cached `getCurrentActor()` wrapper. New Academy OS reads use the non-redirecting `requireStudentPrincipal()` helper.

Multi-role users retain only their own STUDENT scope on this surface. Extra INSTRUCTOR, COUNSELLOR, ACADEMIC_ADMIN, REGISTRAR or PLATFORM_ADMIN grants neither expand the returned role projection nor authorize another learner's enrolment. The gateway revalidates the principal before releasing a result.

## Enabled catalogue

All UUIDs and pagination values are runtime validated. Objects reject unknown fields, including actor IDs, roles, agent profiles, programme-version overrides, objective overrides and caller-selected firewall actions.

| Capability                    | Input                                       | Output                                                                                    | Scope and activity requirement                                                                            |
| ----------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `get_actor_context`           | `{}`                                        | Human `actor_user_id` and effective institutional role STUDENT                            | Authenticated STUDENT; self only; no learning content                                                     |
| `get_activity_permissions`    | `{}`                                        | Server activity state and five informational capability permission flags                  | Authenticated STUDENT; self only; no assessment identifiers/content                                       |
| `get_current_learner_context` | `{ enrolmentId }`                           | Enrolment/cohort/version references, enrolment status, bounded programme/cohort snapshots | Explicit owned enrolment; fixed EXPLAIN firewall                                                          |
| `get_lesson_context`          | `{ enrolmentId, lessonId }`                 | Enrolment/version/lesson/module references, bounded title and position                    | Owned enrolment → exact programme version → lesson; fixed EXPLAIN firewall                                |
| `get_lesson_objectives`       | `{ enrolmentId, lessonId, afterPosition? }` | Same scope references, ordered bounded objective page and next position cursor            | Same lesson relationship; each objective belongs to that lesson and exact version; fixed EXPLAIN firewall |

`afterPosition` is an optional integer from 0 through 2147483647. Objective reads fetch at most 51 rows and return at most 50; the extra row determines whether a next page exists. Every page independently reauthorizes. An authorized empty page is successful; inaccessible parent context is denied. Objective descriptions are limited to 4,000 characters each. Context titles are limited to 500 characters and version labels to 200. Oversized/malformed service output fails closed; it is not silently truncated into changed academic content.

The gateway orchestrates `getOwnedStudentEnrolment()` in the existing Academy service, the narrow Academy OS learning-context reads and the activity service. It performs no database queries itself. No institutional mutation or mastery calculation has moved into the capability layer.

## Curriculum and ownership

`getOwnedStudentEnrolment()` applies both enrolment-ID and authenticated-student-ID filters in addition to RLS, and validates the returned identity. Lesson reads filter by lesson ID and the programme-version ID derived from that owned enrolment. Objective reads additionally filter by the validated lesson and version. Output projections validate those relationships before release.

The service does not apply a generic current-publication filter or assume the learner's most recent enrolment is their only context. ACTIVE, PAUSED, WITHDRAWN and COMPLETED owned enrolment history follows the existing read relationship. Published/enrolled curriculum immutability remains enforced by the existing database guards. The capability cannot author curriculum, rewrite history or supply an alternative curriculum version.

## Controlled-assessment firewall

Professor learning reads use the existing `assert_academic_action_allowed('EXPLAIN')` RPC. The server fixes the action; input cannot select `EXAMINER_DELIVERY` or `COUNSELLOR_LOGISTICS`. The new activity service also wraps `current_academic_activity_state()` and `academic_action_allowed('EXPLAIN')` for introspection.

All three academic-content capabilities check the firewall before retrieval and again before returning. Lesson/objective Academy OS services independently enforce it too, including when called directly by trusted server code. An active controlled assessment returns `ACTIVITY_BLOCKED` without content retrieval. Identity and permission introspection remain available without learning content. A prior permission snapshot grants no authority to a later call; the snapshot is explicitly marked `informational_only: true`.

These checks reuse the current caller-scoped policy. Staff/agent execution on behalf of another learner is not enabled. The separate RPC reads are not a database transaction or a concurrency lock spanning result delivery. A last-moment activity change after the final check cannot retract an already returned result. Before provider execution or protected production use, review concurrent assessment start/content delivery, add any necessary serialized release boundary in the Academy OS, and enforce fresh activity checks at future generation/delivery points. Do not treat a stored context or conversation as a continuing permission grant.

## Provenance and deterministic errors

Every invocation returns server-created metadata:

- `invocation_id`: a new UUID for each invocation, including retries;
- `actor_user_id`: the authenticated human principal, or null when unavailable;
- `agent_profile`: the fixed PROFESSOR profile;
- `capability_name`: an allowlisted name, or null for malformed/unavailable names;
- `capability_contract_version`: `PROFESSOR_READ_V1`;
- `authorized_scope`: verified self/enrolment/version/lesson references only;
- `outcome`: SUCCESS, DENIED or ERROR;
- `denial_code`: a stable code or null on success;
- `server_timestamp`: UTC timestamp when the result is formed.

Foreign requested identifiers are not copied into denial scope. Principal changes clear the authorized scope. A failed final check releases no successful content or lesson scope.

This checkpoint returns provenance on success and denial; **it does not persist a durable capability execution audit**. Existing institutional mutation audits remain unchanged. No migration is needed for these five server-scoped reads, and none was added. Returning metadata is not a claim that an AuditEvent was written. Durable invocation auditing, its trusted writer and retention policy must be reviewed before external actor rollout; a future sink should store only the metadata above and must not accept client-claimed execution success as trusted audit evidence. Sensitive prose, resource bodies, assessment prompts/answers, learner responses and credentials must not enter that sink.

| Code                     | Meaning                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `UNAUTHENTICATED`        | Verified authenticated identity is unavailable                          |
| `FORBIDDEN`              | Principal lacks STUDENT authority                                       |
| `INVALID_INPUT`          | Malformed request, unknown fields or invalid input values               |
| `CAPABILITY_UNAVAILABLE` | Capability name is outside the five-name allowlist                      |
| `NOT_FOUND_OR_FORBIDDEN` | Parent resource is absent/inaccessible or relationships do not match    |
| `ACTIVITY_BLOCKED`       | Existing controlled-activity firewall denies the read                   |
| `CONTEXT_CONFLICT`       | Principal or returned request identity changed/mismatched               |
| `SERVICE_UNAVAILABLE`    | Service/database/firewall check failed, or output violates its contract |

Authentication and STUDENT checks precede request execution. Input-schema failures use INVALID_INPUT; malformed backend output uses SERVICE_UNAVAILABLE. Error messages are fixed and exclude SQL, PostgREST/Supabase diagnostics, validation payloads and stack traces. Output objects use strict allowlists. Unavailable capability names are not echoed into provenance. Denials do not masquerade as empty successful academic records.

## Verification and remaining boundary

`academic-capabilities.test.ts` exercises authentication/role gates, forged/unknown requests, fixed profile, output bounds/minimisation, service failure normalization, provenance, identity changes and fresh firewall checks. `academic-capability-workflow.test.ts` invokes the real identity, capability and Academy OS services against all repository migrations/seed under authenticated PostgreSQL RLS, using a small test-only client adapter. It covers own and foreign enrolments, multi-role isolation, wrong versions, objective pagination, historical statuses, immutability, role revocation and actual controlled attempts.

The adapter exercises SQL policy and service composition; it is not hosted Supabase Auth/JWT/PostgREST acceptance or an independent concurrent PostgreSQL test. Those existing production prerequisites remain outstanding.

Learning evidence writes, mastery evaluation requests, handoffs, support/private records, learning-resource retrieval, current-session resolution, learning history and mastery reads are not registered. `MASTERY_V1`, validated evidence requirements, institutional records, support permissions, assessment lifecycle and RBAC remain unchanged. Provider/cost/rate controls, durable execution auditing, content retention, homework integrity policy and human review/escalation remain prerequisites before academic-agent rollout.
