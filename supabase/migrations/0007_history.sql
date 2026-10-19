-- Phase 3 (history / "My bills"): bills gets a closed-list category,
-- billing period (for month-over-month grouping), and a verdict snapshot
-- -- "My bills" lists past bills with their verdict without re-running
-- the full checks/verdict pipeline for every row on every page view (the
-- line-item-level role data needed for that is still intact in line_items
-- if a real recompute is ever needed; this snapshot is just for display).
--
-- Idempotent: safe to run again even if already applied -- add column if
-- not exists, create table if not exists, drop policy if exists before
-- every create policy, enabling RLS twice is a no-op.
begin;

alter table public.bills
  add column if not exists category text,
  add column if not exists billing_period_start date,
  add column if not exists billing_period_end date,
  add column if not exists verdict_outcome text,
  add column if not exists verdict_gap numeric(12,2);

comment on column public.bills.category is
  'Closed list: electricity, internet, mobile, credit_card, groceries, software, appliance, other. LLM-assigned, never guessed at use time.';
comment on column public.bills.verdict_outcome is
  'Snapshot of the verdict decided at confirm/correction time: clean, confirmed_error, cannot_verify, or unexplained.';
comment on column public.bills.verdict_gap is
  'Snapshot of the verdict''s signed gap, if any -- null for a plain clean bill.';

-- bill_metrics: non-money, non-"line on the bill" values (units consumed,
-- kWh, data used, ...) that computeBillChecks has no use for but are worth
-- keeping for history/averages instead of silently dropping them.
create table if not exists public.bill_metrics (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references public.bills (id) on delete cascade,
  metric     text not null,          -- e.g. 'units_consumed'
  value      numeric(12,2) not null,
  unit       text,                   -- e.g. 'kWh', 'GB', nullable
  created_at timestamptz not null default now()
);

alter table public.bill_metrics enable row level security;

-- Ownership follows the parent bill, same helper/pattern as line_items,
-- promises and messages in 0001.
drop policy if exists "bill_metrics_select_own" on public.bill_metrics;
create policy "bill_metrics_select_own" on public.bill_metrics
  for select using (public.bill_owned_by_current_user(bill_id));

drop policy if exists "bill_metrics_insert_own" on public.bill_metrics;
create policy "bill_metrics_insert_own" on public.bill_metrics
  for insert with check (public.bill_owned_by_current_user(bill_id));

drop policy if exists "bill_metrics_update_own" on public.bill_metrics;
create policy "bill_metrics_update_own" on public.bill_metrics
  for update
  using (public.bill_owned_by_current_user(bill_id))
  with check (public.bill_owned_by_current_user(bill_id));

drop policy if exists "bill_metrics_delete_own" on public.bill_metrics;
create policy "bill_metrics_delete_own" on public.bill_metrics
  for delete using (public.bill_owned_by_current_user(bill_id));

grant select, insert, update, delete on public.bill_metrics to authenticated;

commit;
