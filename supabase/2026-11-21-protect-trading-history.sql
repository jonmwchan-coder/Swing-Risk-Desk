-- Run after supabase/schema.sql and revision history setup.
-- Fail closed when a stale browser tries to erase existing executed trades
-- without a corresponding explicit archival correction.
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.desk_preserves_history(p_prior jsonb, p_next jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  previous_position jsonb;
  replacement_position jsonb;
  previous_event jsonb;
  previous_adjustment jsonb;
  previous_archive jsonb;
  new_archive jsonb;
  record_type text;
  archive_kind text;
  old_id text;
  position_id text;
  allowed boolean;
begin
  if p_prior is null or p_next is null then return false; end if;
  if jsonb_typeof(p_prior->'positions')<>'array' or jsonb_typeof(p_next->'positions')<>'array' then return false; end if;
  if jsonb_typeof(p_prior->'archive') not in ('array') or jsonb_typeof(p_next->'archive') not in ('array') then return false; end if;
  if jsonb_typeof(p_prior->'adjustments')<>'array' or jsonb_typeof(p_next->'adjustments')<>'array' then return false; end if;
  new_archive := coalesce(p_next->'archive','[]'::jsonb);
  for previous_position in select value from jsonb_array_elements(p_prior->'positions') loop
    position_id := previous_position->>'id';
    select value into replacement_position from jsonb_array_elements(p_next->'positions') where value->>'id'=position_id limit 1;
    if replacement_position is null then
      select exists (
        select 1 from jsonb_array_elements(new_archive) as a
         where a->>'kind'='position' and a->'record'->>'id'=position_id
           and nullif(a->>'restoredAt','') is null
      ) into allowed;
      if not allowed then return false; end if;
    else
      foreach record_type in array array['fills','exits','journalEntries','planHistory'] loop
        if jsonb_typeof(previous_position->record_type)<>'array' or jsonb_typeof(replacement_position->record_type)<>'array' then return false; end if;
        for previous_event in select value from jsonb_array_elements(previous_position->record_type) loop
          old_id:=previous_event->>'id';
          if old_id is null then return false; end if;
          if not exists (
            select 1 from jsonb_array_elements(replacement_position->record_type) as nxt where nxt->>'id'=old_id
          ) then
            archive_kind:=case record_type when 'fills' then 'transaction' when 'exits' then 'transaction' when 'journalEntries' then 'journal-entry' else 'plan-revision' end;
            select exists (
              select 1 from jsonb_array_elements(new_archive) a
              where a->>'kind'=archive_kind and a->>'positionId'=position_id
                and nullif(a->>'restoredAt','') is null
                and (
                  (archive_kind='transaction' and a->'record'->'tx'->>'id'=old_id and a->'record'->>'side'=case record_type when 'fills' then 'BUY' else 'SELL' end)
                  or
                  (archive_kind<>'transaction' and a->'record'->>'id'=old_id)
                )
            ) into allowed;
            if not allowed then return false; end if;
          end if;
        end loop;
      end loop;
    end if;
  end loop;
  for previous_adjustment in select value from jsonb_array_elements(p_prior->'adjustments') loop
    old_id:=previous_adjustment->>'id';
    if old_id is null then return false; end if;
    if not exists(select 1 from jsonb_array_elements(p_next->'adjustments') a where a->>'id'=old_id) then
      select exists(select 1 from jsonb_array_elements(new_archive) a
        where a->>'kind'='adjustment' and a->'record'->>'id'=old_id and nullif(a->>'restoredAt','') is null) into allowed;
      if not allowed then return false; end if;
    end if;
  end loop;
  for previous_archive in select value from jsonb_array_elements(p_prior->'archive') loop
    old_id:=previous_archive->>'id';
    if old_id is null then return false; end if;
    if not exists(
      select 1 from jsonb_array_elements(new_archive) a
      where a->>'id'=old_id and
      (nullif(previous_archive->>'restoredAt','') is null or nullif(a->>'restoredAt','') is not null)
    ) then return false; end if;
  end loop;
  return true;
end
$function$
;
revoke all on function app_private.desk_preserves_history(jsonb,jsonb) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION app_private.reject_missing_desk_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if not app_private.desk_preserves_history(old.state,new.state) then
  raise exception 'Cloud snapshot removed recorded trades, journal history, or archive records without explicit archive markers'
   using errcode='23514';
 end if;
 return new;
end
$function$
;
revoke all on function app_private.reject_missing_desk_history() from public,anon,authenticated;

drop trigger if exists desk_prevent_stale_history_overwrite on public.desk_snapshots;
create trigger desk_prevent_stale_history_overwrite
before update of state on public.desk_snapshots
for each row execute function app_private.reject_missing_desk_history();
