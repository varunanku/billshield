-- Phase 1 item 8: extraction now returns two separate provider fields --
-- provider_name stays the brand/service name the customer recognises
-- (e.g. "Overleaf"), and this adds the optional registered company
-- (e.g. "Digital Science UK Limited") alongside it. Emails still address
-- the brand (provider_name); this is for reference/record-keeping only.
alter table public.bills
  add column if not exists provider_legal_name text;

comment on column public.bills.provider_legal_name is
  'Registered company name, if printed and different from the brand (provider_name) -- optional, never guessed.';
