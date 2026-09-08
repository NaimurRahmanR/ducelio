# Database and migrations
Supabase PostgreSQL is the production store. Migrations live in supabase/migrations and are applied lexically. Generated UUIDs and foreign keys establish identity; version-consistency constraints protect academic relationships. Sensitive tables enable RLS and lack general-purpose client write policies.
## Local Supabase
Install the Supabase CLI and Docker separately. From this repository:
```sh
supabase start
supabase db reset
```
Use the printed local URL/publishable key in .env.local. Keep real credentials out of git. The optional demo seed uses deterministic fictional UUIDs and no login passwords; it is intended for local development only. No demo users are inserted into Supabase Auth.
For a managed project, link using the CLI and review the migration diff before running `supabase db push`. Do not apply a destructive reset to production.
## Verification
PGlite runs the actual PostgreSQL migrations, constraints, seed and role policies in isolated test databases. A small test-only auth schema emulates auth.uid(). These tests are PostgreSQL integration tests, not validation of hosted Supabase/Auth/SMTP/REST infrastructure. A staging Supabase test remains required.
## Operations
Documented operator actions require a reason and audit event. Back up and rehearse restore before live use. Choose support-record retention and deletion policies; the initial schema deliberately avoids health/demographic profiling.
