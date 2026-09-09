# Roadmap

## Completed foundations

Phase 1 completed eight validated checkpoints covering repository/design foundations, data/seed, authentication and stable identity, RBAC/RLS, Counsellor services, student UI, support/admin shells and the first integration/security audit.

Phase 2 implemented and hardened the deterministic Academy Operating System: governed ProgrammeVersion publication, Enrolment and Counsellor assignment workflows, ClassSession/Attendance/LessonProgress, LearningResource delivery, append-only LearningEvidence, deterministic `MASTERY_V1`, Assignment workflows, controlled-assessment activity firewalls, Registrar corrections, Notification records and deterministic `SUPPORT_V1` learner-support triggers. Checkpoint 14 closed the accumulated authorization, concurrency, timezone, idempotency, projection and audit-minimisation issues identified during integration.

Checkpoint 15 is the Phase 2 closure gate: reconcile documentation, review the complete `main...phase-2-academy-os` diff/security posture, rerun the exact-tree local quality gate, open the pull request to `main`, and require GitHub CI/review before merge.

## Next product stage

The next major implementation stage may introduce permissioned academic-agent interfaces only after Phase 2 is merged and reviewed. Professor, Tutor, Practical Instructor, Practice Coach, Examiner and AI Counsellor capabilities must call narrowly scoped Academy OS tools/APIs; they are not database principals. The existing controlled-assessment activity firewall must be enforced by those tools rather than by prompts.

Before academic-agent rollout, define the tool/capability catalogue, provenance contract, model/provider boundary, cost/rate controls, prompt/content retention policy, failure/abstention/escalation behaviour, homework-specific integrity policy and human override/review paths. No agent should silently create mastery, grades, official records or support-risk judgments.

Formal grading/result publication, academic completion/certification workflows, institutional announcement authoring, production notification scheduling/email/push and broader curriculum authoring remain separate deterministic work where needed; they should not be smuggled into AI prompts.

## Production readiness

Before real learners or protected assessments are operated, complete hosted Supabase/Auth/JWT/PostgREST/RPC acceptance, provider and SMTP tests, true concurrent PostgreSQL scenarios, backups/restore exercises, rate limits/abuse controls, privacy/support-data governance, monitoring/alerting, accessibility/browser/device acceptance and deployment security review. Add pagination/operational tooling before scale and decide explicit tenant isolation before supporting multiple institutions.

Do not confuse passing local tests or a green pull request with production readiness.
