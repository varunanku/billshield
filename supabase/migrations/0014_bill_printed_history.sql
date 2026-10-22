-- Printed payment history: electricity and water bills often print the
-- last few months' amounts, units or payments. Those rows are stored here,
-- separately from line_items -- they are never part of this bill's
-- arithmetic checks or verdict, only context for month-over-month
-- comparison and the follow-up chat, always labelled as printed (not
-- checked by BillShield).
--
-- Owner-only select/insert/delete; no update (a wrong row is deleted, not
-- edited). One row per printed period per bill.
--
-- Idempotent: safe to run again even if already applied.
begin;

create table if not exists public.bill_printed_history (
  id           uuid primary key default gen_random_uuid(),
  bill_id      uuid not null references public.bills (id) on delete cascade,
  user_id      uuid not null references public.users (id),
  period_label text not null,
  period_start date,
  amount       numeric(12,2),
  units        numeric(12,2),
  amount_paid  numeric(12,2),
  paid_on      date,
  created_at   timestamptz default now(),
  unique (bill_id, period_label)
);

create index if not exists bill_printed_history_user_id_idx on public.bill_printed_history (user_id);

alter table public.bill_printed_history enable row level security;

drop policy if exists "bill_printed_history_select_own" on public.bill_printed_history;
create policy "bill_printed_history_select_own" on public.bill_printed_history
  for select using (user_id = auth.uid() and public.bill_owned_by_current_user(bill_id));

drop policy if exists "bill_printed_history_insert_own" on public.bill_printed_history;
create policy "bill_printed_history_insert_own" on public.bill_printed_history
  for insert with check (user_id = auth.uid() and public.bill_owned_by_current_user(bill_id));

drop policy if exists "bill_printed_history_delete_own" on public.bill_printed_history;
create policy "bill_printed_history_delete_own" on public.bill_printed_history
  for delete using (user_id = auth.uid() and public.bill_owned_by_current_user(bill_id));

grant select, insert, delete on public.bill_printed_history to authenticated;

comment on table public.bill_printed_history is
  'Past months'' amounts/units/payments as printed on an electricity or water bill. Never checked by BillShield; never part of the verdict.';

commit;
