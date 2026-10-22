-- Consolidated monthly timeline: one row per (user, provider, month), the
-- single source for month-over-month history in the chat and on My bills.
--
-- 1. public.provider_key(name): a lowercase key so the same provider's
--    bills line up however the name was printed. "TATA POWER DELHI
--    DISTRIBUTION LIMITED" and "Tata Power-DDL" both -> "tata power".
--    ponytail: first two significant words -- cheap and right for every
--    Indian utility name seen so far; a provider whose first two words
--    differ between bills won't match (upgrade path: an alias table).
-- 2. bills.provider_key (generated from provider_name, so always
--    consistent) and bills.reconciled_total (the checks' effective total,
--    written at confirm; null on older bills, which fall back to the
--    printed total).
-- 3. public.provider_monthly_timeline, a security_invoker view: it runs
--    with the caller's rights, so the RLS on bills, bill_metrics and
--    bill_printed_history decides which rows anyone sees.
--    - checked rows: each saved bill, month = billing_period_end or bill_date.
--    - printed rows: bill_printed_history, labelled with their source bill.
--    - per month, a checked row beats any printed row; among printed rows,
--      the one from the most recent bill wins.
--    - per (user, provider), by month: previous available month and the
--      change in Rs and %, 3- and 6-month rolling averages (calendar
--      windows: this month and the 2 or 5 before it, counting only months
--      that have data), min and max to date, and above/below the 3-month
--      average. Months with no data are absent -- never a zero row.
--
-- Idempotent: safe to run again even if already applied.
begin;

create or replace function public.provider_key(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(
    array_to_string(
      (regexp_split_to_array(
        btrim(
          regexp_replace(
            regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', ' ', 'g'),
            '\m(limited|ltd|pvt|private|the|company|co|inc|llp|corp|corporation)\M',
            ' ',
            'g'
          )
        ),
        '\s+'
      ))[1:2],
      ' '
    ),
    ''
  );
$$;

revoke execute on function public.provider_key(text) from public, anon;
grant execute on function public.provider_key(text) to authenticated, service_role;

alter table public.bills
  add column if not exists reconciled_total numeric(12,2),
  add column if not exists provider_key text generated always as (public.provider_key(provider_name)) stored;

create index if not exists bills_user_provider_key_idx on public.bills (user_id, provider_key);

comment on column public.bills.reconciled_total is
  'The checks'' effective total at confirm/correction time (printed total, or the detected rounded total). Null on bills saved before this existed.';
comment on column public.bills.provider_key is
  'public.provider_key(provider_name): lowercase first two significant words, so the same provider''s bills line up.';

drop view if exists public.provider_monthly_timeline;

create view public.provider_monthly_timeline
with (security_invoker = true)
as
with checked as (
  select
    b.user_id,
    b.provider_key,
    b.provider_name,
    date_trunc('month', coalesce(b.billing_period_end, b.bill_date))::date as month,
    'checked'::text as source,
    coalesce(b.reconciled_total, b.total_amount)::numeric as amount,
    m.units,
    null::numeric as amount_paid,
    null::text as period_label,
    b.id as source_bill_id,
    b.bill_date as source_bill_date,
    b.created_at
  from public.bills b
  left join lateral (
    select bm.value::numeric as units
    from public.bill_metrics bm
    where bm.bill_id = b.id and bm.metric = 'units_consumed'
    order by bm.created_at desc
    limit 1
  ) m on true
  where b.provider_key is not null and b.provider_name <> 'Unknown provider'
),
printed as (
  select
    b.user_id,
    b.provider_key,
    b.provider_name,
    date_trunc('month', h.period_start)::date as month,
    'printed'::text as source,
    h.amount::numeric,
    h.units::numeric,
    h.amount_paid::numeric,
    h.period_label,
    b.id as source_bill_id,
    b.bill_date as source_bill_date,
    h.created_at
  from public.bill_printed_history h
  join public.bills b on b.id = h.bill_id
  where h.period_start is not null and b.provider_key is not null and b.provider_name <> 'Unknown provider'
),
ranked as (
  select
    c.*,
    row_number() over (
      partition by c.user_id, c.provider_key, c.month
      order by (c.source = 'checked') desc, c.source_bill_date desc, c.created_at desc
    ) as rn
  from (select * from checked union all select * from printed) c
),
months as (
  select
    r.*,
    lag(r.month) over w as prev_month,
    lag(r.amount) over w as prev_amount,
    avg(r.amount) over w3 as avg_3m_raw,
    avg(r.amount) over w6 as avg_6m_raw,
    count(r.amount) over w6 as months_in_6m,
    min(r.amount) over wtd as min_to_date,
    max(r.amount) over wtd as max_to_date
  from ranked r
  where r.rn = 1
  window
    w   as (partition by r.user_id, r.provider_key order by r.month),
    w3  as (partition by r.user_id, r.provider_key order by r.month range between interval '2 months' preceding and current row),
    w6  as (partition by r.user_id, r.provider_key order by r.month range between interval '5 months' preceding and current row),
    wtd as (partition by r.user_id, r.provider_key order by r.month rows between unbounded preceding and current row)
)
select
  user_id,
  provider_key,
  provider_name,
  month,
  source,
  amount,
  units,
  amount_paid,
  period_label,
  source_bill_id,
  source_bill_date,
  prev_month,
  prev_amount,
  round(amount - prev_amount, 2) as change_rs,
  case when prev_amount > 0 then round((amount - prev_amount) / prev_amount * 100, 2) end as change_pct,
  round(avg_3m_raw, 2) as avg_3m,
  round(avg_6m_raw, 2) as avg_6m,
  months_in_6m,
  case when avg_6m_raw > 0 then round((amount - avg_6m_raw) / avg_6m_raw * 100, 2) end as pct_vs_avg_6m,
  min_to_date,
  max_to_date,
  case
    when amount is null or avg_3m_raw is null then null
    when amount > avg_3m_raw then 'above'
    when amount < avg_3m_raw then 'below'
    else 'equal'
  end as vs_avg_3m
from months;

grant select on public.provider_monthly_timeline to authenticated;

comment on view public.provider_monthly_timeline is
  'One row per user, provider_key and month: saved bills (checked) beat printed history; rolling figures computed per provider. security_invoker, so callers see only their own rows.';

commit;
