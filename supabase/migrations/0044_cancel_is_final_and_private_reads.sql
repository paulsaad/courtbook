-- Review of 0043 (two findings, both valid):
--   1. cancelled -> closed -> open reopened a cancelled match, bypassing the cancellation guard.
--   2. hiding a private match from the board was not enough: "matches: read" was using (true),
--      so any signed-in player could still read every match straight from the table.

-- 1. cancellation is final -----------------------------------------------------
create or replace function set_match_status(p_match uuid, p_status match_status) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; r record;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  -- a cancelled match stays cancelled: no route back, not even through 'closed'
  if m.status = 'cancelled' and p_status <> 'cancelled' then raise exception 'cannot_reopen'; end if;
  update matches set status = p_status,
    closed_at = case when p_status = 'open' then null else now() end,
    closed_reason = case when p_status = 'closed' then 'organizer' else null end
  where id = p_match;
  if p_status = 'closed' then
    -- clear the waiting list: the request is removed rather than declined, so if the organizer opens
    -- the match again those players may ask once more (a decline is final, see join_match)
    for r in select profile_id from match_players where match_id = p_match and status = 'pending' loop
      delete from match_players where match_id = p_match and profile_id = r.profile_id and status = 'pending';
      perform notify(r.profile_id, 'join_declined', p_match, 'The organizer made this match private');
    end loop;
  end if;
  if p_status = 'cancelled' then
    for r in select profile_id from match_players where match_id = p_match and status in ('accepted', 'pending') loop
      perform notify(r.profile_id, 'match_cancelled', p_match, 'Match cancelled by the organizer');
    end loop;
  end if;
end $$;
revoke execute on function set_match_status(uuid, match_status) from public, anon;
grant execute on function set_match_status(uuid, match_status) to authenticated;

-- 2. who may read a match row at all ------------------------------------------
-- security definer, so the policy below does not recurse through match_players' own policy
create or replace function is_in_match(p_match uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from matches m where m.id = p_match and m.organizer_id = auth.uid())
      or exists (select 1 from match_players mp where mp.match_id = p_match and mp.profile_id = auth.uid()
                   and mp.status in ('accepted', 'pending'));
$$;
revoke execute on function is_in_match(uuid) from public, anon;
grant execute on function is_in_match(uuid) to authenticated;

drop policy if exists "matches: read" on matches;
create policy "matches: read" on matches for select to authenticated using (
  status = 'open'                 -- on the board: anyone signed in may see it
  or organizer_id = auth.uid()
  or is_in_match(id)              -- in it, or waiting for an answer
  or is_staff_of(club_id)
  or is_admin()
);
