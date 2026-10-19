-- Phase 3 (verdict + email) needs a number to compare the billed amount
-- against, not just the free-text "statement". docs/schema.md's promises
-- table has no such column yet -- this is the one new column Phase 3
-- requires. No new table, no RLS change needed: ownership already follows
-- bill_id via the existing policies, which key off the row, not the column
-- list, and the existing grants are table-level.
alter table public.promises
  add column if not exists promised_amount numeric(12,2);

comment on column public.promises.promised_amount is
  'What the user says they were promised they''d pay, if they gave a number. Optional -- a promise can be a plain statement with no comparable figure, in which case the verdict can''t numerically compare it and falls back to the unexplained/inquiry outcome instead of confirmed_error.';
