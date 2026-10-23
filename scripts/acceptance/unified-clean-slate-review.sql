-- READ-ONLY review, after independently confirming ducelio-acceptance
-- (project ref blqaomssojfxaxskcyxd). This script cannot reset or delete data.
begin transaction read only;
select max(version) latest_migration,count(*) migration_count
from supabase_migrations.schema_migrations;
select to_regclass('public.course_engine_packages')::text unified_package_register,
  to_regclass('public.course_engine_publications')::text unified_publication_register,
  to_regclass('public.course_engine_coupons')::text unified_coupon_register;
-- Capture these counts with the backup/restore receipt. Account, payment,
-- refund, entitlement and academic/audit evidence must be preserved.
select 'auth_users' category,count(*) records from auth.users
union all select 'app_users',count(*) from public.app_users
union all select 'role_grants',count(*) from public.role_grants
union all select 'academy_orders',count(*) from public.academy_orders
union all select 'academy_payment_events',count(*) from public.academy_payment_events
union all select 'academy_order_refunds',count(*) from public.academy_order_refunds
union all select 'academy_entitlements',count(*) from public.academy_entitlements
union all select 'academy_enrolments',count(*) from public.academy_enrolments
union all select 'commercial_orders',count(*) from public.commercial_v1_orders
union all select 'commercial_entitlements',count(*) from public.commercial_v1_entitlements
union all select 'audit_events',count(*) from public.audit_events;
rollback;
