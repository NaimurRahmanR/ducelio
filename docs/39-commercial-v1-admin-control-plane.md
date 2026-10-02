# Commercial V1 admin control plane — checkpoint 1 (People, roles, account safety, cohorts)

Migration `202610010044_admin_control_plane_foundations.sql`. This checkpoint removes the ordinary need for privileged SQL to appoint staff or create cohorts. It is the first backend-first checkpoint, not a complete admin backend.

## Identity model (unchanged)

Ducelio does not create Supabase Auth users. A person signs up (or is provisioned by the identity provider), migration 002's trigger creates their `app_users` row, `student_profiles` row and `STUDENT` grant, and only then can a `PLATFORM_ADMIN` find and manage them. No service-role key is used by application code, and no typed email ever grants authority: the operator locates an existing identity and acts on its `app_users.id`.

The very first `PLATFORM_ADMIN` in a new environment still needs one reviewed, privileged bootstrap grant (a `staff_profiles` row and a `PLATFORM_ADMIN` role grant). Every later staff change uses the governed RPCs below.

## People authority (`PLATFORM_ADMIN` only)

| RPC                                                     | Effect                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_list_people(p_query)`                            | Bounded directory: staff by default; display-name substring or exact email search. Returns roles, staff title, account status, email.             |
| `admin_set_staff_profile(p_user_id,p_title,p_reason)`   | Create or retitle a staff profile (1–120 characters). Idempotent.                                                                                 |
| `admin_grant_role(p_user_id,p_role,p_reason)`           | Grant `INSTRUCTOR`, `COUNSELLOR`, `ACADEMIC_ADMIN`, `REGISTRAR` or `PLATFORM_ADMIN`. Requires an active account with a staff profile. Idempotent. |
| `admin_revoke_role(p_user_id,p_role,p_reason)`          | Revoke one of the same staff roles. Idempotent.                                                                                                   |
| `admin_set_account_status(p_user_id,p_status,p_reason)` | `ACTIVE` ↔ `DEACTIVATED`.                                                                                                                         |

`STUDENT` is provisioned by identity and is never grantable or revocable here (`UNSUPPORTED_ROLE`). Fictional demo accounts are refused (`DEMO_ACCOUNT`). Every reason is 5–300 characters.

### Account status

`app_users.account_status` defaults every existing and new account to `ACTIVE`. `public.current_app_user()` — the single identity root that every RLS policy, `has_role()` and governed RPC already derives from — now resolves only `ACTIVE` accounts. A deactivated account therefore holds no database authority anywhere (no reads beyond what an anonymous session has, no RPC authority), while its identity, role grants, staff profile, enrolments, assignments and audit history are preserved untouched. Reactivation restores the existing grants. The application identity layer treats a deactivated session as signed out and redirects to `/login?error=account-inactive`; `current_account_status()` exposes only the caller's own status for that purpose.

### Safety rules (database-enforced)

- **Last usable `PLATFORM_ADMIN`.** Revoking `PLATFORM_ADMIN` from, or deactivating, the last usable platform administrator is refused (`LAST_PLATFORM_ADMIN`). "Usable" means non-demo, `ACTIVE`, linked to a confirmed Auth identity and holding the grant — an unconfirmed or deactivated holder does not count.
- **Self-lockout.** An operator cannot revoke their own `PLATFORM_ADMIN` or deactivate their own account (`SELF_LOCKOUT`). Revoking one's own non-administrative role is allowed.
- **Serialization.** Every people mutation takes one transaction-scoped advisory lock, so two administrators cannot concurrently remove each other.
- **Counsellor continuity.** `COUNSELLOR` cannot be revoked while the person still has an active counsellor assignment (`ACTIVE_COUNSELLOR_ASSIGNMENTS`). Deactivation is deliberately not blocked by this (it is the emergency lever); reassign learners afterwards.
- **Instructor continuity.** `INSTRUCTOR` cannot be revoked while the person still teaches live delivery: the activation instructor of a cohort that is not `COMPLETED`, or a still-`SCHEDULED` class session of such a cohort (`ACTIVE_TEACHING_ASSIGNMENTS`). Completed or cancelled history never blocks revocation. A refused revocation writes nothing, including no audit row.
- **No new targets for deactivated staff.** A trigger on `course_activations`, `class_sessions`, `assignments`, `assessments` (`instructor_id`) and `counsellor_assignments` (`counsellor_id`) refuses a `DEACTIVATED` account as a new or changed target for every writer (`STAFF_DEACTIVATED`). Deactivation never rewrites existing relationships; the People directory reports each person's live teaching and active counselling counts so a deactivated person's relationships can be reassigned. The bounded pickers `list_assignable_instructors`, `list_assignable_counsellors` and `get_course_activation_options` (which also omits completed cohorts) offer only `ACTIVE` staff.
- **Staff profile prerequisite.** Staff relationships reference `staff_profiles`, so staff roles require one (`STAFF_PROFILE_REQUIRED`); a deactivated account cannot be given a profile or role (`ACCOUNT_DEACTIVATED`).

Client sessions still have no INSERT/UPDATE/DELETE on `app_users`, `role_grants`, `staff_profiles`, `cohorts`, `enrolments` or `audit_events`; the migration asserts this. Privileged database owners can still write directly — that is the operator break-glass path, not an application capability.

## Cohort authority (`ACADEMIC_ADMIN` or `PLATFORM_ADMIN`)

`REGISTRAR` correction authority is deliberately not cohort authority.

`cohorts` gains `status` (`OPEN` | `CLOSED` | `COMPLETED`, default `OPEN`), optional `ends_on` (≥ `starts_on`) and optional `capacity` (1–10,000 seats).

| RPC                                                                    | Effect                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_create_cohort(version,title,starts_on,ends_on,capacity,reason)` | Creates an `OPEN` cohort for a **published, non-demo** programme version. Same version/title/start replays idempotently.                                                            |
| `admin_update_cohort(cohort,title,starts_on,ends_on,capacity,reason)`  | Edits until completion. `starts_on` is locked once any enrolment or activation exists (it drives delivery scheduling). Capacity cannot drop below current non-withdrawn enrolments. |
| `admin_change_cohort_status(cohort,status,reason)`                     | `OPEN → CLOSED`, `CLOSED → OPEN` (reopen), `CLOSED → COMPLETED`. `COMPLETED` is terminal.                                                                                           |
| `admin_cohort_workspace()` / `admin_cohort_roster(cohort)`             | Bounded projections: lifecycle, version linkage, enrolment counts, activation/offer state; roster from the canonical `enrolments`.                                                  |

