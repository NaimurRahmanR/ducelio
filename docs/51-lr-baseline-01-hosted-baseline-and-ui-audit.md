# LR-BASELINE-01 — hosted baseline resolution and initial website readiness

Status: **implemented locally, uncommitted, awaiting independent review.** Base: `main` at `00ab7317171eb16f121f8106a2061e553233f71d` (PR #61). Review worktree branch: `review/lr-baseline-01` (no commit). Hosted target: Supabase project `ducelio-acceptance` (`blqaomssojfxaxskcyxd`). Nothing here is production evidence.

## 1. Hosted migration reconciliation (read-only, 2026-10-13)

| Check                                                                                                | Result                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL` host and `ACCEPTANCE_DATABASE_URL` pooler user both carry the project ref | Yes (`blqaomssojfxaxskcyxd`)                                                                                      |
| DB marker row `_ducelio_acceptance_marker` = `ACCEPTANCE_ENVIRONMENT_ID`                             | Yes (1 row)                                                                                                       |
| Hosted `get_ducelio_acceptance_environment_id()` via the admin JWT = `ACCEPTANCE_ENVIRONMENT_ID`     | Yes (anon is denied, as intended)                                                                                 |
| `supabase_migrations.schema_migrations`                                                              | 56 rows, `202609080001` … `202610070056`, same order as the repository                                            |
| Ledger `statements` vs repository files (whitespace/semicolon-normalised)                            | **56/56 identical**                                                                                               |
| Every function (373 names) and table (112) created by migrations exists                              | Yes                                                                                                               |
| Public tables without RLS                                                                            | None                                                                                                              |
| Private schemas usable by `anon`/`authenticated`                                                     | None                                                                                                              |
| `SECURITY DEFINER` public functions without a pinned `search_path`                                   | None                                                                                                              |
| `anon` table privileges in `public`                                                                  | Only the operator-provisioned marker table (RLS on, no policy); see §3                                            |
| `anon` EXECUTE on public functions                                                                   | 86 (28 trigger functions, 4 intended RPCs, Supabase's `rls_auto_enable`, **53 beyond migration intent**) — see §2 |

## 2. Confirmed schema/privilege defect and proposed migration 057

**Hosted default-ACL facts (read-only).**

- Every Ducelio function (236 in `public`, 212 in `*_private`) is owned by `postgres`, the non-superuser migration role. `postgres` is not a member of `supabase_admin`.
- `pg_default_acl` for `postgres` IN SCHEMA `public` (and `storage`) grants functions, tables and sequences to `anon`, `authenticated` and `service_role` explicitly. `supabase_admin` has its own equivalent rows for `public`, `graphql` and `graphql_public`, plus `postgres`-only rows for `extensions`.
- `postgres` has **no global** function default, so PostgreSQL's built-in default also grants EXECUTE to `PUBLIC` (of which `anon` and `authenticated` are members) in every schema.
- `postgres` can create functions only in `public`, its 21 Ducelio `*_private` schemas, `extensions` and `supabase_migrations`. In `extensions` it owns 49 functions (pgcrypto, uuid-ossp, pg_stat_statements), and 48 of them rely on the `PUBLIC` default.

**Root cause.** Phase 1–2 migrations wrote `revoke all … from public` and then granted `authenticated`. That does not remove the explicit per-schema `anon` grant. Every drifting function was created in migrations 003–019. The PGlite helper emulated only a `service_role` default, so no suite could see it.

**Severity HIGH — `apply_objective_mastery_policy(uuid,uuid,uuid,uuid)`.** Migration 014 grants it to nobody: it is an internal helper of `record_learning_evidence`. Hosted, `anon` and `authenticated` can EXECUTE it through PostgREST. It accepts a caller-chosen trigger evidence row and `p_actor`. A learner can read their own evidence, enrolment and objective ids (`can_read_learning_evidence` owner branch). Reproduced locally under hosted-faithful defaults: a learner moved their own mastery `NEEDS_REINFORCEMENT → DEMONSTRATED` by replaying older correct evidence, and the appended history row was attributed to an administrator. This breaks the "mastery only from validated evidence through deterministic policy history" invariant. It was **not** exercised on hosted. A read-only hosted scan found 2 mastery history rows, 0 evaluator mismatches and 0 current rows not derived from the latest evidence.

**Lower severity — 52 phase 1–2 RPCs executable by `anon`.** This is a deny-by-default gap, not a demonstrated bypass. Dependency review (hosted, read-only, plus source):

- 34 RLS policies call them, all `to authenticated`. No view, publication or non-Ducelio function calls them.
- `anon` holds no table privilege in `public`, so it cannot fire the three SECURITY INVOKER triggers that call `current_app_user`/`has_role`. Those fire only inside SECURITY DEFINER RPCs, as `postgres`.
- The 4 reviewed `anon` RPCs are SECURITY DEFINER, so their internal `current_app_user` calls run as the owner. This is tested: `anon` still reads the catalogue after 057.
- All 30 application call sites authenticate before the RPC (`requireActor`/`requireStudentPrincipal`/`supportContext`).

**Proposed correction (not applied hosted):** `supabase/migrations/202610130057_supabase_default_privilege_hardening.sql`

1. Revokes all on `apply_objective_mastery_policy` from `public, anon, authenticated, service_role`. The legitimate caller runs as the definer.
2. Revokes EXECUTE from `anon` on the explicit 52 RPC signatures. Each is cast to `regprocedure`, so a missing signature fails the migration.
3. **Long-term control** for functions `postgres` creates from now on:
   - `alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, service_role`;
   - a global `alter default privileges for role postgres revoke execute on functions from public, service_role`, which replaces the built-in `PUBLIC` default (the `service_role` part is a no-op on hosted);
   - `PUBLIC` is explicitly re-granted per schema in every other schema `postgres` can create functions in (hosted: `extensions`, `supabase_migrations`), so future extension installs behave exactly as today.
4. Migration-time self-verification: every listed privilege; a probe SECURITY DEFINER function in `public` that must be executable by no API role (then dropped); and the preserved `PUBLIC` default in each preserved schema. The migration also refuses to run unless the runner and the function owner are `postgres`.

Not changed:

- the 4 reviewed `anon` RPCs and every `authenticated` grant;
- existing trigger functions;
- phase 1–2 `service_role` grants;
- `supabase_admin`, `supabase_auth_admin` and every other Supabase role's defaults, which a `postgres` migration cannot alter and must not;
- `postgres` defaults in schemas it cannot create functions in (`storage`);
- table and sequence defaults;
- non-migration objects.

Consequence for future migrations: a new RPC is callable only after an explicit `grant execute … to authenticated` (or `anon`), which every reviewed RPC since migration 020 already does.

**Before/after privilege matrix** (P = PUBLIC, A = anon, U = authenticated, S = service_role). "Hosted now" is read live (read-only). "After 057" is the full PGlite chain under hosted-faithful defaults. Hosted-now equals the PGlite chain through 056 for all 446 Ducelio functions (0 mismatches).

| Functions | Category                                     | Hosted now | After 057 |
| --------- | -------------------------------------------- | ---------- | --------- |
| 1         | `apply_objective_mastery_policy`             | `-AUS`     | `----`    |
| 52        | phase 1–2 public RPCs                        | `-AUS`     | `--US`    |
| 4         | reviewed anon RPCs                           | `-AU-`     | `-AU-`    |
| 138       | other public RPCs                            | `--U-`     | `--U-`    |
| 3         | internal public functions                    | `----`     | `----`    |
| 28        | public trigger functions with default grants | `-AUS`     | `-AUS`    |
| 8         | public trigger functions without them        | `----`     | `----`    |
| 131       | private non-trigger                          | `----`     | `----`    |
| 81        | private trigger                              | `----`     | `----`    |

53 functions change. **None gains any privilege.** Only the mastery helper loses `authenticated`/`service_role`.

| Default ACL (functions)                                                   | Before                                  | After               |
| ------------------------------------------------------------------------- | --------------------------------------- | ------------------- |
| `postgres` global                                                         | none (built-in `PUBLIC` + owner)        | owner only          |
| `postgres` IN `public`                                                    | `anon`, `authenticated`, `service_role` | owner only          |
| `postgres` IN `extensions`, `supabase_migrations`                         | none (built-in `PUBLIC`)                | `PUBLIC` (explicit) |
| `postgres` IN `storage`; every `supabase_admin`/`supabase_auth_admin` row | as listed above                         | unchanged           |

**Regression and impact tests:** `tests/supabase-default-privileges-db.test.ts`, 14 tests. A new `testDatabase({ supabaseDefaultPrivileges: true })` option mirrors the hosted `postgres` and `supabase_admin` contexts. The suite compares the chain through 056 with the full chain under identical defaults:

- the diff is exactly the 52 + 1;
- the 52 equal the computed drift set;
- table, sequence and trigger-function privileges and all `supabase_admin` defaults are unchanged.

It also covers:

- a new internal SECURITY DEFINER function is executable by no API role, and an `authenticated` call is denied;
- an explicitly granted RPC works for `authenticated` only;
- `extensions` keeps the `PUBLIC` default;
- `supabase_admin`-created functions keep Supabase's defaults;
- `anon` can still read the catalogue;
- learner mastery replay is refused;
- `record_learning_evidence` still moves mastery.

Mutation checks (temporary edits, restored and SHA-256-verified; the migration's self-checks were removed in M1–M3 so only the suite could catch them): **6/6 killed**.

| Mutant | Change                                 |
| ------ | -------------------------------------- |
| M1     | no per-schema revoke                   |
| M2     | no global revoke                       |
| M3     | no `PUBLIC` preservation               |
| M4     | mastery helper left to `authenticated` |
| M5     | one RPC dropped from the list          |
| M6     | an extra `authenticated` revoke        |

Once 057 is in the repository, the harness `MIGRATIONS` surface correctly reports a ledger mismatch (57 local, 56 hosted) until 057 is reviewed and deployed.

## 2a. `npm run format:check` root cause and fix

Reproduced from clean clones of `00ab731`:

- **As-is:** with the system git config `core.autocrlf=true`, exactly 7 files fail (`.github/workflows/ci.yml`, `package.json`, `tsconfig.json`, four `content/courses/security-plus-sy0-701/*.json`), exit 1.
- **Cause:** `.gitattributes` pins `eol=lf` only for `ts`, `tsx`, `mjs`, `css`, `sql` and `md`. The `json`/`yml` blobs are LF in git, but Windows checks them out as CRLF, and Prettier's default `endOfLine: "lf"` rejects that. The eighth such file, `package-lock.json`, is Prettier-ignored. Linux CI checks out LF, so it passes.
- **Fix:** add `*.json`, `*.yml` and `*.yaml text eol=lf` to `.gitattributes`. The same clone with only those three lines passes (exit 0) with no content change.
- **In the worktree:** the same lines were added and only those 8 working copies were re-checked-out from the unchanged index. `git diff` shows 0 lines for json/yml.

## 3. Acceptance-environment observations (not changed)

- `_ducelio_acceptance_marker` carries the Supabase default grants (`anon`/`authenticated` INSERT/UPDATE/DELETE/TRUNCATE). RLS with no policy blocks row access through PostgREST, and PostgREST cannot issue TRUNCATE. It is operator-provisioned and was deliberately left untouched. Recommendation: the operator revokes those grants by hand.
- The journey needs `ACADEMIC_EXECUTION_KEY_ID`/`ACADEMIC_EXECUTION_HMAC_KEY_HEX` matching the one active hosted controller key, plus `ACCEPTANCE_WRITE_ENABLED=true`. Neither is configured in this checkout or the user/machine environment. No key was provisioned or recreated.

## 4. Hosted customer-journey history (read-only reconstruction)

| Run      | Created (UTC)    | Footprint                                                           | Recorded outcome                                                                         |
| -------- | ---------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `vf2w0i` | 2026-09-28 21:17 | fixtures only                                                       | run #1 (docs/38)                                                                         |
| `jz55ep` | 2026-09-28 22:46 | 2 expired QUIZ_1 attempts                                           | run #2: ASSESSMENTS FAIL (PGRST200 embed) — docs/38                                      |
| `gf32dm` | 2026-09-29 00:18 | 2 attempts, 1 result                                                | run #3 (PR #40/#42 forensics)                                                            |
| `x0pzs0` | 2026-09-29 02:00 | 12 graded attempts, 2 lab results, 1 learner receipt                | run #4: all surfaces except `BELOW_PASS_MARK_COMPLETION_REFUSED` (status-0 RPC) — PR #42 |
| `rb3gn9` | 2026-09-30 14:45 | learner 6×100 % + receipt; foreign 6×0 %, no receipt; 2 lab results | **no recorded report anywhere**: consistent with a full run, but not evidence of PASS    |

The PGRST200 projection fix (PR #40) and the status-0 activity retry (PR #42) are on `main`. Migrations 044–056 were deployed after run #5, so a fresh run on the current schema is required.

## 5. Page-by-page UI/UX findings

Legend: **F** confirmed functional defect · **P** confirmed presentation/usability defect · **M** missing implementation · **U** unverified browser/device behaviour · **OK** implemented correctly (source + render tests). Every row also carries **U** for visual, responsive, keyboard and screen-reader behaviour: no real browser was available in this session.

### Public

| Surface                            | Finding                                                                                                                                                                                                                 | Sev  | Source                                                     | Disposition                                                                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                | `main` redirects to `/courses`; PR #63 adds a page but swallows catalogue errors as "no courses", formats dates by host locale, shows Sign in to signed-in users (PR text claims otherwise), fails Prettier in CI       | F/P  | `src/app/page.tsx`                                         | **Corrected here** (§6)                                                                                                                                                                                                                                   |
| `/courses`                         | No `<main id="main">` (root skip link targets nothing); outage shown as "no courses open"; `toLocaleDateString()` on a date-only value (host-zone day shift, US-style numerals)                                         | F/P  | `src/app/courses/page.tsx`                                 | **Corrected here**                                                                                                                                                                                                                                        |
| `/courses/[slug]`                  | No `main` landmark; same date defect                                                                                                                                                                                    | F/P  | `src/app/courses/[slug]/page.tsx`                          | **Corrected here**                                                                                                                                                                                                                                        |
| `/`, `/courses`, `/courses/[slug]` | A published offer whose cohort already started was labelled "Next cohort starts 2 October 2026" (observed against the hosted acceptance catalogue); a "started"/"next" claim depends on the viewer's own clock and zone | P    | offer projection consumers                                 | **Corrected here**: neutral "Cohort start date: <time datetime=YYYY-MM-DD>"; whether such offers should stay published is a commerce decision. Sarah's AC-7 card still says "Next cohort starts" (`src/components/sarah-course-guidance.tsx` l.81) — open |
| `/courses/[slug]`                  | Transport failure becomes `notFound()` (404 for an outage); COMPLETED copy says "visit your results" without a link                                                                                                     | F/P  | same, l.18–21                                              | Open — recommend an unavailable state and a link to `/student/progress`                                                                                                                                                                                   |
| `/courses` hero copy               | "plus a counsellor by your side" — a human counsellor may not be assigned (the learner UI says so)                                                                                                                      | P    | `src/app/courses/page.tsx`, `src/components/auth-page.tsx` | Open — copy decision for review                                                                                                                                                                                                                           |
| `/checkout/success`                | Differentiated states with `role` semantics (OK); no `main` landmark; headings use `--` as a dash                                                                                                                       | P    | `src/app/checkout/success/page.tsx`                        | Open                                                                                                                                                                                                                                                      |
| `/checkout/cancel`                 | "contact support" with no reachable public support channel; no `main` landmark                                                                                                                                          | F/P  | `src/app/checkout/cancel/page.tsx`                         | Open — needs a real support contact                                                                                                                                                                                                                       |
| `/login` … `/verify-email`         | Shared `AuthPage` with `main#main`, safe `next` handling (OK). Email delivery unproven (`SUPABASE_AUTH_EMAIL` BLOCKED)                                                                                                  | OK/U | `src/components/auth-page.tsx`                             | No change                                                                                                                                                                                                                                                 |
| root `error`                       | Always claims "Your records have not been changed", which is not guaranteed if an action committed before a render error                                                                                                | P    | `src/app/error.tsx`                                        | Open                                                                                                                                                                                                                                                      |
| `loading`/`not-found`              | `loading.tsx` is itself `<main id="main">`, so every streamed dynamic page briefly carries two `main#main` (observed in the built app's HTML); its copy "Opening your academy…" also shows on public pages              | P    | `src/app/loading.tsx`                                      | Open — use a non-landmark status container                                                                                                                                                                                                                |
| `/demo/*`                          | States "classes are a later milestone" and "Assignment submission and grading are not implemented in Phase 1": stale and contradicted by the live product                                                               | P    | `src/components/demo-section.tsx` l.109, l.214             | Open — public truthfulness                                                                                                                                                                                                                                |

### Learner

| Surface                                                                                          | Finding                                                                                                                                                                                       | Sev | Source                                                     | Disposition                                                                                    |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/student/calendar`                                                                              | Falls through to the "later milestone" placeholder on `main`. PR #65's agenda dereferences an unvalidated profile zone (`RangeError` would fail the page) and lists all history oldest-first  | F/M | `src/components/live-student.tsx`                          | **Corrected here** (upcoming/past grouping, safe zone, start and end as two `<time>` instants) |
| `/student/classes`                                                                               | Times via `toLocaleString()` (server zone/locale, not the learner's), inconsistent with the Calendar                                                                                          | F   | same                                                       | **Corrected here**                                                                             |
| `/student/results`                                                                               | Shows objective mastery only; formal grades live on `/student/progress`                                                                                                                       | P   | same                                                       | **Corrected here** (PR #65's bridge card retained)                                             |
| learner shell breadcrumb                                                                         | Any page outside the nav (Tutor notes, classroom) reads "Study plan"                                                                                                                          | P   | `src/components/academy-shell.tsx`                         | **Corrected here**                                                                             |
| `/student/progress`                                                                              | Zero enrolments shows an alert "not currently available for this course"; raw codes (`QUIZ_1`, `MIDTERM`); labs shown only as "Lab"; nav label "Course completion" vs title "Course progress" | P   | `src/app/student/progress/page.tsx`                        | Open                                                                                           |
| `/student/classroom/[id]`                                                                        | Professor panel titled "Professor" with no AI disclosure (Sarah carries one); 2 host-locale timestamps                                                                                        | P   | `src/components/professor-classroom-panel.tsx` l.145, page | Open — transparency                                                                            |
| `/student/leaderboard`                                                                           | Host-locale date                                                                                                                                                                              | P   | `src/app/student/leaderboard/page.tsx` l.69                | Open                                                                                           |
| `/student/announcements`                                                                         | Allow-listed, renders the placeholder; reachable only by URL for live learners                                                                                                                | M   | `src/app/student/[section]/page.tsx`                       | Open — remove the route or implement                                                           |
| `/student/assessments`                                                                           | Lists only the 100 earliest-opening in-scope assessments; a learner with more cannot see their newest course's assessments                                                                    | F   | `src/server/assessments.ts` l.357                          | Open (the journey does not depend on it)                                                       |
| assignments, assessments, notifications, Tutor notes, notes, practicals, Sarah, support, profile | Real projections, explicit empty/error states, shared shell (OK). Host-locale timestamps remain in assignment/assessment/notification/Tutor-note/Sarah components (22 files repo-wide)        | P   | see `toLocale*` list                                       | Open — adopt `src/domain/learner-time.ts` incrementally                                        |
| root `loading` only                                                                              | No per-route loading UI for the slow learner reads                                                                                                                                            | P/U | `src/app/loading.tsx`                                      | Open                                                                                           |

### Administrative and support

| Surface                                                                                                    | Finding                                                                                                       | Sev  | Source                                                | Disposition |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------- | ----------- |
| staff shell                                                                                                | "Student academy" link always shown; staff without STUDENT end at `/login?error=forbidden` (dead-end control) | F    | `src/components/staff-shell.tsx` l.125–128            | Open        |
| staff shell                                                                                                | 12 record tabs plus up to 12 control-plane links in two tab rows; mobile overflow behaviour unverified        | U    | same                                                  | Open        |
| `/admin/activation/policy`, `/admin/activation/recovery`                                                   | Load failures are swallowed (`.catch(() => …)`), so an outage can look like "nothing to do"                   | F/P  | `src/app/admin/activation/{policy,recovery}/page.tsx` | Open        |
| admin workspaces (attendance, sessions, evidence, registrar, publication, recovery, counsellor assignment) | Host-locale timestamps                                                                                        | P    | components listed by the `toLocale*` scan             | Open        |
| People, Cohorts, Course engineering, Activation, Commerce, Academic review/results, Agents, `/support`     | Role-gated pages with governed RPCs, existing render/action suites, truthful "not configured" labels (OK)     | OK/U | `src/app/admin/**`, `src/app/support/page.tsx`        | No change   |

## 6. Homepage and navigation corrections in this checkpoint

- `src/app/page.tsx` — PR #63's intent kept with corrections:
  - one `main#main`;
  - hero with "Explore courses" and "Create an account", or the role-correct workspace link when signed in (`canEnter`; destinations still enforce their own roles);
  - "How Ducelio works" (curriculum, labelled AI teaching that pauses during controlled assessments, mastery never from time/page views);
  - "Getting started" steps;
  - up to 3 published offers;
  - outage and empty states kept distinct;
  - external-qualification disclaimer;
  - a labelled demo link.
- `src/components/offer-card.tsx` — shared `OfferCard`, `loadPublishedOffers`, `OfferListStatus`.
- `formatCohortStartDate` in `src/domain/commercial-v1-commerce.ts` and `CohortStartDate` in `src/components/offer-card.tsx`: the stored day as `<time datetime="YYYY-MM-DD">`, with no past/future claim.
- `src/app/courses/page.tsx`, `src/app/courses/[slug]/page.tsx` — `main#main`, shared card and date, outage state.
- `src/app/globals.css` — `.launch-*` styles on existing tokens, gold-on-navy primary action, a light focus ring inside the dark hero, full-width actions under 640px.
- `src/components/live-student.tsx` — PR #65 Calendar and Results bridge, plus:
  - learner-zone times through `src/domain/learner-time.ts` (UTC fallback, stated), rendered by `src/components/learner-time-range.tsx` as two `<time>` elements whose `datetime` is each end's exact instant;
  - upcoming/past grouping;
  - end date repeated across midnight;
  - Classes, lesson-progress, evidence and mastery timestamps converted too.
- `src/components/academy-shell.tsx` — truthful breadcrumb fallback.

PR #65's source-string test (`tests/launch-calendar-results-ui.test.ts`) is superseded by the rendered `tests/learner-calendar-results-ui.test.ts`. PR #64 (docs only) fails CI on Prettier only. Its migration and journey statements are superseded by §1 and §4.

**HTTP smoke (built app, `next start`, hosted acceptance catalogue, anonymous GETs only):** `/` 200 with one hero `h1` and 3 featured offers; `/courses` 200 with 10 offers; `/login` 200; `/student` 307 to login. This is not visual evidence.

**Unverified:** visual appearance, real-device layout at 320–414 px, keyboard focus order, screen-reader output, colour contrast measured in a browser. A visual review is required before merge.
