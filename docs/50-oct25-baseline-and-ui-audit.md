# Ducelio — 12 October 2026 launch baseline and route-by-route UI/UX audit

**Release deadline:** 25 October 2026, public paid **website**. iOS/Android store packages are later distribution work; this web release must be mobile-responsive.
**Canonical issue:** [#62](https://github.com/NaimurRahmanR/ducelio/issues/62).
**Code inspected:** \`main\` at \`00ab7317171eb16f121f8106a2061e553233f71d\`; latest merged PR #61. GitHub main CI [37562017408](https://github.com/NaimurRahmanR/ducelio/actions/runs/37562017408) passed. This is a static source review and a reconciliation of previously recorded operator evidence, **not** a new deployed site walkthrough or staging acceptance run.

## A. Confirmed platform baseline

- 56 sequential numbered migrations \`001–056\` exist under \`supabase/migrations\`; no historical migration was modified by this audit.
- The last recorded successful hosted migration comparison (docs/38) is through \`043\` on 28 September. **Do not assume 044–056 are currently missing on staging**; inspect staging's real ledger first. Differences between repository and *last recorded evidence* total 13 migrations, not 13 proven deployment failures.
- Recorded hosted PASS: JWT/PostgREST, three Examiner app paths driven with deterministic provider stub, six named independent-PostgreSQL concurrency scenarios, and Stripe test-mode 7/7. None alone proves production operation.
- Prior full journey: \`ACCESS\`, \`DELIVERY\`, \`CLASSROOM\`, \`TUTOR_LAB\` passed; \`ASSESSMENTS\` stopped on a PostgREST assessment projection. The correction has been merged, but no full succeeding hosted rerun is documented. \`RECOVERY\`, \`LAB\`, \`PROGRESS_COMPLETION\` and negative replay have not been demonstrated by this whole-journey run.
- Latest AC-7 checkpoint: 4,196/4,196 tests across 171 files passed locally and main CI passed. Its independently described follow-ups include migrations 054–056 hosting, Sarah live-model evaluation, real PostgreSQL races, retention and browser tests.
- The marketing homepage in current \`main\` redirects to \`/courses\`; [PR #63](https://github.com/NaimurRahmanR/ducelio/pull/63) proposes an initial homepage replacement **and is not yet merged / browser-accepted**.
- No visible production mobile applications or app-store release bundles in the source tree.
- UI/UX audit below covers source entry points and key components. **No screenshot-level visual, keyboard/screen-reader or real-device test has run as part of this audit.**

## B. Page-by-page public and identity UX source inventory

| Entry | Code/source evidence | Exact release work | Priority |
| --- | --- | --- | --- |
| \`/\` | Redirects immediately to catalogue on \`main\` | Review PR #63's distinct homepage, visual quality, CTAs, mobile and accessibility | P0 |
| \`/courses\` | Real offer listing, server-price projection, signup and login | Catalogue product copy, empty state, loading, mobile grid; \`listCommercialV1Offers().catch(() => [])\` currently makes read failures look like no inventory—separate unavailable and genuinely empty states | P0 |
| \`/courses/[slug]\` | Real offer/price, entitlement-specific messaging, checkout component | Clarify course outline, delivery, buying/refund/support expectations; \`getCommercialV1Offer(...).catch(...NOT_FOUND)\` currently makes transport failures look like 404—investigate safe unavailable-state separation | P0 |
| \`/login\` | Shared real \`AuthPage\` and email/password form; configurable OAuth | Browser login, redirect safety, errors, keyboard/mobile, session expiry | P0 |
| \`/signup\` | Shared real \`AuthPage\` | Signup, confirmation, identity-mapping and email deliverability test; add legal consent/help as appropriate | P0 |
| \`/forgot-password\` | Shared real \`AuthPage\` | Verify real reset-mail delivery, errors, expiry/replay on production HTTPS origin | P0 |
| \`/reset-password\` | Shared real \`AuthPage\` | Verify callback/reset completion from email on mobile and desktop | P0 |
| \`/verify-email\` | Shared real \`AuthPage\` | Real email verification path and clear success/failure states | P0 |
| \`/checkout/success\` | Verified reconciliation flow and differentiated pending, refunded, revoked, failed and confirmed states | Real Stripe webhook + browser review, handling delayed fulfilment, receipt/help actions | P0 |
| \`/checkout/cancel\` | Clear cancellation state, link back | Confirm a customer can resume purchase and is not misled about payment | P1 |
| \`/not-found\`, root \`error\`, \`loading\` | Generic framework error/empty/loading components | Check branded error recovery, accessibility, realistic slow networks | P1 |

## C. Authenticated learner UX source inventory

| Entry / surface | Code/source evidence | Exact release work | Priority |
| --- | --- | --- | --- |
| \`/student\`, \`/student/programme\` | LiveStudent renders programme enrolments and learner home | Dashboard hierarchy, next action, multiple enrolments, empty states, mobile | P0 |
| \`/student/calendar\` | Whitelisted by dynamic route but currently falls through to **'planned for later milestone'** placeholder in LiveStudent | **Confirmed functional UX gap:** implement real calendar/session schedule view from existing authorised class sessions or remove misleading nav until complete | P0 |
| \`/student/classes\` | Real session, attendance, classroom eligibility and feedback views | Timezone, lesson order, touch targets, error/recovery, attendance truth | P0 |
| \`/student/classroom/[classSessionId]\` | Real scoped lesson content, Professor execution, Tutor/Lab follow-up, objectives and resources | Live provider quality, stream/latency, interruption, error, scrolling and accessible resource links | P0 |
| \`/student/study-plan\` | Real plan view and governing forms in LiveStudent | Mobile forms, schedules, confirm/change/refusal states | P0 |
| \`/student/assignments\` | Real StudentAssignmentList and coursework submissions | Real-account submission/history/validation, keyboard/mobile | P0 |
| \`/student/assessments\` | Real controlled assessment section with server-owned state | End-to-end assessment/grading, timeout, firewall and mobile accessibility | P0 |
| \`/student/practicals\` | Real self-scoped practical list and pagination | Lab submission, status and mobile error/pagination QA | P0 |
| \`/student/progress\` | Formal components, objective diagnostics and completion action | Ensure graded results, pending and passed/refused completion are legible | P0 |
| \`/student/results\` | LiveStudent renders **objective mastery only**, while formal results live in the distinct progress view | **Confirmed information-architecture mismatch:** clearly label mastery vs formal grades and provide prominent navigation to formal component results; do not change result authority | P0 |
| \`/student/notes\` | Learner resources and Tutor note link | Long reading, hyperlinks, mobile display and unavailable resources | P1 |
| \`/student/tutor-notes\` | Real immutable supplementary notes with paging | Pagination, safe formatting and sparse/empty state | P1 |
| \`/student/leaderboard\` | Real leaderboard table | Horizontal mobile tables, empty self-rank, accessibility | P1 |
| \`/student/support\` | Assigned counsellor, follow-ups, events | Privacy, support actions, humane no-counsellor state | P0 |
| \`/student/sarah\` | AC-5 guide, AC-6 ratings, AC-7 course guidance mode restrictions | Live-model behaviour, replays/failure, mobile, feedback, privacy/retention | P0 |
| \`/student/notifications\` | Real StudentNotificationPage | Display/read state, refresh and production delivery implications | P1 |
| \`/student/profile\` | Student no., roles, timezone and password-reset navigation | Findable privacy/deletion/export/support request paths; full account lifecycle | P0 |
| \`/student/announcements\` | Whitelisted dynamic route but falls through to placeholder; not an AcademyShell nav primary item | Either remove the inert route or provide an honestly scoped noticeboard; no fake live announcement feature | P1 |

## D. Admin, human support and demonstration source inventory

| Entry | Source reviewed | Exact remaining checks |
| --- | --- | --- |
| \`/admin\` | Live tabs: Overview, Programmes, Resources, Students, Counsellors, Sessions, Evidence, Assignments, Assessments, Notifications, Registry, Audit | Operator tasks, on-screen errors, responsive tables, role visibility, load |
| \`/admin/people\` | Roles, staff and audit table | Search/action refusals, deactivation, admin continuity |
| \`/admin/cohorts\` | Register, creation, rosters and controls | Capacity, pagination, lifecycle, error clarity |
| \`/admin/course-engineering\` | Course import, validation, safe preview, agent config, test and publish | Full guided publication workflow using real Security+ package |
| \`/admin/activation\` | Governed delivery-activation form | Real cohort activation end-to-end |
| \`/admin/activation/policy\` | Formal component, lab and results policy controls | Safe operator workflow, errors and state |
| \`/admin/activation/recovery\` | Examiner recovery worklist/actions | Controlled hosted recovery, human handoff clarity |
| \`/admin/academic-review\` | Manual grade escalation/review | Privileged access, corrections and reviewer conflict |
| \`/admin/academic-results\` | Detailed versioned grades, provenance, progress and regrade controls | Wide tables, filtering, pagination and academic correctness |
| \`/admin/commerce\` | Offers, campaigns and archive actions | End-to-end price/checkout/revocation and refund operations |
| \`/admin/agents\` | Runtime configuration and provider evidence dashboard | Operational visibility, accurate proof labels, budget/error clarity |
| \`/support\` | Assigned real counsellor caseload/profile interactions | Auth isolation, readable records, sensitive-data minimisation |
| \`/demo\`, \`/demo/[section]\`, \`/demo/admin\`, \`/demo/counsellor\` | Fictional credential-free demo surfaces | Prominent fictional/demo notice, no crossover to real app, mobile QA; decide public demo visibility |

## E. Cross-cutting gaps and source-level confidence

1. **Confirmed in source:** public homepage redirect on current main, learner Calendar placeholder, learner Announcements placeholder, formal Results vs mastery navigation mismatch. PR #63 addresses only the homepage starting point, not a complete branded website.
2. **Confirmed in source tree:** no public Privacy, Terms, refund, support-contact or account-deletion routes were found. This does not prove policies are absent from some external hosted site; inspect the eventual live domain. Customer-facing obligations must be satisfied before paid launch.
3. **Potential error-state defect:** public course listing catches all read errors as empty, and course detail catches as not-found. Confirm exact safe server/API contract before a code change.
4. **Source present but visual acceptance missing:** CSS has responsive breakpoints and AcademyShell has mobile nav. Actual iOS Safari/Android Chrome/browser, keyboard, screen reader, zoom, loading and slow-connection checks are unrun here.
5. **No false promise:** never claim SEO, performance, learning quality, mobile comfort, live-money/SMTP delivery or accessibility PASS solely from committed source.

## F. Hosted acceptance — exact safe operator sequence

**Read-only preflight first** (configured/missing/malformed flags only; never paste \`.env.local\` values into tickets):

\`\`\`powershell
Set-Location 'C:\Users\naimu\OneDrive\Desktop\ducelio'
git status --short
git rev-parse HEAD
npm.cmd run acceptance:preflight
\`\`\`

**Environment identity gate:** establish that acceptance PostgREST/Supabase and \`ACCEPTANCE_DATABASE_URL\` identify the same authorised, dedicated **non-production** staging environment (\`ACCEPTANCE_ENVIRONMENT_ID\` binding). Never run seeded tests against production, never \`supabase db reset\` on a hosted project, never log secrets. Read the actual \`supabase_migrations.schema_migrations\` ledger and compare to 001–056 before any schema change. Snapshot/backup, review pending migration statements and update staging only with explicit operator authorisation.

**After staging parity confirmed**, run \`npm.cmd run acceptance:hosted\` and capture its PASS/FAIL/BLOCKED/NOT_RUN row statuses and logs. The hosted harness deliberately does **not** execute \`POSTGRES_CONCURRENCY\` or \`FULL_CUSTOMER_JOURNEY\`. These are separate, potentially mutating operator commands. Only after explicit non-production write gate and review, run the individual \`acceptance:concurrency\` and \`acceptance:journey\` scripts; record actual sub-surface results. Never conflate reviewer-entitlement journey with live-money Stripe payment.

For each stage: record checked repository SHA, project/environment, migration ledger (numbers only), command, start/finish time, per-surface status, exact defect/PR and reviewer. **No fresh hosted execution occurred during this repository-only audit.**

## G. First launch-hour action summary

- **Completed now:** source route inventory, migration file inventory, historical acceptance reconciliation and P0 gap triage.
- **In review:** [PR #63](https://github.com/NaimurRahmanR/ducelio/pull/63), public homepage + responsive styling. Await CI and browser QA; no premature merge.
- **Staging blocker:** current hosted database and deployed web runtime not connected for direct verification; use authorised operator execution or connected infrastructure tools. Do not mark hosted acceptance as failed simply because it was not run.
- **Next P0 code edits:** real learner Calendar, Results discoverability, truthful public error states, legal/customer policy routes once owner-approved text is available, checkout and responsive journey QA.
- **Release scope:** fully polished, reliable public paid website by 25 October; the subsequent iOS/Android store packages will share its backend and web learner experience.
