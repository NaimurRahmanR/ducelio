# Operations and security review

## Verification boundary

Phase 2 has local application, PostgreSQL/PGlite and workflow regression coverage. The latest completed local gate after Checkpoint 14 passed lint, route/type generation, TypeScript, 149 tests across 23 files, production build and Prettier. That evidence validates the checked-in deterministic contracts under the local test harness; it is not hosted production acceptance.

PGlite emulates `auth.uid()` and an `auth.users` table for deterministic tests. It does not emulate GoTrue, PostgREST, real JWTs, network failures, SMTP/OAuth providers or true independent concurrent PostgreSQL sessions. Hosted Supabase/Auth/provider acceptance is still required. Row-locking and uniqueness strategies are tested functionally but must also be exercised with real concurrent sessions before production.

The application uses no service-role key in ordinary application flows. Browser configuration is limited to a Supabase publishable key. Server identity is resolved from Supabase Auth and stable Ducelio identity; editable metadata and typed Student IDs are not authorization. Security-definer functions use fixed search paths, explicit actor/relationship checks and restricted execution grants. RLS remains a defence layer for direct REST/table reads.

## Phase 2 security posture

- Published/enrolled curriculum is versioned and history-preserving; mutable parent labels are not used where historical snapshots are required.
- Academic mutation services distinguish ACADEMIC_ADMIN/PLATFORM_ADMIN authority from Registrar correction authority. Registrar corrections to existing enrolment/attendance records preserve immutable before/after provenance.
- Assigned INSTRUCTOR operations are limited to RPCs that explicitly permit the instructor relationship; private Counsellor prose remains outside instructor/admin access by default.
- Class scheduling rejects cohort/instructor overlaps and serializes governed scheduling on both cohort and instructor records. Browser-local authoring times are converted to ISO instants before server validation.
- LearningEvidence is append-only and version/session/objective bound. `MASTERY_V1` is deterministic, versioned and based on validated evidence diversity rather than clicks/time/progress.
- Controlled assessment question/answer-key tables are not learner-readable. Protected prompts are released only to a learner with a server-owned ACTIVE attempt inside the assessment/attempt window. Answer keys and marking guidance are not returned through learner delivery.
- Controlled assessment attempts/responses are append-only/history-preserving; response identity is database-bound to the attempt/assessment/learner, and attempt numbering remains monotonic after administrative voids.
- `current_academic_activity_state()` plus `academic_action_allowed()` / `assert_academic_action_allowed()` provide the technical controlled-assessment firewall for future academic-agent tools. Prompt-only enforcement is not acceptable.
- `SUPPORT_V1` uses authoritative ABSENT attendance, approaching Assignment deadlines without submission, overdue planned study items and `NEEDS_REINFORCEMENT` mastery. It does not infer inactivity, motivation or risk from engagement telemetry or conversational sentiment.
- Notification provenance is immutable; learner read-state does not modify source academic/support records.
- Audit payloads minimise protected assessment content, learner submission bodies, private support prose and full lecture-note bodies where those records have dedicated authoritative storage.

## Required deployment configuration

