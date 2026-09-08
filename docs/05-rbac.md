# RBAC
Deny by default. Each operation checks authenticated actor + institutional role + object ownership or assignment. A role alone is insufficient for learner records.
| Role | Phase 1 boundary |
| --- | --- |
| STUDENT | Own academic and learner-visible support context; own study-plan items |
| INSTRUCTOR | Role foundation; private learner support explicitly denied |
| COUNSELLOR | Only currently assigned learners' support context and support writes |
| ACADEMIC_ADMIN | Protected administration shell and institutional structure; no private counselling prose |
| REGISTRAR | Protected registry shell; future official-record workflows only |
| PLATFORM_ADMIN | Protected shell/audit and assignment management; private support prose is not granted by this role alone |
Role grants are database-managed, inaccessible to ordinary application mutations. Initial privileged grants use reviewed operator SQL, not public signup.
Academic writes and role administration are not generally exposed in Phase 1. No staff role can bypass the support boundary by passing a learner ID. A student's own support profile may be visible to them, while private counsellor interactions remain staff-only and assignment-scoped.
Routes call services. Actions call services. Database RLS protects direct REST requests too. Security-definer functions require explicit authorization and a fixed search_path, with PUBLIC execution revoked.
