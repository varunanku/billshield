-- Phase 1 item 3: sign-up now captures a full name, passed through
-- supabase.auth.signUp's user metadata (data: { full_name }). This adds a
-- nullable column to hold it on the public.users profile row, and updates
-- the signup trigger (0001_init.sql) to copy it from auth metadata --
-- nullable because a user who signed up before this existed has none, and
-- a signup can theoretically still omit it (defensive, not expected).
--
-- Idempotent: safe to run again even if already applied.
begin;

alter table public.users
  add column if not exists full_name text;

comment on column public.users.full_name is
  'Captured at sign-up (auth metadata full_name) -- nullable: null for accounts created before this column existed.';

-- Re-create (not just alter) the trigger function so it also copies
-- full_name for every NEW signup from here on; existing users are
-- untouched by this migration.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

commit;
