# CP2F — Hosted acceptance readiness for migration 059

Status: **implemented locally, uncommitted, awaiting independent review.**

> Renumbered from `docs/55` to `docs/56`: `docs/55` is used by `docs/55-certification-blueprint-academic-gate.md` on `feat/academic-certification-blueprint-v1`. The text below is unchanged from the CP2F worktree (written 2026-10-17, before migration 059 was applied); current hosted evidence is recorded separately.

- Branch `feat/cp2-interactive-exam-engine` (PR #73 head `6394982`), plus the uncommitted CP2F changes listed below.
- Companion branch `fix/cp2-deployment-bridge` (docs/54).
- **Nothing was written to any hosted system:** no hosted write, migration, account creation, Vercel change, commit or push.

Hosted interactions in this checkpoint, all read-only:

- read-only SQL in `BEGIN … READ ONLY` transactions, over certificate-verified TLS;
- three Supabase CLI `db push --dry-run --linked` runs, which execute only `SELECT 1` and a `SELECT` of the ledger (proven on a local statement log);
- one Management API `GET` per CLI run;
- one `backups list` call.

## 1. CP2 branch changes in this checkpoint

- **Learner assessment list pagination**, ported from docs/54 B into CP2's projection.
  - It keeps `get_active_assessment_exam_state` resume and `serverNow`.
  - The exam workspace now opens from the separately read `activeAssessment`. Previously CP2 could not open the workspace when the active assessment fell outside the learner's earliest 100.
- **Test infrastructure:** `tests/postgrest-select-query.ts`, the two shims moved onto it, and three composition tests updated to the new read pattern.
- **New tests:**
  - `tests/student-assessment-pagination-db.test.ts`, with CP2 resume assertions;
  - `tests/student-assessments-pagination-ui.test.ts`;
  - `tests/acceptance-exam-engine-plan.test.ts`;
  - `tests/acceptance-exam-engine-driver.test.ts`.
- **Hosted tooling** (`scripts/acceptance/`):
  - `migration-059-verify.mjs` + `migration-059-contract.json`;
  - `supabase-linked-cli.mjs`;
  - `exam-engine-plan.mjs`, `exam-engine-browser.mjs` and `exam-engine.mjs`;
  - additive changes to `examiner-provider-stub.mjs` (identifiers + `inspect` hook), `examiner-app.mjs` (passes `inspect`) and `fixtures.mjs` (`transformPackage`).
- **Strengthened test:** `tests/acceptance-examiner-app-grading-db.test.ts` now pins the provider's pre-CP2 context key set.
- **Unchanged:** migration 059, SHA-256 `2a200a89…f1f2f7`.

## 2. Migration command and ledger safety (part C)

The CLI is pinned: `supabase@2.120.0`, npm integrity `sha512-NF8ueHsOZMbyiFJARKbiZy9AhNtj5E5R49P+cVqlv2u/T2JpMtsvp29YgPgrIWkVUjsfhJseTmKEdckatSeWZQ==`. It is installed outside the repository and run by Node directly: no shell, no `npx`.

It runs in **linked** mode through `scripts/acceptance/supabase-linked-cli.mjs`.

- **Password handling:**
  - The wrapper reads the database password in-process from `ACCEPTANCE_DATABASE_URL`, in the operator's `.env.local` outside the checkout.
  - It passes the password only as `SUPABASE_DB_PASSWORD` in a minimal child environment: never an argument, file, log line or shell history.
  - Setting the password also stops the CLI creating a temporary login role through the Management API.
  - Output is scrubbed; the password appeared 0 times in output.
- **What it refuses:**
  - `--password`, `--db-url` and `--local`;
  - a missing `--linked`;
  - `db push` without `--skip-vault` (no Vault secret updates);
  - a workdir not linked to `blqaomssojfxaxskcyxd`, or one whose pooler is not that project's session pooler;
  - a CLI version other than 2.120.0.

Verified locally on a disposable PostgreSQL 17.10, with the identical push code path through `--db-url` (no password in the URL; the password via `PGPASSWORD`) and full statement logging:

- **Dry-run is read-only:** it executes only `SELECT 1` and `SELECT version FROM supabase_migrations.schema_migrations`.
- **Ledger built by the CLI:** it pushed 001–058, 58 rows, and 057's "runner must be postgres" check passed.
- **Selection:** with 059 present, the dry run lists exactly `202610160059_interactive_examination_engine.sql`.
- **Atomicity:** 059 was made to fail midway, at statement 32, after its schema, tables and triggers had been created. Nothing remained: no schema, table or trigger, and the ledger was still 58.
- **Push:** ledger 59, with the 059 statements equal to the file (54 statements). A repeated dry run reports "Remote database is up to date."
- **Linked mode itself cannot be exercised locally:** it accepts only a `*.supabase.com` pooler and calls the Management API.

Verified against hosted (read-only):

- `db push --dry-run --linked --skip-vault` through the wrapper, run three times (including the final in-repository copy), lists **exactly** `202610160059_interactive_examination_engine.sql`.
- The verifier's pre-phase afterwards shows the ledger still exactly 001–058.

## 3. Preflight, post-migration verification and recovery

`scripts/acceptance/migration-059-verify.mjs` is read-only, with certificate-verified TLS (`CP2F_CA_FILE` = Supabase Root 2021 CA, SHA-256 fingerprint `80:70:25:AD…CA:FA`). It exits 0 only when every check passes.

**Pre-phase** (15 checks on hosted, 11 locally):

- **Checkout and file hashes:** contract file hash; 59 migrations in the deploy checkout; the 059 hash.
- **Target binding:**
  - HTTPS API origin for the project;
  - the `postgres.<ref>` session-pooler user, on port 5432 and database `postgres`;
  - no insecure TLS override;
  - the CA is supplied;
  - the acceptance marker matches.
- **Database state:**
  - non-superuser `postgres`, in a read-only transaction;
  - the ledger is exactly 001–058, with statements identical to the repository;
  - no 059 object exists;
  - every object 059 wraps or depends on exists, and each wrapped function exactly once.
- **Quiescence:** no ACTIVE attempt, no AUTHORIZED/RUNNING Examiner execution in any execution table, and no transaction older than 60 seconds.
- **Snapshot:** writes a catalogue and row-count snapshot by exclusive create, only if every check passes.

**Post-phase** (24 checks) compares against the snapshot and the reviewed PostgreSQL 17 contract:

- **Ledger:** exactly 001–059, with statements identical.
- **Functions:** exactly the 32 contracted additions, none removed, exactly the 9 contracted replacements.
- **Tables and columns:** exactly 2 new tables and 10 new columns; no existing table or column changed.
- **Triggers:** exactly 6 new triggers; none changed.
- **Unchanged:** policies and default ACLs.
- **Schemas:** only `assessment_interaction_private` added.
- **New tables:** RLS on, empty, and no API-role table, column or schema privilege.
- **Privileges:**
  - the 9 public entry points are authenticated-only, SECURITY DEFINER, with an empty `search_path`;
  - `activate_course_package` privileges are unchanged;
  - no API role can execute any private 059 function.
- **CP2B fix and guard:** the key-presence trigger function is SECURITY DEFINER; the marks guard is attached and enabled.
- **Data:** no existing row count changed, and only the 2 new tables are new.

Locally the pre-phase passed 11/11 and the post-phase 24/24. A post-phase before the push FAILED, as it should. Against hosted, the pre-phase passed 15/15 twice (snapshots were rehearsal-only).

**Recovery procedure:**

- **Forward-only:**
  - no `db reset`, ledger edit or hand-patching;
  - a failed push rolls back atomically (proven above): record the masked error, re-run the pre-phase to confirm ledger 58 and no 059 objects, then stop.
- **If a post-check or the acceptance fails after a successful push:**
  - stop all mutating acceptance and do not merge CP2;
  - prepare a reviewed forward migration 060. It would drop the 3 new public RPCs and the marks guard; move the 4 originals back to `public` after dropping the wrappers; restore the 037/045 bodies of `activate_course_package`, `assert_full_package_valid`, `redact_answer_keys` and the 2 response wrappers; and keep both new tables as append-only history.
- **The bridge (docs/54)** keeps the deployed application working on either schema throughout.
- **Ledger ahead of `main`:** while 059 is applied but CP2 is unmerged, the ledger is ahead of `main`, so 059 must not change afterwards. The approval names the file hash.

## 4. Authenticated acceptance harness (part D)

`scripts/acceptance/exam-engine.mjs` is operator-run and **mutating**. It is never invoked by any other command.

**Gates.** Until every gate passes, nothing signs in, seeds or writes, and every surface is BLOCKED:

- prerequisites, including `ACCEPTANCE_WRITE_ENABLED=true`, the controller key ID and secret, all four existing identities, Chrome, and an evidence directory outside the repository;
- migration 059 present (read-only check);
- the real loopback app session, with the deterministic provider stub (no billable model call) and real sign-ins;
- the seeder's own two independent write gates (database marker and hosted RPC environment ID).

It reuses the four existing synthetic identities; **no account is created.** The pagination fix (docs/54 B) is what makes the existing learner usable.

Surfaces:

| Surface            | What it proves on hosted                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTHORING          | Admin authors all five objective types on a DRAFT through the governed RPC. An invalid key is refused. The learner, unrelated staff and anon cannot author or list. The list never carries keys                                                                                                                                                                                              |
| PROTECTION         | No API role, including admin and anon, can read either CP2 table. Nothing is released before an attempt                                                                                                                                                                                                                                                                                      |
| BROWSER_EXAM       | Real UI in Chrome: sign-in, the new assessment on page 1, start, all six types answered and saved with canonical bodies (one revision each). Another learner gets no definitions and cannot write. A refresh restores every answer. An unchanged answer cannot be re-saved. A changed answer becomes revision 2. Review-and-submit completes. No protected marker in page HTML or exam state |
| MIXED_GRADING      | One provider call carrying only the free-text question and exactly the pre-CP2 context key set. Objective marks equal the scorer, including the planned partial mark. The revision is valid. No protected marker in any raw provider request                                                                                                                                                 |
| OBJECTIVE_ONLY     | All five objective types GRADED deterministically, with 0 provider calls                                                                                                                                                                                                                                                                                                                     |
| LEGACY_FREE_TEXT   | A legacy free-text MIDTERM grades with the unchanged provider request shape                                                                                                                                                                                                                                                                                                                  |
| TIMED_EXPIRY       | A 1-minute attempt: a late save is refused, it is finalised `AUTO_TIMEOUT`, the saved answer is graded and the unsaved one zeroed                                                                                                                                                                                                                                                            |
| ACADEMIC_REVIEW    | An escalated objective+free-text attempt: the reviewer sees the locked deterministic mark (API and page), a forged objective mark is refused, and the deterministic grade records                                                                                                                                                                                                            |
| COMPATIBILITY      | Existing learner pages (assessments pages 1–2, progress, results) and admin pages (course engineering, academic review) answer 200 with no protected material. Latency is recorded                                                                                                                                                                                                           |
| AUDIT_MINIMISATION | Audit rows for every run definition carry identifiers and type only                                                                                                                                                                                                                                                                                                                          |
| WRITE_LEDGER       | Created definitions, keys and attempts match the reviewed plan exactly                                                                                                                                                                                                                                                                                                                       |

**Local verification of its components.** This is local evidence only: **none of it is authenticated hosted acceptance.**

- `tests/acceptance-exam-engine-plan.test.ts` (12 tests):
  - both synthetic packages pass the CP2 TypeScript validator **and** 059's database validator;
  - canonical bodies equal the application's;
  - the reference and SQL scorers both award exactly the planned best and partial marks for every type;
  - the protected-marker scan works;
  - the write plan matches the packages.
- `tests/acceptance-exam-engine-driver.test.ts` (6 tests): every gate blocks with no session, seeding or write.
- **Browser driver:** the same functions the hosted journey uses, run against the **real `ExamWorkspace` component in real headless Chrome**. The CP2B component harness stands in for the server actions with an in-memory store that applies the real validation and canonicalisation. Result: **27/27**, covering all six types answered and saved canonically, reload restore, a changed answer as revision 2, Save disabled when unchanged, and submit. No authentication, database or network is involved.
- **Stub identifiers:** the existing real-route grading test now pins the identifiers the stub records (`questionIds`, `contextKeys`).

**Exact hosted writes** (`plannedHostedWrites()`). All are synthetic and run-ID-tagged.

- **Per course (main and review):**
  - one each of: package import, programme version, module, lesson, objective, cohort, activation, enrolment, grading policy, lab policy, result policy, pre-publication test run, practical and learning resource;
  - 6 assessments, 6 component bindings and 5 agent configurations.
  - Main: 16 questions, with 11 objective definitions and 11 keys. Review: 7 questions, with 1 definition and 1 key.
- **Authoring check:** 1 DRAFT assessment (never published), with 6 questions, 5 definitions and 5 keys.
- **Run:**
  - 5 attempts, 16 response revisions and 5 Examiner executions;
  - 5 result revisions (including the human review grade) and 1 review case;
  - a content-minimised audit row per governed write, counted after the run.
- **Auth:** sign-ins for the 4 existing identities only (sessions, refresh tokens and Auth audit rows); **0 users created**.
- **Never created:** an offer, campaign, order, payment, Stripe object, public catalogue entry, controller key or any secret.

**Containment, not deletion.** Attempts, responses, executions, results, audit rows and both CP2 tables are append-only by design and by trigger. Containment is separately approved governed writes, after the evidence is captured:

- `change_assessment_status(CLOSED)` for the 12 published run assessments;
- the DRAFT stays DRAFT;
- `change_enrolment_status(WITHDRAWN)` for the 2 run enrolments.

The evidence file (outside the repository) lists every created identifier.

## 5. Backup and credential readiness (part E)

- **Managed backups:** `supabase backups list` (Management API `GET`, read-only) shows 7 daily physical backups with status COMPLETED, the latest 2026-10-16 01:33 UTC, WAL-G enabled, **PITR disabled**.
- **Restoration is not proven and cannot be proven without a hosted write.** Restoring a daily backup is an in-place, project-wide overwrite from the dashboard, and without PITR there is no point-in-time choice. A listed backup is not restore evidence (docs/38 §9 remains BLOCKED).
- **Operator steps:**
  1. Confirm a COMPLETED daily backup dated after the final pre-phase and before the push, or enable PITR.
  2. Confirm, on the plan, whether "restore to a new project" is available. That is the only non-destructive managed restore drill.
  3. Alternatively, produce a protected logical export with PostgreSQL 17 client tools:
     - `pg_dump --schema-only` plus data for the Ducelio schemas, **excluding the data of `academic_execution_private.controller_keys` and `commercial_v1_commerce_private.controller_keys`**;
     - encrypt it at rest, outside the repository;
     - restore it into an isolated local cluster with the Supabase roles pre-created, and verify critical record counts.
  - **This machine has neither Docker nor `pg_dump`/`pg_restore`,** so the logical-export drill could not be performed here.
- **Examiner signing key** (reference only; no secret was read or requested). Two academic controller keys are active on hosted:
  - one installed 2026-09-27;
  - one installed 2026-10-13.

  Their identifiers are kept in the operator's records, not in the repository.

  The operator sets `ACADEMIC_EXECUTION_KEY_ID` to the one whose 32-byte secret they hold, and supplies `ACADEMIC_EXECUTION_HMAC_KEY_HEX` in the process environment only. The harness verifies the ID is active before any write.

## 6. Ordered staging execution procedure

Hosted writes need approval at four gates (**A1–A4**).

1. **Review and merge the bridge** (docs/54). Vercel deploys `main`, which is compatible with 058 and 059. Smoke test it read-only.
2. **Prepare a fresh detached deploy worktree** at the approved CP2 SHA:
   - `npm ci`;
   - confirm the 059 hash and 59 files;
   - copy only `supabase/.temp` (the link) from the operator checkout.
3. **Run the read-only pre-phase:** `migration-059-verify.mjs --phase=pre` must report 15/15 and write the snapshot.
4. **Confirm a backup** (§5). Announce the staging window.
5. **Run the linked dry run** through the wrapper. It must list exactly 059.
6. **A1 — apply 059:** `supabase-linked-cli.mjs … -- db push --linked --skip-vault --yes`.
7. **Run the post-phase:** 24/24 required, otherwise STOP and follow §3 recovery.
8. **Smoke test the staging bridge** read-only: a review case opens and free-text grading paths are unchanged.
9. **A2 — run the hosted acceptance:** `node --env-file=… scripts/acceptance/exam-engine.mjs --chrome=… --evidence=…`. It takes about 30 minutes because the windows are sequential. Every surface must PASS.
10. **Independent review of the evidence**, then rebase CP2 onto the merged bridge, then CI, then the owner merges. Vercel deploys CP2.

    Rebase resolution, which must be explicit:
    - **Take CP2's version** of the A files: `src/domain/commercial-v1-examiner-grading.ts`, `src/domain/commercial-v1-academic-review.ts`, and **also** the three `src/server/commercial-v1-examiner-{grading,recovery,regrade}/context.ts`. These change only on the bridge, so git would auto-take the bridge's versions, but CP2 requires the 059 keys. Typecheck would fail on the missing bridge exports.
    - **Drop** `tests/cp2-deployment-bridge-db.test.ts` and its 059 fixture copy, which are bridge-only: CP2 carries the real migration.
    - **Keep CP2's version** of the pagination files (B is identical in intent, plus CP2's exam-state resume).
    - **Union the fixture options,** except the bridge's `migration059` / `extraMigrationFiles` use, because CP2's chain already contains 059 and applying it twice would fail.

