# Roadmap

## Completed foundations

Phase 1 completed eight validated checkpoints covering repository/design foundations, data/seed, authentication and stable identity, RBAC/RLS, Counsellor services, student UI, support/admin shells and the first integration/security audit.

Phase 2 implemented and hardened the deterministic Academy Operating System: governed ProgrammeVersion publication, Enrolment and Counsellor assignment workflows, ClassSession/Attendance/LessonProgress, LearningResource delivery, append-only LearningEvidence, deterministic `MASTERY_V1`, Assignment workflows, controlled-assessment activity firewalls, Registrar corrections, Notification records and deterministic `SUPPORT_V1` learner-support triggers. Checkpoint 14 closed the accumulated authorization, concurrency, timezone, idempotency, projection and audit-minimisation issues identified during integration.

Phase 2 is complete and merged. Checkpoint 15 closed the final review/security corrections, local gates, PR CI/review and merge at `9b902e7`; post-merge main CI passed. Historical evidence remains in the Phase 1/2 completion records.

## Phase 3 — academic capability layer

Phase 3 through 1D-B1 is merged to main at `52720f51848bfdcf93d03d709820b44d788911d9`. PR #2 is merged and post-merge main CI passed (user-confirmed). Checkpoint 1A/1B was reviewed at `c8c9ad9`; its provider-independent Professor read boundary exposes `get_actor_context`, `get_activity_permissions`, `get_current_learner_context`, `get_lesson_context` and `get_lesson_objectives`. Every capability requires the authenticated human STUDENT and self-owned enrolment scope; PROFESSOR is a server-selected capability profile, not a RoleGrant or database principal.

No AI provider/model integration exists. Checkpoint 1D-A adds serialized database content-release authorization and durable release lifecycle auditing. Release begin/close and assessment start share the authenticated learner's `student_profiles` row lock. The seven content reads hold a bounded lease through validation and close it before successful return. Identity/permission introspection remains available without a lease.

Checkpoint 1C is complete at `f21755b`: the Professor boundary now also exposes current/next class session, learning resources, permitted learning history and persisted mastery state through strict bounded projections, exact enrolment/version scope and the existing EXPLAIN firewall. Checkpoint 1D-A keeps the same nine `PROFESSOR_READ_V2` JSON contracts. Evidence writes, mastery evaluation requests and learning handoffs remain deferred.

The 1D-A database audit proves only release authorization lifecycle metadata. Authenticated users can directly invoke the narrow release RPCs; no gateway-only trust or proof of gateway/model execution is claimed. Metadata excludes academic content and private/support prose. Local sequential PGlite acceptance passes; true concurrent hosted PostgreSQL acceptance with independent connections remains outstanding. Ordering valid release before assessment start cannot retract bytes already returned to a client.

Checkpoint 1D-A was committed/pushed at `902e915` after local validation and second review. Its original standalone checkpoint did not run PR CI; it is now included in merged PR #2 at `52720f5`. Hosted/true-concurrency acceptance remains outstanding.

Checkpoint 1D-B1 is committed and pushed at `85d3b85` and included in PR #2. A controller HMAC-SHA256 attestation supplements the authenticated learner session; narrow DB operations independently enforce learner/release binding, immutable lifecycle audit, replay rejection, admission ceilings and bounded lifetime. The B1 runtime intentionally abstains with no provider and a zero-call/zero-spend budget. This control-plane audit is separate from 1D-A learner release authorization and future B2 provider execution evidence. See `15-academic-execution-governance.md` for secret provisioning, the signing protocol, privacy/retention semantics and acceptance limits. B1 has passed final second review and PR #2 CI passed at `85d3b85`; it is now merged through PR #2 at `52720f5` and post-merge main CI passed. Hosted/production acceptance remains outstanding.

Provider integration remains blocked. B2 must review actual provider isolation/execution evidence, nonzero estimates and usage/cost reconciliation, lease latency/cancellation, retention duration, failure/abstention/escalation and human-review delivery policy. Production secret provisioning, perimeter abuse protection and hosted concurrent acceptance remain prerequisites; local execution-admission tests do not establish distributed or hosted acceptance.

B1's second-review corrections explicitly close ambient service-role lifecycle/audit mutation privileges and preserve DB-governed terminal failure codes. The corrected local gate passes 438 tests, check/build/format/diff validation and final second review. Hosted ACL/default-privilege and role-membership acceptance remains required. Historical per-transition controller-key UUID attribution is deferred and documented; no B2 work or provider call has begun.

