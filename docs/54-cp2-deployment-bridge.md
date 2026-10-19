# CP2F-A/B — Deployment compatibility bridge and learner assessment pagination

Status: **implemented locally, uncommitted, awaiting independent review.**

- Branch: `fix/cp2-deployment-bridge` from `main` `dd5e27a`.
- **Not deployed.**
- Migration 059 is not part of this branch. Its reviewed file is used only as a SHA-256-pinned test fixture.

## Why

The public staging application (Vercel `ducelio-staging`, serving `main`) reads the same `ducelio-acceptance` database that CP2's migration 059 will change.

Today's `main` validates two responses strictly:

- the Examiner assessment context (`z.strictObject`);
- academic review questions.

Migration 059 always adds `objectiveMarks` and `objectiveQuestionCount` to every successful assessment context, and `objective` to every review question. So applying 059 under today's `main` would break:

- Examiner initial grading (the execution is left to the database's expiry backstop);
- recovery and regrade (`SERVICE_UNAVAILABLE`);
- opening any assessment review case.

The bridge makes the deployed application work on **both** schema 058 and schema 059. It must be deployed before 059 is applied.

## A. Compatibility behaviour (accepts exactly three shapes, nothing broader)

| Database context                                                                                      | Bridge behaviour                                                                         |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Pre-059 (neither key)                                                                                 | Accepted unchanged                                                                       |
| 059 shape, assessment without objective questions (`objectiveQuestionCount: 0`, `objectiveMarks: []`) | Accepted. The two keys are removed, so the provider receives exactly the pre-059 context |
| One key without the other, a non-zero count, or any objective mark                                    | **Refused (fail closed)**                                                                |
| Any other unknown key, malformed mark, negative or fractional count                                   | Refused, as before (strict schema)                                                       |

The refusals by reader:

- **Initial grading:** refused before any provider call, as `FAILED/INTERNAL_ERROR` with zero usage. It is recoverable later by an application that grades objective questions.
- **Recovery and regrade:** refused with `SERVICE_UNAVAILABLE`.

Review questions accept an `objective` key only when it is absent or `null`. A non-null objective (an objective case) fails closed (`SERVICE_UNAVAILABLE`) instead of being shown as free text. The database also refuses any human mark that differs from the deterministic one (`OBJECTIVE_MARKS_MISMATCH`).

The legacy learner surface could still show an objective question's prompt as a free-text box. Its structured-answer validation in 059 refuses any non-structured body, so nothing invalid is ever stored. Objective assessments exist only in synthetic acceptance runs until CP2 is deployed.

Files:

- `src/domain/commercial-v1-examiner-grading.ts`
- `src/server/commercial-v1-examiner-{grading,recovery,regrade}/context.ts`
- `src/domain/commercial-v1-academic-review.ts`

## B. Learner assessment list defect and fix

The learner projection (`getStudentAssessments`) had three truncation points:

- **Assessments:** it read the **100 earliest** (`opens_at` ascending), so a learner with more than 100 visible assessments never saw newly published ones. On hosted, the acceptance learner sees 192 through RLS.
- **Attempts:** it read the 100 newest across all assessments, which could under-count a listed assessment's attempts.
- **Responses:** it read the 1,000 newest across all attempts.

It now reads:

- one page of 25 assessments, newest opening first (`opens_at`, `id` descending: a total order, so pages never overlap or skip). It shows Newer/Older page links (`/student/assessments?page=N`), and the page number is validated strictly: digits only, 1..1000, anything else is page 1;
- the learner's own ACTIVE attempt and its assessment **independently of the page**, so an active attempt is always visible and resumable;
- attempts only for the page's assessments (at most 25 × 5);
- response revisions only for the active attempt.

Every read stays under the learner's own session and RLS. Caps (500 attempts, 900 revisions, each plus one overflow row) stay below hosted PostgREST `max_rows` (1000), so an overflow fails closed (`READ_ATTEMPTS`/`READ_RESPONSES`) rather than being silently truncated.

Files:

- `src/server/assessments.ts`
- `src/app/student/[section]/page.tsx`
- `src/components/student-assessment-page.tsx`
- `src/components/student-assessment-section.tsx`
- `src/components/student-assessments.tsx`

## Evidence (local; not hosted)

- **`tests/cp2-deployment-bridge-db.test.ts`** (24 tests). It runs the real examiner-app route, submission grading, HMAC authority, OpenAI Responses adapter and loopback provider stub on PGlite, on **schema 058 and schema 059**:
  - free-text grading is GRADED on both;
  - the provider HTTP body is byte-identical between them (identifiers normalised);
  - a provider failure is still the recoverable `FAILED/PROVIDER_UNAVAILABLE`;
  - an objective assessment on 059 is refused with zero provider calls and no result;
  - the recovery and regrade readers accept the real 058/059 free-text contexts and refuse the objective one;
  - an escalated free-text case is readable and gradeable on both schemas;
  - an objective case is refused, and a forged objective mark is refused by the database while the deterministic mark is accepted.
- **`tests/student-assessment-pagination-db.test.ts`** (8 tests), under real RLS with governed RPCs only:
  - the learner has 312 visible assessments, 105 historical attempts and 1,109 historical revisions;
  - the new assessment is on page 1, and the old earliest-100 read provably omits it;
  - every page together lists every assessment exactly once;
  - attempt counts are exact;
  - an active attempt resumes from pages 1, 5 and 9 with exactly its own revisions;
  - 901 revisions fail closed;
  - another learner sees nothing.
- **`tests/student-assessments-pagination-ui.test.ts`** (4 tests): the page links.
- **Mutation checks:** bridge 7/7 killed; pagination 6/6 killed.
- **Test infrastructure:**
  - `tests/postgrest-select-query.ts` is a faithful select builder, used by two existing shims. It provides `ORDER BY` with PostgREST NULLS defaults, `range`, and a 1,000-row max-rows ceiling.
  - `tests/db-helper.ts` gains `extraMigrationFiles`.
  - The policy and submission-grading fixtures gain `migration059`, `quiz1QuestionsAfterValidation` and `escalateToAcademicReview`.
  - Three existing composition tests now assert the new read pattern: two attempt reads, and responses read only with an active attempt.

## Deployment order

1. Bridge PR → review → merge. Vercel deploys `main` (the bridge), which still runs on 058.
2. Apply 059 (docs/56 procedure). The bridge keeps grading and review working, and refuses objective content.
3. Run hosted acceptance with the CP2 application (local loopback server).
4. Merge CP2 onto the bridge. Vercel deploys CP2.

CP2 overlaps this branch in the domain/context/review files and in the fixtures. CP2's versions supersede the bridge's A changes, which CP2 already requires. B is ported to CP2.

## Reconciliation with CP2 (local, uncommitted)

When `main` (`79c16a2`, this bridge merged) is merged into CP2 (`6394982`, PR #73):

- **A is superseded.** CP2's domain and review schemas are used, and the three Examiner context readers return to CP2's version. Git merges those three readers silently to the bridge version because CP2 never edited them; left as merged, they would refuse every objective assessment and break CP2's types.
- **The bridge-only test and fixture are retired.** `tests/cp2-deployment-bridge-db.test.ts` tests the pre-CP2 application. `tests/fixtures/cp2-migration-059-interactive-examination-engine.sql` is byte-identical to the canonical migration (SHA-256 `2a200a89…f2f7`, also the pin in the retired test), which would otherwise be applied twice. The bridge's lasting guarantees stay covered by CP2's own suites: the provider never receives objective questions or keys, and a human mark cannot differ from the deterministic one.
- **B is kept.** The pagination is kept with CP2's exam workspace and server time. One defect not flagged by Git is fixed: CP2 found the live exam's assessment only on the current page, so an active attempt whose assessment is on another page rendered no workspace. The page-independent `activeAssessment` is now passed through, with a UI regression test (mutation-checked).

Deployment order is unchanged: migration 059 must be applied before the CP2 application is deployed.

## Local gates

Node 24.19.0, `VITEST_MAX_WORKERS=2`:

- `npm run check`: exit 0, 4,313 passed and 5 skipped (the existing checkout PostgreSQL file without a database URL).
- `npm run format:check`, `git diff --check` and `npm run build` (20/20): all exit 0.
