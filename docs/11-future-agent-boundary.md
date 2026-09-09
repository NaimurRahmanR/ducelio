# Future academic actor boundary

No AI academic actor is integrated through Phase 2.

Future Professor, Tutor, Practical Instructor, Practice Coach, Examiner or AI Counsellor capabilities must be external callers of narrowly scoped application tools/services. Never issue database credentials or service-role tokens to an AI actor. The deterministic Academy OS remains authoritative for identity, enrolment, curriculum/version state, attendance, evidence/mastery state, assessment activity, official records and audit history.

Actor capability must be bounded by authenticated user/learner context, staff/agent capability, programme version, institutional relationship, server-owned activity state and a specific operation. Permissioned tools must re-check the backend boundary; a model prompt is not authorization.

Academic actors may eventually propose or submit structured LearningEvidence through a reviewed permissioned service. Deterministic source validation and versioned mastery policy own ObjectiveMastery. AI output cannot directly overwrite grades, attendance, enrolment, deadlines, mastery, Registrar corrections or other official records.

Controlled assessments already expose `current_academic_activity_state()`, `academic_action_allowed()` and `assert_academic_action_allowed()` as technical enforcement points. During an ACTIVE controlled attempt normal help/final-answer/practice actions are denied while examiner delivery and Counsellor logistics remain the current permitted contract. Future tools must consult that backend state before retrieval or action. Do not replace this with conversational instructions.

Coursework homework has a different intended future policy: explanation/hints/critique may be permitted while final-answer or submission generation can be denied. That homework-specific tool policy is not yet implemented and must be reviewed before academic-agent release.

The Counsellor relationship remains institutional even if a future interface is conversational. AI support must not infer motivation, inactivity, risk or mastery from clicks, page views, time-on-page or sentiment. Phase 2 `SUPPORT_V1` uses explicit authoritative conditions; any later trigger policy requires the same reviewed deterministic standard.

Every future AI/tool action must carry auditable provenance, bounded inputs/outputs, idempotency where applicable, rate limits and human review/override where institutional policy requires it. Protected assessment answers, private Counsellor prose and unrelated learner records must never be included merely because a model could use them.
