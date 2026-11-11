-- Paul (11 Nov): a match opened to players should be able to go private again *keeping* the players
-- who already joined. Private = status 'closed' by the organizer: out of discovery and out of other
-- players' boards, while the people already in keep the match, the chat and their place.
-- Going private also clears the waiting list — nobody is left hanging on a match they can no longer see.

create or replace function set_match_status(p_match uuid, p_status match_status) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; r record;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  if p_status = 'open' and m.status = 'cancelled' then raise exception 'cannot_reopen'; end if;
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

-- A private match belongs to the organizer and the players in it: a declined or former requester
-- must not keep seeing it on their board (was: any match_players row at all).
drop function if exists match_board(uuid, int);
create function match_board(p_club uuid, p_days int)
returns table (
  match_id uuid, club_id uuid, club_name text, club_slug text, sport sport, start_at timestamptz, end_at timestamptz,
  level_min int, level_max int, level_legacy boolean, my_level int,
  players_needed int, joined int, pending int, status match_status, note text, join_mode text,
  organizer_id uuid, organizer_name text, my_status text, i_organize boolean, booking_id uuid, court_name text
)
language sql stable security definer set search_path = public as $$
  select m.id, m.club_id, c.name, c.slug, m.sport, m.start_at, m.end_at,
         (match_level_bounds(m))[1], (match_level_bounds(m))[2], m.level_min is null and m.level is not null,
         (select pl.level from player_levels pl where pl.profile_id = auth.uid() and pl.sport = m.sport),
         m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'pending')::int,
         m.status, m.note, m.join_mode, m.organizer_id, o.name,
         (select mp.status from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()),
         m.organizer_id = auth.uid(),
         m.booking_id, k.name
  from matches m
  left join clubs c on c.id = m.club_id
  left join profiles o on o.id = m.organizer_id
  left join bookings b on b.id = m.booking_id
  left join courts k on k.id = b.court_id
  where auth.uid() is not null
    and (p_club is null or m.club_id = p_club)
    and m.start_at > now() and m.start_at < now() + make_interval(days => coalesce(p_days, 14))
    and (m.status = 'open' or m.organizer_id = auth.uid()
         or exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()
                      and mp.status in ('accepted', 'pending')))
  order by m.start_at;
$$;
revoke execute on function match_board(uuid, int) from public, anon;
grant execute on function match_board(uuid, int) to authenticated;