11. **A3 — staging sign-in smoke** on the deployed CP2.
12. **A4 — containment** (§4).
13. **Docs PR** with the evidence.

**Remaining external prerequisites:**

- the controller key secret;
- an approved backup / restore-drill decision;
- review and merge of the bridge;
- the four approvals.

## 7. Final local gates (Node 24.19.0, Windows, `VITEST_MAX_WORKERS=2`)

| Gate                                     | CP2 worktree                                                                                                                    | Bridge worktree                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `npm run check` (lint, typecheck, tests) | exit 0; 4,383 passed, 14 skipped (the two real-PostgreSQL concurrency files, which need `DUCELIO_TEST_POSTGRES_URL`), 186 files | exit 0; 4,313 passed, 5 skipped (the existing checkout PostgreSQL file), 180 files |
| `npm run format:check`                   | exit 0                                                                                                                          | exit 0                                                                             |
| `git diff --check` (including new files) | exit 0                                                                                                                          | exit 0                                                                             |
| `npm run build`                          | exit 0 (20/20 pages)                                                                                                            | exit 0 (20/20 pages)                                                               |

**Gate history:**

- An earlier CP2 run failed 5 tests, and the CP2 run before that failed typecheck. All were fixed and both runs are superseded by the clean run above.
- Typecheck: implicit `any` from `.mjs` imports in two new tests, and a temporary component-harness copy under the ignored `work/` directory. The harness copy has been moved out of the repository.
- 3 failures: provider-stub record contracts broken by the then default-on identifier fields. They were made opt-in, and the existing records are unchanged.
- 4 failures: 30-second timeouts in unrelated database suites during a run the host's memory pressure slowed to 65 minutes. All 7 affected files then passed (280/280) on their own.