Professor, Tutor, Lab Instructor, Examiner and Counsellor capabilities must call narrowly scoped Academy OS services; the deterministic backend continues to own institutional truth. The controlled-assessment activity firewall must be enforced by those tools rather than by prompts.

Provider rollout must wait for reviewed durable audit, assessment/content concurrency guarantees, provider boundaries, cost/rate controls, prompt/content retention, failure/abstention/escalation policy, homework integrity and human override/review paths. No agent should silently create mastery, grades, official records or support-risk judgments.

Formal grading/result publication, academic completion/certification workflows, institutional announcement authoring, production notification scheduling/email/push and broader curriculum authoring remain separate deterministic work where needed; they should not be smuggled into AI prompts.

## Phase 3 checkpoint 2A — institutional delivery lifecycle

Checkpoint 2A is complete and merged through PR #3. The reviewed feature head was `79bb3653c451b11ffd6e03c94e8de3e9ca1a9fbc`; GitHub created merge commit `28937559a7c3266fec0fd6898fad129a7cd014d4` on `main`. Post-merge Ducelio CI run #23 passed lint, route/type generation, TypeScript/tests, formatting and the production build.

The merged checkpoint provides learner-selected weekdays/local time/IANA timezone, governed plan confirmation and future schedule changes, next-slot-minus-60-minute latest-start boundaries, immutable learner starts, validated-progress completion, durable catch-up, course-time-bound academic-agent availability, continuing Counsellor modes, bounded learner-request handoffs and admin delivery projections.

Checkpoint 2A does not contain a model/provider runtime, production classroom, learner delivery controls, payment system, grading/result publication, official course-completion workflow or hosted production acceptance. Those are now Commercial V1 work rather than reasons to reopen 2A.

## Commercial V1 — platform completion

The product programme now targets a production-ready Ducelio commercial academy platform by **30 September 2026**, with one complete real cybersecurity course proving the platform.

Commercial V1 must make courses and academic agents reusable platform configuration rather than bespoke application development. The Course & Agent Engineering layer must support validated course packages containing programme metadata, curriculum versions, modules, lessons, objectives, learning resources, practicals, assignments, assessments, rubrics, mastery mappings, scheduling defaults and role-specific Professor/Tutor/Lab Instructor/Examiner/Counsellor configuration.

The target course workflow is **upload → validate → preview → configure agents → test → publish**. Adding a normal later course must not require a new database migration, bespoke React route or bespoke core server endpoint.

The first real course is the reference implementation. By approximately **15 October 2026**, the wider initial cybersecurity catalogue should be loadable through the same engineering system rather than through repeated core application redevelopment.

The backend must remain client-independent so the web application and later iOS/Android applications share the same institutional authority, enrolment, curriculum, delivery, AI runtime, assessment, mastery, records, notification and entitlement services.

Commercial V1 also includes the real provider/runtime boundary, learner delivery UI, academic-agent experiences, public sales/Counsellor experience, real checkout and payment-backed entitlement provisioning, grading/results/course completion, commercial Admin operations, production communications and production acceptance.

The Course & Agent Engineering domain/server/persistence foundation and the B2 provider-neutral runtime harness are implemented locally on `commercial-v1-course-agent-runtime` (starting SHA `ccfb8c8ae0a2ab172286b5f97c8305e9386d9eb7`); see `18-course-agent-engineering.md` and `implementation-progress.md` for exact scope. Real provider execution is deliberately not yet composed into the live migration-022 execution RPC, whose admitted envelope remains zero provider calls until a dedicated, separately reviewed migration raises it; no admin authoring UI or per-cohort assignment/assessment materialisation exists yet.

## Production readiness

Before real learners or protected assessments are operated, complete hosted Supabase/Auth/JWT/PostgREST/RPC acceptance, provider and SMTP tests, true concurrent PostgreSQL scenarios, backups/restore exercises, rate limits/abuse controls, privacy/support-data governance, monitoring/alerting, accessibility/browser/device acceptance and deployment security review. Add pagination/operational tooling before scale and decide explicit tenant isolation before supporting multiple institutions.

Do not confuse passing local tests or a green pull request with production readiness.
