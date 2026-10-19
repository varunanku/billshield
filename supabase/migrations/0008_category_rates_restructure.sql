-- Phase 4 (GST rate reference): category_rates goes from one row per
-- category to one row per (category, item_keyword, hsn_prefix) so a
-- single category (e.g. "appliance") can carry different rates for
-- different items. This is reference data only, seeded by
-- scripts/seed-category-rates.mjs from data/category-rates.csv (which the
-- developer fills from the official CBIC schedule -- never invented here),
-- so dropping and recreating is safe: no user data references this table.
--
-- Idempotent: safe to run again even if already applied. The drop+recreate
-- only fires once, the first time this runs against the OLD (0001) one-
-- row-per-category shape -- detected by the absence of item_keyword,
-- a column only the new shape has. A re-run against the new shape (or a
-- from-scratch project with no category_rates table at all) leaves
-- existing rows alone instead of wiping seeded data on every re-run.
begin;

do $$
begin
  if to_regclass('public.category_rates') is not null
     and not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'category_rates' and column_name = 'item_keyword'
     )
  then
    drop table public.category_rates;
  end if;
end $$;

create table if not exists public.category_rates (
  id             uuid primary key default gen_random_uuid(),
  category       text not null,    -- matches bills.category
  item_keyword   text,             -- nullable: narrows within a category, matched against a bill's own line labels
  hsn_prefix     text,             -- nullable: the HSN/SAC code prefix this rate applies to, for reference
  gst_rate_total numeric(5,2),     -- nullable until sourced -- a null rate is a placeholder, never shown as a real figure
  cgst           numeric(5,2),
  sgst           numeric(5,2),
  igst           numeric(5,2),
  source_url     text,             -- nullable: the CBIC (or other official) page this was read from
  effective_from date              -- nullable
);

alter table public.category_rates enable row level security;

-- Same pattern as before: read-only reference table for any signed-in
-- user; writable only via service role (the seed script), which bypasses
-- RLS -- there is no insert/update/delete policy for regular users.
drop policy if exists "category_rates_select_all" on public.category_rates;
create policy "category_rates_select_all" on public.category_rates
  for select using (auth.role() = 'authenticated');

grant select on public.category_rates to authenticated;

-- service_role has no table grants by design (see 0001's comments) --
-- this one explicit grant is what lets scripts/seed-category-rates.mjs
-- (an operator script, service role key, never reaches the browser)
-- replace this reference table's contents.
grant select, insert, delete on public.category_rates to service_role;

commit;
