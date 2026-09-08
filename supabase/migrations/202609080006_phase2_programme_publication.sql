-- Phase 2 checkpoint 1: governed programme publication with immutable historical metadata.
alter table public.programme_versions
  add column title_snapshot text,
  add column examination_body_snapshot text,
  add column qualification_name_snapshot text,
  add column published_at timestamptz,
  add column published_by uuid references public.app_users(id);

alter table public.programme_versions
  add constraint published_version_requires_snapshot check (
    status = 'DRAFT' or (
      title_snapshot is not null and length(trim(title_snapshot)) > 0 and
      examination_body_snapshot is not null and length(trim(examination_body_snapshot)) > 0 and
      qualification_name_snapshot is not null and length(trim(qualification_name_snapshot)) > 0 and
      published_at is not null
    )
  );

create function public.prepare_programme_publication() returns trigger
language plpgsql set search_path='' as $$
declare
  programme_record public.programmes%rowtype;
begin
  if TG_OP = 'INSERT' and NEW.status = 'PUBLISHED' then
    raise exception 'Create programme versions as DRAFT and publish after content validation';
  end if;

  if TG_OP = 'UPDATE' and OLD.status = 'DRAFT' and NEW.status = 'PUBLISHED' then
    if not exists (
      select 1 from public.modules where programme_version_id = NEW.id
    ) then
      raise exception 'Programme version must contain at least one module before publication';
    end if;

    if exists (
      select 1
      from public.modules m
      where m.programme_version_id = NEW.id
        and not exists (
          select 1
          from public.lessons l
          where l.module_id = m.id
            and l.programme_version_id = NEW.id
        )
    ) then
      raise exception 'Every module must contain at least one lesson before publication';
    end if;

    if exists (
      select 1
      from public.lessons l
      where l.programme_version_id = NEW.id
        and not exists (
          select 1
          from public.lesson_objectives o
          where o.lesson_id = l.id
            and o.programme_version_id = NEW.id
        )
    ) then
      raise exception 'Every lesson must contain at least one objective before publication';
    end if;

    select * into programme_record
    from public.programmes
    where id = NEW.programme_id;

    if not found then
      raise exception 'Programme not found';
    end if;

    NEW.title_snapshot := programme_record.title;
    NEW.examination_body_snapshot := programme_record.examination_body;
    NEW.qualification_name_snapshot := programme_record.qualification_name;
    NEW.published_at := coalesce(NEW.published_at, now());
    NEW.published_by := coalesce(NEW.published_by, public.current_app_user());
  end if;

  return NEW;
end $$;

revoke all on function public.prepare_programme_publication() from public;

create trigger prepare_programme_publication
before insert or update of status on public.programme_versions
for each row execute function public.prepare_programme_publication();

create function public.publish_programme_version(
  p_version_id uuid,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  current_status text;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded publication reason is required';
  end if;

  select status into current_status
  from public.programme_versions
  where id = p_version_id
  for update;

  if not found then
    raise exception 'Programme version not found';
  end if;

  if current_status = 'PUBLISHED' then
    return p_version_id;
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  update public.programme_versions
  set status = 'PUBLISHED', published_by = actor
  where id = p_version_id;

  return p_version_id;
end $$;

revoke all on function public.publish_programme_version(uuid,text) from public;
grant execute on function public.publish_programme_version(uuid,text) to authenticated;
