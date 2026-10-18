-- BillShield: core schema, RLS, grants.
-- Columns match docs/schema.md exactly (section 4 of the submission doc).
-- Auto-expose is off for this project, so every table (and every helper
-- function RLS calls) needs an explicit GRANT to `authenticated` below --
-- PostgREST serves nothing that isn't granted, and we never grant to `anon`.

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
-- Header facts only; individual charges live in line_items.
create table public.bills (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id) on delete cascade,
  provider_name   text not null,
  bill_date       date not null,
  total_amount    numeric(12,2) not null,
  file_path       text not null, -- storage object path, not the file itself
  support_contact text,          -- nullable: only if the bill prints one
  category        text,          -- nullable: LLM-assigned, closed list
  created_at      timestamptz not null default now()
);

-- 3. line_items -----------------------------------------------------------
-- One row per charge on a bill: label and amount. No user_id here --
-- ownership follows the parent bill (see RLS below).
create table public.line_items (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references public.bills (id) on delete cascade,
  line_order integer not null,
  label      text not null, -- e.g. "Static IP Charges", or "Amount Paid"
  amount     numeric(12,2) not null,
  flagged    boolean not null default false
);

-- 4. promises -------------------------------------------------------------
create table public.promises (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references public.bills (id) on delete cascade,
  statement  text not null, -- the user's own words
  source     text,          -- nullable: verbal, written or plan page
  created_at timestamptz not null default now()
);

-- 5. messages ---------------------------------------------------------
-- The AI-drafted email or verdict. line_item_id is the proof link: the one
-- line_items row this message disputes (empty for a clean verdict).
create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  bill_id          uuid not null references public.bills (id) on delete cascade,
  line_item_id     uuid references public.line_items (id) on delete set null,
  promise_id       uuid references public.promises (id) on delete set null,
  subject          text not null,
  body             text not null,
  tone             text not null, -- 'confident' or 'inquiry'
  created_at       timestamptz not null default now(),
  action_taken     text, -- nullable: sent_as_is / sent_with_tone_preset / sent_manually_edited / not_sent
  tone_preset_used text, -- nullable: e.g. more_formal, more_concise, friendlier
  final_body       text  -- nullable: what was actually sent, if it differs from body
);

-- 6. category_rates ---------------------------------------------------
-- Reference data (India GST only), not user-owned. Readable by every
-- signed-in user; writable only via service role (migrations/seed), which
-- bypasses RLS -- there is no insert/update/delete policy for regular users.
create table public.category_rates (
  category      text primary key, -- matches bills.category
  rate_percent  numeric(5,2),     -- nullable: null if not sourced
  rate_type     text not null,    -- gst_flat, slab_based, or not_confirmed
  source_note   text,             -- nullable
  last_verified date              -- nullable
);

-- Ownership helpers for RLS ------------------------------------------
-- line_items, promises and messages have no user_id column -- ownership
-- follows the bill. These are `stable`/`security invoker`, so each call
-- runs as the calling user and is itself subject to bills' own RLS.

create function public.bill_owned_by_current_user(p_bill_id uuid)
returns boolean
language sql
stable
security invoker
as $$
  select exists (
    select 1 from public.bills b
    where b.id = p_bill_id and b.user_id = auth.uid()
  );
$$;

-- For messages insert/update: line_item_id and promise_id, when set, must
-- belong to the same bill as the message -- otherwise one user could link
-- a message row to another user's line_items/promises.
create function public.message_links_belong_to_bill(
  p_bill_id uuid,
  p_line_item_id uuid,
  p_promise_id uuid
)
returns boolean
language sql
stable
security invoker
as $$
  select
    (p_line_item_id is null or exists (
      select 1 from public.line_items li
      where li.id = p_line_item_id and li.bill_id = p_bill_id
    ))
    and
    (p_promise_id is null or exists (
      select 1 from public.promises p
      where p.id = p_promise_id and p.bill_id = p_bill_id
    ));
$$;

