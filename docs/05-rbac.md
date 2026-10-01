# RBAC

Deny by default. Each operation checks authenticated actor + institutional role + object ownership or assignment. A role alone is insufficient for learner records.

| Role           | Current boundary                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| STUDENT        | Own academic and learner-visible support context; own permitted learner actions                                         |
| INSTRUCTOR     | Assigned academic operations where an explicit service permits them; private learner support denied by default          |
| COUNSELLOR     | Only currently assigned learners' support context and support writes                                                    |
| ACADEMIC_ADMIN | Academic structure and governed academic operations; no private counselling prose and no Registrar correction authority |
| REGISTRAR      | Official-record read context plus governed enrolment/attendance correction workflows; no academic teaching authority    |
| PLATFORM_ADMIN | Platform administration, audit and explicitly permitted institutional overrides; private support prose is not automatic |

Role grants are database-managed and inaccessible to direct client mutation. Staff roles (INSTRUCTOR, COUNSELLOR, ACADEMIC_ADMIN, REGISTRAR, PLATFORM_ADMIN) are granted and revoked only by a PLATFORM_ADMIN through the governed, audited RPCs of migration 044 (docs/39), which refuse removing the last usable PLATFORM_ADMIN and self-lockout. STUDENT is provisioned by signup and is not grantable there. Only the very first PLATFORM_ADMIN in a new environment uses a reviewed privileged bootstrap grant. A DEACTIVATED account keeps its grants but holds no authority: `current_app_user()` resolves ACTIVE accounts only. Cohort creation and lifecycle belong to ACADEMIC_ADMIN/PLATFORM_ADMIN, never REGISTRAR.

Checkpoint 12 narrows the Registrar boundary. A Registrar correction is a documented exception workflow for an existing official enrolment or attendance record: it requires a bounded reason, preserves record identity, writes immutable correction history and remains audited. Registrar-only actors cannot use the ordinary class-session, attendance, lesson-progress, learning-evidence or generic enrolment mutation paths merely because legacy read helpers include REGISTRAR in the broad academic-administration context. Completed enrolments remain outside the current correction workflow.

Academic judgment remains separate. Registrar correction authority does not permit curriculum publication or authoring, learning-evidence creation, mastery decisions, assignment/assessment authoring, protected-answer access, grading, class scheduling or teaching actions. Those operations retain their own explicit role and relationship checks.

No staff role can bypass the support boundary by passing a learner ID. A student's own support profile may be visible to them, while private counsellor interactions remain assignment-scoped and require the COUNSELLOR role.

Routes call services. Actions call services. Database RLS protects direct REST requests too. Security-definer functions require explicit authorization and a fixed search_path, with PUBLIC execution revoked.
