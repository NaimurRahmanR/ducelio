# Ducelio repository rules

Start every continuation by reading this file, docs/implementation-progress.md, git status, recent commits and existing tests. Resume the first incomplete checkpoint. Preserve working implementation.

- Ducelio is an Academy OS, not a chatbot application. No AI, payments or full assessment/mastery engines in Phase 1.
- Institutional truth belongs to deterministic backend services. Authenticated identity is authoritative; typed Student IDs never authenticate.
- Backend RBAC is mandatory. Never trust client-supplied roles or actor IDs. Deny by default and enforce ownership/assignment as well as role.
- Programme content and fixed lesson objectives are versioned. Preserve enrolled curriculum history.
- Mastery requires validated LearningEvidence and audit history. Time spent, navigation and lesson progress do not equal mastery.
- Counsellor is a first-class persistent learner relationship, across programmes. Counsellors do not own grades, enrolment, deadlines or official records.
- Support records have separate permission boundaries; instructors cannot read private support records by default. Minimise sensitive data.
- Future AI actors receive permissioned APIs only, never unrestricted database access. Assessment/homework firewalls must eventually be technically enforced from activity state.
- Never invent official exam content. Label demo academic content and seeded previews. Ducelio prepares learners for external qualifications; it does not award them.
- Maintain auditability, database constraints, tests, mobile responsiveness and accessibility. Every enabled visible control has a meaningful action.
- Keep secrets out of git and client code. React renders user content as text; never inject unsanitised HTML.
- After each checkpoint: run relevant tests/type checks, fix failures, update progress with migrations/limitations/configuration/next action, and commit if permitted.
- If interrupted: record LAST COMPLETED CHECKPOINT, CURRENT PARTIAL CHECKPOINT, COMPLETED ITEMS, INCOMPLETE ITEMS, KNOWN FAILURES, NEXT EXACT ACTION. Do not begin another large feature.

Use Node 22.12+ (Node 24 LTS recommended), npm and the lockfile. `npm run check` runs lint, type checking and tests. `npm run build` is a separate required gate. Production identity and PostgreSQL policies are exercised with Supabase; credential-free `/demo` must never grant production access.
