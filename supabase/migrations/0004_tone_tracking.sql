-- Phase 4 (tone selector + regeneration tracking). The brief asked for new
-- `tone`, `version`, `is_default_tone`, `edited_before_send` columns, but
-- `messages.tone` and `messages.tone_preset_used` already exist (0001) --
-- tone holds the confident/inquiry stance, tone_preset_used (nullable,
-- unused until now) is exactly the slot for which of the 6 style presets
-- (polite/firm/formal/brief/friendly/escalation) was used. Reusing it
-- instead of adding a second, confusingly-named tone column.
--
-- Idempotent: safe to run again even if already applied.
begin;

alter table public.messages
  add column if not exists version integer not null default 1,
  add column if not exists is_default_tone boolean not null default true,
  add column if not exists edited_before_send boolean;

comment on column public.messages.version is
  'Which regeneration this row is, 1-based, per bill_id -- each Regenerate click inserts a new row rather than overwriting.';
comment on column public.messages.is_default_tone is
  'True for the original verdict-driven draft (no style preset applied); false once a tone_preset_used value was chosen.';
comment on column public.messages.edited_before_send is
  'Set when the message is marked sent: whether the sent text (final_body) differs from the generated body.';

-- scripts/tone-stats.mjs is an operator-run reporting script (service role
-- key, never reaches the browser) that aggregates tone/version data across
-- ALL users' messages -- the one case where that's an intended bypass of
-- per-user RLS, not a bug. service_role has no table grants by design
-- (see 0001's comments), so this one explicit, read-only grant is what
-- lets that script run at all.
grant select on public.messages to service_role;

commit;
