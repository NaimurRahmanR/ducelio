# Architecture

## Decision: modular monolith

Next.js App Router + React + strict TypeScript + Tailwind. Server components load records through application services; Zod validates boundaries; PostgreSQL enforces invariants. Supabase supplies managed PostgreSQL and authentication. No microservices or AI dependencies.
Layers: src/app (routes/actions) → src/server (application/data services) → src/domain (pure policy/validation) → Supabase/PostgreSQL.
The user explicitly requested a Next.js/Supabase repository and local preview; a hosted Sites scaffold is not substituted for this application architecture.

## Trust boundaries

Browser input is untrusted. Server identity is validated against Supabase Auth; roles come from the protected role table, never editable user metadata. Database RLS repeats ownership/assignment checks. Mutations go through constrained transactional RPCs and append audit records.
The public /demo tree is deterministic fixture rendering. It has no impersonation cookie, no privileged token and no write path into production records. Real routes never fall back to demo data on query failure.

## Deployment

Run Next.js as a Node server with HTTPS at the trusted APP_URL and Supabase in a selected region. No application service-role key is required. SSR session responses must not be cached by a CDN. Use the proxy for cookie refresh, then reauthenticate/authorize inside every service/action.
Keep preview and production data distinct. Add telemetry/error correlation without logging credentials, support prose or authentication tokens. Backups, restoration exercises, alerting and deployment-specific security review are operational prerequisites.
