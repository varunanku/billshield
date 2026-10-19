-- Phase 2 (chat-proposed corrections): applying a correction re-runs
-- computeBillChecks/decideVerdict, which needs the full role-rich line
-- list back -- previously only recoverable by convention (negative
-- amount = discount, label "Amount Paid" = payment, everything else
-- assumed "charge"), which silently breaks for any bill with a discount
-- or payment line that also needs correcting. Storing role explicitly
-- removes the guesswork; lib/bill-checks.ts's fromPersistedLines reads it
-- back directly. Existing rows get role = null (not reconstructable
-- retroactively) -- they still render fine, they just can't be corrected
-- via chat until re-uploaded.
alter table public.line_items
  add column if not exists role text;

comment on column public.line_items.role is
  'charge/tax/discount/payment, as classified at confirm time -- null for rows saved before this column existed.';
