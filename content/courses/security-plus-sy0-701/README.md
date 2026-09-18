# CompTIA Security+ SY0-701 Preparation — Ducelio course package

`package.json` in this directory is a real `COURSE_PACKAGE_V1` package (see
`src/domain/course-package.ts`), the first commercial course content authored
for Ducelio (checkpoint SEC701-A). `objective-coverage.json` and
`sources.json` are provenance metadata alongside it — neither is part of the
`COURSE_PACKAGE_V1` schema itself, and neither is read by any server code in
this checkpoint. Revision 2 adds cumulative final-assessment provenance; it
remains bounded and reviewable, not a finished, textbook-length course.

This README distinguishes two categories of statement throughout:

- **OFFICIAL FACT** — a verified fact about the real CompTIA Security+
  SY0-701 exam blueprint.
- **DUCELIO DESIGN** — a Ducelio-authored instructional design decision. None
  of this is CompTIA content, and none of it is verified or endorsed by
  CompTIA.

## OFFICIAL FACT — the exam blueprint this course prepares for

- Exam code: **SY0-701**.
- Five domains, each independently verified before this package was authored:
  1. General Security Concepts — 12%
  2. Threats, Vulnerabilities, and Mitigations — 22%
  3. Security Architecture — 18%
  4. Security Operations — 28%
  5. Security Program Management and Oversight — 20%
- Official top-level objective-number ranges: 1.1–1.4, 2.1–2.5, 3.1–3.4,
  4.1–4.9, 5.1–5.6 — 28 top-level objective IDs in total.
- Source document: CompTIA Security+ (SY0-701) Certification Exam Objectives,
  **version 5.0**, publisher CompTIA. See `sources.json` for the full
  provenance record (source metadata only — no copied objective text).

This package's `objective-coverage.json` records exactly these 28 objective
IDs, each mapped to one Ducelio module/lesson, with the five domain weights
summing to 100. It does **not** reproduce any official objective's
descriptive prose — only the bare domain/objective identifiers and weights,
used purely for provenance and coverage-proof purposes.

## DUCELIO DESIGN — how this package turns that blueprint into a course

- **Course structure.** Exactly five Ducelio modules, one per official exam
  domain, and exactly one principal Ducelio lesson per official top-level
  objective ID (28 lessons total: 4 + 5 + 4 + 9 + 6, matching each domain's
  objective count). This 1:1 lesson-to-objective-ID structure is a Ducelio
  authoring choice for this course design, not a CompTIA requirement.
- **Lesson content.** Every lesson's title, learning objective, lecture-note
  or reference-link resource, and any exercise/practical-lab instructions are
  original Ducelio-authored material. The real SY0-701 objectives document
  was consulted only to identify each objective's general subject area (for
  example, "objective 4.8 concerns incident response") so lessons could be
  meaningfully distinguished and correctly grouped — never to copy its
  wording. No official objective sentence, sub-bullet or exam question
  appears anywhere in this package.
- **Practical labs.** Ten original `PRACTICAL_LAB` activities are spread
  across the architecture and operations modules (certificate/TLS
  inspection, cloud shared-responsibility mapping, network-segmentation
  design, backup/recovery strategy, endpoint hardening, vulnerability
  prioritisation, SIEM log investigation, firewall rule-set analysis, access
  control review, and incident-response evidence analysis), each bounded,
  safe and non-destructive — no live-target attack guidance or exploitation
  instructions. Four additional original `EXERCISE` activities support
  earlier conceptual lessons. Together these exist to exercise the real
  learner → Lab Instructor → lab submission → Examiner grading →
  result/completion path end to end, not to be a complete lab curriculum.
- **Assignments.** Three original assignment templates (control mapping,
  incident-response playbook, vendor risk assessment), each with a
  deterministic rubric and no copied exam content.
- **Controlled assessments.** Six original assessment templates — one per
  existing Commercial V1 formal component (`QUIZ_1`/`QUIZ_2`/`MIDTERM`/
  `QUIZ_3`/`QUIZ_4`/`FINAL`, see `docs/23-commercial-v1-assessment-policy.md`)
  — with 32 original questions total. Every `expectedAnswer` and
  `markingGuidance` is original Ducelio content, never a leaked or
  remembered real certification question, and remains protected package
  content behind the existing controlled-assessment firewall (never exposed
  to a learner-readable surface before or during an attempt). Binding a
  specific assessment template to a specific formal component is a separate,
  governed, post-activation admin action
  (`bind_commercial_v1_assessment_component`) and is not performed by this
  package itself.

  **SEC701-B cumulative final (revision 2).** The assessment retains one
  institutional anchor lesson (`lesson-5-6`). Each of the ten original final
  questions explicitly declares its own source `lessonRef`; its `objectiveRefs`
  resolve only within that lesson. Two questions cover each of the five modules,
  across ten distinct lessons, using existing Ducelio-authored teaching material.
  Migration 037 records the anchor in `course_assessment_objectives.lesson_id`
  and the actual source in `objective_lesson_id`. Older V1 questions that omit
  `lessonRef` still inherit the template anchor. This extends V1 without
  reinterpreting old stored packages or making objective keys globally unique.
  `objective-coverage.json` keeps the same 28 SEC701-A blueprint mappings but
  now identifies package revision 2; `sources.json` remains source-level provenance.
  All 28 lesson mappings remain applicable to revision 2.

