-- DRAFT (not a migration; number assigned on approval — 0067 is reserved for M3's match_detail).
-- Favourite clubs, linked to the player's account so they follow them across devices.
-- Validated by supabase/tests/favourites/club_favourites.sh inside rolled-back transactions on the
-- local replica. Not applied to any database.
--
-- Design:
--  * one row per (player, club); the primary key makes a duplicate impossible;
--  * players read only their own rows (RLS); nobody else — not other players, not club staff — can
--    see who favourited a club;
--  * no client may insert, update or delete rows directly: the only write is set_club_favourite(),
--    which is idempotent (asking twice for the same state changes nothing and never errors);
--  * a club that is inactive can't be added; a favourite of a club that later becomes inactive is
--    kept (it reappears if the club returns) but my_favourite_clubs() leaves it out;
--  * rows go with the account (profiles on delete cascade) and with the club.

create table if not exists club_favourites (
  profile_id uuid not null references profiles(id) on delete cascade,
  club_id    uuid not null references clubs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, club_id)
);
create index if not exists club_favourites_club_idx on club_favourites (club_id);

alter table club_favourites enable row level security;
drop policy if exists "club_favourites: own read" on club_favourites;
create policy "club_favourites: own read" on club_favourites
  for select to authenticated using (profile_id = auth.uid());

-- Supabase grants ALL on new tables to anon and authenticated by default; take that back so the
-- only access is the read policy above and the functions below (lesson of M3 finding S5).
revoke all on club_favourites from public, anon, authenticated;
grant select on club_favourites to authenticated;

-- Add or remove one favourite. Returns the resulting state. Idempotent.
create or replace function set_club_favourite(p_club uuid, p_favourite boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated'; end if;
  if p_favourite is null then raise exception 'bad_request'; end if;
  if not p_favourite then
    delete from club_favourites where profile_id = me and club_id = p_club;
    return false;
  end if;
  if not exists (select 1 from clubs where id = p_club and active) then
    raise exception 'club_not_found';
  end if;
  if (select count(*) from club_favourites where profile_id = me) >= 50
     and not exists (select 1 from club_favourites where profile_id = me and club_id = p_club) then
    raise exception 'too_many_favourites';
  end if;
  insert into club_favourites (profile_id, club_id) values (me, p_club)
  on conflict (profile_id, club_id) do nothing;
  return true;
end;
$$;
revoke all on function set_club_favourite(uuid, boolean) from public, anon;
grant execute on function set_club_favourite(uuid, boolean) to authenticated;

-- My favourites among clubs that are active now, most recently added first.
create or replace function my_favourite_clubs()
returns table (club_id uuid, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select f.club_id, f.created_at
  from club_favourites f
  join clubs c on c.id = f.club_id and c.active
  where f.profile_id = auth.uid()
  order by f.created_at desc, f.club_id;
$$;
revoke all on function my_favourite_clubs() from public, anon;
grant execute on function my_favourite_clubs() to authenticated;
