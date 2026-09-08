# Ducelio

Your ambition. Guided to mastery.

Phase 1 Academy OS: Next.js, React, strict TypeScript, Tailwind, Zod and Supabase PostgreSQL/Auth. No AI integrations.

## Run locally

Requires Node **22.13+**; Node **24 LTS** is recommended. From this repository:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

On PowerShell, replace `cp` with `Copy-Item .env.example .env.local`. Preserve an existing configured .env.local instead of overwriting it.

Install Node 24 LTS with npm and reopen your terminal. Verify node --version reports the supported version. The optional Windows helper below uses Node on PATH and a repository-local npm cache; it does not download or fall back to an application-bundled runtime:

```powershell
.\scripts\npm.ps1 ci
Copy-Item .env.example .env.local
.\scripts\npm.ps1 run dev
```

Open **http://127.0.0.1:3000** for authentication or **http://127.0.0.1:3000/demo** for the credential-free academy. Always use the exact APP_URL origin for live authentication; do not mix localhost and 127.0.0.1 because PKCE cookies are host-bound.

- Student demo: /demo
- Support Centre demo: /demo/support
- Counsellor workspace demo: /demo/counsellor
- Administration demo: /demo/admin
- Protected real-account routes: /student, /support, /admin

Demo records are fictional, read-only fixtures. Live routes use actual authenticated records and never fall back to fixtures. OAuth buttons remain disabled until configured.

Stop any running Ducelio server before npm ci; Windows can otherwise lock native dependencies. Next.js generates next-env.d.ts during dev, build or typecheck; the file is intentionally ignored. The repository can live in any directory. Prefer a non-synchronised working folder to avoid OneDrive file-lock/conflict risk; no path is required by the application.

## Quality gates

```sh
npm run check
npm run format:check
npm run build
npm start
# In another terminal, against the running server:
npm run test:http
```

On Windows you can use `.\scripts\npm.ps1` instead of `npm` for the same commands. The HTTP smoke suite deliberately sends no authentication cookies. Unit and PostgreSQL integration tests do not need Supabase credentials.

## Database and authentication

For a disposable local Supabase project, install the Supabase CLI and Docker, then:

```sh
supabase start
supabase db reset
```

The reset applies all migrations and the fictional local seed. It must never be run against production. Supabase CLI/Docker are not bundled with this repository and were not available during this implementation.

For a managed project, use `supabase link --project-ref YOUR_PROJECT_REF`, review pending migrations, then `supabase db push`. Normal db push does not include the local seed. Configure the publishable key, trusted APP_URL, confirm-email requirement, SMTP and providers using [Authentication setup](docs/04-auth-and-identity.md).

Set environment values before building and rebuild production output after configuration changes. Apply **all five migrations**. Sign up and verify real test users, then provision staff roles, assignments and study plans using reviewed operator workflows in [Operations and security](docs/13-operations-and-security.md). SQL demo users intentionally have no Auth identity or password.

## Repository guide

- `src/app`: routes, callbacks and validated server actions
- `src/components`: shared design system and student/staff views
- `src/domain`: role policies and input validation
- `src/server`: server-only identity/data/support services
- `src/demo`: fictional UI fixtures
- `supabase`: PostgreSQL migrations, local configuration and seed
- `tests`: identity, permission, route and actual PostgreSQL tests
- `scripts`: HTTP smoke checks and Windows runtime helper
- `docs`: principles, architecture, configuration and checkpoint records

Read [Implementation progress](docs/implementation-progress.md) before resuming work. [Phase 1 report](docs/phase-1-completion-report.md) records delivery and limitations. Phase 2 requires a separate instruction.

See [Phase 1.5 readiness audit](docs/14-repository-readiness-audit.md) for the repository migration findings and required engineering foundation work.
