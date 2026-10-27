-- Learner services (docs/61 section 4): profile, private files and lab
-- evidence, email outbox, push reminders, support messages, certificates and
-- payment receipts.
--
-- Deny by default: every new table has RLS enabled, no policies and no client
-- grants. Learners reach their own rows only through SECURITY DEFINER RPCs
-- that resolve identity from public.current_app_user(); a client-supplied
-- learner id is never accepted. Organisation reviewers read lab evidence only
-- through academy_private.can_review_course (migration 070), so a reviewer of
-- one organisation never reads another organisation's learners.
--
-- Delivery is honest: an email stays QUEUED until a provider acknowledgement
-- is recorded through the HMAC-attested dispatcher surface (the reviewed
-- commerce controller keys under a distinct purpose tag); a push reminder is
-- SENT only after the push service accepted it. Nothing here depends on
-- migration 075.
begin;

create schema learner_private;
revoke all on schema learner_private from public, anon, authenticated, service_role;

-- ==========================================================================
-- Section 1: private helpers.
-- ==========================================================================
-- Single-line text: trimmed, bounded, no control characters.
create function learner_private.line(p_value text, p_min integer, p_max integer) returns text
language plpgsql immutable set search_path='' as $$
declare v text := nullif(btrim(p_value), '');
begin
  if v is null then
    if p_min > 0 then raise exception 'INVALID_INPUT'; end if;
    return null;
  end if;
  if length(v) > p_max or length(v) < greatest(p_min, 1) or v ~ '[\x01-\x1F\x7F]' then raise exception 'INVALID_INPUT'; end if;
  return v;
end $$;

-- Multi-line prose: line breaks and tabs kept, other control characters refused.
create function learner_private.prose(p_value text, p_min integer, p_max integer, p_trim boolean default true) returns text
language plpgsql immutable set search_path='' as $$
declare v text := case when p_trim then nullif(btrim(p_value, E' \r\n\t'), '') else nullif(p_value, '') end;
begin
  if v is null then
    if p_min > 0 then raise exception 'INVALID_INPUT'; end if;
    return null;
  end if;
  if length(v) > p_max or length(v) < greatest(p_min, 1) or v ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' then raise exception 'INVALID_INPUT'; end if;
  return v;
end $$;

-- 'YYYY-MM' to the first day of that month, within 1900-01 .. 10 years ahead.
create function learner_private.month(p_value text) returns date
language plpgsql stable set search_path='' as $$
declare v date;
begin
  if p_value is null or btrim(p_value) = '' then return null; end if;
  if p_value !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'INVALID_INPUT'; end if;
  v := to_date(p_value || '-01', 'YYYY-MM-DD');
  if v < date '1900-01-01' or v > (current_date + interval '10 years')::date then raise exception 'INVALID_INPUT'; end if;
  return v;
end $$;

create function learner_private.signature_matches(p_type text, p_bytes bytea) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(case p_type
    when 'image/png' then substring(p_bytes from 1 for 8) = '\x89504e470d0a1a0a'::bytea
    when 'image/jpeg' then substring(p_bytes from 1 for 3) = '\xffd8ff'::bytea
    when 'image/webp' then octet_length(p_bytes) >= 12 and substring(p_bytes from 1 for 4) = '\x52494646'::bytea
      and substring(p_bytes from 9 for 4) = '\x57454250'::bytea
    when 'application/pdf' then substring(p_bytes from 1 for 5) = '\x255044462d'::bytea
    when 'text/plain' then position('\x00'::bytea in p_bytes) = 0
    else false end, false)
$$;

create function learner_private.valid_utf8(p_bytes bytea) returns boolean
language plpgsql immutable set search_path='' as $$
begin
  perform convert_from(p_bytes, 'UTF8');
  return true;
exception when others then
  return false;
end $$;

create function learner_private.verified_email(p_user uuid) returns text
language sql stable security definer set search_path='' as $$
  select a.email from public.app_users u join auth.users a on a.id = u.auth_user_id
  where u.id = p_user and a.email_confirmed_at is not null and a.email is not null and length(a.email) between 3 and 254
$$;

create function learner_private.verify_dispatch(p_key_id uuid, p_canonical text, p_issued_at bigint, p_expires_at bigint, p_mac text)
returns boolean language sql security definer set search_path='' as $$
  select coalesce(academy_private.verify_claim(p_key_id,
    'DUCELIO_LEARNER_SERVICES_HMAC_SHA256_V1' || E'\n' || p_key_id::text || E'\n' || p_canonical || E'\n'
      || p_issued_at::text || E'\n' || p_expires_at::text,
    p_issued_at, p_expires_at, p_mac, 60), false)
$$;

-- Immutable records: no update or delete, including from definer functions.
create function learner_private.guard_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'IMMUTABLE_HISTORY';
end $$;

-- ==========================================================================
-- Section 2: tables.
-- ==========================================================================
create table public.learner_private_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.app_users(id),
  purpose text not null check (purpose in ('PROFILE_PHOTO','LAB_EVIDENCE')),
  enrolment_id uuid,
  file_name text not null check (file_name ~ '^[A-Za-z0-9._() -]{1,120}$'),
  content_type text not null,
  size_bytes integer not null check (size_bytes between 1 and 1048576),
  sha256 bytea not null check (octet_length(sha256) = 32),
  bytes bytea not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (enrolment_id, owner_id) references public.academy_enrolments(id, learner_id),
  check (octet_length(bytes) = size_bytes),
  check (sha256 = pg_catalog.sha256(bytes)),
  check ((purpose = 'PROFILE_PHOTO' and enrolment_id is null and content_type in ('image/png','image/jpeg','image/webp'))
      or (purpose = 'LAB_EVIDENCE' and enrolment_id is not null
          and content_type in ('image/png','image/jpeg','image/webp','application/pdf','text/plain'))),
  check (learner_private.signature_matches(content_type, bytes)),
  check (content_type <> 'text/plain' or learner_private.valid_utf8(bytes))
);
create index learner_private_files_owner on public.learner_private_files(owner_id, purpose, created_at);

create table public.learner_profiles (
  user_id uuid primary key references public.app_users(id),
  first_name text check (first_name is null or length(first_name) between 1 and 60),
  last_name text check (last_name is null or length(last_name) between 1 and 60),
  photo_file_id uuid unique references public.learner_private_files(id),
  updated_at timestamptz not null default clock_timestamp(),
  check ((first_name is null) = (last_name is null)),
  check (first_name is null or length(first_name) + length(last_name) <= 99)
);

create table public.learner_profile_education (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.learner_profiles(user_id),
  sort_order integer not null check (sort_order between 1 and 20),
  institution text not null check (length(institution) between 1 and 150),
  qualification text not null check (length(qualification) between 1 and 150),
  field_of_study text check (field_of_study is null or length(field_of_study) between 1 and 150),
  start_month date not null check (extract(day from start_month) = 1),
  end_month date check (end_month is null or extract(day from end_month) = 1),
  currently_studying boolean not null,
  grade text check (grade is null or length(grade) between 1 and 50),
  description text check (description is null or length(description) between 1 and 2000),
  unique (user_id, sort_order),
  check ((currently_studying and end_month is null) or (not currently_studying and end_month is not null and end_month >= start_month))
);

create table public.learner_profile_employment (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.learner_profiles(user_id),
  sort_order integer not null check (sort_order between 1 and 20),
  employer text not null check (length(employer) between 1 and 150),
  job_title text not null check (length(job_title) between 1 and 150),
  start_month date not null check (extract(day from start_month) = 1),
  end_month date check (end_month is null or extract(day from end_month) = 1),
  is_current boolean not null,
  description text check (description is null or length(description) between 1 and 2000),
  unique (user_id, sort_order),
  check ((is_current and end_month is null) or (not is_current and end_month is not null and end_month >= start_month))
);

-- Evidence a learner attaches to a practical. It never changes the lab
-- submission or its marks (academy_lab_submissions stays authoritative).
create table public.learner_lab_evidence (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null,
  learner_id uuid not null,
  lab_ref text not null check (length(lab_ref) between 1 and 80),
  code_text text check (code_text is null or length(code_text) between 1 and 20000),
  request_key uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (enrolment_id, learner_id) references public.academy_enrolments(id, learner_id),
  unique (enrolment_id, lab_ref),
  unique (enrolment_id, request_key)
);
create table public.learner_lab_evidence_files (
  evidence_id uuid not null references public.learner_lab_evidence(id),
  position integer not null check (position between 1 and 5),
  file_id uuid not null unique references public.learner_private_files(id),
  primary key (evidence_id, position)
);

