-- BillShield: core schema, RLS, grants.
-- Six tables per CLAUDE.md. Auto-expose is off for this project, so every
-- table needs an explicit GRANT to `authenticated` below -- PostgREST will
-- not serve a table that isn't granted, and we never grant to `anon`.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- 1. users ------------------------------------------------------------
-- Profile row mirroring auth.users. id is shared with the auth user so
-- RLS can key off auth.uid() directly.
create table public.users (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now()
);

-- 2. bills --------------------------------------------------------------
create table public.bills (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete cascade,
  category      text not null,
  provider_name text,
  bill_date     date,
  due_date      date,
  amount_total  numeric,
  file_path     text, -- storage object path
  status        text not null default 'pending' check (status in ('pending', 'clean', 'flagged')),
  created_at    timestamptz not null default now()
);

-- 3. line_items -----------------------------------------------------------
-- user_id is denormalized from bills so RLS doesn't need a join.
create table public.line_items (
  id             uuid primary key default gen_random_uuid(),
  bill_id        uuid not null references public.bills (id) on delete cascade,
  user_id        uuid not null references public.users (id) on delete cascade,
  label          text not null, -- e.g. "Amount Paid" for paid-vs-billed rows
  amount_billed  numeric,
  amount_paid    numeric,
  is_flagged     boolean not null default false,
  explanation    text,
  created_at     timestamptz not null default now()
);

-- 4. promises -------------------------------------------------------------
create table public.promises (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  bill_id          uuid references public.bills (id) on delete cascade,
  description      text,
  promised_amount  numeric,
  file_path        text,
  created_at       timestamptz not null default now()
);

-- 5. messages ---------------------------------------------------------
-- line_item_id is the proof link: the one line_items row this message disputes.
create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  bill_id          uuid not null references public.bills (id) on delete cascade,
  line_item_id     uuid references public.line_items (id) on delete set null,
  action_taken     text, -- e.g. "sent", "skipped"
  tone_preset_used text,
  final_body       text,
  created_at       timestamptz not null default now()
);

-- 6. category_rates ---------------------------------------------------
-- Reference data (India GST only), not user-owned. Readable by every
-- signed-in user; writable only via service role (migrations/seed), which
-- bypasses RLS -- there is no insert/update/delete policy for regular users.
create table public.category_rates (
  category       text primary key,
  rate_percent   numeric,
  rate_type      text,
  source_note    text,
  last_verified  date
);

-- Row-level security ---------------------------------------------------
alter table public.users        enable row level security;
alter table public.bills        enable row level security;
alter table public.line_items   enable row level security;
alter table public.promises     enable row level security;
alter table public.messages     enable row level security;
alter table public.category_rates enable row level security;

-- users: a user can only see/update their own profile row.
create policy "users_select_own" on public.users
  for select using (auth.uid() = id);
create policy "users_update_own" on public.users
  for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "users_insert_own" on public.users
  for insert with check (auth.uid() = id);

-- bills: full CRUD on own rows only.
create policy "bills_select_own" on public.bills
  for select using (auth.uid() = user_id);
create policy "bills_insert_own" on public.bills
  for insert with check (auth.uid() = user_id);
create policy "bills_update_own" on public.bills
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bills_delete_own" on public.bills
  for delete using (auth.uid() = user_id);

-- line_items: same, keyed off the denormalized user_id.
create policy "line_items_select_own" on public.line_items
  for select using (auth.uid() = user_id);
create policy "line_items_insert_own" on public.line_items
  for insert with check (auth.uid() = user_id);
create policy "line_items_update_own" on public.line_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "line_items_delete_own" on public.line_items
  for delete using (auth.uid() = user_id);

-- promises: same.
create policy "promises_select_own" on public.promises
  for select using (auth.uid() = user_id);
create policy "promises_insert_own" on public.promises
  for insert with check (auth.uid() = user_id);
create policy "promises_update_own" on public.promises
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "promises_delete_own" on public.promises
  for delete using (auth.uid() = user_id);

-- messages: same.
create policy "messages_select_own" on public.messages
  for select using (auth.uid() = user_id);
create policy "messages_insert_own" on public.messages
  for insert with check (auth.uid() = user_id);
create policy "messages_update_own" on public.messages
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "messages_delete_own" on public.messages
  for delete using (auth.uid() = user_id);

-- category_rates: read-only reference table, any signed-in user.
create policy "category_rates_select_all" on public.category_rates
  for select using (auth.role() = 'authenticated');

-- Grants ------------------------------------------------------------
-- Auto-expose is off, so nothing is reachable via PostgREST until granted
-- here. Grant to `authenticated` only -- never to `anon` or `public`.
revoke all on schema public from anon, public;
grant usage on schema public to authenticated;

revoke all on all tables in schema public from anon, public;

grant select, insert, update, delete on public.users        to authenticated;
grant select, insert, update, delete on public.bills         to authenticated;
grant select, insert, update, delete on public.line_items    to authenticated;
grant select, insert, update, delete on public.promises      to authenticated;
grant select, insert, update, delete on public.messages      to authenticated;
grant select                          on public.category_rates to authenticated;