-- Row-level security ---------------------------------------------------
alter table public.users          enable row level security;
alter table public.bills          enable row level security;
alter table public.line_items     enable row level security;
alter table public.promises       enable row level security;
alter table public.messages       enable row level security;
alter table public.category_rates enable row level security;

-- users: a user can only see/update their own profile row.
create policy "users_select_own" on public.users
  for select using (auth.uid() = id);
create policy "users_insert_own" on public.users
  for insert with check (auth.uid() = id);
create policy "users_update_own" on public.users
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- bills: full CRUD on own rows only.
create policy "bills_select_own" on public.bills
  for select using (auth.uid() = user_id);
create policy "bills_insert_own" on public.bills
  for insert with check (auth.uid() = user_id);
create policy "bills_update_own" on public.bills
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bills_delete_own" on public.bills
  for delete using (auth.uid() = user_id);

-- line_items: ownership follows the parent bill.
create policy "line_items_select_own" on public.line_items
  for select using (public.bill_owned_by_current_user(bill_id));
create policy "line_items_insert_own" on public.line_items
  for insert with check (public.bill_owned_by_current_user(bill_id));
create policy "line_items_update_own" on public.line_items
  for update
  using (public.bill_owned_by_current_user(bill_id))
  with check (public.bill_owned_by_current_user(bill_id));
create policy "line_items_delete_own" on public.line_items
  for delete using (public.bill_owned_by_current_user(bill_id));

-- promises: ownership follows the parent bill.
create policy "promises_select_own" on public.promises
  for select using (public.bill_owned_by_current_user(bill_id));
create policy "promises_insert_own" on public.promises
  for insert with check (public.bill_owned_by_current_user(bill_id));
create policy "promises_update_own" on public.promises
  for update
  using (public.bill_owned_by_current_user(bill_id))
  with check (public.bill_owned_by_current_user(bill_id));
create policy "promises_delete_own" on public.promises
  for delete using (public.bill_owned_by_current_user(bill_id));

-- messages: ownership follows the parent bill. insert/update additionally
-- require that line_item_id and promise_id (when set) belong to that same
-- bill, so a message can never be linked to another user's rows.
create policy "messages_select_own" on public.messages
  for select using (public.bill_owned_by_current_user(bill_id));
create policy "messages_insert_own" on public.messages
  for insert with check (
    public.bill_owned_by_current_user(bill_id)
    and public.message_links_belong_to_bill(bill_id, line_item_id, promise_id)
  );
create policy "messages_update_own" on public.messages
  for update
  using (public.bill_owned_by_current_user(bill_id))
  with check (
    public.bill_owned_by_current_user(bill_id)
    and public.message_links_belong_to_bill(bill_id, line_item_id, promise_id)
  );
create policy "messages_delete_own" on public.messages
  for delete using (public.bill_owned_by_current_user(bill_id));

-- category_rates: read-only reference table, any signed-in user.
create policy "category_rates_select_all" on public.category_rates
  for select using (auth.role() = 'authenticated');

-- Grants ------------------------------------------------------------
-- Auto-expose is off, so nothing is reachable via PostgREST until granted
-- here. Grant to `authenticated` only -- never to `anon` or `public`.
revoke all on schema public from anon, public;
grant usage on schema public to authenticated;

revoke all on all tables in schema public from anon, public;

grant select, insert, update, delete on public.users          to authenticated;
grant select, insert, update, delete on public.bills           to authenticated;
grant select, insert, update, delete on public.line_items      to authenticated;
grant select, insert, update, delete on public.promises        to authenticated;
grant select, insert, update, delete on public.messages        to authenticated;
grant select                          on public.category_rates to authenticated;

-- Functions default to EXECUTE granted to PUBLIC (which anon inherits) --
-- revoke that and grant to authenticated only, same as the tables above.
revoke execute on function public.bill_owned_by_current_user(uuid) from public;
revoke execute on function public.message_links_belong_to_bill(uuid, uuid, uuid) from public;
grant execute on function public.bill_owned_by_current_user(uuid) to authenticated;
grant execute on function public.message_links_belong_to_bill(uuid, uuid, uuid) to authenticated;