create table public.learner_email_outbox (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key ~ '^[A-Z_]{3,40}:[A-Za-z0-9:_-]{1,160}$'),
  kind text not null check (kind in ('SUPPORT_MESSAGE','CERTIFICATE_ISSUED','PAYMENT_RECEIPT')),
  learner_id uuid references public.app_users(id),
  recipient text not null check (length(recipient) between 3 and 254 and recipient ~ '^[^@[:space:]<>,;]+@[^@[:space:]<>,;]+$'),
  reply_to text check (reply_to is null or (length(reply_to) between 3 and 254 and reply_to ~ '^[^@[:space:]<>,;]+@[^@[:space:]<>,;]+$')),
  subject text not null check (length(subject) between 1 and 200 and subject !~ '[\r\n]'),
  body_text text not null check (length(body_text) between 1 and 20000),
  attachment_kind text check (attachment_kind in ('CERTIFICATE','RECEIPT')),
  attachment_id uuid,
  status text not null default 'QUEUED' check (status in ('QUEUED','SENT','FAILED')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz not null default clock_timestamp(),
  claimed_until timestamptz,
  last_error text check (last_error is null or length(last_error) between 1 and 500),
  provider_message_id text check (provider_message_id is null or length(provider_message_id) between 1 and 200),
  sent_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check ((attachment_kind is null) = (attachment_id is null)),
  check ((status = 'SENT') = (sent_at is not null)),
  check (status <> 'SENT' or provider_message_id is not null)
);
create index learner_email_outbox_due on public.learner_email_outbox(next_attempt_at) where status = 'QUEUED';

-- Push endpoints are restricted to the major browser push services so the
-- server never posts to an arbitrary (internal) URL.
create table public.learner_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id),
  endpoint text not null unique check (length(endpoint) between 20 and 1000 and endpoint ~ ('^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[^[:space:]]+$')),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_+/-]{40,200}={0,2}$'),
  auth_secret text not null check (auth_secret ~ '^[A-Za-z0-9_+/-]{8,100}={0,2}$'),
  expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  last_success_at timestamptz
);
create index learner_push_subscriptions_user on public.learner_push_subscriptions(user_id);

create table public.learner_activity_reminders (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references public.app_users(id),
  enrolment_id uuid not null references public.academy_enrolments(id),
  schedule_id uuid not null references public.academy_schedules(id),
  item_id uuid not null references public.academy_schedule_items(id),
  subscription_id uuid not null references public.learner_push_subscriptions(id) on delete cascade,
  kind text not null check (kind in ('LESSON','LAB','REVISION','ASSESSMENT')),
  starts_at timestamptz not null,
  due_at timestamptz not null,
  status text not null default 'PENDING' check (status in ('PENDING','SENT','CANCELLED','FAILED')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  next_attempt_at timestamptz not null,
  claimed_until timestamptz,
  sent_at timestamptz,
  cancelled_reason text check (cancelled_reason in ('SCHEDULE_REVISED','ACCESS_REVOKED','STARTED','SUBSCRIPTION_EXPIRED')),
  last_error text check (last_error is null or length(last_error) between 1 and 300),
  created_at timestamptz not null default clock_timestamp(),
  unique (item_id, subscription_id),
  check (due_at = starts_at - interval '15 minutes'),
  check ((status = 'SENT') = (sent_at is not null)),
  check ((status = 'CANCELLED') = (cancelled_reason is not null))
);
create index learner_activity_reminders_due on public.learner_activity_reminders(due_at) where status = 'PENDING';
create index learner_activity_reminders_subscription on public.learner_activity_reminders(subscription_id, enrolment_id, starts_at);

create table public.learner_support_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.app_users(id),
  category text not null check (category in ('COURSE_CONTENT','TECHNICAL','BILLING','ACCOUNT','FEEDBACK','OTHER')),
  subject text not null check (length(subject) between 3 and 150 and subject !~ '[\r\n]'),
  message text not null check (length(message) between 10 and 5000),
  enrolment_id uuid,
  activity_ref text check (activity_ref is null or length(activity_ref) between 1 and 80),
  request_key uuid not null,
  outbox_id uuid references public.learner_email_outbox(id),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (enrolment_id, sender_id) references public.academy_enrolments(id, learner_id),
  unique (sender_id, request_key)
);
create index learner_support_messages_sender on public.learner_support_messages(sender_id, created_at);

-- Issued only from a real completion row; the foreign key makes a
-- certificate without academy_completions impossible.
create table public.learner_certificates (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null unique references public.academy_completions(enrolment_id),
  learner_id uuid not null references public.app_users(id),
  verification_code text not null unique check (verification_code ~ '^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$'),
  learner_name text not null check (length(learner_name) between 1 and 100),
  course_title text not null check (length(course_title) between 1 and 200),
  issuer_name text not null check (length(issuer_name) between 1 and 150),
  examination_body text check (examination_body is null or length(examination_body) between 1 and 200),
  qualification_name text check (qualification_name is null or length(qualification_name) between 1 and 200),
  completed_at timestamptz not null,
  issued_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or length(revoked_reason) between 5 and 300),
  check ((revoked_at is null) = (revoked_reason is null))
);

create sequence learner_private.receipt_number_seq;
create table public.learner_payment_receipts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.academy_orders(id),
  learner_id uuid not null references public.app_users(id),
  receipt_number text not null unique check (receipt_number ~ '^DUC-R-[0-9]{4}-[0-9]{6,}$'),
  issued_at timestamptz not null default clock_timestamp()
);

-- Certificates may only gain a revocation; every other field is fixed.
create function learner_private.guard_certificate() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op = 'DELETE' or old.revoked_at is not null
    or (to_jsonb(new) - array['revoked_at','revoked_reason']) <> (to_jsonb(old) - array['revoked_at','revoked_reason']) then
    raise exception 'IMMUTABLE_HISTORY';
  end if;
  return new;
end $$;
create trigger guard_certificate before update or delete on public.learner_certificates
  for each row execute function learner_private.guard_certificate();
