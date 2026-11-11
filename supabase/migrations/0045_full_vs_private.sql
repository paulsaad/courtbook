-- Paul on the phone (11 Nov): after he accepted the player who joined, the match "became private by
-- itself". It had filled up, so join_match closed it automatically — correct, but the booking card
-- then read like a private match and offered to put a full match back on the board, where nobody
-- could join it. Tell the two apart: closed_reason is 'full' or 'organizer'.

-- reopening a full match would list it where no one can join; refuse and let the organizer add a spot instead
create or replace function set_match_status(p_match uuid, p_status match_status) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; r record; n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' and p_status <> 'cancelled' then raise exception 'cannot_reopen'; end if;
  if p_status = 'open' and m.status <> 'open' then
    select count(*) into n from match_players where match_id = p_match and status = 'accepted';
    if n >= m.players_needed then raise exception 'match_full'; end if;
  end if;
  update matches set status = p_status,
    closed_at = case when p_status = 'open' then null else now() end,
    closed_reason = case when p_status = 'closed' then 'organizer' else null end
  where id = p_match;
  if p_status = 'closed' then
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

-- why a match is closed, so the app can say "Full" or "Private"
drop function if exists booking_match(uuid);
create function booking_match(p_booking uuid)
returns table (match_id uuid, status match_status, closed_reason text, players_needed int, joined int, pending int, level_min int, level_max int, join_mode text)
language sql stable security definer set search_path = public as $$
  select m.id, m.status, m.closed_reason, m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'pending')::int,
         m.level_min, m.level_max, m.join_mode
  from matches m join bookings b on b.id = m.booking_id
  where m.booking_id = p_booking and m.status <> 'cancelled' and b.player_id = auth.uid()
  limit 1;
$$;
revoke execute on function booking_match(uuid) from public, anon;
grant execute on function booking_match(uuid) to authenticated;

drop function if exists match_board(uuid, int);
create function match_board(p_club uuid, p_days int)
returns table (
  match_id uuid, club_id uuid, club_name text, club_slug text, sport sport, start_at timestamptz, end_at timestamptz,
  level_min int, level_max int, level_legacy boolean, my_level int,
  players_needed int, joined int, pending int, status match_status, closed_reason text, note text, join_mode text,
  organizer_id uuid, organizer_name text, my_status text, i_organize boolean, booking_id uuid, court_name text
)
language sql stable security definer set search_path = public as $$
  select m.id, m.club_id, c.name, c.slug, m.sport, m.start_at, m.end_at,
         (match_level_bounds(m))[1], (match_level_bounds(m))[2], m.level_min is null and m.level is not null,
         (select pl.level from player_levels pl where pl.profile_id = auth.uid() and pl.sport = m.sport),
         m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'pending')::int,
         m.status, m.closed_reason, m.note, m.join_mode, m.organizer_id, o.name,
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
