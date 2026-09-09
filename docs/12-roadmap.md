# Roadmap

## Completed foundations

Phase 1 completed eight validated checkpoints covering repository/design foundations, data/seed, authentication and stable identity, RBAC/RLS, Counsellor services, student UI, support/admin shells and the first integration/security audit.

Phase 2 implemented and hardened the deterministic Academy Operating System: governed ProgrammeVersion publication, Enrolment and Counsellor assignment workflows, ClassSession/Attendance/LessonProgress, LearningResource delivery, append-only LearningEvidence, deterministic `MASTERY_V1`, Assignment workflows, controlled-assessment activity firewalls, Registrar corrections, Notification records and deterministic `SUPPORT_V1` learner-support triggers. Checkpoint 14 closed the accumulated authorization, concurrency, timezone, idempotency, projection and audit-minimisation issues identified during integration.

Phase 2 is complete and merged. Checkpoint 15 closed the final review/security corrections, local gates, PR CI/review and merge at `9b902e7`; post-merge main CI passed. Historical evidence remains in the Phase 1/2 completion records.

## Phase 3 â€” academic capability layer

Phase 3 has begun on `phase-3-ai-academic-layer`. Checkpoint 1A/1B is complete, reviewed and approved on that feature branch at `c8c9ad9`. Its provider-independent Professor read boundary exposes `get_actor_context`, `get_activity_permissions`, `get_current_learner_context`, `get_lesson_context` and `get_lesson_objectives`. Every capability requires the authenticated human STUDENT and self-owned enrolment scope; PROFESSOR is a server-selected capability profile, not a RoleGrant or database principal.

No AI provider/model integration exists. Durable capability execution audit is not implemented, and concurrent assessment-start/content-delivery guarantees are not fully closed. Returned provenance and repeated activity checks do not constitute durable auditing or a serialized content-release transaction.

Checkpoint 1C is complete: the Professor boundary now also exposes current/next class session, learning resources, permitted learning history and persisted mastery state through strict bounded projections, exact enrolment/version scope and the existing EXPLAIN firewall. Evidence writes, mastery evaluation requests and learning handoffs remain deferred. The next security boundary before provider/model execution is Checkpoint 1D: durable capability auditing, assessment/content concurrency closure, provider isolation, rate/cost controls, retention and failure/abstention/escalation policy.

Professor, Tutor, Practical Instructor, Practice Coach, Examiner and AI Counsellor capabilities must call narrowly scoped Academy OS services; the deterministic backend continues to own institutional truth. The controlled-assessment activity firewall must be enforced by those tools rather than by prompts.

Provider rollout must wait for reviewed durable audit, assessment/content concurrency guarantees, provider boundaries, cost/rate controls, prompt/content retention, failure/abstention/escalation policy, homework integrity and human override/review paths. No agent should silently create mastery, grades, official records or support-risk judgments.

Formal grading/result publication, academic completion/certification workflows, institutional announcement authoring, production notification scheduling/email/push and broader curriculum authoring remain separate deterministic work where needed; they should not be smuggled into AI prompts.

## Production readiness

Before real learners or protected assessments are operated, complete hosted Supabase/Auth/JWT/PostgREST/RPC acceptance, provider and SMTP tests, true concurrent PostgreSQL scenarios, backups/restore exercises, rate limits/abuse controls, privacy/support-data governance, monitoring/alerting, accessibility/browser/device acceptance and deployment security review. Add pagination/operational tooling before scale and decide explicit tenant isolation before supporting multiple institutions.

Do not confuse passing local tests or a green pull request with production readiness.
