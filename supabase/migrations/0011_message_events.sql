-- Click-tracking funnel for drafted emails: one row per tap on Copy, Open
-- in email app, or I've sent it (repeated taps each add a row), with how
-- much of the original default draft was still in the editor at that
-- moment (lib/draft-kept.ts). Append-only: users can insert and read
-- their own rows; there are no update or delete policies.
--
-- Idempotent: safe to run again even if already applied.
begin;

create table if not exists public.message_events (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid not null references public.messages (id) on delete cascade,
  user_id        uuid not null references public.users (id),
  event_type     text not null check (event_type in ('copied', 'opened_email_app', 'marked_sent')),
  draft_kept_pct numeric(5,2),
  created_at     timestamptz default now()
);

create index if not exists message_events_message_id_idx on public.message_events (message_id);

-- Same pattern as bill_owned_by_current_user (0001): security invoker, so
-- the messages lookup is itself subject to messages' own RLS.
create or replace function public.message_owned_by_current_user(p_message_id uuid)
returns boolean
language sql
stable
security invoker
as $$
  select exists (
    select 1 from public.messages m
    where m.id = p_message_id and public.bill_owned_by_current_user(m.bill_id)
  );
$$;

revoke execute on function public.message_owned_by_current_user(uuid) from public;
grant execute on function public.message_owned_by_current_user(uuid) to authenticated;

alter table public.message_events enable row level security;

drop policy if exists "message_events_select_own" on public.message_events;
create policy "message_events_select_own" on public.message_events
  for select using (user_id = auth.uid() and public.message_owned_by_current_user(message_id));

drop policy if exists "message_events_insert_own" on public.message_events;
create policy "message_events_insert_own" on public.message_events
  for insert with check (user_id = auth.uid() and public.message_owned_by_current_user(message_id));

grant select, insert on public.message_events to authenticated;

-- scripts/tone-stats.mjs reads every user's events for the funnel report
-- (operator-only, service role key) -- same one read-only grant as 0004.
grant select on public.message_events to service_role;

comment on table public.message_events is
  'One row per Copy / Open in email app / I''ve sent it tap on a drafted email. Append-only.';
comment on column public.message_events.draft_kept_pct is
  '% of the original default draft (v1, is_default_tone) kept in the editor text at the moment of the tap. Null if unknown.';

commit;