- Set `APP_URL` to the exact HTTPS production origin. The local default is `http://127.0.0.1:3000`; use one origin consistently so PKCE/session cookies remain bound correctly.
- Populate `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Never place a service-role/secret key in browser configuration.
- Apply all **19** migrations in lexical order. Preserve deployed migration files and use corrective migrations rather than rewriting history.
- Enable verified email, custom SMTP, sender-domain verification, recovery/confirmation templates and exact redirect allowlists. Configure Google/LinkedIn only when live credentials and callbacks can be tested.
- Apply suitable Supabase/edge rate limits to authentication and public write paths. A CAPTCHA setting needs a corresponding challenge/token UI before enforcement; that integration is not implemented.
- Configure HTTPS termination/HSTS, production secrets, secure cookies, backups, restore exercises, logging/alerts and error monitoring. Do not cache session-dependent responses at a CDN.
- The current security headers are not a substitute for a reviewed strict CSP. Review Next.js-compatible script policy before public rollout.
- Review account lifecycle, session revocation, provider linking and privileged-role provisioning on staging. Manual cross-email account merging is not implemented.
- Choose retention/deletion/export policies for academic, assessment and support data. Private interactions should not contain unnecessary clinical, demographic or similarly sensitive narrative.
- Restrict database-owner/operator credentials. Database owners can bypass RLS; operator access therefore needs independent access control, logging and review.
- Configure a reviewed production scheduler before relying on deterministic support-trigger evaluation. Email/push delivery is not implemented by Phase 2.

## Staff and support provisioning

Signup provisions a student profile and STUDENT grant. The first privileged account requires reviewed operator action; it cannot self-promote through the application. Resolve the stable Ducelio `app_users.id` from a verified Auth UUID and never use a student number as authentication.

Use reviewed transactions/operator tooling to create staff profiles and role grants. Grant only the roles required: COUNSELLOR for assigned learner-support relationships, INSTRUCTOR for explicitly assigned academic operations, ACADEMIC_ADMIN for governed academic administration, REGISTRAR for official-record correction workflows and PLATFORM_ADMIN for the narrow platform/audit/override boundary. Do not grant PLATFORM_ADMIN merely for convenience.

Counsellor reassignment should use the permissioned service when acting through the application. The transaction closes the prior relationship and creates the next; closed history is not rewritten. Before real counselling use, establish historical case-transfer, retention, export and escalation policy.

Real curriculum must be prepared, validated and published separately from the fictional seed. Enrolments bind a published ProgrammeVersion and preserve historical cohort/version snapshots. Existing PAUSED/WITHDRAWN/COMPLETED enrolment history is not silently presented as a fresh successful enrolment.

## Staging acceptance checklist

1. Register/confirm real email users; test confirmation, login/logout, recovery/reset, expiry and global sign-out with actual Supabase sessions.
2. Exercise valid/invalid/expired Google and LinkedIn callbacks and verify one stable Ducelio identity for intentionally linked verified providers.
3. Verify STUDENT, INSTRUCTOR, COUNSELLOR, ACADEMIC_ADMIN, REGISTRAR and PLATFORM_ADMIN boundaries using real JWTs plus direct PostgREST/RPC requests, including forged actor/student IDs.
4. Attempt cross-learner reads/writes, private support access, role escalation, protected assessment-table reads, answer-key retrieval and audit/history mutation.
5. Exercise ProgrammeVersion publication, enrolment lifecycle, Counsellor reassignment, ClassSession scheduling, attendance/progress/evidence, assignment and assessment workflows through browser and direct RPC clients.
6. Run true concurrent PostgreSQL scenarios for duplicate enrolment, programme publication/content mutation, Counsellor reassignment, same-cohort and cross-cohort instructor scheduling, learning-evidence idempotency, assignment submissions and assessment-attempt starts.
7. Validate controlled assessment windows with real server clocks/JWTs: one-active-attempt rules, expiry, protected prompt release, response revisions, submit/void/retry and answer-key non-disclosure.
8. Validate deterministic support-trigger idempotency/resolution and notification read-state without allowing trigger evaluation to mutate its source academic record.
9. Exercise role revocation and reassignment during active sessions; verify stale browser state cannot preserve backend authorization.
10. Review keyboard-only navigation, screen readers, 200% zoom, mobile devices, contrast, focus/error announcements and browser support. Local visual sanity checks are not WCAG certification.
11. Configure/verify backups and a restore exercise; confirm monitoring does not log credentials, Auth tokens, protected assessment text or private Counsellor prose.
12. Run deployment/security review, rate-limit/abuse tests and dependency/security checks before allowing real learner data.

## Scope limits after Phase 2

Phase 2 does **not** implement automatic grading, gradebook/result publication, pass/fail decisions, academic completion/certification, institutional announcement authoring, production support-trigger scheduling, email/push messaging, payments, uploads, offline/PWA synchronisation or AI academic actors. It does not contain official external-exam questions or claim external awarding-body endorsement.

Many staff lists are intentionally bounded and need pagination/operational search before scale. Explicit multi-institution tenant isolation is not yet a product guarantee. Protected assessment foundations must not be advertised as production-ready until the staging/security checklist above and later grading/result controls are completed.

The public demo remains fictional/read-only and grants no production identity. Passing local or GitHub CI is necessary engineering evidence, not production authorization.
