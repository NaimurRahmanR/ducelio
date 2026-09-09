# Database and migrations

Supabase PostgreSQL is the authoritative institutional store. Migrations live in `supabase/migrations` and are applied lexically. Generated UUIDs, composite foreign keys, immutable-history triggers and version-consistency constraints protect academic relationships. Application tables use RLS and do not expose general-purpose client write policies.

## Local Supabase

Install the Supabase CLI and Docker separately. From this repository:

```sh
supabase start
supabase db reset
```

Use the printed local URL/publishable key in `.env.local`. Keep real credentials out of git. The optional demo seed uses deterministic fictional UUIDs and no login passwords; it is intended for local development only. No demo users are inserted into Supabase Auth.

For a managed project, link using the CLI and review the migration diff before running `supabase db push`. Do not apply a destructive reset to production. Preserve already deployed migration files; corrective changes use new migrations.

## Verification

PGlite runs the actual PostgreSQL migrations, constraints, seed and role policies in isolated test databases. A small test-only auth schema emulates `auth.uid()`. The Phase 2 local gate reached 149 passing tests across 23 files after migration 019. These tests are PostgreSQL integration tests, not validation of hosted Supabase Auth, PostgREST, real JWTs, network failures, SMTP or true concurrent PostgreSQL sessions. Staging acceptance remains required.

## Operations

Documented operator actions require reviewed provenance. Back up and rehearse restore before live use. Choose academic/support retention, deletion and export policies. Database-owner bypass privileges are an operational trust boundary and must not be available to application actors.

## Migration ledger

1. `202609080001_academy_foundation.sql` — initial 19-table Academy OS foundation, version consistency and deny-all client access.
2. `202609080002_identity.sql` — unique Auth-to-Ducelio identity mapping and signup provisioning.
3. `202609080003_authorization.sql` — verified identity, role/relationship helpers and RLS read policies.
4. `202609080004_support_services.sql` — transactional Counsellor/support RPCs and audit foundations.
5. `202609080005_integrity_audit.sql` — curriculum locking, published-version enrolment, immutable history and broader audit controls.
6. `202609080006_phase2_programme_publication.sql` — governed ProgrammeVersion DRAFT → PUBLISHED transition and publication snapshots.
7. `202609080007_phase2_enrolment_workflow.sql` — governed Enrolment creation, cohort snapshots and lifecycle transitions.
8. `202609080008_phase2_counsellor_assignment_workspace.sql` — constrained Counsellor discovery for governed assignment operations.
9. `202609080009_phase2_class_sessions.sql` — persisted ClassSession scheduling/lifecycle, overlap checks and visibility rules.
10. `202609080010_phase2_attendance.sql` — authoritative AttendanceRecord creation/correction bound to sessions and enrolments.
11. `202609090011_phase2_lesson_progress.sql` — versioned LessonSegment planning and governed LessonProgress.
12. `202609090012_phase2_learning_resources.sql` — version-bound lecture notes/reference links and resource immutability.
13. `202609090013_phase2_learning_evidence.sql` — append-only LearningEvidence with provenance/idempotency.
14. `202609090014_phase2_objective_mastery.sql` — deterministic `MASTERY_V1`, current ObjectiveMastery and immutable history.
15. `202609090015_phase2_assignments.sql` — governed Assignment lifecycle and append-only learner submissions.
16. `202609090016_phase2_controlled_assessments.sql` — protected Assessment content, server-owned attempts/responses and technical activity firewall.
17. `202609090017_phase2_registrar_corrections.sql` — append-only RegistrarCorrection provenance and Registrar mutation boundary.
18. `202609090018_phase2_notifications_support_triggers.sql` — learner Notification records and deterministic `SUPPORT_V1` trigger evaluation.
19. `202609090019_phase2_integration_hardening.sql` — cross-checkpoint authorization, scheduling serialization, safe learner projections, assessment identity/retry hardening and audit minimisation.

Phase 2 extends the schema substantially beyond the original 19 foundation tables. The domain inventory is maintained in `03-domain-model.md`; migrations are the executable source of truth. Production migrations never include the fictional seed.
