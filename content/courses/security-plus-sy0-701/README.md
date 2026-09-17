# CompTIA Security+ SY0-701 Preparation — Ducelio course package

`package.json` in this directory is a real `COURSE_PACKAGE_V1` package (see
`src/domain/course-package.ts`), the first commercial course content authored
for Ducelio (checkpoint SEC701-A). `objective-coverage.json` and
`sources.json` are provenance metadata alongside it — neither is part of the
`COURSE_PACKAGE_V1` schema itself, and neither is read by any server code in
this checkpoint. This is a first revision: bounded and reviewable, not a
finished, textbook-length course.

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
  authoring choice for this first revision, not a CompTIA requirement.
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
  — with 30 original questions total. Every `expectedAnswer` and
  `markingGuidance` is original Ducelio content, never a leaked or
  remembered real certification question, and remains protected package
  content behind the existing controlled-assessment firewall (never exposed
  to a learner-readable surface before or during an attempt). Binding a
  specific assessment template to a specific formal component is a separate,
  governed, post-activation admin action
  (`bind_commercial_v1_assessment_component`) and is not performed by this
  package itself.

  **Known foundation limitation (review correction pass).**
  `COURSE_PACKAGE_V1` currently binds each assessment template to one
  lesson, and its questions to objectives from that lesson only:
  `src/domain/course-package.ts` contains the TypeScript assessment-template
  and cross-reference validation (`assessmentTemplateSchema` and
  `validateCoursePackage`'s own lesson-scoped `objectiveRefs` checks), and
  the database independently revalidates packages against this same rule
  through its existing `assert_full_package_valid` authority. Therefore
  this SEC701-A revision does not
  yet claim a cumulative, multi-lesson, certification-style final
  assessment: `final` is scoped to a single lesson (risk management,
  domain 5) like every other assessment template here, and is titled
  accordingly ("Final Assessment: Risk Management Checkpoint"), not as a
  comprehensive cross-domain checkpoint. Representing a genuinely
  cumulative assessment remains work for the next commercial-course
  checkpoint, before commercial launch. This limitation does not make
  SEC701-A invalid as a first-revision foundation package — it is an
  accurate description of what this package's `final` template currently
  covers, not a defect this checkpoint silently worked around.

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
