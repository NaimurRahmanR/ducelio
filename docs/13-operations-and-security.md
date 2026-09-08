# Operations and security review

## Verification boundary

Phase 1 has local code, PostgreSQL/PGlite and HTTP tests. A hosted Supabase/Auth/SMTP/OAuth end-to-end test is still required. PGlite emulates auth.uid() and the auth.users table for deterministic tests; it does not emulate GoTrue, PostgREST, real JWTs, network failures, SMTP or concurrent PostgreSQL sessions.

The initial application uses no service-role key. Browser credentials are limited to a Supabase publishable key. All record queries are session-bound. Security-definer functions use a fixed empty search_path, fully qualified tables, explicit authorization and restricted execution grants.

## Required deployment configuration

- Set APP_URL to the exact HTTPS production origin. The local default is http://127.0.0.1:3000. Use one origin consistently.
- Populate NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. The latter must be a publishable/anon key, never a service-role or secret key.
- Apply all five migrations in order. Preserve deployed migration files; add corrective migrations.
- Enable verified email, custom SMTP, sender-domain verification, recovery and confirmation templates, exact redirect allowlists, Google and LinkedIn OIDC.
- Apply suitable Supabase and edge rate limits to sign-in, signup, resend and recovery. A CAPTCHA setting needs a corresponding challenge/token UI before enforcement; that integration is not in Phase 1.
- Configure HTTPS termination/HSTS, production secrets, secure cookies, backups, restore exercises, logging/alerts and error monitoring. Do not cache session-dependent responses at a CDN.
- The initial CSP restricts framing, base URLs and objects. It is not a full nonce-based script CSP; review a strict script policy with Next.js before public rollout.
- Review account lifecycle, session revocation, email linking and admin provisioning on staging. Manual cross-email merges are not implemented.
- Choose retention/deletion/export policies for academic and support data. Private interactions must not contain unnecessary clinical or other sensitive details.
- Establish human-reviewed assignment, support escalation, role-grant and registry workflows. Database owners can bypass RLS; production access to operator credentials must be restricted and externally audited.

## Staff and support provisioning

Signup provisions a student profile and STUDENT grant. The first privileged account requires reviewed SQL executed by the database operator; it cannot self-promote through the application. Use real Auth UUIDs from the Supabase dashboard, never student numbers as authentication.

Example template for a **disposable staging/local project**, after two test users have signed up and verified their email. Replace both UUID placeholders and the reason before running:

```sql
begin;
select set_config('app.audit_reason', 'Approved staging setup; ticket REPLACE_ME', true);
do $$
declare
  learner uuid;
  counsellor uuid;
begin
  select id into strict learner from public.app_users
    where auth_user_id = 'REPLACE_WITH_VERIFIED_LEARNER_AUTH_UUID'::uuid and not is_demo;
  select id into strict counsellor from public.app_users
    where auth_user_id = 'REPLACE_WITH_VERIFIED_COUNSELLOR_AUTH_UUID'::uuid and not is_demo;
  insert into public.staff_profiles(user_id,title)
    values(counsellor,'Learner success counsellor') on conflict do nothing;
  insert into public.role_grants(user_id,role)
    values(counsellor,'COUNSELLOR') on conflict do nothing;
  insert into public.student_support_profiles(student_id,study_goal,weekly_hours)
    values(learner,'Establish a consistent study routine',6) on conflict do nothing;
  insert into public.study_plans(student_id,title)
    values(learner,'Initial study plan') on conflict do nothing;
  insert into public.counsellor_assignments(student_id,counsellor_id)
    values(learner,counsellor) on conflict do nothing;
end $$;
commit;
```

Use a separate reviewed transaction to grant ACADEMIC_ADMIN, REGISTRAR or PLATFORM_ADMIN to the exact intended account. Do not grant PLATFORM_ADMIN simply to view a demo. Role assignments, relationship changes and the supported academic/support writes are audited. Operator-generated audit events may have null actor_id because they have no Auth session; retain the operator identity in database access logs and use a review-ticket reason.

The seed's programme/cohort may be used for explicitly labelled development enrolment after resolving the authenticated app_user ID. Real curricula must be prepared, validated and published separately. Enrolments require a published version. Changing learner/cohort/version or enrolled_at in place is rejected; use a reviewed new enrolment and status transition.

Reassignment should use the permissioned assignCounsellor service when acting as an authenticated academic/platform administrator. The transaction closes the previous relationship and creates the new one. Closed assignment history cannot be rewritten. Ending an assignment remains possible after the former counsellor role is revoked.

## Staging acceptance checklist

1. Register and confirm an email user; prove confirmation codes work in the originating browser and token-hash templates work as configured.
2. Exercise valid/invalid/expired OAuth callbacks for Google and LinkedIn; verify one stable Ducelio identity for safely linked verified providers.
3. Exercise login, logout, password recovery, mismatched password confirmation, expired recovery, global sign-out and session expiry.
4. Verify STUDENT, INSTRUCTOR, COUNSELLOR, ACADEMIC_ADMIN, REGISTRAR and PLATFORM_ADMIN boundaries using real JWTs and direct REST/RPC requests.
5. Attempt cross-learner URLs and direct RPC calls, access after reassignment/role revocation, unverified access and audit modification.
6. Create a real plan item, follow-up and private interaction; verify persistence, refreshed UI and audit provenance. Verify students cannot read private interactions.
7. Run true concurrent PostgreSQL tests for publication/content edits, enrolment and reassignment/support writes.
8. Review keyboard-only navigation, screen readers, 200% text zoom, mobile devices, contrast and browser support. Local sanity checks are not a formal accessibility certification.

## Scope limits

No full curriculum editors, registrar operations, assessment engine, mastery engine, support automation, notifications, external messaging, payments, AI services, uploads or offline/PWA synchronization are implemented. Caseload/programme/audit lists are bounded for Phase 1; add pagination before scaling. The public demo is static fixture rendering and grants no production identity.
