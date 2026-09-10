# Roadmap

## Completed foundations

Phase 1 completed eight validated checkpoints covering repository/design foundations, data/seed, authentication and stable identity, RBAC/RLS, Counsellor services, student UI, support/admin shells and the first integration/security audit.

Phase 2 implemented and hardened the deterministic Academy Operating System: governed ProgrammeVersion publication, Enrolment and Counsellor assignment workflows, ClassSession/Attendance/LessonProgress, LearningResource delivery, append-only LearningEvidence, deterministic `MASTERY_V1`, Assignment workflows, controlled-assessment activity firewalls, Registrar corrections, Notification records and deterministic `SUPPORT_V1` learner-support triggers. Checkpoint 14 closed the accumulated authorization, concurrency, timezone, idempotency, projection and audit-minimisation issues identified during integration.

Phase 2 is complete and merged. Checkpoint 15 closed the final review/security corrections, local gates, PR CI/review and merge at `9b902e7`; post-merge main CI passed. Historical evidence remains in the Phase 1/2 completion records.

## Phase 3 Ã¢â‚¬â€ academic capability layer

Phase 3 has begun on `phase-3-ai-academic-layer`. Checkpoint 1A/1B is complete, reviewed and approved on that feature branch at `c8c9ad9`. Its provider-independent Professor read boundary exposes `get_actor_context`, `get_activity_permissions`, `get_current_learner_context`, `get_lesson_context` and `get_lesson_objectives`. Every capability requires the authenticated human STUDENT and self-owned enrolment scope; PROFESSOR is a server-selected capability profile, not a RoleGrant or database principal.

No AI provider/model integration exists. Checkpoint 1D-A adds serialized database content-release authorization and durable release lifecycle auditing. Release begin/close and assessment start share the authenticated learner's `student_profiles` row lock. The seven content reads hold a bounded lease through validation and close it before successful return. Identity/permission introspection remains available without a lease.

Checkpoint 1C is complete at `f21755b`: the Professor boundary now also exposes current/next class session, learning resources, permitted learning history and persisted mastery state through strict bounded projections, exact enrolment/version scope and the existing EXPLAIN firewall. Checkpoint 1D-A keeps the same nine `PROFESSOR_READ_V2` JSON contracts. Evidence writes, mastery evaluation requests and learning handoffs remain deferred.

The 1D-A database audit proves only release authorization lifecycle metadata. Authenticated users can directly invoke the narrow release RPCs; no gateway-only trust or proof of gateway/model execution is claimed. Metadata excludes academic content and private/support prose. Local sequential PGlite acceptance passes; true concurrent hosted PostgreSQL acceptance with independent connections remains outstanding. Ordering valid release before assessment start cannot retract bytes already returned to a client.

Checkpoint 1D-A is committed and pushed at `902e915` on the feature branch. Local validation and second review passed. PR CI was not run; it is not merged to main. Hosted/true-concurrency acceptance remains outstanding.

Checkpoint 1D-B1 is committed and pushed at `85d3b85` and included in PR #2. A controller HMAC-SHA256 attestation supplements the authenticated learner session; narrow DB operations independently enforce learner/release binding, immutable lifecycle audit, replay rejection, admission ceilings and bounded lifetime. The B1 runtime intentionally abstains with no provider and a zero-call/zero-spend budget. This control-plane audit is separate from 1D-A learner release authorization and future B2 provider execution evidence. See `15-academic-execution-governance.md` for secret provisioning, the signing protocol, privacy/retention semantics and acceptance limits. B1 has passed final second review and PR #2 CI passed at `85d3b85`; merge and hosted/production acceptance are not claimed.

Provider integration remains blocked. B2 must review actual provider isolation/execution evidence, nonzero estimates and usage/cost reconciliation, lease latency/cancellation, retention duration, failure/abstention/escalation and human-review delivery policy. Production secret provisioning, perimeter abuse protection and hosted concurrent acceptance remain prerequisites; local execution-admission tests do not establish distributed or hosted acceptance.

B1's second-review corrections explicitly close ambient service-role lifecycle/audit mutation privileges and preserve DB-governed terminal failure codes. The corrected local gate passes 438 tests, check/build/format/diff validation and final second review. Hosted ACL/default-privilege and role-membership acceptance remains required. Historical per-transition controller-key UUID attribution is deferred and documented; no B2 work or provider call has begun.

Professor, Tutor, Practical Instructor, Practice Coach, Examiner and AI Counsellor capabilities must call narrowly scoped Academy OS services; the deterministic backend continues to own institutional truth. The controlled-assessment activity firewall must be enforced by those tools rather than by prompts.

Provider rollout must wait for reviewed durable audit, assessment/content concurrency guarantees, provider boundaries, cost/rate controls, prompt/content retention, failure/abstention/escalation policy, homework integrity and human override/review paths. No agent should silently create mastery, grades, official records or support-risk judgments.

Formal grading/result publication, academic completion/certification workflows, institutional announcement authoring, production notification scheduling/email/push and broader curriculum authoring remain separate deterministic work where needed; they should not be smuggled into AI prompts.

## Production readiness

Before real learners or protected assessments are operated, complete hosted Supabase/Auth/JWT/PostgREST/RPC acceptance, provider and SMTP tests, true concurrent PostgreSQL scenarios, backups/restore exercises, rate limits/abuse controls, privacy/support-data governance, monitoring/alerting, accessibility/browser/device acceptance and deployment security review. Add pagination/operational tooling before scale and decide explicit tenant isolation before supporting multiple institutions.

Do not confuse passing local tests or a green pull request with production readiness.
