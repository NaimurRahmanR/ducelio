# 58. Academy course activation recovery (ACADEMY-RECOVERY-1)

Operational recovery of `/admin/academy-course-engineering` on the staging deployment, which showed "The Academy service is unavailable. Nothing was changed." This is a recovery checkpoint, not a feature checkpoint.

## 1. Established deployment state (2026-10-22)

- **Running deployment.** Vercel project `ducelio-staging`, Production target, deployed from `6704f08` (GitHub deployment record `7255750415`, status success). That is `main` HEAD (merge of PR #82). The public alias `https://ducelio-staging.vercel.app` serves it.
- **Database actually used.** The Supabase URL is server-only (never inlined into client JavaScript), so it was proven behaviourally. The acceptance administrator signed in through the staging site at 17:10:40.5Z, and a new `auth.sessions` row for that same user appeared in `ducelio-acceptance` (`blqaomssojfxaxskcyxd`) at 17:10:42.7Z. Auth users exist per project, so `ducelio-staging` uses `ducelio-acceptance`.
- **Database state before recovery.** PostgreSQL 17.6. The migration ledger held 59 versions (001–059). There were no `academy_*` tables, and the only Academy-named function was the pre-existing `provision_academy_user`.

## 2. Root cause

PR #82 merged migrations 060–065 and the Academy application code, and Vercel deployed the code. The migrations were never applied to the database that deployment uses.

The exact backend error, captured through PostgREST as the acceptance administrator:

| RPC                             | PostgREST code | Message                                                                                                       |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_academy_course_packages`  | `PGRST202`     | Could not find the function public.list_academy_course_packages without parameters in the schema cache        |
| `upload_academy_course_package` | `PGRST202`     | Could not find the function public.upload_academy_course_package(p_raw_package, p_reason) in the schema cache |

`academyErrorCode()` maps every database message that is not a reviewed Academy refusal code to `SERVICE_UNAVAILABLE`. As a result, a missing migration was indistinguishable from a transient outage.

## 3. Migration review and deployment (acceptance only)

- **CI evidence.** `main` CI was green on `6704f08`: 4,846 tests passed, and the 7 required real-PostgreSQL suites passed 39/39, including the four Academy suites and execution reliability. PR #82 merged with no recorded review.
- **Static review.** Pre-existing objects touched:
  - The firewall functions `current_academic_activity_state` and `academic_content_release_explain_allowed` keep their previous conditions and add an Academy branch, which only tightens them.
  - Two Tutor/Lab trigger functions and `record_tutor_lab_provenance` are redefined.
  - Triggers are added on `assessment_attempts` and the Professor provenance and release tables.
  - `tutor_lab_content_releases` gains a nullable `academy_request_id`, and its Lab practical binding CHECK is replaced by a two-source CHECK that preserves the cohort-row condition.
  - No earlier migration is altered, and there is no destructive DDL.
- **Rehearsal on the real hosted data.** All six files were applied inside one transaction on `ducelio-acceptance` and then rolled back, through the acceptance write gate (`ACCEPTANCE_WRITE_ENABLED` plus the environment marker):
  - every migration applied, in 64–312 ms each;
  - 34 `academy_*` tables, all with RLS on and no direct anon/authenticated privileges (RPC-only);
  - `academy_private` and `execution_reliability_private` unusable by client roles;
  - all 53 Academy RPCs that the application calls are present, executable by `authenticated`, `SECURITY DEFINER` with a pinned `search_path`, and not executable by `service_role`;
  - `anon` can execute only `list_academy_catalogue` and the two HMAC-attested commerce entry points (`fulfill_academy_order`, `apply_academy_commerce_operation`), the same design as `fulfill_commercial_v1_order`;
  - after the rollback, the ledger was 59 with 0 Academy tables.
- **Deployment.** Pinned Supabase CLI 2.120.0, run through `scripts/acceptance/supabase-linked-cli.mjs`, which refuses any project other than `blqaomssojfxaxskcyxd`:
  - `db push --linked --skip-vault --dry-run` listed exactly 060–065;
  - `db push --linked --skip-vault --yes` ran 2026-10-22 17:27:11–15Z and exited 0;
  - no production project was touched.
- **Post-deployment checks.**
  - `npm run acceptance:academy-readiness`: 11/11 PASS.
  - `npm run acceptance:hosted`: `MIGRATIONS` PASS (the hosted ledger exactly matches all 65 repository versions), `RLS_ACL` PASS and `HOSTED_DATABASE` PASS. The other surfaces were BLOCKED by design: no write opt-in, Stripe or provider keys locally.
  - PostgREST role probes: `anon` gets `42501` on admin and learner RPCs; the learner and unrelated staff get `FORBIDDEN` on admin RPCs; the administrator succeeds.
  - The staging page now loads the package register and the practical-evaluation queue, verified in headless Chrome as the acceptance administrator.

## 4. Code changes (one focused PR)

- **`NOT_INSTALLED` (administrator path only).**
  - `adminRpc` in `src/server/academy-course-engineering.ts` classifies `PGRST202`, `PGRST205`, `42883`, `42P01` and `3F000` as a missing database dependency.
  - The administrator sees: "The Academy database components are not installed in this environment, so nothing was changed. A platform operator must apply the pending Academy database migrations…"
  - The server log records only `{rpc, errorCode}`, never the message, arguments or connection details.
  - Learner paths (`src/server/academy-delivery.ts`) are unchanged and keep the generic message, so no deployment detail reaches learners.
- **Register banner.** The package-register banner on the admin page uses that message when the cause is `NOT_INSTALLED`. The shared `Unavailable` component gains an optional `message`.
- **Readiness guard.** `scripts/acceptance/academy-readiness.mjs` with `academy-readiness-contract.json`, run as `npm run acceptance:academy-readiness`.
  - It is a read-only check (`BEGIN TRANSACTION READ ONLY`, rolled back) from the operator credential.
  - It checks: the six Academy migration versions in the ledger; the 56 contract RPCs present, executable by `authenticated`, not by `anon` outside the reviewed allow-list, not by `service_role` (except the recorded pre-057 baseline function), and with a pinned `search_path`; Academy tables with RLS and no client table privileges; and the private schemas present but not client-usable.
  - It is operator tooling: never imported by `src/**`, and it prints only object names and PASS/FAIL.
- **Contract tests.** `tests/academy-readiness-contract.test.ts` keeps the contract in step with the code. Every Academy-migration function that `src/**` references must be listed. Every listed RPC must be created by a migration and used by the app. The anon allow-list must equal the Academy migrations' anon grants.
  - A mutation check (removing `upload_academy_course_package` from the contract) fails the suite.
  - The evaluator fails the exact database state observed on 2026-10-22.

## 5. Course import and learner activation

See the checkpoint record in `implementation-progress.md` for the state of steps 4–5 (AWS SAA-C03 upload, validation, REVIEW_ONLY publication and learner activation).

## 6. Continuation (2026-10-22, 18:00Z): AWS package and V2 pilot

- **File A** (`Downloads\Ducelio_AWS_SAA_C03_Academy_Commercial_Draft_v1.json`) is **not present**. Searches covered:
  - the exact path, and the whole `C:` drive for `*Commercial_Draft*`;
  - every JSON and zip of 100 KB–2 MB modified in the last 30 days under the user profile, by content (`ACADEMY_COURSE_PACKAGE_V1` / `SAA-C03`);
  - Google Drive, by title and by content.
    The only Academy package found is the repository's Security+ package, which is a different course and was not used. Nothing was uploaded.
- **File B** (`Ducelio_AWS_SAA_C03_V2_Question_Pilot.json`): 15,206 bytes, SHA-256 `802520286a8dc5eab73149d2d5f09c91139c9068fb15716fc294b66b0240ba2c`. It contains 8 `SINGLE_SELECT` items, two per official SAA-C03 domain, mapped to task statements 1.2, 1.3, 2.1, 2.2, 3.1, 3.3, 4.1 and 4.2. The file declares "Not an uploadable Academy package".
  - **Technical correctness.** Each keyed answer is correct. The cited AWS documentation was fetched and confirms the decisive claims of SEC-01 (KMS cross-account access needs both the key policy and IAM), SEC-02 (gateway endpoint routes exist only in associated route tables), RES-01 (a Multi-AZ DB instance standby is not readable, unlike a Multi-AZ DB cluster reader) and COST-02 (objects under 128 KB are not monitored or auto-tiered). RES-02, PERF-01, PERF-02 and COST-01 were reviewed against established AWS behaviour, not re-fetched.
  - **Remaining quality issues.** Several distractors still use the absolutes the audit criticised (RES-02 A, COST-01 C, COST-02 B and D). All eight are single-select, so none exercises the official "two or more correct" multiple-response format.
  - **Schema compatibility.** It is not drop-in compatible:
    - options are a letter-keyed object, not `[{id, label}]`;
    - ids are uppercase and fail `^[a-z0-9][a-z0-9_-]{0,39}$`;
    - the key is `correct: ["B"]`, not `{correctOptionId}`;
    - `reasoning`, `distractorExplanations`, `officialSources`, `domain`, `task` and `difficultyTarget` are not strict-schema fields;
    - no item names the V1 question it replaces (only a `lessonRef`).
  - **Recommendation.** Treat the pilot as a revision reference only. A future package revision would need a mechanical conversion (lowercase ids, `correctOptionId`, rationale into marking guidance) and an explicit V1-item replacement map, followed by SME review. Nothing was inserted into V1.
- **AI runtime on staging.** The Operations Engineer page on `ducelio-staging` reports "AI interpretation not configured", so the Anthropic-backed profiles (Operations Engineer, Lab Instructor) have no provider there. The OpenAI-backed Professor and Tutor have no non-secret indicator, so they cannot be confirmed until a real classroom run.
