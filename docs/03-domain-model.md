# Domain model

## Phase 1

User is a stable Ducelio UUID mapped one-to-one to auth.users.id by a unique auth_user_id. Supabase auth.identities owns provider identities; duplicating provider tokens/subjects in an application table is unnecessary. Profile and role grants refer to the Ducelio ID.
Programme → ProgrammeVersion → Module → Lesson → LessonObjective. A cohort belongs to one version. An enrolment must reference the same version as its cohort. Published versions and descendant content must remain immutable; amendments use a new version.
CounsellorAssignment connects staff to student across programmes. StudentSupportProfile, StudyPlan/StudyPlanItem, SupportEvent, SupportFollowup and CounsellorInteraction are separate from academic records. Only one active primary assignment exists per learner.
AuditEvent records actor, action, target, time, source, reason and appropriately minimised before/after state.

## Deferred concepts

ClassSession/Attendance, LessonProgress, LearningEvidence, ObjectiveMastery/MasteryHistory, Resource/LectureNote, Assignment/Submission, Assessment/Question/Attempt/Result, GradebookEntry, Announcement and Notification are documented future modules. Dashboard examples are fixtures, not implied production tables.
SupportRecommendation, InterventionTrigger and AcademicRoutingRequest will be introduced with concrete workflows. Current SupportEvent and interactions preserve the boundary without speculative automation tables.
