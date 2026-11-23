-- 0087: favourite clubs, linked to the player's account so they follow them across devices.
-- From the approved draft (docs/favourites/sql/club_favourites.draft.sql, frozen at bd3b8f1, 17 Nov), with two
-- changes for what has shipped since:
--  * "a club a player may favourite / sees in the list" is club_visible_to_me (0078/0085: published, and not a hidden
--    demo club), not just `active` — so an unpublished or hidden club can never appear through favourites;
--  * my_favourite_clubs() also returns what Home's "Your clubs" row shows (name, slug, town, area, cover, map point),
--    so Home needs no second read; favourites in different regions come back together.
-- 0086 compatibility: if account closing (0086) exists, the closed-account lock-out trigger is attached here too.
--
-- Design (unchanged from the draft):
--  * one row per (player, club); the primary key makes a duplicate impossible;
--  * players read only their own rows (RLS); nobody else — not other players, not club staff — can see who
--    favourited a club;
--  * no client may insert, update or delete rows directly: the only write is set_club_favourite(), idempotent and
--    serialised per player, so the 50-favourite cap holds under concurrent requests;
--  * a favourite of a club that stops being visible is kept (it reappears if the club returns) but is not listed;
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
  if not exists (select 1 from clubs c where c.id = p_club and club_visible_to_me(c.id, c.is_demo)) then
    raise exception 'club_not_found';
  end if;
  -- Serialise additions per player, so two requests at the same moment can't both see 49 and both
  -- insert: the second waits here until the first commits, then counts 50. Same lock the booking
  -- functions take on the player's profile row (0002, 0007). Held until the transaction ends.
  perform 1 from profiles where id = me for update;
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

-- My favourites among clubs I can see now, most recently added first, with what Home shows.
drop function if exists my_favourite_clubs();
create or replace function my_favourite_clubs()
returns table (club_id uuid, created_at timestamptz, name text, slug text, town text, district_code text,
               governorate_code text, cover_url text, lat numeric, lng numeric, is_demo boolean)
language sql stable security definer set search_path = public as $$
  select f.club_id, f.created_at, c.name, c.slug, t.name_en, t.district_code, d.governorate_code, c.cover_url,
         c.lat, c.lng, c.is_demo
  from club_favourites f
  join clubs c on c.id = f.club_id and club_visible_to_me(c.id, c.is_demo)
  left join towns t on t.id = c.town_id
  left join districts d on d.code = t.district_code
  where f.profile_id = auth.uid()
  order by f.created_at desc, f.club_id;
$$;
revoke all on function my_favourite_clubs() from public, anon;
grant execute on function my_favourite_clubs() to authenticated;

-- 0086 (account closing) attaches its lock-out to every table that exists when it runs. A table created after it
-- needs the same trigger, so a closed account cannot change its favourites either.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'refuse_writes_by_closed_account') then
    execute 'drop trigger if exists closed_account_lockout on club_favourites';
    execute 'create trigger closed_account_lockout before insert or update or delete on club_favourites '
         || 'for each statement execute function refuse_writes_by_closed_account()';
  end if;
end $$;
