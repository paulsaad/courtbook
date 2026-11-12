-- Phase 11 step (a): club images, stored and governed by the database.
--
-- Every upload goes through one server route that re-encodes the file before it is stored, and the
-- bucket refuses writes from anyone but that route. So the checks below are guaranteed for every
-- published image, not merely applied by the form: real image content, bounded dimensions, bounded
-- size, WebP, and no EXIF (re-encoding drops it).
--
-- Concurrency: every write takes the club row, so two staff editing the same club's images are
-- serialized. A replacement also states which row it believed was current; if that is no longer the
-- case the write is refused rather than deleting an image someone else has just made current.

create table if not exists club_media (
  id           uuid primary key default gen_random_uuid(),
  club_id      uuid not null references clubs(id) on delete cascade,
  kind         text not null check (kind in ('cover', 'logo', 'gallery')),
  path         text unique,                       -- object in the club-media bucket
  external_url text,                              -- a cover that predates managed storage
  caption      text check (caption is null or char_length(caption) <= 80),
  sort         int not null default 0,
  width        int, height int,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now(),
  check (num_nonnulls(path, external_url) = 1),   -- exactly one source
  check (kind = 'gallery' or caption is null)
);
create unique index if not exists club_media_one_cover on club_media (club_id) where kind = 'cover';
create unique index if not exists club_media_one_logo  on club_media (club_id) where kind = 'logo';
create index if not exists club_media_club_idx on club_media (club_id, kind, sort);

alter table club_media enable row level security;
drop policy if exists "club_media: read" on club_media;
create policy "club_media: read" on club_media for select using (true);   -- venue photos are public

-- files that are no longer referenced but could not be deleted at the time
create table if not exists media_orphans (
  id         uuid primary key default gen_random_uuid(),
  club_id    uuid references clubs(id) on delete set null,
  path       text not null,
  reason     text,
  noticed_at timestamptz not null default now(),
  cleared_at timestamptz
);
alter table media_orphans enable row level security;   -- admin reads it through an RPC; no policy

-- Venue information ------------------------------------------------------------------------------
alter table clubs add column if not exists description text;
alter table clubs add column if not exists arrival_notes text;
alter table clubs drop constraint if exists clubs_description_len;
alter table clubs add constraint clubs_description_len check (char_length(coalesce(description, '')) <= 600);
alter table clubs drop constraint if exists clubs_arrival_len;
alter table clubs add constraint clubs_arrival_len check (char_length(coalesce(arrival_notes, '')) <= 300);
-- null means the club has not said, which is not the same as saying no
alter table clubs add column if not exists has_parking boolean;
alter table clubs add column if not exists has_changing_rooms boolean;
alter table clubs add column if not exists has_showers boolean;
alter table clubs add column if not exists has_equipment_rental boolean;
alter table clubs add column if not exists has_cafe boolean;
alter table clubs add column if not exists has_floodlights boolean;
alter table clubs add column if not exists has_drinking_water boolean;
alter table clubs add column if not exists facilities_confirmed_at timestamptz;

-- cover_url stays the single field discovery already reads; a trigger keeps it true ---------------
create or replace function club_media_sync_cover() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_club uuid := coalesce(new.club_id, old.club_id);
begin
  update clubs c set cover_url = (
    select coalesce(m.external_url, '/storage/v1/object/public/club-media/' || m.path)
    from club_media m where m.club_id = v_club and m.kind = 'cover'
  ) where c.id = v_club;
  return null;
end $$;
drop trigger if exists club_media_cover_sync on club_media;
create trigger club_media_cover_sync after insert or update or delete on club_media
  for each row execute function club_media_sync_cover();

-- Anything already using a cover URL keeps its image: it becomes a cover row pointing at the same
-- address, so nothing is re-hosted and nothing disappears.
insert into club_media (club_id, kind, external_url, sort)
select c.id, 'cover', c.cover_url, 0 from clubs c
where coalesce(c.cover_url, '') <> ''
  and not exists (select 1 from club_media m where m.club_id = c.id and m.kind = 'cover');

