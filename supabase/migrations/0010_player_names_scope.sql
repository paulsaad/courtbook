-- Phase 1 review: player_names() must return only players the caller may identify:
--   the caller themselves; players with a booking at a club where the caller is staff;
--   players who share a match with the caller (as organizer or participant).

create or replace function player_names(p_ids uuid[])
returns table (id uuid, name text, level player_level, sports sport[])
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.level, p.sports
  from profiles p
  where auth.uid() is not null
    and cardinality(p_ids) <= 200
    and p.id = any (p_ids)
    and (
      p.id = auth.uid()
      or exists (select 1 from bookings b where b.player_id = p.id and is_staff_of(b.club_id))
      or exists (
        select 1 from matches m
        left join match_players mp_me on mp_me.match_id = m.id and mp_me.profile_id = auth.uid()
        left join match_players mp_them on mp_them.match_id = m.id and mp_them.profile_id = p.id
        where (m.organizer_id = auth.uid() or mp_me.profile_id is not null)
          and (m.organizer_id = p.id or mp_them.profile_id is not null)
      )
    );
$$;
