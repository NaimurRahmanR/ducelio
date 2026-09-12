# Ducelio Commercial V1 release contract

## Purpose

This document defines the first complete sellable version of Ducelio.

Commercial V1 is not a demo, prototype, investor showcase or partially working MVP. It is the first production-ready version of the business: a reusable AI-native academy platform capable of selling, enrolling, teaching, supporting, assessing and progressing real learners.

The deterministic Academy Operating System remains authoritative for institutional truth. AI agents operate through reviewed capabilities and never replace enrolment, assessment, mastery, records, payment entitlement or other deterministic authority.

## September 2026 target

Target date: **30 September 2026**.

By that date Ducelio should be a production-ready commercial academy platform with:

- one complete real cybersecurity exam-preparation course;
- a reusable Course & Agent Engineering system;
- real AI Professor delivery;
- governed Tutor, Lab Instructor and Examiner experiences;
- persistent Counsellor support plus prospect/admissions Counsellor;
- real purchase, payment verification and entitlement-backed enrolment;
- complete learner scheduling/delivery/catch-up UI;
- assignments, controlled assessments, grading/results and course completion;
- operational Admin tooling;
- production email/notification flows;
- hosted production acceptance, monitoring, security and recovery controls.

## Course & Agent Engineering

Ducelio must be a platform for many courses rather than a hard-coded single-course application.

A normal course package should be able to describe:

- programme and examination-body metadata;
- curriculum/version metadata;
- modules and lessons;
- fixed learning objectives;
- lesson/lecture content;
- approved resources;
- exercises and practical/lab activities;
- assignments;
- controlled assessments;
- rubrics/marking configuration;
- objective/mastery mappings;
- schedule defaults and course delivery metadata;
- Professor configuration;
- Tutor configuration;
- Lab Instructor configuration;
- Examiner configuration;
- Counsellor course/admissions configuration.

The intended authoring lifecycle is:

**upload → validate → preview → configure agents → test → publish**

Course publication must be versioned, auditable and fail closed on invalid or incomplete packages.

Adding an ordinary later course must not require:

- a new database migration;
- a bespoke React page;
- a bespoke core API/server endpoint;
- a new hard-coded Professor/Tutor/Lab/Examiner implementation.

Course-specific behaviour is configuration/content layered onto shared institutional agent runtimes and capability policies.

## AI runtime

The AI runtime must be provider-neutral even if Commercial V1 launches with one provider.

The execution chain is:

**authenticated learner → Academy OS authority → agent runtime → role/course configuration → reviewed capabilities → provider adapter → model**

Provider/model execution must preserve the existing academic-content release, assessment firewall and trusted-execution boundaries.

Production runtime acceptance includes bounded budgets, usage/cost accounting, timeout/cancellation behaviour, retry policy, rate/admission controls, failure/abstention/escalation, provider-safe logging and human-review routes.

## Commercial customer journey

A new customer must be able to complete:

**public site → prospect Counsellor → course selection → account creation/verification → payment → entitlement → enrolment → schedule configuration → scheduled class → Professor → Tutor/Lab when needed → assignments → controlled assessments → grading/results/mastery → catch-up/support → course completion → next-course purchase**

without manual database repair or operator intervention in the normal path.

## First course

Commercial V1 launches with one complete cybersecurity exam-preparation course.

The first course is both:

1. a genuine sellable learning product; and
2. the reference implementation proving that the Course & Agent Engineering layer is generic.

Demo or fictional academic content does not satisfy this requirement.

Real content must be reviewed and must not copy protected official examination questions or imply external awarding-body endorsement.

## October expansion target

Target: approximately **15 October 2026**.

The initial wider cybersecurity catalogue should be added through the Course & Agent Engineering workflow rather than through repeated core application redevelopment.

If normal new courses require repeated schema changes or bespoke product code, the September platform objective is not complete.

## Mobile direction

Ducelio's backend must be client-independent.

The same backend authority should serve:

- the web application;
- the future iOS application;
- the future Android application.

Authentication, entitlement, enrolment, curriculum, scheduling, AI execution, assessment, mastery, records and notifications remain server-owned.

After the initial cybersecurity catalogue is loaded, Ducelio should move into mobile packaging/application work and submission to Apple App Store and Google Play. External store-review approval timing is outside Ducelio's direct control, but the platform must not require a backend redesign for mobile.

## Commercial V1 acceptance

Commercial V1 is complete only when:

- no core customer flow depends on demo fixtures;
- no core learner section says it is planned for a later milestone;
- payment success is verified server-side and provisions idempotent entitlement/enrolment;
- one complete real course can be learned from beginning to completion;
- AI academic roles use real governed provider execution;
- assessment security remains technically enforced;
- grading/results/completion are authoritative and auditable;
- Admin can operate the normal commercial lifecycle without direct database editing;
- hosted production infrastructure passes acceptance;
- production monitoring, backups/recovery, abuse controls and secrets are configured;
- browser/mobile-responsive accessibility and end-to-end release tests pass;
- customer-facing Terms, Privacy, refunds/cancellation and support processes exist.

## Explicitly outside the September finish line

Commercial V1 does not require:

- multiple non-cybersecurity verticals;
- enterprise multi-tenant institutional SaaS;
- native mobile store approval by 30 September;
- offline/PWA learning;
- advanced gamification;
- every possible analytics feature;
- every future specialist AI agent;
- every future language or geography.

These can follow after the first commercial platform is complete.

## Current transition

Checkpoint 2A is closed at merge commit:

`28937559a7c3266fec0fd6898fad129a7cd014d4`

The next engineering programme is Commercial V1.

The immediate implementation priorities are:

1. reusable Course & Agent Engineering;
2. B2 production-capable provider/runtime;
3. learner-facing 2A delivery controls;
4. first real Professor classroom;
5. first real cybersecurity course as the reference package.

Do not reopen completed Academy OS checkpoints unless a concrete commercial integration defect requires a reviewed corrective change.
