# Domain model

## Identity and curriculum core

User is a stable Ducelio UUID mapped one-to-one to `auth.users.id` by a unique `auth_user_id`. Supabase `auth.identities` owns provider identities; application records use the stable Ducelio user ID.

Programme → ProgrammeVersion → Module → Lesson → LessonObjective. A Cohort belongs to one ProgrammeVersion. An Enrolment references the same ProgrammeVersion as its Cohort and retains cohort/version snapshots for historical display. Published or enrolled curriculum is immutable; amendments use a new version.

RoleGrant assigns STUDENT, INSTRUCTOR, COUNSELLOR, ACADEMIC_ADMIN, REGISTRAR or PLATFORM_ADMIN. Role entry does not itself grant every mutation: individual institutional services enforce their narrower authority and relationship rules.

## Teaching and attendance

ClassSession binds a Cohort, ProgrammeVersion, Lesson and Instructor to an immutable scheduled interval and governed SCHEDULED → COMPLETED/CANCELLED lifecycle. Scheduling rejects overlapping cohort or instructor sessions; Phase 2 hardening serializes scheduling for the same instructor before conflict checks.

AttendanceRecord binds one Enrolment to one ClassSession and records PRESENT, LATE, ABSENT or EXCUSED. The record identity is immutable; later corrections preserve the same record and audit provenance.

LessonSegment is planned versioned lesson structure. LessonProgress binds a learner Enrolment and segment to a real ClassSession, with IN_PROGRESS/COMPLETED state. Lesson progress is explicitly not mastery evidence by itself.

LearningResource stores a version-bound LECTURE_NOTE or approved HTTPS REFERENCE_LINK. Curriculum freezing applies to resources. Large note bodies stay in the authoritative resource record rather than being copied into generic audit payloads.

## Learning evidence and mastery

LearningEvidence is append-only provenance for an Enrolment, learner, LessonObjective, ProgrammeVersion and ClassSession. Evidence kinds are CLASS_RESPONSE, RETRIEVAL_CHECK, PRACTICAL_TASK and DEBUGGING_TASK; results are CORRECT, PARTIAL or INCORRECT. Evidence is recorded only through governed services and an idempotency key.

ObjectiveMastery stores current deterministic mastery state for an Enrolment/Objectve pair. ObjectiveMasteryHistory is append-only transition history. `MASTERY_V1` derives DEVELOPING, DEMONSTRATED and NEEDS_REINFORCEMENT only from validated LearningEvidence; navigation, elapsed time and LessonProgress do not establish mastery.

## Coursework and controlled assessments

Assignment is ordinary coursework bound to Cohort, ProgrammeVersion, Lesson and Instructor with DRAFT → PUBLISHED → CLOSED lifecycle. AssignmentSubmission is append-only learner submission history. Submission alone does not create a grade, LearningEvidence or ObjectiveMastery.

Assessment is a controlled assessment bound to Cohort, ProgrammeVersion, Lesson and Instructor with DRAFT → PUBLISHED → CLOSED lifecycle. AssessmentQuestion and AssessmentAnswerKey contain protected content; learners have no direct table access. AssessmentAttempt is server-owned ACTIVE/SUBMITTED/VOIDED state. AssessmentResponse is append-only revision history and is database-bound to the same attempt, assessment and learner identity.

An ACTIVE, unexpired controlled attempt drives the deterministic academic-activity firewall. Protected prompts are released only through the controlled delivery service. Answer keys and marking guidance are never returned by learner delivery.

## Support, notifications and official corrections

CounsellorAssignment connects a COUNSELLOR to a learner across programmes and preserves reassignment history. StudentSupportProfile, StudyPlan/StudyPlanItem, SupportEvent, SupportFollowup and CounsellorInteraction remain separate from authoritative academic records. Private interaction prose stays inside the assigned support relationship.

`SUPPORT_V1` creates or resolves SupportEvent records only from explicit authoritative conditions: ABSENT attendance, an eligible published assignment approaching its deadline without a submission, an overdue planned StudyPlanItem, or ObjectiveMastery in NEEDS_REINFORCEMENT. The legacy INACTIVITY kind is not generated from clicks, page views, time-on-page, prompt sentiment or inferred motivation.

Notification is a learner-visible projection of deterministic institutional/support state with immutable source provenance and learner-controlled read state. Re-evaluation is idempotent and does not alter the academic record that produced the notice.

RegistrarCorrection is append-only provenance for governed correction of existing enrolment-status or attendance-status records, including before/after value, bounded reason, actor and timestamp. REGISTRAR authority is not general teaching, curriculum, evidence or assessment authority.

AuditEvent records actor, action, target, time, source, reason and appropriately minimised before/after state. Protected assessment text, learner submission bodies, support prose and large learning-resource bodies are excluded from the relevant generic audit payloads.

## Still deferred after Phase 2

Formal grading/result publication and GradebookEntry workflows remain deferred. Assessment answer keys exist for protected future grading but Checkpoint 11 does not implement automatic marking or pass/fail decisions. Institutional announcement authoring, production email/push delivery, production support-trigger scheduling and full completion/certification workflows also remain future work.

AI academic actors are not database principals. Future Professor, Tutor, Examiner, Counsellor or other AI services must act through reviewed permissioned tools/APIs that preserve these deterministic domain and activity boundaries.
