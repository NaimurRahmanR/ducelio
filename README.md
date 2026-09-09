# Ducelio

Your ambition. Guided to mastery.

Ducelio is a deterministic Academy Operating System built with Next.js, React, strict TypeScript, Tailwind, Zod and Supabase PostgreSQL/Auth. Phase 2 adds governed academic operations, evidence/mastery, controlled-assessment foundations, Registrar corrections and deterministic learner notifications/support triggers. No AI integration is included in Phase 2.

## Run locally

Requires Node **22.13+**; Node **24 LTS** is recommended. From this repository:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

On PowerShell, replace `cp` with `Copy-Item .env.example .env.local`. Preserve an existing configured `.env.local` instead of overwriting it.

Install Node 24 LTS with npm and reopen your terminal. Verify `node --version` reports the supported version. The optional Windows helper below uses Node on PATH and a repository-local npm cache; it does not download or fall back to an application-bundled runtime:

```powershell
.\scripts\npm.ps1 ci
Copy-Item .env.example .env.local
.\scripts\npm.ps1 run dev
```

Open **http://127.0.0.1:3000** for authentication or **http://127.0.0.1:3000/demo** for the credential-free academy. Always use the exact `APP_URL` origin for live authentication; do not mix `localhost` and `127.0.0.1` because PKCE cookies are host-bound.

- Student demo: `/demo`
- Support Centre demo: `/demo/support`
- Counsellor workspace demo: `/demo/counsellor`
- Administration demo: `/demo/admin`
- Protected real-account routes: `/student`, `/support`, `/admin`

Demo records are fictional, read-only fixtures. Live routes use actual authenticated records and never fall back to fixtures. OAuth buttons remain disabled until configured.

Stop any running Ducelio server before `npm ci`; Windows can otherwise lock native dependencies. Next.js generates `next-env.d.ts` during dev, build or typecheck; the file is intentionally ignored. The repository can live in any directory. Prefer a non-synchronised working folder to avoid OneDrive file-lock/conflict risk; no path is required by the application.

## Quality gates

```sh
npm run check
npm run format:check
npm run build
npm start
# In another terminal, against the running server:
npm run test:http
```

On Windows you can use `.\scripts\npm.ps1` instead of `npm` for the same commands. `npm run check` runs lint, route/type generation, TypeScript and Vitest. The PostgreSQL/PGlite suite executes the ordered migrations and fictional seed. The HTTP smoke suite deliberately sends no authentication cookies.

## Database and authentication

For a disposable local Supabase project, install the Supabase CLI and Docker, then:

```sh
supabase start
supabase db reset
```

The reset applies all migrations and the fictional local seed. It must never be run against production. Supabase CLI/Docker are not bundled with this repository.

For a managed project, use `supabase link --project-ref YOUR_PROJECT_REF`, review pending migrations, then `supabase db push`. Normal `db push` does not include the local seed. Configure the publishable key, trusted `APP_URL`, confirm-email requirement, SMTP and providers using [Authentication setup](docs/04-auth-and-identity.md).

Set environment values before building and rebuild production output after configuration changes. Apply **all 20 ordered migrations** currently in `supabase/migrations`. Sign up and verify real test users, then provision privileged roles and institutional relationships through reviewed operator workflows in [Operations and security](docs/13-operations-and-security.md). SQL demo users intentionally have no Auth identity or password.

## Phase 2 Academy OS

The Phase 2 branch implements governed ProgrammeVersion publication, Enrolment lifecycle, Counsellor assignment, ClassSession scheduling, AttendanceRecord operations, LessonSegment/LessonProgress, versioned LearningResource delivery, append-only LearningEvidence, deterministic `MASTERY_V1`, Assignment workflows, controlled-assessment activity firewalls, Registrar correction history, Notification records and deterministic `SUPPORT_V1` support triggers. The final review hardening additionally enforces instructor-to-class authoring scope, support-notification privacy minimisation and deterministic finalisation of stale controlled-assessment attempts.

The deterministic backend remains authoritative. Typed student identifiers never authenticate; client-supplied roles are not trusted; AI actors do not receive database credentials. Controlled assessment questions are released only through server-owned attempt state, and protected answer keys are not learner-readable.

Phase 2 is still **not production readiness**. Hosted Supabase/JWT/PostgREST/RPC acceptance, real provider/SMTP testing, true concurrent PostgreSQL tests, backups/restore, rate limiting and abuse controls, privacy/support-data governance, accessibility/browser/device acceptance and deployment security review remain required before real learners or protected assessments are operated.

## Repository guide

- `src/app`: routes, callbacks and validated server actions
- `src/components`: shared design system and student/staff views
- `src/domain`: role policies and input validation
- `src/server`: server-only identity, academic and support services
- `src/demo`: fictional UI fixtures
- `supabase`: PostgreSQL migrations, local configuration and seed
- `tests`: identity, permission, route and PostgreSQL workflow tests
- `scripts`: HTTP smoke checks and Windows runtime helper
- `docs`: principles, architecture, configuration and checkpoint records

Read [Implementation progress](docs/implementation-progress.md) before resuming work. [Phase 1 completion](docs/phase-1-completion-report.md) is the historical first-phase record; [Phase 2 progress](docs/phase-2-progress.md) is the checkpoint ledger, and [Phase 2 completion report](docs/phase-2-completion-report.md) records final audit/PR readiness.

See [Phase 1.5 readiness audit](docs/14-repository-readiness-audit.md) for the repository migration findings that preceded Phase 2.
