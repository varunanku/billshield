-- Phase 3 (follow-up chat) reuses the messages table instead of a new one,
-- per the brief's six-table limit. A follow-up turn has no subject/tone
-- (it's not a dispute email) and needs to record which side said it, so
-- those two columns relax/gain here. No RLS change needed: ownership still
-- follows bill_id via the existing policies, which key off the row, not
-- the column list, and the existing grants are table-level.
--
-- Idempotent: safe to run again even if already applied -- add column if
-- not exists, and dropping a already-nullable NOT NULL constraint is a
-- no-op in Postgres.
begin;

alter table public.messages
  add column if not exists type text not null default 'dispute',
  add column if not exists role text;

alter table public.messages
  alter column subject drop not null,
  alter column tone drop not null;

comment on column public.messages.type is
  'dispute (the drafted email/inquiry, the original row shape) or followup (one turn of the bill Q&A chat).';
comment on column public.messages.role is
  'Only set for type=followup rows: user or assistant, for rendering/counting the chat thread.';

commit;
