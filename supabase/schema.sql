-- Swing Risk Desk: private, authenticated, revision-checked snapshot storage.
-- Run once in your OWN Supabase project's SQL editor. Never commit keys, IBKR exports or JSON backups.
create table if not exists public.desk_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check(revision >= 0),
  state jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.desk_snapshots enable row level security;
revoke all on public.desk_snapshots from anon;
grant select on public.desk_snapshots to authenticated;
create policy "Read only your own desk" on public.desk_snapshots
for select to authenticated using(user_id = (select auth.uid()));

create or replace function public.save_desk_snapshot(p_expected_revision bigint, p_state jsonb)
returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  who uuid := (select auth.uid());
  current_revision bigint;
  next_revision bigint;
begin
  if who is null then raise exception 'Sign in required' using errcode='28000'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid expected revision' using errcode='22023'; end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' then raise exception 'Expected JSON object' using errcode='22023'; end if;
  if pg_column_size(p_state) > 15000000 then raise exception 'Snapshot exceeds 15 MB size limit' using errcode='22023'; end if;
  if not (p_state ? 'accounts' and p_state ? 'positions' and p_state ? 'adjustments') then raise exception 'Invalid ledger snapshot' using errcode='22023'; end if;
  -- Lock each per-user row: concurrent devices cannot silently overwrite a newer revision.
  select revision into current_revision from public.desk_snapshots where user_id=who for update;
  if not found then
    if p_expected_revision<>0 then raise exception 'Cloud version conflict' using errcode='40001'; end if;
    begin
      insert into public.desk_snapshots(user_id,revision,state) values(who,1,p_state);
      return 1;
    exception when unique_violation then
      raise exception 'Cloud version conflict' using errcode='40001';
    end;
  end if;
  if current_revision <> p_expected_revision then raise exception 'Cloud version conflict' using errcode='40001'; end if;
  next_revision := current_revision+1;
  update public.desk_snapshots set revision=next_revision,state=p_state,updated_at=now() where user_id=who;
  return next_revision;
end;$$;
revoke all on function public.save_desk_snapshot(bigint,jsonb) from public, anon;
grant execute on function public.save_desk_snapshot(bigint,jsonb) to authenticated;