- **Five-role agent configuration.** All five roles are configured under the
  existing, unmodified role/profile/null policy
  (`src/domain/academic-runtime-profile.ts`'s `ROLE_RUNTIME_PROFILE_POLICY`):
  Professor is enabled with the exact `PROFESSOR_COMMERCIAL_V1` profile and
  the full nine-capability `PROFESSOR_READ_V2` catalogue; Tutor and Lab
  Instructor are enabled with their own exact role-bound profiles
  (`TUTOR_COMMERCIAL_V1`, `LAB_INSTRUCTOR_COMMERCIAL_V1`) and their existing
  reviewed per-role capability sets, exercised through the dedicated
  governed Tutor/Lab execution path (`src/server/tutor-lab-execution`,
  migration 028's `TUTOR_LAB_EXECUTION_V1`); Examiner is enabled with its
  exact `EXAMINER_COMMERCIAL_V1` profile and its two real grading
  capabilities
  (`grade_controlled_assessment`, `grade_practical_lab`); Counsellor is
  enabled but remains non-provider-backed (`modelProfileRef` is `null`, and
  Commercial V1 adds no Counsellor provider-execution path). No capability
  outside `src/domain/academic-capability-policy.ts`'s existing per-role
  allowlist was invented or requested.
- **Scheduling defaults.** Monday/Wednesday/Friday 19:00 (descriptive package
  metadata only; the existing `DELIVERY_V1` institutional default is
  unaffected).

## Not a CompTIA product

Ducelio is not CompTIA, is not endorsed or sponsored by CompTIA, and does not
award the CompTIA Security+ certification. This course prepares a learner for
the external SY0-701 examination; passing it requires sitting CompTIA's own
exam separately. No real, leaked or remembered CompTIA exam question appears
anywhere in this package.

## Before commercial publication

CompTIA periodically revises its exam objectives and retires prior exam
codes. Before this course is activated for a paying cohort, an operator must
re-verify directly with CompTIA that SY0-701 (objectives v5.0) remains the
current, sold exam — not merely rely on this README or on `sources.json`'s
recorded retrieval date (2026-09-17).

## SEC701-B local acceptance and provenance audit

`tests/course-cumulative-assessment-db.test.ts` uses this actual revision-2
file with the governed database RPCs, not a miniature substitute. It exercises
import, validation, redacted preview, Apply, five explicit configuration saves,
COURSE_PREPUBLICATION_TEST_V1, Publish and idempotent Activate, then explicit
binding of all six components and publication of the existing grading and result
policies. Ten test-only lab policies divide the unchanged 2000 bp lab allocation;
the local 7000 bp pass threshold is test input, not a production decision.
No result is graded, no mastery is changed and no provider is called.

The test proves 5 modules, 28 lessons, 14 practical activities (10 labs),
3 assignments and 6 assessments, including ten final question/source mappings.
It exercises configuration/materialised-state drift and exact-state restoration,
immutable raw-package content, protected answer-key storage and actual controlled
question release to an enrolled learner under PGlite's test clock.
A staged 036-to-037 test first activates an unchanged old-style V1 package,
then applies only migration 037 and compares every old provenance field and
answer-key row. A stored pre-upgrade draft also validates after the upgrade.

Downstream source audit found three consumers of `course_assessment_objectives`
in migration 030: `assessment_result_is_valid`, `reconcile_remediation` and
`derive_and_insert_objective_outcomes`. They join/group by `objective_id` and
question/assessment identity; none interprets `lesson_id` as the objective's
source. No downstream function therefore requires replacement. Activation is
the sole production writer, replaced in 037; the assessment binding continues
to use the anchor. Existing grading/results regressions remain required.
The safe operator projection remains unchanged: it reduces questions to counts
and marks and strips question-level prose, protected keys and source lesson refs.

This is local PGlite/domain acceptance only. Hosted PostgreSQL transaction and
migration deployment, Supabase/JWT, provider, payment and browser/mobile
acceptance have not been demonstrated by SEC701-B. It remains subject to
independent review and does not declare production readiness.

Local validation on Node v24.19.0: focused affected suites passed 286 tests
across nine files; the strengthened lifecycle/upgrade DB suite separately passed
12/12. The full check passed lint, typecheck and 1,847 tests across 82 files.
Build, formatting and diff whitespace checks passed. Migrations 001-036 remain
byte-identical to the canonical SEC701-A commit; 037 is the only new migration.


## SEC701-C customer-grade teaching depth

Package revision 3 preserves the verified SY0-701 v5.0 objective map,
assessment firewall, practical catalogue and agent-authority boundaries while
substantially deepening the learner-facing course material.

Every one of the 28 principal lessons now includes an embedded Ducelio study
guide of at least 300 words. The package contains more than 10,000 words of
embedded teaching material, and no lesson depends on an external link as its
only teaching resource. External references remain supplementary.

`objective-breadth-audit.json` binds all 28 official objective IDs to
representative v5.0 subtopic terms and CI verifies that those terms are present
in the corresponding learner guide. This catches the failure mode where a
lesson is long but only teaches the headline while omitting major blueprint
areas.

Classroom and Notes preserve the study-guide paragraph structure for readable
long-form material. Classroom also gives the learner a direct route to
governed Practicals for Tutor/Lab Instructor support.

This checkpoint does not claim CompTIA endorsement, access to live exam
questions, live-provider quality, hosted Supabase acceptance or production
readiness. The course remains exam preparation for an external qualification.
