-- DRAFT — optional player profile photo. Not a numbered migration: nothing here runs on staging or production until
-- Paul approves it and it is given the next free number. Applies on top of the release-candidate schema (0001–0093).
--
-- Design (docs/profile-photo/README.md has the reasoning):
--   * The photo is a small WebP (≤ 256 × 256, ≤ 64 KB) stored in the database, one row per player. No storage bucket,
--     so there are no storage policies to get wrong or activate, and no file can outlive its row.
--   * Only the server writes a photo (set_player_photo refuses any signed-in caller): the web route decodes and
--     re-encodes every upload, which strips EXIF/GPS and bounds the size. A player may remove their own photo directly.
--   * Who may see it is decided here, per request, by player_photo() running as the viewer: the player themself, or a
--     player who shares a non-cancelled game with them where both are the organizer or accepted — and neither has
--     blocked the other, and the subject's account is neither closing nor suspended.
--   * Closing an account hides the photo at once (can_see_player_photo checks deletion_requested); the account's data
--     step deletes it (trigger on account_deletions → 'data_removed'), with the server key, like the rest of their data.
--   * The table gets 0086's closed-account lock-out, as every table must (0086 test E1).

-- 1 ------------------------------------------------------------------------------------------------------------------
create table if not exists player_photos (
  profile_id uuid primary key references profiles(id) on delete cascade,
  image      bytea not null
             check (octet_length(image) between 64 and 65536)
             -- RIFF....WEBP: the server only ever writes WebP; anything else is a bug, refused here too.
             check (substring(image from 1 for 4) = '\x52494646'::bytea and substring(image from 9 for 4) = '\x57454250'::bytea),
  width      int not null check (width between 32 and 256),
  height     int not null check (height between 32 and 256),
  version    int not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);
alter table player_photos enable row level security;   -- no policy: read and written only through the functions below
-- service_role too: Supabase grants it every table by default, and nothing needs that here (the server writes through
-- set_player_photo, the closure trigger runs as the owner). Without this, a direct write with the server key would
-- skip every check below: the same gap as H1 on account_deletions, not repeated on a new table.
revoke all on player_photos from public, anon, authenticated, service_role;

-- 2 ------------------------------------------------------------------------------------------------------------------
-- The one visibility rule. Internal: callers go through player_photo() / match_photo_versions(), which pass auth.uid().
create or replace function can_see_player_photo(p_viewer uuid, p_subject uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_viewer is not null and p_subject is not null
    and not deletion_requested(p_subject)
    and not exists (select 1 from account_suspensions where profile_id = p_subject)
    and (
      p_viewer = p_subject
      or (
        not players_blocked(p_viewer, p_subject)
        and exists (
          select 1
          from matches m
          where m.status <> 'cancelled'
            and (m.organizer_id = p_viewer
                 or exists (select 1 from match_players a where a.match_id = m.id and a.profile_id = p_viewer and a.status = 'accepted'))
            and (m.organizer_id = p_subject
                 or exists (select 1 from match_players b where b.match_id = m.id and b.profile_id = p_subject and b.status = 'accepted'))
        )
      )
    );
$$;
revoke all on function can_see_player_photo(uuid, uuid) from public, anon, authenticated;

-- 3 ------------------------------------------------------------------------------------------------------------------
-- The image, if the caller may see it. No row means "show the placeholder" — the same answer for "no photo" and
-- "not allowed", so the endpoint cannot be used to learn whether a stranger has a photo.
create or replace function player_photo(p_subject uuid)
returns table (image bytea, version int, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select pp.image, pp.version, pp.updated_at
  from player_photos pp
  where pp.profile_id = p_subject and can_see_player_photo(auth.uid(), p_subject);
$$;
revoke all on function player_photo(uuid) from public, anon;
grant execute on function player_photo(uuid) to authenticated;

-- Which players in this game have a photo the caller may see, and its version (for the image URL, so a replaced
-- photo is fetched afresh). Built on match_participants, so it never lists anyone the game page would not.
create or replace function match_photo_versions(p_match uuid)
returns table (profile_id uuid, version int)
language sql stable security definer set search_path = public as $$
  select pp.profile_id, pp.version
  from match_participants(p_match) mp
  join player_photos pp on pp.profile_id = mp.profile_id
  where can_see_player_photo(auth.uid(), mp.profile_id);
$$;
revoke all on function match_photo_versions(uuid) from public, anon;
grant execute on function match_photo_versions(uuid) to authenticated;

-- The caller's own photo version, or null: what the profile page needs to show it, without the bytes.
create or replace function my_photo_version() returns int
language sql stable security definer set search_path = public as $$
  select version from player_photos where profile_id = auth.uid();
$$;
revoke all on function my_photo_version() from public, anon;
grant execute on function my_photo_version() to authenticated;

-- 4 ------------------------------------------------------------------------------------------------------------------
-- Server-only writer: the route has already decoded, re-encoded and measured the image. Returns the new version.
create or replace function set_player_photo(p_actor uuid, p_image bytea, p_width int, p_height int) returns int
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;   -- only the server (service role, no user)
  if p_actor is null or not exists (select 1 from profiles where id = p_actor) then raise exception 'not_found'; end if;
  if deletion_requested(p_actor) then raise exception 'account_closed'; end if;
  if exists (select 1 from account_suspensions where profile_id = p_actor) then raise exception 'suspended'; end if;
  insert into player_photos as pp (profile_id, image, width, height)
  values (p_actor, p_image, p_width, p_height)
  on conflict (profile_id) do update
    set image = excluded.image, width = excluded.width, height = excluded.height,
        version = pp.version + 1, updated_at = now()
  returning pp.version into v;
  return v;
end $$;
revoke all on function set_player_photo(uuid, bytea, int, int) from public, anon, authenticated;
grant execute on function set_player_photo(uuid, bytea, int, int) to service_role;

-- A player removes their own photo. Removing needs no checking of bytes, so it runs as them.
create or replace function remove_player_photo() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  delete from player_photos where profile_id = auth.uid();
  return found;
end $$;
revoke all on function remove_player_photo() from public, anon;
grant execute on function remove_player_photo() to authenticated;

-- 5 ------------------------------------------------------------------------------------------------------------------
-- 0086's lock-out: a closed account changes nothing, on every table (0086 test E1 requires it of a new table).
do $$
begin
  if exists (select 1 from pg_proc where proname = 'refuse_writes_by_closed_account') then
    execute 'drop trigger if exists closed_account_lockout on player_photos';
    execute 'create trigger closed_account_lockout before insert or update or delete on player_photos '
         || 'for each statement execute function refuse_writes_by_closed_account()';
  end if;
end $$;

-- Account deletion: the photo is deleted at the account's data step, when its record becomes 'data_removed' (or
-- 'done', which follows it). That step runs with the server key, so the lock-out above lets it through. It is NOT
-- deleted at closing: closing runs as the person, and the lock-out refuses every write once their account is closed
-- (deleting there would make closing itself fail). From closing until the data step the photo is hidden from everyone
-- (can_see_player_photo), and an account under legal hold ('held') keeps it hidden, like the rest of its data.
-- An upload that raced the closure is caught by the same data step.
create or replace function player_photo_on_closure() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('data_removed', 'done') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    delete from player_photos where profile_id = new.subject_id;
  end if;
  return null;
end $$;
revoke all on function player_photo_on_closure() from public, anon, authenticated;
drop trigger if exists player_photo_on_closure on account_deletions;
create trigger player_photo_on_closure after insert or update of status on account_deletions
  for each row execute function player_photo_on_closure();