do $$ declare t text; begin
  foreach t in array array['learner_lab_evidence','learner_lab_evidence_files','learner_support_messages','learner_payment_receipts'] loop
    execute format('create trigger guard_immutable before update or delete on public.%I for each row execute function learner_private.guard_immutable()', t);
  end loop;
  foreach t in array array['learner_private_files','learner_profiles','learner_profile_education','learner_profile_employment',
    'learner_lab_evidence','learner_lab_evidence_files','learner_email_outbox','learner_push_subscriptions',
    'learner_activity_reminders','learner_support_messages','learner_certificates','learner_payment_receipts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;
revoke all on sequence learner_private.receipt_number_seq from public, anon, authenticated, service_role;

-- ==========================================================================
-- Section 3: shared projections and internal services.
-- ==========================================================================
create function learner_private.learner_name(p_user uuid) returns text
language sql stable security definer set search_path='' as $$
  select coalesce((select p.first_name || ' ' || p.last_name from public.learner_profiles p where p.user_id = p_user and p.first_name is not null),
    (select u.display_name from public.app_users u where u.id = p_user))
$$;

create function learner_private.course_provider(p_course uuid) returns text
language sql stable security definer set search_path='' as $$
  select coalesce((select o.name from public.course_engine_publications p join public.course_engine_organisations o on o.id = p.organisation_id
    where p.course_id = p_course), 'Ducelio')
$$;

create function learner_private.delivery(p_outbox uuid) returns text
language sql stable security definer set search_path='' as $$
  select coalesce((select status from public.learner_email_outbox where id = p_outbox), 'NOT_QUEUED')
$$;

create function learner_private.enqueue_email(p_key text, p_kind text, p_learner uuid, p_recipient text, p_reply_to text,
  p_subject text, p_body text, p_attachment_kind text, p_attachment_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  insert into public.learner_email_outbox(idempotency_key, kind, learner_id, recipient, reply_to, subject, body_text, attachment_kind, attachment_id)
  values (p_key, p_kind, p_learner, p_recipient, p_reply_to, p_subject, p_body, p_attachment_kind, p_attachment_id)
  on conflict (idempotency_key) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.learner_email_outbox where idempotency_key = p_key; end if;
  return v_id;
end $$;

create function learner_private.certificate_json(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('certificateId', c.id, 'enrolmentId', c.enrolment_id, 'verificationCode', c.verification_code,
    'learnerName', c.learner_name, 'courseTitle', c.course_title, 'issuerName', c.issuer_name,
    'examinationBody', c.examination_body, 'qualificationName', c.qualification_name,
    'completedAt', c.completed_at, 'issuedAt', c.issued_at, 'revoked', c.revoked_at is not null, 'revokedAt', c.revoked_at,
    'emailDelivery', learner_private.delivery((select o.id from public.learner_email_outbox o where o.idempotency_key = 'CERTIFICATE:' || c.id::text)))
  from public.learner_certificates c where c.id = p_id
$$;

create function learner_private.receipt_json(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('receiptId', r.id, 'receiptNumber', r.receipt_number, 'issuedAt', r.issued_at, 'orderId', o.id,
    'courseTitle', c.title, 'provider', learner_private.course_provider(o.course_id),
    'learnerName', learner_private.learner_name(o.learner_id),
    'amountMinor', o.amount_minor, 'currency', o.currency,
    'listAmountMinor', t.list_amount_minor, 'discountMinor', t.discount_amount_minor,
    'paidAt', (select min(pe.recorded_at) from public.academy_payment_events pe where pe.order_id = o.id and pe.status = 'PAID'),
    'refund', (select jsonb_build_object('amountMinor', f.amount_minor, 'currency', f.currency, 'refundedAt', f.verified_at)
      from public.academy_order_refunds f where f.order_id = o.id),
    'emailDelivery', learner_private.delivery((select x.id from public.learner_email_outbox x where x.idempotency_key = 'RECEIPT:' || r.id::text)))
  from public.learner_payment_receipts r join public.academy_orders o on o.id = r.order_id
  join public.academy_courses c on c.id = o.course_id
  left join public.course_engine_order_terms t on t.order_id = o.id
  where r.id = p_id
$$;

-- Receipt authority: FULFILLED order plus a verified PAID payment event for
-- the order's own amount and currency. Idempotent under an order lock.
create function learner_private.issue_receipt(p_order_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare o public.academy_orders%rowtype; v_id uuid; v_email text; v_title text; v_number text;
begin
  select * into o from public.academy_orders where id = p_order_id;
  if not found or o.state <> 'FULFILLED' then return null; end if;
  if not exists (select 1 from public.academy_payment_events pe where pe.order_id = o.id and pe.status = 'PAID'
      and pe.amount_minor = o.amount_minor and pe.currency = o.currency) then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('LEARNER_RECEIPT:' || o.id::text, 0));
  select id into v_id from public.learner_payment_receipts where order_id = o.id;
  if found then return v_id; end if;
  v_number := 'DUC-R-' || to_char(clock_timestamp() at time zone 'UTC', 'YYYY') || '-' || lpad(nextval('learner_private.receipt_number_seq')::text, 6, '0');
  insert into public.learner_payment_receipts(order_id, learner_id, receipt_number) values (o.id, o.learner_id, v_number) returning id into v_id;
  select title into v_title from public.academy_courses where id = o.course_id;
  v_email := learner_private.verified_email(o.learner_id);
  if v_email is not null then
    perform learner_private.enqueue_email('RECEIPT:' || v_id::text, 'PAYMENT_RECEIPT', o.learner_id, v_email, null,
      'Your Ducelio payment receipt ' || v_number,
      'Hello ' || learner_private.learner_name(o.learner_id) || ',' || E'\n\n'
        || 'Thank you for your payment for "' || v_title || '". Your receipt ' || v_number || ' is attached.' || E'\n\n'
        || 'You can also download it from your Ducelio account: {{APP_URL}}/student/profile' || E'\n\n' || 'Ducelio',
      'RECEIPT', v_id);
  end if;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (null, 'LEARNER_RECEIPT_ISSUED', 'learner_payment_receipts', v_id, 'LEARNER_SERVICES_V1', 'Receipt issued for a verified paid order',
    jsonb_build_object('order_id', o.id, 'receipt_number', v_number, 'email_queued', v_email is not null));
  return v_id;
end $$;

-- Issue at fulfilment time without ever blocking a verified fulfilment; the
-- learner-facing RPCs re-issue idempotently if this was deferred.
create function learner_private.issue_receipt_on_fulfilment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  begin
    perform learner_private.issue_receipt(new.id);
  exception when others then
    raise warning 'LEARNER_RECEIPT_DEFERRED';
  end;
  return null;
end $$;
create trigger learner_receipt_on_fulfilment after update of state on public.academy_orders
  for each row when (new.state = 'FULFILLED' and old.state is distinct from 'FULFILLED')
  execute function learner_private.issue_receipt_on_fulfilment();

-- Reminder materialisation from the CURRENT schedules only. Reminders of a
-- superseded schedule are cancelled; the revised schedule's items (new ids)
-- receive fresh reminders, and an occurrence already reminded on the same
-- subscription (an item carried unchanged into a revision) is not repeated.
create function learner_private.sync_reminders(p_learner uuid, p_until timestamptz) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  update public.learner_activity_reminders r set status = 'CANCELLED', cancelled_reason = 'SCHEDULE_REVISED', claimed_until = null
  where r.status = 'PENDING' and (p_learner is null or r.learner_id = p_learner)
    and exists (select 1 from public.academy_schedules s where s.id = r.schedule_id and s.superseded_at is not null);
  update public.learner_activity_reminders r set status = 'CANCELLED', cancelled_reason = 'ACCESS_REVOKED', claimed_until = null
  where r.status = 'PENDING' and (p_learner is null or r.learner_id = p_learner)
    and exists (select 1 from public.academy_enrolments e join public.academy_entitlements ent on ent.id = e.entitlement_id
      where e.id = r.enrolment_id and (ent.state <> 'ACTIVE' or e.status <> 'ACTIVE'));
  update public.learner_activity_reminders r set status = 'CANCELLED', cancelled_reason = 'STARTED', claimed_until = null
  where r.status = 'PENDING' and (p_learner is null or r.learner_id = p_learner) and r.starts_at <= clock_timestamp();
  update public.learner_activity_reminders r set status = 'CANCELLED', cancelled_reason = 'SUBSCRIPTION_EXPIRED', claimed_until = null
  where r.status = 'PENDING' and (p_learner is null or r.learner_id = p_learner)
    and exists (select 1 from public.learner_push_subscriptions s where s.id = r.subscription_id and s.expires_at <= clock_timestamp());
  insert into public.learner_activity_reminders(learner_id, enrolment_id, schedule_id, item_id, subscription_id, kind, starts_at, due_at, next_attempt_at)
  select e.learner_id, e.id, s.id, i.id, sub.id, i.kind, i.starts_at, i.starts_at - interval '15 minutes', i.starts_at - interval '15 minutes'
  from public.learner_push_subscriptions sub
  join public.academy_enrolments e on e.learner_id = sub.user_id and e.status = 'ACTIVE'
  join public.academy_entitlements ent on ent.id = e.entitlement_id and ent.state = 'ACTIVE'
  join public.academy_schedules s on s.enrolment_id = e.id and s.superseded_at is null
  join public.academy_schedule_items i on i.schedule_id = s.id
  where (p_learner is null or sub.user_id = p_learner)
    and (sub.expires_at is null or sub.expires_at > clock_timestamp())
    and i.starts_at > clock_timestamp() and i.starts_at <= p_until
    and not exists (select 1 from public.learner_activity_reminders x where x.subscription_id = sub.id and x.enrolment_id = e.id
      and x.starts_at = i.starts_at and x.status = 'SENT')
  on conflict (item_id, subscription_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ==========================================================================
-- Section 4: profile.
-- ==========================================================================
create function public.get_my_learner_profile() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); p public.learner_profiles%rowtype;
begin
  select * into p from public.learner_profiles where user_id = actor;
  return jsonb_build_object(
    'displayName', (select display_name from public.app_users where id = actor),
    'firstName', p.first_name, 'lastName', p.last_name,
    'email', learner_private.verified_email(actor),
    'studentNumber', (select student_number from public.student_profiles where user_id = actor),
    'photo', (select jsonb_build_object('fileId', f.id, 'contentType', f.content_type, 'sizeBytes', f.size_bytes, 'uploadedAt', f.created_at)
      from public.learner_private_files f where f.id = p.photo_file_id),
    'education', coalesce((select jsonb_agg(jsonb_build_object('institution', x.institution, 'qualification', x.qualification,
        'fieldOfStudy', x.field_of_study, 'startMonth', to_char(x.start_month, 'YYYY-MM'), 'endMonth', to_char(x.end_month, 'YYYY-MM'),
        'currentlyStudying', x.currently_studying, 'grade', x.grade, 'description', x.description) order by x.sort_order)
      from public.learner_profile_education x where x.user_id = actor), '[]'),
    'employment', coalesce((select jsonb_agg(jsonb_build_object('employer', x.employer, 'position', x.job_title,
        'startMonth', to_char(x.start_month, 'YYYY-MM'), 'endMonth', to_char(x.end_month, 'YYYY-MM'),
        'current', x.is_current, 'description', x.description) order by x.sort_order)
      from public.learner_profile_employment x where x.user_id = actor), '[]'),
    'updatedAt', p.updated_at);
end $$;

create function public.save_my_learner_profile(p_first_name text, p_last_name text, p_education jsonb, p_employment jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); fn text; ln text; x jsonb; i integer;
  edu_count integer; emp_count integer;
begin
  perform 1 from public.student_profiles where user_id = actor for update;
  begin
    fn := learner_private.line(p_first_name, 1, 60);
    ln := learner_private.line(p_last_name, 1, 60);
    if length(fn) + length(ln) > 99 then raise exception 'INVALID_INPUT'; end if;
    if p_education is null or jsonb_typeof(p_education) <> 'array' or jsonb_array_length(p_education) > 20
      or p_employment is null or jsonb_typeof(p_employment) <> 'array' or jsonb_array_length(p_employment) > 20 then
      raise exception 'INVALID_INPUT';
    end if;
    insert into public.learner_profiles(user_id, first_name, last_name) values (actor, fn, ln)
    on conflict (user_id) do update set first_name = excluded.first_name, last_name = excluded.last_name, updated_at = clock_timestamp();
    delete from public.learner_profile_education where user_id = actor;
    delete from public.learner_profile_employment where user_id = actor;
    i := 0;
    for x in select value from jsonb_array_elements(p_education) loop
      i := i + 1;
      if jsonb_typeof(x) <> 'object' or jsonb_typeof(coalesce(x->'currentlyStudying', 'false')) <> 'boolean' then raise exception 'INVALID_INPUT'; end if;
      insert into public.learner_profile_education(user_id, sort_order, institution, qualification, field_of_study, start_month, end_month,
        currently_studying, grade, description)
      values (actor, i, learner_private.line(x->>'institution', 1, 150), learner_private.line(x->>'qualification', 1, 150),
        learner_private.line(x->>'fieldOfStudy', 0, 150), learner_private.month(x->>'startMonth'), learner_private.month(x->>'endMonth'),
        coalesce((x->>'currentlyStudying')::boolean, false), learner_private.line(x->>'grade', 0, 50),
        learner_private.prose(x->>'description', 0, 2000));
    end loop;
    i := 0;
    for x in select value from jsonb_array_elements(p_employment) loop
      i := i + 1;
      if jsonb_typeof(x) <> 'object' or jsonb_typeof(coalesce(x->'current', 'false')) <> 'boolean' then raise exception 'INVALID_INPUT'; end if;
      insert into public.learner_profile_employment(user_id, sort_order, employer, job_title, start_month, end_month, is_current, description)
      values (actor, i, learner_private.line(x->>'employer', 1, 150), learner_private.line(x->>'position', 1, 150),
        learner_private.month(x->>'startMonth'), learner_private.month(x->>'endMonth'),
        coalesce((x->>'current')::boolean, false), learner_private.prose(x->>'description', 0, 2000));
    end loop;
  exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format
    or datetime_field_overflow or string_data_right_truncation or numeric_value_out_of_range then
    raise exception 'INVALID_INPUT';
  end;
  edu_count := jsonb_array_length(p_education);
  emp_count := jsonb_array_length(p_employment);
  -- The learner's own name is their display name everywhere it is shown.
  update public.app_users set display_name = fn || ' ' || ln where id = actor and display_name is distinct from fn || ' ' || ln;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'LEARNER_PROFILE_SAVED', 'learner_profiles', actor, 'LEARNER_SERVICES_V1', 'Learner updated their profile',
    jsonb_build_object('education_entries', edu_count, 'employment_entries', emp_count));
  return public.get_my_learner_profile();
end $$;

-- ==========================================================================
-- Section 5: private files and lab evidence.
-- ==========================================================================
create function public.upload_my_private_file(p_purpose text, p_enrolment_id uuid, p_file_name text, p_content_type text, p_content_base64 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); v_bytes bytea; v_id uuid; v_prior uuid; v_name text;
  e public.academy_enrolments%rowtype;
begin
  if p_purpose is null or p_purpose not in ('PROFILE_PHOTO','LAB_EVIDENCE') or p_content_type is null or p_content_base64 is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_FILE');
  end if;
  if length(p_content_base64) > 1398200 then return jsonb_build_object('ok', false, 'code', 'FILE_TOO_LARGE'); end if;
  begin
    v_bytes := decode(p_content_base64, 'base64');
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_FILE');
  end;
  if octet_length(v_bytes) = 0 then return jsonb_build_object('ok', false, 'code', 'EMPTY_FILE'); end if;
  if octet_length(v_bytes) > 1048576 then return jsonb_build_object('ok', false, 'code', 'FILE_TOO_LARGE'); end if;
  if p_purpose = 'PROFILE_PHOTO' then
    if p_enrolment_id is not null or p_content_type not in ('image/png','image/jpeg','image/webp') then
      return jsonb_build_object('ok', false, 'code', 'UNSUPPORTED_TYPE');
    end if;
  else
    e := academy_private.my_enrolment(p_enrolment_id, false);
    if p_content_type not in ('image/png','image/jpeg','image/webp','application/pdf','text/plain') then
      return jsonb_build_object('ok', false, 'code', 'UNSUPPORTED_TYPE');
    end if;
    if (select count(*) from public.learner_private_files f where f.owner_id = actor and f.purpose = 'LAB_EVIDENCE'
        and not exists (select 1 from public.learner_lab_evidence_files ef where ef.file_id = f.id)) >= 10 then
      return jsonb_build_object('ok', false, 'code', 'QUOTA_EXCEEDED');
    end if;
  end if;
  if not learner_private.signature_matches(p_content_type, v_bytes)
    or (p_content_type = 'text/plain' and not learner_private.valid_utf8(v_bytes)) then
    return jsonb_build_object('ok', false, 'code', 'TYPE_MISMATCH');
  end if;
  v_name := left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._() -]', '_', 'g')), 120);
  if v_name = '' then v_name := 'file'; end if;
  insert into public.learner_private_files(owner_id, purpose, enrolment_id, file_name, content_type, size_bytes, sha256, bytes)
  values (actor, p_purpose, e.id, v_name, p_content_type, octet_length(v_bytes), pg_catalog.sha256(v_bytes), v_bytes) returning id into v_id;
  if p_purpose = 'PROFILE_PHOTO' then
    insert into public.learner_profiles(user_id) values (actor) on conflict (user_id) do nothing;
    select photo_file_id into v_prior from public.learner_profiles where user_id = actor for update;
    update public.learner_profiles set photo_file_id = v_id, updated_at = clock_timestamp() where user_id = actor;
    if v_prior is not null then delete from public.learner_private_files where id = v_prior; end if;
  end if;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'LEARNER_FILE_UPLOADED', 'learner_private_files', v_id, 'LEARNER_SERVICES_V1', 'Learner uploaded a private file',
    jsonb_build_object('purpose', p_purpose, 'content_type', p_content_type, 'size_bytes', octet_length(v_bytes), 'enrolment_id', e.id));
  return jsonb_build_object('ok', true, 'fileId', v_id, 'fileName', v_name, 'contentType', p_content_type,
    'sizeBytes', octet_length(v_bytes), 'sha256', encode(pg_catalog.sha256(v_bytes), 'hex'));
end $$;

-- Owner, or (lab evidence only, once attached) a reviewer of the course's
-- own organisation. A profile photo is never readable by anyone else.
create function public.read_private_file(p_file_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); f public.learner_private_files%rowtype;
begin
  if actor is null then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into f from public.learner_private_files where id = p_file_id;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if f.owner_id is distinct from actor and not (f.purpose = 'LAB_EVIDENCE' and exists (
      select 1 from public.learner_lab_evidence_files ef join public.learner_lab_evidence ev on ev.id = ef.evidence_id
      join public.academy_enrolments e on e.id = ev.enrolment_id
      where ef.file_id = f.id and academy_private.can_review_course(e.course_id))) then
    raise exception 'NOT_FOUND_OR_FORBIDDEN';
  end if;
  return jsonb_build_object('fileId', f.id, 'fileName', f.file_name, 'contentType', f.content_type, 'sizeBytes', f.size_bytes,
    'sha256', encode(f.sha256, 'hex'), 'createdAt', f.created_at, 'contentBase64', translate(encode(f.bytes, 'base64'), E'\n', ''));
end $$;

-- A profile photo, or a lab file not yet attached to evidence.
create function public.delete_my_private_file(p_file_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); f public.learner_private_files%rowtype;
begin
  select * into f from public.learner_private_files where id = p_file_id and owner_id = actor for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if exists (select 1 from public.learner_lab_evidence_files where file_id = f.id) then
    return jsonb_build_object('ok', false, 'code', 'FILE_ATTACHED');
  end if;
  update public.learner_profiles set photo_file_id = null, updated_at = clock_timestamp() where user_id = actor and photo_file_id = f.id;
  delete from public.learner_private_files where id = f.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'LEARNER_FILE_DELETED', 'learner_private_files', f.id, 'LEARNER_SERVICES_V1', 'Learner deleted a private file',
    jsonb_build_object('purpose', f.purpose));
  return jsonb_build_object('ok', true);