Database guards (all writers, including privileged ones where noted):

- A lifecycle trigger keeps cohort identity and programme version immutable, allows only the transitions above and freezes a `COMPLETED` cohort (binds privileged writers too).
- New enrolments require an `OPEN` cohort with a free seat (`COHORT_NOT_OPEN`, `COHORT_FULL`). The only exception is **verified paid fulfilment**: `fulfill_commercial_v1_order` (the only writer of `commercial_v1_payment_events`, after its HMAC claim verifies and session/amount/currency match) records PAID evidence before its enrolment insert; an `AFTER INSERT` trigger on that table sets a transaction-local marker naming the order, and the enrolment guard requires both that marker for an order of the same learner, cohort and version and durable matching PAID evidence. Orders can only be created while the cohort is open with a free seat, so this honours exactly the paid checkouts that began legitimately, without rolling back payment evidence. A pending unpaid order, a spoofed marker without PAID evidence, or another learner's verified order grants nothing, and an ordinary admin enrolment (its own transaction) never carries the marker. Idempotent replays of an existing enrolment are unaffected. Any later change to `fulfill_commercial_v1_order` must keep recording PAID evidence before the enrolment insert; the database tests fail otherwise.
- New commercial orders and offer publication require an `OPEN` cohort (and orders a free seat). Closing archives the cohort's published offers in the same transaction (each with its own audit row), which also stops campaign redemption.
- A `COMPLETED` cohort refuses new course activation. A `CLOSED` cohort can still be activated for its existing learners.
- Completion never alters enrolments or any learner record.

## Audit

Existing infrastructure only. `role_grants` and `cohorts` already carry the migration 004/005 `audit_change` trigger; the RPCs set `app.audit_reason`, so each row records actor, action, target, role/state and the bounded reason with a timestamp. `staff_profiles` gains the same trigger. Account status changes write one explicit `ACCOUNT_DEACTIVATED` / `ACCOUNT_REACTIVATED` row (`source = ADMIN_PEOPLE_V1`) whose state is only `{account_status}`. Offer archival caused by closing writes `COMMERCIAL_V1_OFFER_ARCHIVED` (`source = ADMIN_COHORTS_V1`). No email, credential or free-form payload enters audit state; the People page projects audit rows to kind/role/names/reason and never sends raw state to the browser.

## Product surfaces

- `/admin/people` — search, staff profile, grant/revoke, deactivate/reactivate, recent people audit. Controls mirror the database rules (no self-deactivation control, no self-revocation of `PLATFORM_ADMIN`), but every rule is enforced in the database and every refusal is explained.
- `/admin/cohorts` — create, register (programme/version, dates, seats, status, activation/offer), roster, edit, lifecycle.
- Admin navigation now has two groups: **Academy records** (the existing `/admin?section=` workspaces, without the former Cohorts and Announcements placeholders) and **Control plane** (People, Cohorts, Course Engineering, Activation, Policy setup, Grade recovery, Commerce), each shown only to roles its page admits.

The acceptance harness (`scripts/acceptance/fixtures.mjs`) now creates its cohort through `admin_create_cohort` as the acceptance admin; it requires migration 044 on the hosted acceptance project.

## Known limitations

- Initial Auth-user creation remains self-signup / external identity provisioning; the first `PLATFORM_ADMIN` needs one privileged bootstrap grant.
- Deactivation removes authority but does not revoke live Supabase refresh tokens; the session simply resolves to no actor.
- There is no reassignment workflow for an activation's instructor (activations are immutable), so revoking `INSTRUCTOR` from an activation instructor requires completing that cohort. Class sessions are rescheduled or cancelled through the existing session workflow; counsellors through the counsellor assignment workflow. `assignments`/`assessments` instructor references are not counted as live teaching (activation and session relationships are).
- Fail-closed edge: if a verified PAID event was recorded but fulfilment returned early (for example the learner had lost the STUDENT role) and the same provider event is replayed after the cohort closed or filled, the duplicate event sets no marker and fulfilment is refused; the payment evidence stays durable for reconciliation.
- A paid checkout started while a cohort was open is honoured even if the cohort is later closed or completed, and may exceed capacity; seat reservation and refund/reconciliation belong to the later commerce checkpoint. Abandoned `PENDING` orders do not block completion.
- Completing a cohort does not yet block new class sessions, assignments or assessments created by other workflows for that cohort.
- The generic `audit_change` rows use `INSERT`/`UPDATE`/`DELETE` as the action; the People page maps them to readable kinds.
- Hosted Supabase/PostgREST acceptance of migration 044 has not been run.