**Not re-run in this checkpoint:** the two real-PostgreSQL concurrency suites. The local disposable cluster was stopped by the host for memory and was not restarted. They last passed 14/14 on PostgreSQL 17.10 (CP2E) and in CI on `6394982`. The CP2F changes touch no SQL. CI's `postgres-concurrency` job re-runs them on the next push.

## 8. Post-migration evidence (2026-10-19, read-only)

This tooling now sits on the reconciled PR #73 head `5dd0358`, in a separate local worktree. Run from there, the harness starts **that** code: `REPO_ROOT` is the script's own checkout.

**Migration 059 is applied on `ducelio-acceptance`.** `migration-059-verify.mjs --phase=post`, run against the last pre-059 snapshot (2026-10-17T21:26:58Z), passed **26/28**:

- Ledger exactly 001–059, with statements identical to the repository.
- Exactly the contracted 32 functions added, 9 replaced, 2 tables, 10 columns and 6 triggers.
- Nothing removed, and no policy, schema or default-ACL drift.
- Privileges are correct, and the mark guard is enabled.

The 2 FAILs are explained by acceptance data written after the migration, not by drift:

- **New tables not empty:** 62 objective definitions and 62 keys across 18 assessments. RLS is on, and no API role has any access.
- **Row counts changed:** in exactly the tables the A2 write plan uses. No commerce, order, payment or campaign table changed.

