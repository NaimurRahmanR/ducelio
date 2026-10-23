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

## 7. Continuation (2026-10-22, 23:15Z): upload readiness and the V2 course

The owner asked for two independent results: a genuinely improved V2 package, and a staging interface the owner can use to upload and activate it. The AWS course itself was **not** uploaded, published or sold.

- **Hosted readiness test on `ducelio-staging` (`6704f08`), as the acceptance administrator in headless Chrome.** The test used disposable synthetic packages with the `acceptance-` key prefix (recognised as test records):
  - the uploader is reachable;
  - a non-JSON file is refused ("not valid UTF-8 JSON. Nothing was uploaded.");
  - an invalid package is rejected with both path-addressed issues;
  - a valid package is validated with 0 warnings, and its review renders modules, formats, assessments, grading and pending decisions;
  - the valid synthetic package was then **rejected** through the real reject action, so it can never be published;
  - learner and unrelated-staff accounts are redirected with `error=forbidden`;
  - hosted records left: two `acceptance-academy-upload-check-20261022a*` package revisions, both REJECTED. No curriculum, offer or catalogue entry was created.
- **Defect found and fixed in this branch.** A file of 1,048,200 bytes (under the application's 1 MiB limit) and a 1.2 MB file both failed silently: no message, and React error #441 in the console.
  - Probing with non-JSON files, which create no database rows, showed that the framework's default 1 MB Server Action limit counts multipart overhead. A 1,040,000-byte file reaches the application; 1,048,200 bytes does not.
  - Fix: the shared `MAX_ACADEMY_UPLOAD_BYTES` and `academyUploadSizeError` live in `src/domain/academy-delivery.ts`; the upload form refuses an oversized file before sending, with the same message; `next.config.ts` sets `serverActions.bodySizeLimit` to `1200kb` (1 MiB plus multipart headroom, following the Next.js 16 documentation).
  - The product limit is unchanged at 1 MiB. Regression tests cover the boundary, the config headroom (mutation-checked) and the shared check.
  - The fix is **not deployed**; it reaches staging when this PR is merged.
- **V2 package.** Built and verified outside the repository; it contains protected answer keys and is not committed. The repository records only these facts:
  - `Ducelio_AWS_SAA_C03_Academy_Commercial_V2.json`: 918,263 bytes, SHA-256 `a3efaacd…b670d8`, package revision 2.
  - It passes the real TypeScript validator (all four formats feasible).
  - On a local PGlite database with all 65 migrations, it passed the full admin pipeline to REVIEW_ONLY, with public sale refused (`POLICY_PENDING`, 8 decisions), no answer keys in the learner attempt payload, and correct database scoring.
  - Its size is below the framework's existing limit, so the owner can upload it today, before this fix is deployed.

## 8. Continuation (2026-10-23): course lifecycle by delivery model, and the browser icon

The owner uploaded and published the AWS SAA-C03 V2 package for individual learning: package `ef6b8a49-849f-4488-84e6-0ebcaa2644f8`, course `eaa1f7ba-…`, offer `aws-solutions-architect-associate` in REVIEW_ONLY, with four GBP formats and 8 pending decisions. `/admin/courses` then wrongly showed "Activate delivery — create cohort" with "Publish offer" and "Public catalogue" blocked.

- **Root cause.** The admin course lifecycle (`src/domain/admin-course-lifecycle.ts`) was built only from the cohort-delivery records: `course_package_imports` grouped by package key, commercial activations and offers, and the cohort workspace. The individual-learning relationship (Academy package → curriculum import) was never read, so a published curriculum without an activation always got cohort advice.
- **Design: lifecycle by delivery model, never by owner.**
  - Two independent dimensions. The delivery model is **Individual learning**, **Cohort delivery** or **Both delivery models**, plus **No delivery model yet** and **Delivery model unconfirmed**. Ownership (Ducelio-owned or organisation-owned) is a separate concept; see §9.
  - The delivery model comes only from recorded relationships:
    - individual learning when an Academy package is attached to one of the course's curriculum imports, by `academy_courses.curriculum_import_id` (recorded at publication) or by the same key, revision and embedded curriculum (before publication);
    - cohort delivery when an activation, a cohort offer or a non-demo cohort exists.
  - Nothing is inferred from titles, package keys, owners or publishers. Tests use keys such as `aws-…`, `acme-corporation-…` and `partner-org-…` to prove it.
  - **Never a silent cohort default.** With complete evidence and neither model recorded, the course has _no delivery model yet_ and the next step is "Choose a delivery model", offering both. If any evidence read fails (individual-learning, activations, offers or cohorts), the model is _unconfirmed_, the reason is shown, and no cohort is suggested. A recorded model is kept even when the other side could not be read, with a note.
  - A shared curriculum shows both lifecycles; neither gates the other.
- **Individual-learning lifecycle.**
  - The eight stages are: upload, validate, review, prepare curriculum, publish course and offer, learner access (individual schedules, no cohort or instructor), approval gates (pending decisions) and public sale and catalogue.
  - Publication and sale are separate. The sale stage is complete only for `PUBLIC_SALE` confirmed in the public Academy catalogue. REVIEW_ONLY reads "Published for review only — not on public sale".
  - Every action links to `/admin/academy-course-engineering?packageId=<recorded package id>`.
- **Classification beyond 100 courses.**
  - `list_academy_course_packages` returns only the 100 newest packages, so a course whose package fell outside that window would have lost its classification.
  - Migration `202610270066_admin_course_delivery_evidence.sql` adds the admin-only `get_academy_delivery_evidence(p_import_ids uuid[])`. It resolves exactly the register's curriculum imports in one set-based query over the unique (key, revision) indexes and the unique `curriculum_import_id`, with no listing window. It also returns the offer currency, the priced formats and the number of Academy packages not yet attached to a curriculum.
  - The server sends the register in batches of 500, so 1,200 courses take 3 queries, not one per course. Any failed batch fails the whole read, so partial evidence is never presented as complete. Each call accepts at most 1,000 ids; that bounds request size without omitting any course.
  - **Deployment order.** On a database without 066, the server falls back to `list_academy_course_packages`. Its links are positive evidence, but it counts as complete only when it returns fewer than 100 rows. A course absent from a full window is _unconfirmed_, never "not individual".
  - 066 was confirmed unapplied before it was edited: the acceptance ledger ends at `202610260065` and the live function had no `formats`. It was then rewritten and renamed from `…_academy_admin_offer_terms.sql`; the earlier draft's change to `list_academy_course_packages` was dropped.
  - Status: **not applied to any hosted project.**
- **Surfaces.**
  - `/admin/courses` shows delivery-model labels, Individual learning / Cohort delivery / No delivery model yet filters and counts, "review only", the Academy Course Engineering link and the count of unattached packages.
  - `/admin/courses/[packageKey]` shows the individual-learning lifecycle, delivery model and ownership, the individual-learning delivery panel, a delivery-model choice for undecided courses, and the offer with formats, prices, sale mode and decisions. Cohort panels and the B2B sales link appear only for cohort delivery.
  - The dashboard shows "Individual learning: <stage>", and live counts include only courses on public sale.
  - The Operations Engineer `inspect_course` shows the individual-learning track, offer and link, with no cohort note.
  - The cohort-delivery lifecycle and its guidance are unchanged when cohort delivery is recorded.
- **Browser icon.**
  - The purple brand leaf (the `.brand-mark` shape) with the champagne-gold italic Georgia "D", using `--launch-purple`, `--launch-purple-deep` and `--launch-champagne`.
  - It is served through the App Router file conventions in `src/app`: `favicon.ico` (16/32/48 PNG frames), `icon.svg`, `icon1-3.png` (16/32/48) and `apple-icon.png` (180, opaque), generated by `scripts/brand/render-favicons.mjs`.
- **Verification.**
  - Local gates: `npm run check` (lint, typecheck, 217 test files, 4,926 tests passed, 39 skipped), `npm run format:check`, and `npm run build` run as in CI (without the local Supabase variables; with them, the existing HTTPS `APP_URL` rule stops a production build at `http://localhost`).
  - Real PostgreSQL (PGlite, all 66 migrations):
    - published and unpublished links;
    - admin-only access, with learner, instructor, registrar and anonymous refused;
    - batch bound 1,000;
    - 150 linked packages: the old list returns 100, the evidence read returns all 150;
    - 1,200 packages in 3 batches: all linked, 50 ms;
    - the unattached-package count excludes rejected packages;
    - the end-to-end review-only course is individual learning with no cohort link.
  - **Local branch app (`next dev`) against the hosted acceptance Supabase. This is not hosted acceptance of the new code.** Because 066 is not applied, it exercised the fallback path: the server log shows `PGRST202` for `get_academy_delivery_evidence`. Checked in Chrome:
    - 29 of 29 checks pass;
    - the AWS course is "Individual learning", review only, with "Published for review only — not on public sale. 8 pending decisions must be resolved first.", no cohort step, never "Live", and its record link;
    - the detail page shows the individual-learning lifecycle, "Individual learning · Ducelio-owned", all 8 decisions and "The offer's format prices could not be read." (the prices need 066);
    - Security+ is still cohort delivery, all eight stages complete, "Live in the catalogue";
    - counts: All 2, Individual learning 1, Cohort delivery 1, No delivery model yet 0, Live 1;
    - across all 48 courses (2 business, 46 acceptance-test): 1 individual learning, 46 cohort delivery, 1 no delivery model yet, and 0 courses given cohort advice without a recorded cohort model;
    - the Operations Engineer gives the individual-learning track and link, with no cohort note;
    - the review-only slug is absent from the public catalogue and `/academy/<slug>` is not found;
    - the learner is refused at `/admin/courses`;
    - the favicon is served with correct content types on public, academy, learner and admin pages, and earlier screen captures show it in real Chrome tabs.
- **Not done (boundaries).** No AWS re-upload, cohort, price change, entitlement, sale enablement or decision change; no production change; migration 066 not applied anywhere.

## 9. Organisation ownership: capability assessment (2026-10-23)

Ducelio must let external organisations upload their own courses and use its teaching, scheduling, examination, progress and delivery operations. Today's schema and authorities were inspected for this. **Result: organisation ownership does not exist. It is a core product gap that needs its own implementation checkpoint, not an optional extra.** The delivery-model correction in §8 is owner-independent and is ready for it, but no multi-organisation support is claimed.

Evidence:

- **No organisation or tenant entity.** Across all 66 migrations there is no organisation, tenant, partner or client table, and no `organisation_id`, `tenant_id` or `owner_id` column. The only occurrence of "organisation" is a comment in migration 060 that refers to the cohort workflow.
- **Roles are global.**
  - `platform_role` is `STUDENT, INSTRUCTOR, COUNSELLOR, ACADEMIC_ADMIN, REGISTRAR, PLATFORM_ADMIN` (migration 001, line 2).
  - `role_grants(user_id, role)` has no scope (001, line 12), and `has_role()` is platform-wide (003, line 5).
- **Courses have no owner.**
  - `programmes` (001, line 29), `course_package_imports` (024, line 30), `academy_course_packages` (060, line 77), `academy_offers` (060, line 128) and `cohorts` (001, line 78) record no owning organisation.
  - Package tables record only `created_by`.
- **Ingestion and delivery authority is Ducelio-only.**
  - `list_course_packages` and the import pipeline require `ACADEMIC_ADMIN` or `PLATFORM_ADMIN` (024, line 1372).
  - Every Academy RPC calls `academy_private.require_course_admin()` (060, line 45).
  - Complimentary access (`grant_academy_entitlement`, 060, line 790) is a course-admin action.
  - Purchases go through the public Ducelio catalogue only.
- **Isolation is learner-level, not organisation-level.**
  - Academy tables revoke all client privileges (060, lines 354–355). Learner RPCs enforce the learner's own enrolments, and staff scoping is per class session (`class_sessions.instructor_id`, migration 009) or per assigned learner (counsellors).
  - Any course administrator sees every course and learner.

| Capability for an external organisation                                    | Status                                                                             | Evidence                                                                                                                                                        |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own or manage a course                                                     | **MISSING**                                                                        | No ownership entity or column; only global course administrators manage courses                                                                                 |
| Upload and update its content                                              | **MISSING** for organisations (implemented for Ducelio course administrators only) | Import and upload RPCs require the global `ACADEMIC_ADMIN`/`PLATFORM_ADMIN` roles                                                                               |
| Choose individual learning without a cohort                                | **PARTIAL**                                                                        | The cohort-free individual-learning model exists (Academy tables, learner-chosen schedules), but only Ducelio administrators can choose it                      |
| Configure permitted academic operations                                    | **PARTIAL**                                                                        | Per-course agent configuration, grading, formats and pending decisions exist per package; set by Ducelio administrators only, with no organisation policy layer |
| Offer the course to its own learners                                       | **MISSING**                                                                        | No organisation learner population or organisation-restricted offer; access is through Ducelio's public catalogue or an admin grant                             |
| Keep its course records and learner data isolated from other organisations | **MISSING**                                                                        | No tenant boundary in tables, RLS or RPCs. Learner-to-learner isolation is implemented                                                                          |

**Consequences.**

- Every external course must be onboarded and operated by Ducelio staff.
- Granting an organisation's staff member `ACADEMIC_ADMIN` would expose every course and every learner's records platform-wide. That must not be done as a workaround.
- Scenario 2 (external organisation-owned individual course) and scenario 9 (several organisations without leakage) cannot pass today and are **not claimed**.

**Required checkpoint (not started).**

- An organisations entity with organisation-scoped memberships and roles.
- Owning-organisation columns on programmes, packages, offers and cohorts, with immutable history.
- Organisation-scoped ingestion, review and publication authorities.
- Organisation-scoped learner populations, entitlements and offers.
- RLS and RPC scoping with cross-organisation denial tests.
- Audit, and organisation-aware admin surfaces.
- §8's delivery-model classification needs no change for this: it never reads the owner.

**Other remaining gaps.**

- `list_course_packages` (migration 024) returns at most 200 curriculum revisions, so in a very large register older courses are missing from `/admin/courses`. They are never misclassified, but they are not listed.
- The admin pages build every listed course's lifecycle per request. That is fine for hundreds of courses; thousands need server-side paging and filtering.
- The Academy Course Engineering register still lists the 100 newest packages.