end $$;

-- The caller's uploaded lab files for one enrolment that are not attached to
-- submitted evidence, so an abandoned form can be resumed or cleaned up
-- (unattached uploads count against the upload quota). Metadata only.
create function public.list_my_unattached_lab_files(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, false);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('fileId', f.id, 'fileName', f.file_name, 'contentType', f.content_type,
      'sizeBytes', f.size_bytes) order by f.created_at, f.id)
    from public.learner_private_files f
    where f.owner_id = e.learner_id and f.enrolment_id = e.id and f.purpose = 'LAB_EVIDENCE'
      and not exists (select 1 from public.learner_lab_evidence_files ef where ef.file_id = f.id)), '[]'::jsonb);
end $$;

create function learner_private.evidence_json(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('evidenceId', ev.id, 'enrolmentId', ev.enrolment_id, 'labRef', ev.lab_ref, 'codeText', ev.code_text,
    'createdAt', ev.created_at,
    'files', coalesce((select jsonb_agg(jsonb_build_object('fileId', f.id, 'fileName', f.file_name, 'contentType', f.content_type,
        'sizeBytes', f.size_bytes, 'sha256', encode(f.sha256, 'hex')) order by ef.position)
      from public.learner_lab_evidence_files ef join public.learner_private_files f on f.id = ef.file_id where ef.evidence_id = ev.id), '[]'))
  from public.learner_lab_evidence ev where ev.id = p_id
$$;

create function public.submit_my_lab_evidence(p_enrolment_id uuid, p_lab_ref text, p_file_ids uuid[], p_code_text text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, true);
  prior public.learner_lab_evidence%rowtype; v_id uuid; v_code text; v_files uuid[] := coalesce(p_file_ids, '{}'); i integer;
begin
  if p_request_key is null or p_lab_ref is null or length(p_lab_ref) not between 1 and 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into prior from public.learner_lab_evidence where enrolment_id = e.id and request_key = p_request_key;
  if found then
    if prior.lab_ref <> p_lab_ref then return jsonb_build_object('ok', false, 'code', 'REQUEST_CONFLICT'); end if;
    return jsonb_build_object('ok', true, 'replayed', true, 'evidence', learner_private.evidence_json(prior.id));
  end if;
  -- One governed submission per practical, whichever form made it (the
  -- text-only submit_my_academy_lab writes the same academy_lab_submissions row).
  if exists (select 1 from public.learner_lab_evidence where enrolment_id = e.id and lab_ref = p_lab_ref)
      or exists (select 1 from public.academy_lab_submissions where enrolment_id = e.id and lab_ref = p_lab_ref) then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_EXISTS');
  end if;
  if e.status <> 'ACTIVE' then return jsonb_build_object('ok', false, 'code', 'ENROLMENT_CLOSED'); end if;
  if exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state <> 'ACTIVE') then
    return jsonb_build_object('ok', false, 'code', 'ACCESS_REVOKED');
  end if;
  -- The controlled-assessment firewall and the practical's own window apply
  -- exactly as they do to submit_my_academy_lab.
  if academy_private.exam_active() then return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED'); end if;
  if not exists (select 1 from public.academy_schedule_items i join public.academy_schedules s on s.id = i.schedule_id
      where s.enrolment_id = e.id and s.superseded_at is null and i.kind = 'LAB' and i.ref = p_lab_ref and i.starts_at <= clock_timestamp()) then
    return jsonb_build_object('ok', false, 'code', 'LAB_NOT_OPEN');
  end if;
  if academy_private.unified_enrolment(e.id) and not academy_private.unified_activity_open(e.id, 'LAB', p_lab_ref) then
    return jsonb_build_object('ok', false, 'code', 'WINDOW_CLOSED');
  end if;
  begin
    v_code := learner_private.prose(p_code_text, 0, 20000, false);
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end;
  if v_code is not null and btrim(v_code, E' \r\n\t') = '' then v_code := null; end if;
  if cardinality(v_files) > 5 or (select count(distinct f) from unnest(v_files) f) <> cardinality(v_files) or array_position(v_files, null) is not null then
    return jsonb_build_object('ok', false, 'code', 'TOO_MANY_FILES');
  end if;
  if cardinality(v_files) = 0 and v_code is null then return jsonb_build_object('ok', false, 'code', 'EMPTY_EVIDENCE'); end if;
  if (select count(*) from public.learner_private_files f where f.id = any(v_files) and f.owner_id = e.learner_id
      and f.purpose = 'LAB_EVIDENCE' and f.enrolment_id = e.id
      and not exists (select 1 from public.learner_lab_evidence_files ef where ef.file_id = f.id)) <> cardinality(v_files) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_FILE');
  end if;
  insert into public.learner_lab_evidence(enrolment_id, learner_id, lab_ref, code_text, request_key)
  values (e.id, e.learner_id, p_lab_ref, v_code, p_request_key) returning id into v_id;
  for i in 1..cardinality(v_files) loop
    insert into public.learner_lab_evidence_files(evidence_id, position, file_id) values (v_id, i, v_files[i]);
  end loop;
  -- The governed practical submission that progression, review and marking
  -- read. Its body is the code exactly as written, or, for files only, the
  -- attached file names; the files themselves stay in learner_lab_evidence.
  insert into public.academy_lab_submissions(enrolment_id, learner_id, lab_ref, body, request_key)
  values (e.id, e.learner_id, p_lab_ref,
    coalesce(v_code, 'Practical evidence files: ' || (select string_agg(f.file_name, ', ' order by ef.position)
      from public.learner_lab_evidence_files ef join public.learner_private_files f on f.id = ef.file_id where ef.evidence_id = v_id)),
    p_request_key);
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (e.learner_id, 'LEARNER_LAB_EVIDENCE_SUBMITTED', 'learner_lab_evidence', v_id, 'LEARNER_SERVICES_V1', 'Learner attached practical evidence',
    jsonb_build_object('enrolment_id', e.id, 'lab_ref', p_lab_ref, 'files', cardinality(v_files), 'code_text', v_code is not null));
  return jsonb_build_object('ok', true, 'replayed', false, 'evidence', learner_private.evidence_json(v_id));
