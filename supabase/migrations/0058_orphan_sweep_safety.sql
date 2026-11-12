-- Round 3 of the review found that an absent row is not proof of refusal: if the publishing
-- transaction is still running — blocked on the club lock, say — a read sees nothing, and the route
-- would delete a file the transaction then commits a reference to. The route now deletes a file only
-- on proof that nothing can still commit, and records anything else here instead.
--
-- That means this table holds two different kinds of entry, and round 4 was right that calling them
-- all "orphans" invites a cleanup that deletes the wrong file:
--
--   certain = true   The database refused, terminally, and said so. Nothing referenced the file at
--                    that moment and nothing can come along later. The file is safe to delete.
--   certain = false  **A reconciliation candidate, not a file proven safe to delete.** Nobody knows
--                    how the publication ended. The path may be referenced a moment from now.
--
-- WHOEVER CLEANS THESE UP must establish a terminal outcome for an uncertain entry first. "Not
-- currently referenced" is not sufficient and neither is a list fetched a moment ago, because both
-- can be made stale by a transaction that is still running. The outcome available in practice is
-- age: no transaction outlives the server's statement and idle-in-transaction timeouts, so an entry
-- older than that by a comfortable margin has settled. A sweep must therefore re-check the reference
-- inside the same transaction that deletes, and only for entries old enough to have settled.
-- There is no sweep yet; this is the contract for the one that gets written.
alter table media_orphans add column if not exists certain boolean not null default false;

-- Whoever records a file now has to say which kind it is. No default: the caller knows, and guessing
-- wrong in either direction is the bug this migration exists to prevent.
create or replace function record_media_orphan(
  p_actor uuid, p_club uuid, p_path text, p_reason text, p_certain boolean
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_club_editor_as(p_actor, p_club);
  perform assert_media_path(p_club, p_path);          -- only this club's own files
  if p_certain is null then raise exception 'certainty_required'; end if;
  if exists (select 1 from club_media where path = p_path) then raise exception 'still_in_use'; end if;
  insert into media_orphans (club_id, path, reason, certain) values (p_club, p_path, p_reason, p_certain);
end $$;

drop function if exists record_media_orphan(uuid, uuid, text, text);
revoke execute on function record_media_orphan(uuid, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function record_media_orphan(uuid, uuid, text, text, boolean) to service_role;

-- The list still hides anything a row references, which is necessary but not sufficient — see above.
create or replace function media_orphans_list() returns setof media_orphans
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
    select o.* from media_orphans o
    where o.cleared_at is null
      and not exists (select 1 from club_media m where m.path = o.path)
    order by o.certain desc, o.noticed_at;      -- the ones safe to act on first
end $$;
revoke execute on function media_orphans_list() from public, anon;
grant execute on function media_orphans_list() to authenticated;
