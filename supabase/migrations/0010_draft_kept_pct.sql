-- How much of the first draft the user kept when they marked it sent:
-- word-level LCS similarity (lib/draft-kept.ts) between the bill's
-- original default draft (version 1, is_default_tone) and the final text,
-- 0-100 with 2 decimals. Nullable: null for rows sent before this existed,
-- unsent rows, or when no original default draft is found.
-- edited_before_send (0004) stays as-is alongside it.
--
-- Idempotent: safe to run again even if already applied.
begin;

alter table public.messages
  add column if not exists draft_kept_pct numeric(5,2);

comment on column public.messages.draft_kept_pct is
  'Set when marked sent: % of the original default draft''s words (v1, is_default_tone) kept in final_body, by word-level LCS. Null if unknown.';

commit;
