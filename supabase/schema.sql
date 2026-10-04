-- Run this once in Supabase → SQL Editor → New query.
-- It creates one row per user holding their whole budget as JSON, and locks it down so each
-- signed-in user can only read and write their own row.

create table if not exists public.finance_data (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  rev        bigint not null default 1,          -- bumped on every save; used to detect edits from another device
  updated_at timestamptz not null default now(),
  constraint finance_data_size_limit check (pg_column_size(data) < 5000000)  -- ~5 MB per user
);

alter table public.finance_data enable row level security;

drop policy if exists "Users can read their own data"   on public.finance_data;
drop policy if exists "Users can insert their own data" on public.finance_data;
drop policy if exists "Users can update their own data" on public.finance_data;
drop policy if exists "Users can delete their own data" on public.finance_data;

create policy "Users can read their own data" on public.finance_data
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "Users can insert their own data" on public.finance_data
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "Users can update their own data" on public.finance_data
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Users can delete their own data" on public.finance_data
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Anonymous (signed-out) visitors get no access at all.
revoke all on public.finance_data from anon;
grant select, insert, update, delete on public.finance_data to authenticated;

-- Lets a signed-in user permanently delete their own account (their finance_data row is removed
-- by the ON DELETE CASCADE above). Runs with elevated rights but can only ever touch auth.uid().
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
