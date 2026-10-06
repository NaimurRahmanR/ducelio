# Counsellor architecture

CounsellorAssignment is a persistent learner relationship, independent of programme enrolment. Assignments are staff-role validated, dated and history-preserving. Reassignment ends the current relationship and creates a new one in an audited transaction.

StudentSupportProfile stores study goals, preferred contact and learning availability, not speculative sensitive profiling. Study plans organise learning; due dates on personal plan items do not modify institutional deadlines.

SupportEvent stores deterministic condition type, source reference, occurrence time and deduplication key. Event generation belongs to backend detection workflows, not client input. Checkpoint 13 introduces `SUPPORT_V1`, the first explicit deterministic support-trigger policy. It creates or resolves support events from authoritative records only:

- `MISSED_CLASS` from an authoritative attendance record whose status is `ABSENT`;
- `DEADLINE_APPROACHING` from a published assignment that is open, due within 48 hours, belongs to an ACTIVE enrolment and has no recorded submission for that enrolment;
- `PLAN_OVERDUE` from a personal study-plan item that remains `PLANNED` after its due date;
- `OBJECTIVE_REINFORCEMENT` from an objective whose deterministic mastery state is `NEEDS_REINFORCEMENT`.

`INACTIVITY` remains a legacy schema value but `SUPPORT_V1` deliberately does not generate it. Clicks, page views, elapsed time, prompt sentiment, inferred motivation and similar engagement proxies are not support-trigger inputs. A future inactivity policy would require an explicit reviewed definition and authoritative source rather than behavioural guesswork.

Institutional notifications are learner-visible projections of deterministic support state and open counsellor follow-ups. They do not modify attendance, deadlines, grades, enrolments or mastery. Notification provenance is immutable; learners may mark their own notices as read. Re-evaluating the same rule set is idempotent and does not duplicate notices.

The current trigger evaluator is an authorised backend operation for ACADEMIC_ADMIN or PLATFORM_ADMIN. It is suitable for a future reviewed scheduler, but Checkpoint 13 does not claim that a production scheduler, email delivery or push-notification provider is configured.

Current service boundaries include learner support context, study plans, support events, counsellor follow-ups/interactions, deterministic trigger evaluation and learner notification reads. Deadline and mastery triggers use their owning Academy OS records; future academic actors must not gain unrestricted raw database access to reproduce these queries independently.

Learners read their own profile, plans, learner-visible follow-ups, support events and institutional notifications. Assigned counsellors access permitted support context. Private interaction summaries are excluded from student views and inaccessible to instructors/admins absent an explicit support assignment and role. Reassignment access follows current assignment; introduce a reviewed historical-access policy before broader case transfer.

**Human counsellors and Sarah Mitchell are different things (AC-5).** Everything above describes human counsellors: real staff accounts with the COUNSELLOR role and dated assignments. Sarah Mitchell is Ducelio's AI learner-success counsellor, the persona of the platform COUNSELLOR AI role. She has no user account, role grant or assignment, never reads `counsellor_interactions` or follow-up titles, and authorises nothing through `is_assigned_counsellor()`. She may only propose support-profile changes, which the learner alone confirms. See [AC-5](47-agent-behaviour-ac5-sarah.md).

Do not store health diagnoses or other unnecessary sensitive narrative. Private note retention, access/export and escalation procedures require an institutional policy before real counselling use.