**When 059 was applied:** between 2026-10-17T21:26:58Z (absent in the A1 snapshot) and 2026-10-17T23:08:35Z (first 059 audit row). The ledger has no `created_by` column, so no actor is recorded.

**Earlier A2 runs:** temporary patch notes record several hosted runs on 2026-10-17/18, the last completing 10/11 surfaces. MIXED_GRADING failed on a harness leak-scanner false positive; the A2T scanner correction is part of this tooling.

**Containment (A4) was never done:** 42 synthetic run assessments are still PUBLISHED (plus 3 DRAFT), and 7 activations remain ACTIVATED.

## 9. Re-run plan at `5dd0358` (each write needs its own approval)

1. **Fresh read-only check:** post-phase verification plus quiescence. No active attempts, no live Examiner executions, no transaction older than 60 seconds.
2. **A4-prior (approval):** contain the earlier runs with the governed status writes in §4, after confirming their identifiers from the run evidence files.
3. **A2 (approval):** from this worktree, `node --env-file=<acceptance .env.local> scripts/acceptance/exam-engine.mjs --chrome=<chrome.exe> --evidence=<dir outside the repo>`, with `ACCEPTANCE_WRITE_ENABLED=true` set for that one run only. All 11 surfaces must PASS.
4. **A4 (approval):** contain this run.
5. **Evidence:** an independent review of the evidence, then the PR #73 merge decision.