end $$;

create function public.get_my_lab_evidence(p_enrolment_id uuid, p_lab_ref text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, false);
begin
  return jsonb_build_object('evidence', learner_private.evidence_json(
    (select id from public.learner_lab_evidence where enrolment_id = e.id and lab_ref = p_lab_ref)));
end $$;

create function public.get_lab_evidence_for_review(p_enrolment_id uuid, p_lab_ref text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); e public.academy_enrolments%rowtype;
begin
  select * into e from public.academy_enrolments where id = p_enrolment_id;
  if actor is null or not found or e.learner_id = actor or not academy_private.can_review_course(e.course_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return jsonb_build_object('evidence', learner_private.evidence_json(
    (select id from public.learner_lab_evidence where enrolment_id = e.id and lab_ref = p_lab_ref)));
end $$;

-- ==========================================================================
-- Section 6: email outbox dispatcher (HMAC-attested, server only).
-- ==========================================================================
create function public.claim_learner_email_batch(p_key_id uuid, p_limit integer, p_issued_at bigint, p_expires_at bigint, p_mac text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 50 or p_key_id is null or p_issued_at is null or p_expires_at is null
    or not learner_private.verify_dispatch(p_key_id, 'CLAIM_EMAIL' || E'\n' || p_limit::text, p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'UNTRUSTED_CLAIM');
  end if;
  update public.learner_email_outbox set status = 'FAILED', last_error = 'ATTEMPTS_EXHAUSTED', claimed_until = null
  where status = 'QUEUED' and attempts >= 5 and (claimed_until is null or claimed_until < clock_timestamp());
  with due as (
    select id from public.learner_email_outbox
    where status = 'QUEUED' and attempts < 5 and next_attempt_at <= clock_timestamp()
      and (claimed_until is null or claimed_until < clock_timestamp())
    order by next_attempt_at, created_at limit p_limit for update skip locked
  ), claimed as (
    update public.learner_email_outbox o set attempts = o.attempts + 1, claimed_until = clock_timestamp() + interval '5 minutes'
    from due where o.id = due.id returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'attempt', c.attempts, 'kind', c.kind, 'recipient', c.recipient,
      'replyTo', c.reply_to, 'subject', c.subject, 'bodyText', c.body_text,
      'attachment', case c.attachment_kind
        when 'CERTIFICATE' then jsonb_build_object('kind', 'CERTIFICATE', 'data', learner_private.certificate_json(c.attachment_id))
        when 'RECEIPT' then jsonb_build_object('kind', 'RECEIPT', 'data', learner_private.receipt_json(c.attachment_id)) end)
    order by c.next_attempt_at, c.created_at), '[]') into result
  from claimed c;
  return jsonb_build_object('ok', true, 'messages', result);
end $$;

