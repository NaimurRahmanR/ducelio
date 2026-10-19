# Academic Gate v1 — Certification blueprint and official-source evidence

**Status:** Approved design baseline. **Implementation NOT DONE.** Issue: [#75](https://github.com/NaimurRahmanR/ducelio/issues/75).

**Boundary:** Certification-body objectives define exam scope; approved official primary technical authorities (standards publishers, government authorities and original vendor documentation) may substantiate technical explanations. No anonymous/unverified sources, copyrighted exam dumps, unlicensed copying, fabricated exam facts, or unsourced AI-generated claims.

**Out of scope:** Generating or publishing final Security+ content/questions; changing CP2 PR #73; real student/customer operations; secrets; live model calls; hosted database mutations; production deployment; merging this branch.

## I. Certification authority contract

A `CertificationBlueprint` is identified by a stable issuer/exam code and *immutable* revision. It must record:
- issuer, certification, exam code, offered language/region, verified active/retiring status, last verification date and verification source;
- official objectives source (official origin, document version, retrieval/checksum, licence constraints), domains and exact published weights, all mandatory objectives/subtopics;
- question count **rule** (minimum/maximum/fixed only if the issuer actually publishes it), official duration, published supported question formats and documented navigation, timing, accommodations and scoring disclosures;
- **known/unknown distinctions**: mock design choices cannot masquerade as confidential issuer exam details;
- approval identity, reviewer identity, immutable content fingerprint, approval timestamp, supersession/staleness status.

The issuer's specification overrides a generic Ducelio template. The same rules may apply to different exam codes only with independently approved blueprints.

## II. Academic evidence contract

A versioned `ApprovedSource` ledger has a source ID, primary authority, version, source locator, rights/permissions, retrieval date, review date and approved/superseded/revoked state.

A versioned `ContentClaim` ledger binds each examinable factual assertion, learning objective, example, practical instruction, answer explanation and formal item rubric to:
`{claimId, contentRevision, objectiveId, sourceId, sourceVersion, preciseLocator, reviewerId, reviewedAt, status}`.

Statuses: `UNREVIEWED | VERIFIED | CONFLICT | INSUFFICIENT | STALE | REJECTED`. A citation string alone is **not proof** of support. The human reviewer checks that the source actually supports the claim and is applicable to this exam version. The author cannot self-approve.

Source changes invalidate affected claim approvals; substantive content changes invalidate attached review receipts. Formal item banks and their protected keys stay server-only.

## III. Mock examination fidelity

A distinct `ExamFormManifest` binds: blueprint ID/revision, course revision, exam-mode policy revision, item revisions, selection seed, objective/domain coverage weights, duration/count, valid interaction types, format distribution, approved rubrics and a content digest.

Full simulation must:
- use verified published exam duration, published formats and number constraints; no fabricated exact PBQ distribution, question order or scoring conversions;
- run database-authoritative time/expiry and submission, preserve saves and idempotent retries, provide permitted navigation and review-state flags only when implemented and tested;
- deny AI Professor/Tutor/Lab answer assistance for the *same learner's active formal exam*, at the server admission boundary, not just by hiding controls;
- keep protected keys and examiner rubrics away from the learner and unapproved providers;
- provide **clearly labelled Ducelio practice results** rather than an invented issuer score or guaranteed official pass prediction.

Issuer exam examples are not to be copied into Ducelio's bank. No unreviewed model-generated formal question may be published.

## IV. Publication and activation authority

The current `COURSE_PREPUBLICATION_TEST_V1` proves deterministic package integrity/configuration, not academic truth/fidelity. Preserve it unchanged. Implement **additive, versioned academic approval** that cannot be bypassed through:
- package publication, direct programme version publication, alternate activation RPCs, or paid-offer publishing;
- direct backend calls, stale approval records, changed content hashes, mismatch of exam codes/blueprints, reviewer spoofing, service-role/client bypass, or concurrency.

Approval must bind a deterministic, database-recomputed hash covering certification blueprint, source registry snapshot, claim ledger, academic review, item bank/form manifest, course content revision and academic runtime policy. No caller-supplied outcome or pass/fingerprint.

A published pre-existing legacy course must not be silently rewritten, unpublished or broken by the additive migration. New certification offerings cannot bypass the mandatory gate via omission of a client-supplied certification marker. Migration needs explicit independent authorization and real-Postgres tests.

## V. Release-blocking regression evidence

Minimum tests (all negative cases must demonstrate actual refusal at the relevant backend authority):
1. Wrong/missing exam blueprint, stale issuer source, wrong version, expired approval.
2. Missing principal objective or subtopic, fabricated keyword-only coverage, unverified supporting claim.
3. Unreviewed/scored formal question, ambiguous key, protected key disclosure, unlicensed source.
4. Wrong published duration, exceeding issuer's maximum, unsupported format, imprecise PBQ mix advertised as official.
5. Changed source, claim, content, exam manifest or model policy after approval; forged/mismatched fingerprint.
6. Same-learner AI assistance during active exam; different learner/course isolation.
7. Client-modified clock, refresh, late save, double submit, timeout race, immutable released results.
8. Direct RPC publication/activation/offer bypass, unauthorized caller and parallel transaction races.
9. Existing unmodified V1 packages, historical published courses, original COURSE_PREPUBLICATION_TEST_V1 outcomes and CP2 key ACLs remain compatible.
10. Admin views emit only bounded diagnostics and cannot expose scoring keys, marking guidance or privileged provider context.

Tests must run in CI, with real PostgreSQL where DB locking semantics matter. Human academic approval is necessary but not sufficient for a release; live/browser/accessibility/provider gates are separate.

## VI. Existing Security+ baseline

`content/courses/security-plus-sy0-701/` package revision 3 currently has five modules, 28 top-level lessons, six assessment templates, and 32 free-text questions. Its source registry references SY0-701 objective **v5.0**, requiring objective-version reconciliation before content approval. The 28-objective lexical breadth audit is not proof of claim-level correctness. This content is **not** automatically publication-approved by this document.

`src/components/exam-workspace.tsx` currently offers question navigation, saved/unsaved status and server-time-calibrated countdown; it does **not** show a verified flag-for-review feature in the reviewed source. The CP2 hosted matrix remains 10/11 pending its independent final gate; separately, two live provider smoke tests passed on 19 Oct 2026. None is an academic readiness certificate.

## VII. Ordered implementation milestones

1. Finalize schemas, closed-vocabulary reviewer diagnostics and review authority; publish a migration proposal (not database deployment).
2. Review the *actual* SQL function definitions and grants for every certification publication, activation and offer entry point.
3. Implement additive DB authority, transaction-safe immutable approvals and versioning. Never build a browser-only check.
4. Implement admin evidence/review screens and bounded results; preserve the existing content firewall and agent role boundaries.
5. Implement exam-form validation + active-exam teaching admission denial, with suitable separate standard module tests.
6. Run lint, typecheck, full local tests, Postgres concurrency and CI; attach precise evidence; independent code review.
7. Request separate permission for isolated hosted acceptance; do not merge/publish/deploy automatically.

**Do not declare the gate implemented until the above enforcement and acceptance evidence exist.** This branch begins with the approved engineering specification only.
