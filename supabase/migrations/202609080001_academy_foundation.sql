-- Phase 1: domain constraints. Client access denied until policy migration.
create type public.platform_role as enum ('STUDENT','INSTRUCTOR','COUNSELLOR','ACADEMIC_ADMIN','REGISTRAR','PLATFORM_ADMIN');
create table public.app_users (
 id uuid primary key default gen_random_uuid(),
 auth_user_id uuid unique references auth.users(id),
 display_name text not null check(length(display_name) between 1 and 100),
 is_demo boolean not null default false,
 created_at timestamptz not null default now(),
 check(auth_user_id is not null or is_demo)
);

create table public.role_grants (
 user_id uuid not null references public.app_users(id),
 role public.platform_role not null,
 primary key(user_id,role)
);

create table public.student_profiles (
 user_id uuid primary key references public.app_users(id),
 student_number text unique not null,
 timezone text not null default 'Europe/London'
);

create table public.staff_profiles (
 user_id uuid primary key references public.app_users(id),
 title text not null
);

create table public.programmes (
 id uuid primary key default gen_random_uuid(),
 slug text unique not null check(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 title text not null,
 examination_body text not null,
 qualification_name text not null,
 is_demo boolean not null default false
);

create table public.programme_versions (
 id uuid primary key default gen_random_uuid(),
 programme_id uuid not null references public.programmes(id),
 label text not null,
 status text not null default 'DRAFT' check(status in ('DRAFT','PUBLISHED')),
 is_demo boolean not null default false,
 created_at timestamptz not null default now(),
 unique(programme_id,label)
);

create table public.modules (
 id uuid primary key default gen_random_uuid(),
 programme_version_id uuid not null references public.programme_versions(id),
 title text not null,
 position integer not null check(position>0),
 unique(programme_version_id,position),
 unique(id,programme_version_id)
);

create table public.lessons (
 id uuid primary key default gen_random_uuid(),
 module_id uuid not null,
 programme_version_id uuid not null,
 title text not null,
 position integer not null check(position>0),
 foreign key(module_id,programme_version_id) references public.modules(id,programme_version_id),
 unique(module_id,position),
 unique(id,programme_version_id)
);

create table public.lesson_objectives (
 id uuid primary key default gen_random_uuid(),
 lesson_id uuid not null,
 programme_version_id uuid not null,
 description text not null,
 position integer not null check(position>0),
 foreign key(lesson_id,programme_version_id) references public.lessons(id,programme_version_id),
 unique(lesson_id,position)
);

create table public.cohorts (
 id uuid primary key default gen_random_uuid(),
 programme_version_id uuid not null references public.programme_versions(id),
 title text not null,
 starts_on date not null,
 unique(id,programme_version_id)
);

create table public.enrolments (
 id uuid primary key default gen_random_uuid(),
 student_id uuid not null references public.student_profiles(user_id),
 cohort_id uuid not null,
 programme_version_id uuid not null references public.programme_versions(id),
 status text not null default 'ACTIVE' check(status in ('ACTIVE','PAUSED','COMPLETED','WITHDRAWN')),
 enrolled_at timestamptz not null default now(),
 foreign key(cohort_id,programme_version_id) references public.cohorts(id,programme_version_id),
 unique(student_id,cohort_id)
);

create table public.counsellor_assignments (
 id uuid primary key default gen_random_uuid(),
 student_id uuid not null references public.student_profiles(user_id),
 counsellor_id uuid not null references public.staff_profiles(user_id),
 starts_at timestamptz not null default now(),
 ended_at timestamptz,
 check(student_id<>counsellor_id),
 check(ended_at is null or ended_at>=starts_at)
);

create table public.student_support_profiles (
 student_id uuid primary key references public.student_profiles(user_id),
 study_goal text not null default '' check(length(study_goal)<=1000),
 weekly_hours integer not null default 0 check(weekly_hours between 0 and 80),
 preferred_contact text not null default 'ACADEMY' check(preferred_contact in ('ACADEMY','EMAIL')),
 updated_at timestamptz not null default now()
);

create table public.study_plans (
 id uuid primary key default gen_random_uuid(),
 student_id uuid not null references public.student_profiles(user_id),
 title text not null,
 status text not null default 'ACTIVE' check(status in ('ACTIVE','ARCHIVED')),
 unique(id,student_id)
);

create table public.study_plan_items (
 id uuid primary key default gen_random_uuid(),
 plan_id uuid not null,
 student_id uuid not null,
 title text not null check(length(trim(title)) between 1 and 200),
 due_on date not null,
 status text not null default 'PLANNED' check(status in ('PLANNED','DONE')),
 created_by uuid not null references public.app_users(id),
 created_at timestamptz not null default now(),
 foreign key(plan_id,student_id) references public.study_plans(id,student_id)
);

create table public.support_events (
 id uuid primary key default gen_random_uuid(),
 student_id uuid not null references public.student_profiles(user_id),
 kind text not null check(kind in ('MISSED_CLASS','DEADLINE_APPROACHING','INACTIVITY','MILESTONE','PLAN_OVERDUE')),
 source_reference text not null,
 deduplication_key text not null unique,
 occurred_at timestamptz not null default now(),
 status text not null default 'OPEN' check(status in ('OPEN','RESOLVED')),
 unique(id,student_id)
);

create table public.support_followups (
 id uuid primary key default gen_random_uuid(),
 student_id uuid not null references public.student_profiles(user_id),
 event_id uuid,
 title text not null check(length(trim(title)) between 1 and 200),
 due_on date not null,
 status text not null default 'OPEN' check(status in ('OPEN','DONE')),
 created_by uuid not null references public.app_users(id),
 created_at timestamptz not null default now(),
 foreign key(event_id,student_id) references public.support_events(id,student_id)
);

create table public.counsellor_interactions (
 id uuid primary key default gen_random_uuid(),
 student_id uuid not null references public.student_profiles(user_id),
 counsellor_id uuid not null references public.staff_profiles(user_id),
 summary text not null check(length(trim(summary)) between 1 and 2000),
 occurred_at timestamptz not null default now()
);

create table public.audit_events (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid references public.app_users(id),
 action text not null,
 target_type text not null,
 target_id uuid not null,
 source text not null default 'DATABASE',
 reason text not null,
 before_state jsonb,
 after_state jsonb,
 occurred_at timestamptz not null default now()
);

create unique index one_active_primary_counsellor on public.counsellor_assignments(student_id) where ended_at is null;
create index counsellor_caseload on public.counsellor_assignments(counsellor_id) where ended_at is null;
create unique index one_active_study_plan on public.study_plans(student_id) where status='ACTIVE';
create function public.guard_curriculum_version() returns trigger language plpgsql set search_path='' as $$
declare old_version uuid; new_version uuid;
begin
 if TG_TABLE_NAME='programme_versions' then
   if OLD.status='PUBLISHED' or exists(select 1 from public.enrolments where programme_version_id=OLD.id) then raise exception 'Published or enrolled curriculum is immutable'; end if;
 else
   if TG_OP <> 'INSERT' then old_version:=OLD.programme_version_id; end if;
   if TG_OP <> 'DELETE' then new_version:=NEW.programme_version_id; end if;
   if exists(select 1 from public.programme_versions v where v.id in(old_version,new_version) and (v.status='PUBLISHED' or exists(select 1 from public.enrolments e where e.programme_version_id=v.id))) then raise exception 'Published or enrolled curriculum is immutable'; end if;
 end if;
 if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;
create trigger freeze_version before update or delete on public.programme_versions for each row execute function public.guard_curriculum_version();
create trigger freeze_content before insert or update or delete on public.modules for each row execute function public.guard_curriculum_version();
create trigger freeze_content before insert or update or delete on public.lessons for each row execute function public.guard_curriculum_version();
create trigger freeze_content before insert or update or delete on public.lesson_objectives for each row execute function public.guard_curriculum_version();
alter table public.app_users enable row level security;
revoke all on public.app_users from anon, authenticated;
alter table public.role_grants enable row level security;
revoke all on public.role_grants from anon, authenticated;
alter table public.student_profiles enable row level security;
revoke all on public.student_profiles from anon, authenticated;
alter table public.staff_profiles enable row level security;
revoke all on public.staff_profiles from anon, authenticated;
alter table public.programmes enable row level security;
revoke all on public.programmes from anon, authenticated;
alter table public.programme_versions enable row level security;
revoke all on public.programme_versions from anon, authenticated;
alter table public.modules enable row level security;
revoke all on public.modules from anon, authenticated;
alter table public.lessons enable row level security;
revoke all on public.lessons from anon, authenticated;
alter table public.lesson_objectives enable row level security;
revoke all on public.lesson_objectives from anon, authenticated;
alter table public.cohorts enable row level security;
revoke all on public.cohorts from anon, authenticated;
alter table public.enrolments enable row level security;
revoke all on public.enrolments from anon, authenticated;
alter table public.counsellor_assignments enable row level security;
revoke all on public.counsellor_assignments from anon, authenticated;
alter table public.student_support_profiles enable row level security;
revoke all on public.student_support_profiles from anon, authenticated;
alter table public.study_plans enable row level security;
revoke all on public.study_plans from anon, authenticated;
alter table public.study_plan_items enable row level security;
revoke all on public.study_plan_items from anon, authenticated;
alter table public.support_events enable row level security;
revoke all on public.support_events from anon, authenticated;
alter table public.support_followups enable row level security;
revoke all on public.support_followups from anon, authenticated;
alter table public.counsellor_interactions enable row level security;
revoke all on public.counsellor_interactions from anon, authenticated;
alter table public.audit_events enable row level security;
revoke all on public.audit_events from anon, authenticated;
revoke all on function public.guard_curriculum_version() from public;
create index enrolments_student on public.enrolments(student_id);
create index study_plan_items_student on public.study_plan_items(student_id);
create index support_events_student on public.support_events(student_id);
create index support_followups_student on public.support_followups(student_id);
create index counsellor_interactions_student on public.counsellor_interactions(student_id);
