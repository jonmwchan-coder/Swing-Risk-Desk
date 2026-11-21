-- After deploying cloud client protocol 2, reject uploads from outdated app shells.
-- Keep this trigger in a non-exposed app_private schema; do not bypass RLS.
create or replace function app_private.reject_missing_desk_history()
returns trigger
language plpgsql security definer
set search_path=''
as $trigger$
begin
  if new.state->>'syncProtocolVersion' is distinct from '2' then
    raise exception 'Outdated Swing Desk app cannot save private cloud history. Reload both devices to update.'
      using errcode='23514';
  end if;
  if not app_private.desk_preserves_history(old.state,new.state) then
    raise exception 'Cloud snapshot removed recorded trades, journal history, or archive records without explicit archive markers'
      using errcode='23514';
  end if;
  return new;
end
$trigger$;
revoke all on function app_private.reject_missing_desk_history() from public,anon,authenticated;
