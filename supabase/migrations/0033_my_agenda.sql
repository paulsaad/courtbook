-- Phase 6 (d): one list of everything the player has committed to — bookings and matches — for My CourtBook and Home.
create or replace function my_agenda()
returns table (kind text, id uuid, start_at timestamptz, end_at timestamptz, club_name text, club_slug text, timezone text, title text, status text, role text)
language sql stable security definer set search_path = public as $$
  (select 'booking', b.id, b.start_at, b.end_at, c.name, c.slug, c.timezone, k.name, b.status::text, 'player'
   from bookings b join clubs c on c.id = b.club_id left join courts k on k.id = b.court_id
   where auth.uid() is not null and b.player_id = auth.uid() and b.status in ('confirmed', 'cancelled', 'no_show'))
  union all
  (select 'match', m.id, m.start_at, m.end_at, c.name, c.slug, c.timezone, coalesce(s.name_en, m.sport::text) || ' match', m.status::text,
          case when m.organizer_id = auth.uid() then 'organizer' else mp.status end
   from matches m join clubs c on c.id = m.club_id
   left join sports s on s.code = m.sport
   left join match_players mp on mp.match_id = m.id and mp.profile_id = auth.uid()
   where auth.uid() is not null and (m.organizer_id = auth.uid() or mp.status in ('accepted', 'pending')))
  order by start_at desc
  limit 200;
$$;
revoke execute on function my_agenda() from public, anon;
grant execute on function my_agenda() to authenticated;
