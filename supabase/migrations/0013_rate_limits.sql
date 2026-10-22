-- Abuse limits (security phase 3).
--
-- 1. rate_limit_hits + hit_rate_limit(): a fixed-window counter shared by
--    every Vercel instance. Server routes call it with the service role key
--    for per-user and per-IP limits on sign-up, sign-in, extraction, chat
--    and email regeneration (lib/rate-limit.ts). RLS is on and there are no
--    policies or grants for users: only the security-definer function
--    touches the table, and only service_role may call the function.
-- 2. Uploads go straight from the browser to storage, so the per-user upload
--    limit lives in the storage insert policy itself: at most 30 files per
--    user per hour.
--
-- Idempotent: safe to run again even if already applied.
begin;

create table if not exists public.rate_limit_hits (
  key          text primary key,
  window_start timestamptz not null,
  hits         integer not null
);

alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from anon, authenticated, public;

-- Returns 0 when the call is allowed, otherwise the seconds until the
-- current window ends.
create or replace function public.hit_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.rate_limit_hits%rowtype;
  win interval := make_interval(secs => p_window_seconds);
begin
  insert into public.rate_limit_hits as t (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update set
    window_start = case when t.window_start < now() - win then now() else t.window_start end,
    hits         = case when t.window_start < now() - win then 1 else t.hits + 1 end
  returning * into r;

  if r.hits > p_limit then
    return greatest(1, ceil(extract(epoch from (r.window_start + win - now())))::integer);
  end if;
  return 0;
end;
$$;

revoke execute on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;

-- Same ownership rule as 0001's policy, plus the hourly cap. The subquery
-- runs under the select policy (own folder only), so it counts only this
-- user's own files.
drop policy if exists "bills_bucket_insert_own" on storage.objects;
create policy "bills_bucket_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (
      select count(*) from storage.objects o
      where o.bucket_id = 'bills'
        and (storage.foldername(o.name))[1] = auth.uid()::text
        and o.created_at > now() - interval '1 hour'
    ) < 30
  );

commit;