-- SENT is recorded only with the provider's own message id.
create function public.complete_learner_email(p_key_id uuid, p_message_id uuid, p_attempt integer, p_outcome text,
  p_provider_message_id text, p_error text, p_issued_at bigint, p_expires_at bigint, p_mac text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.learner_email_outbox%rowtype;
begin
  if p_key_id is null or p_message_id is null or p_attempt is null or p_outcome is null or p_outcome not in ('SENT','FAILED')
    or p_issued_at is null or p_expires_at is null
    or not learner_private.verify_dispatch(p_key_id, concat_ws(E'\n', 'COMPLETE_EMAIL', p_message_id::text, p_attempt::text, p_outcome,
      coalesce(p_provider_message_id, ''), coalesce(p_error, '')), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'UNTRUSTED_CLAIM');
  end if;
  select * into m from public.learner_email_outbox where id = p_message_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if m.status <> 'QUEUED' then return jsonb_build_object('ok', true, 'status', m.status, 'replay', true); end if;
  if m.attempts <> p_attempt or m.claimed_until is null then return jsonb_build_object('ok', false, 'code', 'STALE_ATTEMPT'); end if;
  if p_outcome = 'SENT' then
    if p_provider_message_id is null or length(p_provider_message_id) not between 1 and 200 then
      return jsonb_build_object('ok', false, 'code', 'PROVIDER_ACK_REQUIRED');
    end if;
    update public.learner_email_outbox set status = 'SENT', sent_at = clock_timestamp(), provider_message_id = p_provider_message_id,
      claimed_until = null, last_error = null where id = m.id;
  elsif m.attempts >= 5 then
    update public.learner_email_outbox set status = 'FAILED', claimed_until = null,
      last_error = coalesce(left(nullif(p_error, ''), 500), 'DELIVERY_FAILED') where id = m.id;
  else
    update public.learner_email_outbox set claimed_until = null, last_error = coalesce(left(nullif(p_error, ''), 500), 'DELIVERY_FAILED'),
      next_attempt_at = clock_timestamp() + least(interval '1 minute' * power(2, m.attempts - 1), interval '1 hour') where id = m.id;
  end if;
  select * into m from public.learner_email_outbox where id = m.id;
  if m.status <> 'QUEUED' then
    insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
    values (null, 'LEARNER_EMAIL_' || m.status, 'learner_email_outbox', m.id, 'LEARNER_SERVICES_V1', 'Outbox delivery outcome recorded',
      jsonb_build_object('kind', m.kind, 'attempts', m.attempts));
  end if;
  return jsonb_build_object('ok', true, 'status', m.status, 'attempts', m.attempts, 'replay', false);
end $$;

-- ==========================================================================
-- Section 7: push subscriptions and activity reminders.
-- ==========================================================================
create function public.subscribe_my_push(p_endpoint text, p_p256dh text, p_auth text, p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); s public.learner_push_subscriptions%rowtype; created integer;
begin
  if p_endpoint is null or length(p_endpoint) not between 20 and 1000
    or p_endpoint !~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[^[:space:]]+$'
    or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_+/-]{40,200}={0,2}$' or p_auth is null or p_auth !~ '^[A-Za-z0-9_+/-]{8,100}={0,2}$'
    or (p_expires_at is not null and p_expires_at <= clock_timestamp()) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUBSCRIPTION');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('LEARNER_PUSH:' || p_endpoint, 0));
  select * into s from public.learner_push_subscriptions where endpoint = p_endpoint for update;
  if found and s.user_id <> actor then
    -- The browser profile now belongs to another signed-in learner.
    delete from public.learner_push_subscriptions where id = s.id;
    s.id := null;
  end if;
  if s.id is null then
    if (select count(*) from public.learner_push_subscriptions where user_id = actor) >= 10 then
      return jsonb_build_object('ok', false, 'code', 'SUBSCRIPTION_LIMIT');
    end if;
    insert into public.learner_push_subscriptions(user_id, endpoint, p256dh, auth_secret, expires_at)
    values (actor, p_endpoint, p_p256dh, p_auth, p_expires_at) returning * into s;
    insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
    values (actor, 'LEARNER_PUSH_SUBSCRIBED', 'learner_push_subscriptions', s.id, 'LEARNER_SERVICES_V1', 'Learner enabled class reminders', null);
  else
    update public.learner_push_subscriptions set p256dh = p_p256dh, auth_secret = p_auth, expires_at = p_expires_at where id = s.id;
  end if;
  created := learner_private.sync_reminders(actor, clock_timestamp() + interval '14 days');
  return jsonb_build_object('ok', true, 'subscriptionId', s.id, 'remindersScheduled', created);
end $$;

create function public.unsubscribe_my_push(p_endpoint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); v_id uuid;
begin
  delete from public.learner_push_subscriptions where endpoint = p_endpoint and user_id = actor returning id into v_id;
  if v_id is not null then
    insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
    values (actor, 'LEARNER_PUSH_UNSUBSCRIBED', 'learner_push_subscriptions', v_id, 'LEARNER_SERVICES_V1', 'Learner disabled class reminders', null);
  end if;
  return jsonb_build_object('ok', true, 'removed', v_id is not null);
end $$;

create function public.refresh_my_activity_reminders() returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); created integer;
begin
  created := learner_private.sync_reminders(actor, clock_timestamp() + interval '14 days');
  return jsonb_build_object('ok', true, 'created', created,
    'pending', (select count(*) from public.learner_activity_reminders where learner_id = actor and status = 'PENDING'),
    'subscriptions', (select count(*) from public.learner_push_subscriptions where user_id = actor));
end $$;

-- In-app fallback: the learner's own upcoming occupied intervals from their
-- current schedules, independent of push delivery.
create function public.list_my_upcoming_reminders(p_days integer default 7) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); v_days integer := least(greatest(coalesce(p_days, 7), 1), 14);
begin
  return jsonb_build_object('serverTime', clock_timestamp(),
    'pushEnabled', exists (select 1 from public.learner_push_subscriptions where user_id = actor
      and (expires_at is null or expires_at > clock_timestamp())),
    'items', coalesce((select jsonb_agg(v.item order by v.starts_at, v.id) from (
      select i.id, i.starts_at, jsonb_build_object('itemId', i.id, 'enrolmentId', e.id, 'courseTitle', c.title, 'kind', i.kind, 'ref', i.ref,
        'part', i.part, 'parts', i.parts, 'startsAt', i.starts_at, 'endsAt', i.ends_at, 'remindAt', i.starts_at - interval '15 minutes',
        'dueNow', clock_timestamp() >= i.starts_at - interval '15 minutes',
        'pushScheduled', exists (select 1 from public.learner_activity_reminders r where r.item_id = i.id and r.status in ('PENDING','SENT'))) item
      from public.academy_enrolments e
      join public.academy_entitlements ent on ent.id = e.entitlement_id and ent.state = 'ACTIVE'
      join public.academy_courses c on c.id = e.course_id
      join public.academy_schedules s on s.enrolment_id = e.id and s.superseded_at is null
      join public.academy_schedule_items i on i.schedule_id = s.id
      where e.learner_id = actor and e.status = 'ACTIVE' and i.starts_at > clock_timestamp()
        and i.starts_at <= clock_timestamp() + make_interval(days => v_days)
      order by i.starts_at, i.id limit 50) v), '[]'));
end $$;

