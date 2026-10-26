# 60 · Operations Engineer and course-review recovery

Branch `fix/restore-operations-engineer-course-workflow`, from `main` at `583f558` (PR #84 merge). PR #85 was read for context only; none of its code is used. No migration, merge, deployment or production change.

## Defects found and fixed

| #   | Defect (verified)                                                                                                                                                                                                                                                                                                                                                               | Fix                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `c4dd5a0` (PR #84) removed the Operations Engineer. `/admin/operations-engineer` redirected to Course Engineering, all three actions returned "retired", and the navigation entry was deleted. The topbar "Ask Operations Engineer" link was kept, so it landed on the redirect. The surviving action catalogue still targeted retired commercial-v1, campaign and cohort RPCs. | Restored as its own workspace, with its page, actions and navigation entry. The catalogue is rebuilt on the unified engine, and no retired path is used.                                                                                                                                                                                                                                           |
| D2  | Course upload **stored first, then validated**. An invalid file became a REJECTED record that permanently held its key and revision, so the corrected file failed with `REVISION_CONFLICT`.                                                                                                                                                                                     | Upload is validated before anything is written, with specific findings. A conflict is explained using the revisions that actually exist and the next free number. An identical re-upload creates nothing.                                                                                                                                                                                          |
| D3  | Publishing created an agent-configuration revision N+1 **before** the publication gate. A refused publication (always `POLICY_PENDING` for AWS) left that revision behind, and later attempts collided with it.                                                                                                                                                                 | The recorded publication gate is checked before any write.                                                                                                                                                                                                                                                                                                                                         |
| D4  | "Curriculum pipeline: not started" was shown for a validated revision. The curriculum is imported inside `publish_unified_course` by design.                                                                                                                                                                                                                                    | Lifecycle stages are derived from recorded state: Uploaded, Structurally validated · awaiting academic review, Approved for publication, Publication checks incomplete, Published and Failed validation.                                                                                                                                                                                           |
| D5  | Every "Academic review" link opened cohort-era learner-result grading, and no route existed for course packages.                                                                                                                                                                                                                                                                | A dedicated **Course academic review** workspace at `/admin/course-engineering/review`. The grading page is relabelled **Learner result review**, stays functional and links across.                                                                                                                                                                                                               |
| D6  | Resolving a decision meant posting back the whole pretty-printed package (984,167 bytes for AWS, near the 1 MiB limit), protected assessments included.                                                                                                                                                                                                                         | Decision-only resolution: the server derives revision N+1 from the stored revision with only the selected decisions removed. It uses the same `revise_unified_course_package` path: organisation REVIEW authority, per-decision evidence (10–300 characters) and rationale (20–1000 characters), immutable history. The JSON editor is now content-only, and forged resolution fields are ignored. |

## Operations Engineer (unified)

The same governed plane as before: interpret, then authoritative read with the administrator's session, then proposal (state fingerprint, nonce, TTL), then explicit confirmation, then re-check of authority, input and fingerprint, then execution through the existing service under that administrator, then a verification re-read and a receipt. Lost replies are decided from the records, and an unreadable outcome is reported as UNCERTAIN.

- **Reads:**
  - courses and lifecycle stages;
  - inspecting one revision (pending and resolved decisions, gate explanation, links to its review);
  - discount codes;
  - **orders and sales statistics.** These report order totals, payment-confirmed orders, discounts and recorded refunds, per currency. **Recognised revenue is reported as "Not reported"**, because there is no settled-revenue ledger and no captured or refund amounts. Learner identifiers are omitted.
  - AI runtime health (platform course administrators only).
- **Changes, each confirmed by the administrator:**
  - upload a course package (the attached file is hashed into the proposal, so a different file at confirmation is refused);
  - publish a course (blocked while decisions are pending; warns when card checkout is unconfigured);
  - create a percentage or fixed-amount coupon;
  - activate or deactivate a coupon.
- **AI:** uses the reviewed `OPERATIONS_ENGINEER` profile. It never sees files, cannot approve academic decisions and is told so. Without a provider key the page says "AI interpretation not configured" and every operation remains available as a typed control.
- **Organisation scope:** access follows Course Engineering (platform course administrators or organisation members). Choice lists come only from the administrator's own reads, and the database enforces scope on every RPC.
- **Duplicate protection:**
  - **database level:** upload, publish and create coupon;
  - **partial:** coupon availability, because coupons record no availability revision. Replaying it can only re-apply the administrator's own confirmed, reversible availability, so it is enabled with a **5-minute** proposal window instead of 15 minutes.

## AWS SAA-C03 (acceptance, read only)

Revision 3 (`3c9cd70d…`) is VALIDATED, owned by the Ducelio organisation, with 8 pending decisions and no curriculum import. Revision 2 is published through the legacy path. The stored package is valid with 0 warnings:

- 5 modules, 22 lessons, 20 ungraded labs;
- quizzes 1–4: 15 items in 30 minutes, 2 attempts each;
- midterm: 40 items in 80 minutes;
- final: 65 items in 130 minutes, 1 attempt;
- single- and multiple-select items only;
- weights: final 55%, midterm 25%, quizzes 5% each;
- 70% compensatory course pass mark.

No software defect blocks its review. No structural correction was needed. **No decision was resolved.**

| Decision                       | Kind                           | Evidence needed to resolve it                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OFFICIAL_SOURCE_RECONCILIATION | Independent academic evidence  | An AWS subject-matter expert's review record confirming every teaching claim and flagged item against current AWS documentation, with corrections first made as a content revision                                                      |
| EXAM_ITEM_INDEPENDENT_REVIEW   | Examination review             | An independent item review (answer keys, distractors, ambiguity, difficulty, domain mapping), with REVIEW FLAG items resolved                                                                                                           |
| ACADEMIC_PASS_POLICY_APPROVAL  | Academic policy approval       | An approved pass mark, weights and retry policy. Adopting the recommended FINAL component pass mark would be a content revision first.                                                                                                  |
| DELIVERY_FORMAT_FEASIBILITY    | Technical confirmation         | Database previews with real start dates, weekdays and timezones. Locally, all 4 formats were feasible at their minimum and maximum study days for one start date at 18:00 Europe/London. That is supporting evidence, not the decision. |
| COURSE_PRICE_APPROVAL          | Owner business decision        | The price (one price applies to every duration in the unified engine), the refund approach and the marketing promises                                                                                                                   |
| HOSTED_ACCEPTANCE              | Operational acceptance         | A controlled hosted learner journey with AI provider execution and Stripe test mode. **Blocked:** no provider or Stripe credentials.                                                                                                    |
| LAB_ASSESSMENT_MODEL           | Business and academic decision | Whether any capstone lab is graded. Grading would need a LABS weight, rubrics and human evaluation capacity, as a content revision.                                                                                                     |
| ASSESSMENT_FORM_VARIATION      | Business decision              | Fund alternate forms, or rotate items by revision. Currently one fixed form per assessment.                                                                                                                                             |

**Engine proof (disposable localhost PostgreSQL 18.4, synthetic evidence, nothing hosted).** The real revision 3 package went through the following:

- **Uploads:** identical re-upload replayed; same revision with different content refused (`REVISION_CONFLICT`).
- **Gates held:**
  - publication refused (`POLICY_PENDING`) while the 8 decisions were pending;
  - a learner's resolution refused;
  - evidence for only 7 of the 8 removed decisions refused (`ACADEMIC_EVIDENCE_REQUIRED`).
- **Publication after resolution:** all 8 resolved with TEST evidence created revision 4, leaving revision 3 unchanged. Revision 4 published in 3.6 s (curriculum PUBLISHED, 22 lessons, 4 formats listed).
- **Learner journey:** a 100% coupon granted access, and Standard 6W confirmed a 63-item timetable (30 lesson sessions, 20 labs, quiz-1/2, midterm, quiz-3/4, final). Protected content stayed unreadable to the learner.

The temporary test and the package copy were not committed.

## Evidence

- **Real PostgreSQL 18.4 gate:** 14 files, 93/93, none skipped; `assert-pg-concurrency-report.mjs` passed.
- **Real browser:** Chrome, local app on ducelio-acceptance, `scripts/acceptance/recovery-browser.mjs`. **19/19 surfaces passed:**
  - navigation, and the OE opening as its own page;
  - AI not configured stated honestly;
  - course list and AWS inspection (8 pending);
  - AWS publication blocked with no confirmation possible;
  - the sales report;
  - invalid upload refused before any record;
  - TEST upload proposed, confirmed, stored, validated and verified; replay created nothing;
  - Course academic review showing 8 decisions with none pre-selected (not submitted);
  - Learner result review separate;
  - Course Engineering stages and invalid/conflicting uploads refused with no record;
  - TEST coupon created and deactivated through confirmed proposals;
  - AWS unchanged; 390 px layout without overflow;
  - learner My Learning and catalogue working, admin workspaces refused;
  - zero console errors.
- **Fixtures left (owner-authorised, labelled):**
  - two `acceptance-unified-recovery-*` package revisions, VALIDATED and never published (one from an interrupted run), kept as immutable history;
  - one `TEST-RECOVERY-*` 5% coupon, inactive, 0 uses.
- **Not verified:**
  - **hosted cross-organisation refusal:** no second-organisation or PLATFORM_ADMIN acceptance identity exists. It is covered by the access matrix, the OE unit tests and the six organisation tests on real PostgreSQL.
  - **AI interpretation with a live provider:** no key.
  - **recording a decision on hosted:** not authorised.