-- Writes -------------------------------------------------------------------------------------------
create or replace function assert_club_editor(p_club uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;
end $$;
revoke execute on function assert_club_editor(uuid) from public, anon;

-- Set the cover or the logo. p_expect is the row the caller believed was current: null means "there
-- was none". A mismatch means someone else changed it first, and we refuse rather than delete their
-- image. Returns the path that is now unreferenced, for the caller to delete afterwards.
create or replace function set_club_image(
  p_club uuid, p_kind text, p_path text, p_width int, p_height int, p_expect uuid
) returns table (media_id uuid, old_path text)
language plpgsql security definer set search_path = public as $$
declare v_old club_media%rowtype; v_id uuid;
begin
  perform assert_club_editor(p_club);
  if p_kind not in ('cover', 'logo') then raise exception 'bad_kind'; end if;
  if p_path is null then raise exception 'path_required'; end if;
  perform 1 from clubs where id = p_club for update;          -- serialize edits to this club

  select * into v_old from club_media where club_id = p_club and kind = p_kind;
  if coalesce(v_old.id::text, '') is distinct from coalesce(p_expect::text, '') then
    raise exception 'changed_elsewhere';
  end if;

  if v_old.id is not null then delete from club_media where id = v_old.id; end if;
  insert into club_media (club_id, kind, path, width, height, created_by)
  values (p_club, p_kind, p_path, p_width, p_height, auth.uid())
  returning id into v_id;
  return query select v_id, v_old.path;
end $$;
revoke execute on function set_club_image(uuid, text, text, int, int, uuid) from public, anon;
grant execute on function set_club_image(uuid, text, text, int, int, uuid) to authenticated;

-- Add one gallery image. The cap is counted under the club lock, so simultaneous uploads cannot
-- both see five and both become the sixth and seventh.
create or replace function add_club_gallery(p_club uuid, p_path text, p_caption text, p_width int, p_height int)
returns uuid
language plpgsql security definer set search_path = public as $$
declare n int; v_id uuid;
begin
  perform assert_club_editor(p_club);
  if p_path is null then raise exception 'path_required'; end if;
  if char_length(coalesce(p_caption, '')) > 80 then raise exception 'caption_too_long'; end if;
  perform 1 from clubs where id = p_club for update;
  select count(*) into n from club_media where club_id = p_club and kind = 'gallery';
  if n >= 6 then raise exception 'gallery_full'; end if;
  insert into club_media (club_id, kind, path, caption, sort, width, height, created_by)
  values (p_club, 'gallery', p_path, nullif(btrim(coalesce(p_caption, '')), ''), n, p_width, p_height, auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function add_club_gallery(uuid, text, text, int, int) from public, anon;
grant execute on function add_club_gallery(uuid, text, text, int, int) to authenticated;

create or replace function set_gallery_caption(p_id uuid, p_caption text) returns void
language plpgsql security definer set search_path = public as $$
declare v_club uuid;
begin
  select club_id into v_club from club_media where id = p_id and kind = 'gallery';
  if v_club is null then raise exception 'not_found'; end if;
  perform assert_club_editor(v_club);
  if char_length(coalesce(p_caption, '')) > 80 then raise exception 'caption_too_long'; end if;
  update club_media set caption = nullif(btrim(coalesce(p_caption, '')), '') where id = p_id;
end $$;
revoke execute on function set_gallery_caption(uuid, text) from public, anon;
grant execute on function set_gallery_caption(uuid, text) to authenticated;

-- Reorder by listing the ids in the order wanted. Anything missing or foreign is refused, so a
-- stale screen cannot silently drop an image someone else added.
create or replace function reorder_club_gallery(p_club uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform assert_club_editor(p_club);
  perform 1 from clubs where id = p_club for update;
  select count(*) into n from club_media where club_id = p_club and kind = 'gallery';
  if n <> coalesce(array_length(p_ids, 1), 0) then raise exception 'changed_elsewhere'; end if;
  if exists (select 1 from unnest(p_ids) u(id)
             where not exists (select 1 from club_media m where m.id = u.id and m.club_id = p_club and m.kind = 'gallery'))
  then raise exception 'changed_elsewhere'; end if;
  update club_media m set sort = x.ord - 1
  from unnest(p_ids) with ordinality x(id, ord) where m.id = x.id;
end $$;
revoke execute on function reorder_club_gallery(uuid, uuid[]) from public, anon;
grant execute on function reorder_club_gallery(uuid, uuid[]) to authenticated;

-- Remove one image. Returns its path so the caller can delete the file afterwards.
create or replace function remove_club_media(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare m club_media%rowtype;
begin
  select * into m from club_media where id = p_id;
  if not found then raise exception 'not_found'; end if;
  perform assert_club_editor(m.club_id);
  perform 1 from clubs where id = m.club_id for update;
  delete from club_media where id = p_id;
  update club_media set sort = s.ord - 1
  from (select id, row_number() over (order by sort, created_at) ord
        from club_media where club_id = m.club_id and kind = 'gallery') s
  where club_media.id = s.id;
  return m.path;
end $$;
revoke execute on function remove_club_media(uuid) from public, anon;
grant execute on function remove_club_media(uuid) to authenticated;

-- A file left behind because its deletion failed. Recorded, never guessed at.
create or replace function record_media_orphan(p_club uuid, p_path text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_club_editor(p_club);
  if p_path is null then return; end if;
  if exists (select 1 from club_media where path = p_path) then raise exception 'still_in_use'; end if;
  insert into media_orphans (club_id, path, reason) values (p_club, p_path, p_reason);
end $$;
revoke execute on function record_media_orphan(uuid, text, text) from public, anon;
grant execute on function record_media_orphan(uuid, text, text) to authenticated;

create or replace function media_orphans_list() returns setof media_orphans
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query select * from media_orphans where cleared_at is null order by noticed_at;
end $$;
revoke execute on function media_orphans_list() from public, anon;
grant execute on function media_orphans_list() to authenticated;

-- Venue information ---------------------------------------------------------------------------
create or replace function set_club_venue(
  p_club uuid, p_description text, p_arrival text,
  p_parking boolean, p_changing boolean, p_showers boolean, p_rental boolean,
  p_cafe boolean, p_floodlights boolean, p_water boolean
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_club_editor(p_club);
  update clubs set
    description = nullif(btrim(coalesce(p_description, '')), ''),
    arrival_notes = nullif(btrim(coalesce(p_arrival, '')), ''),
    has_parking = p_parking, has_changing_rooms = p_changing, has_showers = p_showers,
    has_equipment_rental = p_rental, has_cafe = p_cafe, has_floodlights = p_floodlights,
    has_drinking_water = p_water,
    facilities_confirmed_at = now()
  where id = p_club;
end $$;
revoke execute on function set_club_venue(uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function set_club_venue(uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) to authenticated;

grant select on club_media to anon, authenticated;

-- The bucket, where this runs against Supabase. Writes are closed to everyone except the service
-- role, which only the upload route holds: that is what makes the re-encode unavoidable rather
-- than advisory. Skipped on a plain Postgres (the test database has no storage schema).
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('club-media', 'club-media', true, 5242880, array['image/webp'])
    on conflict (id) do update set public = true, file_size_limit = 5242880,
      allowed_mime_types = array['image/webp'];

    execute $p$drop policy if exists "club-media: public read" on storage.objects$p$;
    execute $p$create policy "club-media: public read" on storage.objects
              for select using (bucket_id = 'club-media')$p$;
    -- no insert/update/delete policy at all: authenticated users cannot write here directly
    execute $p$drop policy if exists "club-media: no client writes" on storage.objects$p$;
  end if;
end $$;
