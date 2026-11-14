-- Applied to Supabase project qgfahvkcbdqfmjbpxgec on 2026-11-14.
-- Preserve the preceding 30 ledger revisions; use with supabase/schema.sql.
-- This archive is server-side only: the app still exports one full JSON backup.
create table if not exists public.desk_snapshot_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  revision bigint not null check (revision >= 0),
  state jsonb not null,
  archived_at timestamptz not null default now(),
  primary key (user_id, revision)
);
alter table public.desk_snapshot_history enable row level security;
revoke all on public.desk_snapshot_history from public, anon, authenticated;
grant select on public.desk_snapshot_history to authenticated;
create policy "Read only your own recovery versions" on public.desk_snapshot_history
for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.archive_desk_snapshot_update()
returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if new.revision > old.revision then
    insert into public.desk_snapshot_history (user_id, revision, state)
    values (old.user_id, old.revision, old.state)
    on conflict (user_id, revision) do nothing;
    delete from public.desk_snapshot_history
    where user_id = old.user_id
      and revision not in (
        select revision from public.desk_snapshot_history
        where user_id = old.user_id
        order by revision desc limit 30
      );
  end if;
  return new;
end;$$;
create trigger desk_snapshot_history_on_update
before update of revision on public.desk_snapshots
for each row execute function public.archive_desk_snapshot_update();