create function public.claim_learner_push_batch(p_key_id uuid, p_limit integer, p_issued_at bigint, p_expires_at bigint, p_mac text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 200 or p_key_id is null or p_issued_at is null or p_expires_at is null
    or not learner_private.verify_dispatch(p_key_id, 'CLAIM_PUSH' || E'\n' || p_limit::text, p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'UNTRUSTED_CLAIM');
  end if;
  perform learner_private.sync_reminders(null, clock_timestamp() + interval '30 minutes');
  update public.learner_activity_reminders set status = 'FAILED', claimed_until = null, last_error = coalesce(last_error, 'ATTEMPTS_EXHAUSTED')
  where status = 'PENDING' and attempts >= 3 and (claimed_until is null or claimed_until < clock_timestamp());
  with due as (
    select id from public.learner_activity_reminders
    where status = 'PENDING' and attempts < 3 and due_at <= clock_timestamp() and next_attempt_at <= clock_timestamp()
      and starts_at > clock_timestamp() and (claimed_until is null or claimed_until < clock_timestamp())
    order by due_at limit p_limit for update skip locked
  ), claimed as (
    update public.learner_activity_reminders r set attempts = r.attempts + 1, claimed_until = clock_timestamp() + interval '2 minutes'
    from due where r.id = due.id returning r.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('reminderId', c.id, 'attempt', c.attempts, 'kind', c.kind, 'startsAt', c.starts_at,
      'endpoint', s.endpoint, 'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth_secret)) order by c.due_at), '[]') into result
  from claimed c join public.learner_push_subscriptions s on s.id = c.subscription_id;
  return jsonb_build_object('ok', true, 'reminders', result);
end $$;

create function public.complete_learner_push(p_key_id uuid, p_reminder_id uuid, p_attempt integer, p_outcome text, p_error text,
  p_issued_at bigint, p_expires_at bigint, p_mac text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.learner_activity_reminders%rowtype;
begin
  if p_key_id is null or p_reminder_id is null or p_attempt is null or p_outcome is null or p_outcome not in ('SENT','GONE','FAILED')
    or p_issued_at is null or p_expires_at is null
    or not learner_private.verify_dispatch(p_key_id, concat_ws(E'\n', 'COMPLETE_PUSH', p_reminder_id::text, p_attempt::text, p_outcome,
      coalesce(p_error, '')), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'UNTRUSTED_CLAIM');
  end if;
  select * into r from public.learner_activity_reminders where id = p_reminder_id for update;
  if not found then return jsonb_build_object('ok', true, 'status', 'GONE', 'replay', true); end if;
  if r.status <> 'PENDING' then return jsonb_build_object('ok', true, 'status', r.status, 'replay', true); end if;
  if r.attempts <> p_attempt or r.claimed_until is null then return jsonb_build_object('ok', false, 'code', 'STALE_ATTEMPT'); end if;
  if p_outcome = 'SENT' then
    update public.learner_activity_reminders set status = 'SENT', sent_at = clock_timestamp(), claimed_until = null, last_error = null where id = r.id;
    update public.learner_push_subscriptions set last_success_at = clock_timestamp() where id = r.subscription_id;
    return jsonb_build_object('ok', true, 'status', 'SENT', 'replay', false);
  elsif p_outcome = 'GONE' then
    -- 404/410 from the push service: the subscription no longer exists.
    delete from public.learner_push_subscriptions where id = r.subscription_id;
    insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
    values (null, 'LEARNER_PUSH_SUBSCRIPTION_EXPIRED', 'learner_push_subscriptions', r.subscription_id, 'LEARNER_SERVICES_V1',
      'Push service reported the subscription gone', null);
    return jsonb_build_object('ok', true, 'status', 'GONE', 'replay', false);
  end if;
  update public.learner_activity_reminders set claimed_until = null, last_error = coalesce(left(nullif(p_error, ''), 300), 'DELIVERY_FAILED'),
    status = case when r.attempts >= 3 then 'FAILED' else 'PENDING' end,
    next_attempt_at = clock_timestamp() + interval '1 minute' where id = r.id;
  return jsonb_build_object('ok', true, 'status', case when r.attempts >= 3 then 'FAILED' else 'PENDING' end, 'replay', false);
end $$;

-- ==========================================================================
-- Section 8: support messages.
-- ==========================================================================
create function public.submit_my_support_message(p_category text, p_subject text, p_message text, p_enrolment_id uuid,
  p_activity_ref text, p_request_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); prior public.learner_support_messages%rowtype;
  v_subject text; v_message text; v_ref text; v_email text; v_id uuid; v_outbox uuid; v_course text; recent integer; oldest timestamptz;
begin
  if p_request_key is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  perform 1 from public.student_profiles where user_id = actor for update;
  select * into prior from public.learner_support_messages where sender_id = actor and request_key = p_request_key;
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'messageId', prior.id, 'delivery', learner_private.delivery(prior.outbox_id));
  end if;
  begin
    v_subject := learner_private.line(p_subject, 3, 150);
    v_message := learner_private.prose(p_message, 10, 5000);
    v_ref := learner_private.line(p_activity_ref, 0, 80);
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end;
  if p_category is null or p_category not in ('COURSE_CONTENT','TECHNICAL','BILLING','ACCOUNT','FEEDBACK','OTHER') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if p_enrolment_id is not null then
    select c.title into v_course from public.academy_enrolments e join public.academy_courses c on c.id = e.course_id
    where e.id = p_enrolment_id and e.learner_id = actor;
    if not found then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  elsif v_ref is not null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select count(*), min(created_at) into recent, oldest from public.learner_support_messages
  where sender_id = actor and created_at > clock_timestamp() - interval '1 hour';
  if recent >= 5 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED',
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (oldest + interval '1 hour' - clock_timestamp())))::integer));
  end if;
  v_email := learner_private.verified_email(actor);
  if v_email is null then return jsonb_build_object('ok', false, 'code', 'EMAIL_NOT_VERIFIED'); end if;
  v_id := gen_random_uuid();
  v_outbox := learner_private.enqueue_email('SUPPORT:' || v_id::text, 'SUPPORT_MESSAGE', actor, 'support@ducelio.com', v_email,
    '[Ducelio support] ' || v_subject,
    'Category: ' || p_category || E'\n'
      || 'From: ' || learner_private.learner_name(actor) || ' (student number '
      || coalesce((select student_number from public.student_profiles where user_id = actor), 'unknown') || ')' || E'\n'
      || 'Reply to: ' || v_email || E'\n'
      || coalesce('Course: ' || v_course || ' (enrolment ' || p_enrolment_id::text || ')' || E'\n', '')
      || coalesce('Activity: ' || v_ref || E'\n', '')
      || E'\n' || v_message,
    null, null);
  insert into public.learner_support_messages(id, sender_id, category, subject, message, enrolment_id, activity_ref, request_key, outbox_id)
  values (v_id, actor, p_category, v_subject, v_message, p_enrolment_id, v_ref, p_request_key, v_outbox);
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'LEARNER_SUPPORT_MESSAGE_SUBMITTED', 'learner_support_messages', v_id, 'LEARNER_SERVICES_V1', 'Learner contacted support',
    jsonb_build_object('category', p_category, 'enrolment_id', p_enrolment_id));
  return jsonb_build_object('ok', true, 'replayed', false, 'messageId', v_id, 'delivery', learner_private.delivery(v_outbox));
end $$;

create function public.list_my_support_messages() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student();
begin
  return coalesce((select jsonb_agg(v.item order by v.created_at desc) from (
    select m.created_at, jsonb_build_object('messageId', m.id, 'category', m.category, 'subject', m.subject, 'enrolmentId', m.enrolment_id,
      'activityRef', m.activity_ref, 'createdAt', m.created_at, 'delivery', learner_private.delivery(m.outbox_id)) item
    from public.learner_support_messages m where m.sender_id = actor order by m.created_at desc limit 50) v), '[]');
end $$;

-- ==========================================================================
-- Section 9: certificates.
-- ==========================================================================
create function learner_private.new_verification_code() returns text
language plpgsql volatile set search_path='' as $$
declare alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; b bytea := extensions.gen_random_bytes(16); v text := ''; i integer;
begin
  for i in 0..15 loop
    v := v || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
    if i in (3, 7, 11) then v := v || '-'; end if;
  end loop;
  return v;
end $$;

create function public.issue_my_certificate(p_enrolment_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, false);
  comp public.academy_completions%rowtype; v_id uuid; v_email text; v_title text; v_body text; v_qual text; v_name text; v_code text; attempt integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('LEARNER_CERTIFICATE:' || e.id::text, 0));
  select id into v_id from public.learner_certificates where enrolment_id = e.id;
  if found then return jsonb_build_object('ok', true, 'replayed', true, 'certificate', learner_private.certificate_json(v_id)); end if;
  select * into comp from public.academy_completions where enrolment_id = e.id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_COMPLETED'); end if;
  if exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state <> 'ACTIVE') then
    return jsonb_build_object('ok', false, 'code', 'ACCESS_REVOKED');
  end if;
  -- No certificate for demo content (AGENTS.md: demo academic content is
  -- labelled, never presented as a real completion).
  if exists (select 1 from public.academy_courses c join public.programme_versions pv on pv.id = c.programme_version_id
      left join public.academy_course_packages pk on pk.id = c.package_id
      where c.id = e.course_id and (pv.is_demo or coalesce((pk.raw_package->'course'->>'demoContent')::boolean, false))) then
    return jsonb_build_object('ok', false, 'code', 'DEMO_COURSE');
  end if;
  -- The examination body and qualification as PUBLISHED (the version
  -- snapshot), never the live programme row, which may be edited later.
  select c.title, nullif(btrim(coalesce(pv.examination_body_snapshot, p.examination_body)), ''),
         nullif(btrim(coalesce(pv.qualification_name_snapshot, p.qualification_name)), '')
    into v_title, v_body, v_qual
  from public.academy_courses c join public.programme_versions pv on pv.id = c.programme_version_id
  join public.programmes p on p.id = pv.programme_id where c.id = e.course_id;
  v_name := left(learner_private.learner_name(e.learner_id), 100);
  loop
    attempt := attempt + 1;
    v_code := learner_private.new_verification_code();
    begin
      insert into public.learner_certificates(enrolment_id, learner_id, verification_code, learner_name, course_title, issuer_name,
        examination_body, qualification_name, completed_at)
      values (e.id, e.learner_id, v_code, v_name, left(v_title, 200), left(learner_private.course_provider(e.course_id), 150),
        left(v_body, 200), left(v_qual, 200), comp.completed_at) returning id into v_id;
      exit;
    exception when unique_violation then
      if attempt >= 3 then raise; end if;
    end;
  end loop;
  v_email := learner_private.verified_email(e.learner_id);
  if v_email is not null then
    perform learner_private.enqueue_email('CERTIFICATE:' || v_id::text, 'CERTIFICATE_ISSUED', e.learner_id, v_email, null,
      'Your Ducelio certificate: ' || left(regexp_replace(v_title, '[\r\n]+', ' ', 'g'), 150),
      'Hello ' || v_name || ',' || E'\n\n'
        || 'Congratulations on completing "' || v_title || '". Your certificate is attached.' || E'\n\n'
        || 'Verification code: ' || v_code || E'\n'
        || 'Anyone can confirm it at {{APP_URL}}/verify?code=' || v_code || E'\n\n'
        || case when v_body is not null then 'This certificate confirms completion of a Ducelio preparation course. It is not an official certification from the examination body.' || E'\n\n' else '' end
        || 'Ducelio',
      'CERTIFICATE', v_id);
  end if;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (e.learner_id, 'LEARNER_CERTIFICATE_ISSUED', 'learner_certificates', v_id, 'LEARNER_SERVICES_V1', 'Certificate issued from a recorded completion',
    jsonb_build_object('enrolment_id', e.id, 'email_queued', v_email is not null));
  return jsonb_build_object('ok', true, 'replayed', false, 'certificate', learner_private.certificate_json(v_id));
