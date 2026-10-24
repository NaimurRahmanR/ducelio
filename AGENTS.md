# Ducelio repository rules

Start every continuation by reading this file, `docs/implementation-progress.md`, git status, recent commits and existing tests. Resume the first incomplete checkpoint. Preserve working implementation.

- Ducelio is an Academy OS, not a chatbot application. The deterministic backend owns authoritative institutional state.
- No AI integration is present through Phase 2. Future AI actors receive reviewed permissioned tools/APIs only, never unrestricted database access or service-role credentials.
- Authenticated backend identity is authoritative; typed Student IDs never authenticate. Never trust client-supplied roles or actor IDs.
- Backend RBAC and database RLS are mandatory. Deny by default and enforce operation-specific role plus ownership/assignment boundaries.
- Programme content and fixed lesson objectives are versioned. Preserve published and enrolled curriculum history; corrections do not silently rewrite historical academic records.
- Mastery requires validated LearningEvidence and deterministic policy history. Time spent, navigation, page views, resource use, attendance and lesson progress do not equal mastery.
- Counsellor is a first-class persistent learner relationship across programmes. Counsellors do not own grades, enrolment, deadlines, attendance, curriculum or other official academic records.
- Support records have separate permission boundaries; instructors/admin roles cannot read private counselling prose by default. Minimise sensitive data and audit payloads.
- Controlled-assessment firewalls are server-owned and technically enforced from activity state. Protected prompts and answer keys must never be exposed through ordinary learner-readable tables or prompt-only policy.
- Registrar correction authority is not academic teaching authority. Preserve explicit separation between official-record correction workflows and curriculum/evidence/assessment operations.
- Deterministic support triggers must use reviewed authoritative conditions. Do not infer inactivity, motivation, risk or mastery from clicks, page views, time-on-page or conversational sentiment.
- Never invent official exam content. Label demo academic content and seeded previews. Ducelio prepares learners for external qualifications; it does not award those external qualifications.
- Maintain auditability, database constraints, idempotency, tests, mobile responsiveness and accessibility. Every enabled visible control has a meaningful action.
- Keep secrets out of git and client code. React renders user content as text; never inject unsanitised HTML.
- After each checkpoint: run relevant tests/type checks, fix failures, update progress with migrations/limitations/configuration/next action, and commit if permitted.
- If interrupted: record LAST COMPLETED CHECKPOINT, CURRENT PARTIAL CHECKPOINT, COMPLETED ITEMS, INCOMPLETE ITEMS, KNOWN FAILURES and NEXT EXACT ACTION. Do not begin another large feature while a checkpoint is partial.
- Before important changes reach `main`, use Git, run the required gates, review the diff/security boundaries and require PR CI/review. A feature-branch push alone does not prove CI passed.

Use Node 22.13+ (Node 24 LTS recommended), npm and the lockfile. `npm run check` runs lint, type checking and tests. `npm run build` and `npm run format:check` are separate required gates. Production identity and PostgreSQL policies are exercised with Supabase; credential-free `/demo` must never grant production access.

Hosted Supabase/JWT/PostgREST/provider testing, true concurrent PostgreSQL acceptance, SMTP, backups/restore, rate limiting/abuse controls, privacy/support-data governance, accessibility/browser/device acceptance and deployment security review are required before production use.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
