-- Phase 1 review round 2: player_public allowed any authenticated user to list every
-- player. Replace with a lookup by explicit ids: callers only learn names for ids they
-- already hold (match participants; staff: bookers at their club). No phone, no listing.

drop view player_public;

create or replace function player_names(p_ids uuid[])
returns table (id uuid, name text, level player_level, sports sport[])
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.level, p.sports
  from profiles p
  where auth.uid() is not null
    and p.id = any (p_ids)
    and cardinality(p_ids) <= 200;
$$;
revoke execute on function player_names(uuid[]) from public, anon;
grant execute on function player_names(uuid[]) to authenticated;