end $$;

create function public.get_my_certificates() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student();
begin
  return jsonb_build_object(
    'certificates', coalesce((select jsonb_agg(learner_private.certificate_json(c.id) order by c.issued_at desc)
      from public.learner_certificates c where c.learner_id = actor), '[]'),
    'eligible', coalesce((select jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'courseTitle', co.title, 'completedAt', d.completed_at)
        order by d.completed_at desc)
      from public.academy_completions d join public.academy_enrolments e on e.id = d.enrolment_id
      join public.academy_courses co on co.id = e.course_id
      join public.academy_entitlements ent on ent.id = e.entitlement_id and ent.state = 'ACTIVE'
      join public.programme_versions pv on pv.id = co.programme_version_id
      left join public.academy_course_packages pk on pk.id = co.package_id
      where e.learner_id = actor and not exists (select 1 from public.learner_certificates c where c.enrolment_id = e.id)
        and not (pv.is_demo or coalesce((pk.raw_package->'course'->>'demoContent')::boolean, false))), '[]'));
end $$;

create function public.get_my_certificate(p_certificate_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student();
begin
  if not exists (select 1 from public.learner_certificates where id = p_certificate_id and learner_id = actor) then
    raise exception 'NOT_FOUND_OR_FORBIDDEN';
  end if;
  return learner_private.certificate_json(p_certificate_id);
end $$;

-- Public verification: minimal fields only (no ids, scores or revocation prose).
create function public.verify_certificate(p_code text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); c public.learner_certificates%rowtype;
begin
  if length(v) <> 16 then return jsonb_build_object('found', false); end if;
  v := substr(v, 1, 4) || '-' || substr(v, 5, 4) || '-' || substr(v, 9, 4) || '-' || substr(v, 13, 4);
  select * into c from public.learner_certificates where verification_code = v;
  if not found then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'valid', c.revoked_at is null, 'revoked', c.revoked_at is not null,
    'verificationCode', c.verification_code, 'learnerName', c.learner_name, 'courseTitle', c.course_title, 'issuerName', c.issuer_name,
    'completedOn', to_char(c.completed_at at time zone 'UTC', 'YYYY-MM-DD'), 'issuedOn', to_char(c.issued_at at time zone 'UTC', 'YYYY-MM-DD'),
    'revokedOn', to_char(c.revoked_at at time zone 'UTC', 'YYYY-MM-DD'), 'preparationCourse', c.examination_body is not null);
end $$;

-- ==========================================================================
-- Section 10: payment receipts.
-- ==========================================================================
create function public.issue_my_payment_receipt(p_order_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); v_id uuid;
begin
  if not exists (select 1 from public.academy_orders where id = p_order_id and learner_id = actor) then
    raise exception 'NOT_FOUND_OR_FORBIDDEN';
  end if;
  v_id := learner_private.issue_receipt(p_order_id);
  if v_id is null then return jsonb_build_object('ok', false, 'code', 'NOT_ELIGIBLE'); end if;
  return jsonb_build_object('ok', true, 'receipt', learner_private.receipt_json(v_id));
end $$;

create function public.list_my_payment_receipts() returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); o record;
begin
  -- Backfill: orders fulfilled before this migration (or whose fulfilment-
  -- time issuance was deferred) receive their receipt here, idempotently.
  for o in select id from public.academy_orders x where x.learner_id = actor and x.state = 'FULFILLED'
      and not exists (select 1 from public.learner_payment_receipts r where r.order_id = x.id) loop
    perform learner_private.issue_receipt(o.id);
  end loop;
  return coalesce((select jsonb_agg(learner_private.receipt_json(r.id) order by r.issued_at desc)
    from public.learner_payment_receipts r where r.learner_id = actor), '[]');
end $$;

create function public.get_my_payment_receipt(p_receipt_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student();
begin
  if not exists (select 1 from public.learner_payment_receipts where id = p_receipt_id and learner_id = actor) then
    raise exception 'NOT_FOUND_OR_FORBIDDEN';
  end if;
  return learner_private.receipt_json(p_receipt_id);
end $$;

-- ==========================================================================
-- Section 11: privileges and their verification.
-- ==========================================================================
do $$ declare f record; begin
  for f in select oid::regprocedure sig from pg_proc where pronamespace = 'learner_private'::regnamespace loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
  for f in select oid::regprocedure sig, proname from pg_proc where pronamespace = 'public'::regnamespace and proname in (
    'get_my_learner_profile','save_my_learner_profile','upload_my_private_file','read_private_file','delete_my_private_file',
    'submit_my_lab_evidence','get_my_lab_evidence','list_my_unattached_lab_files','get_lab_evidence_for_review','subscribe_my_push','unsubscribe_my_push',
    'refresh_my_activity_reminders','list_my_upcoming_reminders','submit_my_support_message','list_my_support_messages',
    'issue_my_certificate','get_my_certificates','get_my_certificate','verify_certificate','issue_my_payment_receipt',
    'list_my_payment_receipts','get_my_payment_receipt','claim_learner_email_batch','complete_learner_email',
    'claim_learner_push_batch','complete_learner_push') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname in ('claim_learner_email_batch','complete_learner_email','claim_learner_push_batch','complete_learner_push') then
      execute format('grant execute on function %s to anon', f.sig);
    elsif f.proname = 'verify_certificate' then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- The anon grants again as literal statements (idempotent), so static review
-- and the readiness contract see exactly which functions anon may call.
grant execute on function public.claim_learner_email_batch(uuid,integer,bigint,bigint,text) to anon;
grant execute on function public.complete_learner_email(uuid,uuid,integer,text,text,text,bigint,bigint,text) to anon;
grant execute on function public.claim_learner_push_batch(uuid,integer,bigint,bigint,text) to anon;
grant execute on function public.complete_learner_push(uuid,uuid,integer,text,text,bigint,bigint,text) to anon;
grant execute on function public.verify_certificate(text) to anon, authenticated;

do $$ declare r text; t text; f text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(r, 'learner_private', 'USAGE,CREATE')
      or has_sequence_privilege(r, 'learner_private.receipt_number_seq', 'USAGE,SELECT,UPDATE') then
      raise exception 'Unsafe learner_private privileges';
    end if;
    if exists (select 1 from pg_proc where pronamespace = 'learner_private'::regnamespace and has_function_privilege(r, oid, 'EXECUTE')) then
      raise exception 'Unsafe learner_private function privileges';
    end if;
    foreach t in array array['learner_private_files','learner_profiles','learner_profile_education','learner_profile_employment',
      'learner_lab_evidence','learner_lab_evidence_files','learner_email_outbox','learner_push_subscriptions',
      'learner_activity_reminders','learner_support_messages','learner_certificates','learner_payment_receipts'] loop
      if has_table_privilege(r, 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r, 'public.' || t, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe learner services table privileges on %', t;
      end if;
    end loop;
    foreach f in array array['public.get_my_learner_profile()','public.save_my_learner_profile(text,text,jsonb,jsonb)',
      'public.upload_my_private_file(text,uuid,text,text,text)','public.read_private_file(uuid)','public.delete_my_private_file(uuid)',
      'public.submit_my_lab_evidence(uuid,text,uuid[],text,uuid)','public.get_my_lab_evidence(uuid,text)',
      'public.list_my_unattached_lab_files(uuid)',
      'public.get_lab_evidence_for_review(uuid,text)','public.subscribe_my_push(text,text,text,timestamptz)','public.unsubscribe_my_push(text)',
      'public.refresh_my_activity_reminders()','public.list_my_upcoming_reminders(integer)',
      'public.submit_my_support_message(text,text,text,uuid,text,uuid)','public.list_my_support_messages()',
      'public.issue_my_certificate(uuid)','public.get_my_certificates()','public.get_my_certificate(uuid)',
      'public.issue_my_payment_receipt(uuid)','public.list_my_payment_receipts()','public.get_my_payment_receipt(uuid)'] loop
      if has_function_privilege(r, f, 'EXECUTE') <> (r = 'authenticated') then raise exception 'Unsafe learner RPC privileges on %', f; end if;
    end loop;
    foreach f in array array['public.claim_learner_email_batch(uuid,integer,bigint,bigint,text)',
      'public.complete_learner_email(uuid,uuid,integer,text,text,text,bigint,bigint,text)',
      'public.claim_learner_push_batch(uuid,integer,bigint,bigint,text)',
      'public.complete_learner_push(uuid,uuid,integer,text,text,bigint,bigint,text)'] loop
      if has_function_privilege(r, f, 'EXECUTE') <> (r = 'anon') then raise exception 'Unsafe dispatcher RPC privileges on %', f; end if;
    end loop;
    if has_function_privilege(r, 'public.verify_certificate(text)', 'EXECUTE') <> (r in ('anon','authenticated')) then
      raise exception 'Unsafe certificate verification privileges';
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
