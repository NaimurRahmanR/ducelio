-- Phase 2 checkpoint 7: versioned learning resources and lecture notes.

create table public.learning_resources (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null,
  programme_version_id uuid not null,
  kind text not null check(kind in ('LECTURE_NOTE','REFERENCE_LINK')),
  title text not null check(length(trim(title)) between 1 and 200),
  body text,
  url text,
  position integer not null check(position > 0),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  foreign key(lesson_id, programme_version_id)
    references public.lessons(id, programme_version_id),
  unique(lesson_id, position),
  check(
    (kind = 'LECTURE_NOTE' and body is not null and length(trim(body)) between 1 and 12000 and url is null)
    or
    (kind = 'REFERENCE_LINK' and url is not null and url ~ '^https://[^[:space:]]+$' and body is null)
  )
);

create trigger freeze_content
before insert or update or delete on public.learning_resources
for each row execute function public.guard_curriculum_version();

alter table public.learning_resources enable row level security;
revoke all on public.learning_resources from anon, authenticated;
grant select on public.learning_resources to authenticated;
create policy read_permitted on public.learning_resources
for select to authenticated using (public.can_read_version(programme_version_id));

create function public.create_learning_resource(
  p_lesson_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_url text,
  p_position integer,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  version_id uuid;
  version_status text;
  result uuid;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_kind not in ('LECTURE_NOTE','REFERENCE_LINK') then
    raise exception 'Unsupported learning resource kind';
  end if;

  if p_title is null or length(trim(p_title)) not between 1 and 200 then
    raise exception 'A bounded learning resource title is required';
  end if;

  if p_position is null or p_position < 1 then
    raise exception 'Learning resource position must be positive';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded curriculum-change reason is required';
  end if;

  if p_kind = 'LECTURE_NOTE' then
    if p_body is null or length(trim(p_body)) not between 1 and 12000 or p_url is not null then
      raise exception 'Lecture notes require body text and no URL';
    end if;
  else
    if p_url is null or p_url !~ '^https://[^[:space:]]+$' or p_body is not null then
      raise exception 'Reference links require a valid HTTPS URL and no body text';
    end if;
  end if;

  select l.programme_version_id, v.status
  into version_id, version_status
  from public.lessons l
  join public.programme_versions v on v.id = l.programme_version_id
  where l.id = p_lesson_id
  for update of v;

  if not found then
    raise exception 'Lesson not found';
  end if;

  if version_status <> 'DRAFT' then
    raise exception 'Learning resources can only be changed on draft programme versions';
  end if;

  if exists(
    select 1 from public.enrolments where programme_version_id = version_id
  ) then
    raise exception 'Enrolled curriculum is immutable';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  insert into public.learning_resources(
    lesson_id, programme_version_id, kind, title, body, url, position, created_by
  ) values(
    p_lesson_id, version_id, p_kind, trim(p_title),
    case when p_kind='LECTURE_NOTE' then trim(p_body) else null end,
    case when p_kind='REFERENCE_LINK' then trim(p_url) else null end,
    p_position, actor
  ) returning id into result;

  return result;
end $$;

revoke all on function public.create_learning_resource(uuid,text,text,text,text,integer,text) from public;
grant execute on function public.create_learning_resource(uuid,text,text,text,text,integer,text) to authenticated;

create trigger audit_change
after insert or update or delete on public.learning_resources
for each row execute function public.audit_institutional_change();
