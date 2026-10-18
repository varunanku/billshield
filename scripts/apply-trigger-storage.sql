create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

insert into storage.buckets (id, name, public)
values ('bills', 'bills', false)
on conflict (id) do nothing;

create policy "bills_bucket_select_own" on storage.objects
  for select using (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "bills_bucket_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "bills_bucket_update_own" on storage.objects
  for update
  using (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "bills_bucket_delete_own" on storage.objects
  for delete using (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
