# Implementation progress

LAST COMPLETED CHECKPOINT: 4
CURRENT PARTIAL CHECKPOINT: None
COMPLETED ITEMS: Initial source, strict TypeScript, Next.js application, design primitives, environment handling and repository rules.
INCOMPLETE ITEMS: Checkpoints 5–8.
KNOWN FAILURES: None. npm optional binding installation issue resolved with npm install --include=optional under Node 24.
NEXT EXACT ACTION: Checkpoint 5 — transactional counsellor/study-plan/support services with audit and permission tests.

## Checkpoint ledger

Each checkpoint records files/features, migrations, tests, limitations, external configuration and the exact next checkpoint below.


## Checkpoint 1 — complete
- Files/features: Next.js 16.3.4, React 19.2.8, strict TypeScript, Tailwind 4.3.3, Zod configuration checks, shared design primitives, basic routes/error/loading states, npm lockfile, AGENTS.md, README and all twelve architecture documents.
- Migrations: none (next checkpoint).
- Validation: ESLint passed with no warnings after fix; route type generation + TypeScript passed; Vitest 4/4 passed; production webpack build passed (/, /demo).
- Limitations: initial visual foundation only; auth/database/navigation are not yet implemented. Host default Node 20 is too old; use Node 22.12+ (validated with bundled Node 24.19.0).
- External configuration: Supabase project, provider credentials and SMTP will be required for live authentication; none required for the demo.
- Exact next checkpoint: 2 — database/domain model, migrations and demo seed architecture.


## Checkpoint 2 — complete
- Files/features: domain validation, 19 relational tables, version-consistent foreign keys, immutable published/enrolled curriculum, unique active counsellor/plan constraints, fictional SQL seed, isolated TypeScript UI fixtures and local Supabase configuration.
- Migrations: 202609080001_academy_foundation.sql. All client database access initially denied.
- Validation: actual PostgreSQL migrations and seed executed in PGlite; 12/12 tests passed, including version mismatch, content immutability, cross-student item and duplicate counsellor rejection; TypeScript and ESLint passed.
- Limitations: timetable, results, assessments, mastery and announcements remain documented future modules; UI examples for them are not live academic records. PGlite does not replace a hosted Supabase integration test.
- External configuration: Supabase CLI/Docker or managed PostgreSQL project needed for a durable live database. Seed is local/demo only and creates no sign-in accounts.
- Exact next checkpoint: 3 — authentication and unified identity.


## Checkpoint 3 — complete
- Files/features: server-only Supabase SSR client, HTTP-only PKCE/session cookies, refresh proxy, email signup/login, verification/resend, forgot/reset password, OAuth actions and callback routes, Google/LinkedIn OIDC buttons, trusted-origin redirect handling and polished authentication screens.
- Migrations: 202609080002_identity.sql provisions/backfills a unique stable Ducelio identity and STUDENT role; client role metadata is ignored. Supabase auth.identities is the canonical provider identity store.
- Validation: 16/16 tests passed, including provisioning/duplicate mapping, metadata escalation rejection, redirects and authentication validation; TypeScript and ESLint passed.
- Limitations: actual provider/email delivery and hosted session lifecycle require staging credentials. Manual cross-email account linking/merging and magic links are deliberately deferred; verified provider linking is delegated to Supabase.
- External configuration: exact Supabase, SMTP, redirect, Google and LinkedIn OIDC instructions in docs/04-auth-and-identity.md. No real credentials invented or committed.
- Exact next checkpoint: 4 — RBAC and security boundaries.


## Checkpoint 4 — complete
- Files/features: validated backend Actor, centralized role/relationship policies, protected student/support/admin entry points, protected admin API, RLS on every application table, no general client mutation grants and no trust in editable metadata.
- Migrations: 202609080003_authorization.sql; fixed-search-path permission helpers and explicit function grants. Verified Auth identity is required at SQL and application layers.
- Validation: 34/34 tests passed; PostgreSQL tests exercise anon/student/other student/assigned counsellor/instructor and reject direct role/academic writes; protected API tests return 401/403/200 as appropriate. TypeScript and ESLint passed.
- Limitations: staff operational workflows are shells; privileged role provisioning remains an operator-controlled database action. No blanket private-support access for admins.
- External configuration: apply migrations to Supabase and exercise direct REST/RLS under real JWTs on staging before production.
- Exact next checkpoint: 5 — counsellor institutional services.
