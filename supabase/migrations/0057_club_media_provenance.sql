-- Review of 0056. Five findings, all valid.
--
-- 1. The write functions were executable by any authenticated staff member and accepted any path, so
--    staff could publish a path that was never uploaded, never processed, or belongs to another club.
--    Publication becomes server-only: EXECUTE is revoked from authenticated and granted to the
--    service role, which only the upload route holds. The route authenticates the person and passes
--    who they are; the database still checks that person is staff of that club, and now also checks
--    the path belongs to that club and looks like something the route produced.
-- 2. Reordering accepted [A, A, B] for a gallery of [A, B, C]: three ids, all members, and C quietly
--    dropped. An exact permutation is now required.
-- 3. club_media.created_by was readable by anyone. Visitors get the columns they need and not the
--    identity of the staff member who uploaded.
-- 4. Adding no write policy does not override a permissive one that already exists on
--    storage.objects. Restrictive policies are added, which AND with everything else.
-- 5. cover_url held a root-relative path, which a browser resolves against the app's own origin, not
--    Supabase's. It now holds an absolute URL built from a stored setting.

-- 3 ----------------------------------------------------------------------------------------------
revoke select on club_media from anon, authenticated;
grant select (id, club_id, kind, path, external_url, caption, sort, width, height)
  on club_media to anon, authenticated;

-- 5 ----------------------------------------------------------------------------------------------
create table if not exists app_settings (key text primary key, value text not null);
alter table app_settings enable row level security;   -- read through functions only
insert into app_settings (key, value)
values ('storage_base_url', 'https://lgujfbwunokobjxlvpuf.supabase.co')
on conflict (key) do nothing;

create or replace function storage_public_url(p_path text) returns text
language sql stable security definer set search_path = public as $$
  select rtrim((select value from app_settings where key = 'storage_base_url'), '/')
         || '/storage/v1/object/public/club-media/' || p_path;
$$;

create or replace function club_media_sync_cover() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_club uuid := coalesce(new.club_id, old.club_id);
begin
  update clubs c set cover_url = (
    select coalesce(m.external_url, storage_public_url(m.path))
    from club_media m where m.club_id = v_club and m.kind = 'cover'
  ) where c.id = v_club;
  return null;
end $$;

-- repair anything 0056 wrote as a root-relative path
update club_media set sort = sort where kind = 'cover';   -- fires the trigger, rewriting cover_url

-- 1 ----------------------------------------------------------------------------------------------
-- A path the route produced: clubs/<this club>/<uuid>.webp and nothing else.
create or replace function assert_media_path(p_club uuid, p_path text) returns void
language plpgsql immutable set search_path = public as $$
begin
  if p_club is null or p_path is null then raise exception 'path_required'; end if;
  if p_path !~ ('^clubs/' || p_club::text || '/[0-9a-f-]{36}\.webp$') then raise exception 'bad_path'; end if;
end $$;

-- The caller is the service role (the upload route). It has already established who the person is;
-- the database still decides whether that person may touch this club.
create or replace function assert_club_editor_as(p_actor uuid, p_club uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p_actor is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from club_staff where club_id = p_club and profile_id = p_actor)
     and not exists (select 1 from profiles where id = p_actor and 'admin' = any(roles)) then
    raise exception 'forbidden';
  end if;
end $$;

create or replace function set_club_image(
  p_actor uuid, p_club uuid, p_kind text, p_path text, p_width int, p_height int, p_expect uuid
) returns table (media_id uuid, old_path text)
language plpgsql security definer set search_path = public as $$
declare v_old club_media%rowtype; v_id uuid;
begin
  perform assert_club_editor_as(p_actor, p_club);
  if p_kind not in ('cover', 'logo') then raise exception 'bad_kind'; end if;
  perform assert_media_path(p_club, p_path);
  perform 1 from clubs where id = p_club for update;

  select * into v_old from club_media where club_id = p_club and kind = p_kind;
  if coalesce(v_old.id::text, '') is distinct from coalesce(p_expect::text, '') then
    raise exception 'changed_elsewhere';
  end if;

  if v_old.id is not null then delete from club_media where id = v_old.id; end if;
  insert into club_media (club_id, kind, path, width, height, created_by)
  values (p_club, p_kind, p_path, p_width, p_height, p_actor)
  returning id into v_id;
  return query select v_id, v_old.path;
end $$;

create or replace function add_club_gallery(
  p_actor uuid, p_club uuid, p_path text, p_caption text, p_width int, p_height int
) returns uuid
language plpgsql security definer set search_path = public as $$
declare n int; v_id uuid;
begin
  perform assert_club_editor_as(p_actor, p_club);
  perform assert_media_path(p_club, p_path);
  if char_length(coalesce(p_caption, '')) > 80 then raise exception 'caption_too_long'; end if;
  perform 1 from clubs where id = p_club for update;
  select count(*) into n from club_media where club_id = p_club and kind = 'gallery';
  if n >= 6 then raise exception 'gallery_full'; end if;
  insert into club_media (club_id, kind, path, caption, sort, width, height, created_by)
  values (p_club, 'gallery', p_path, nullif(btrim(coalesce(p_caption, '')), ''), n, p_width, p_height, p_actor)
  returning id into v_id;
  return v_id;
end $$;

create or replace function set_gallery_caption(p_actor uuid, p_id uuid, p_caption text) returns void
language plpgsql security definer set search_path = public as $$
declare v_club uuid;
begin
  select club_id into v_club from club_media where id = p_id and kind = 'gallery';
  if v_club is null then raise exception 'not_found'; end if;
  perform assert_club_editor_as(p_actor, v_club);
  if char_length(coalesce(p_caption, '')) > 80 then raise exception 'caption_too_long'; end if;
  update club_media set caption = nullif(btrim(coalesce(p_caption, '')), '') where id = p_id;
end $$;

-- 2 ----------------------------------------------------------------------------------------------
create or replace function reorder_club_gallery(p_actor uuid, p_club uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare n int; k int;
begin
  perform assert_club_editor_as(p_actor, p_club);
  perform 1 from clubs where id = p_club for update;
  if p_ids is null or array_position(p_ids, null) is not null then raise exception 'changed_elsewhere'; end if;
  select count(*) into n from club_media where club_id = p_club and kind = 'gallery';
  -- an exact permutation: same number, no repeats, every one of them and nothing else
  select count(distinct u.id) into k from unnest(p_ids) u(id);
  if n <> coalesce(array_length(p_ids, 1), 0) or k <> n then raise exception 'changed_elsewhere'; end if;
  if exists (select 1 from unnest(p_ids) u(id)
             where not exists (select 1 from club_media m where m.id = u.id and m.club_id = p_club and m.kind = 'gallery'))
  then raise exception 'changed_elsewhere'; end if;
  update club_media m set sort = x.ord - 1
  from unnest(p_ids) with ordinality x(id, ord) where m.id = x.id;
end $$;

create or replace function remove_club_media(p_actor uuid, p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare m club_media%rowtype;
begin
  select * into m from club_media where id = p_id;
  if not found then raise exception 'not_found'; end if;
  perform assert_club_editor_as(p_actor, m.club_id);
  perform 1 from clubs where id = m.club_id for update;
  delete from club_media where id = p_id;
  update club_media set sort = s.ord - 1
  from (select id, row_number() over (order by sort, created_at) ord
        from club_media where club_id = m.club_id and kind = 'gallery') s
  where club_media.id = s.id;
  return m.path;
end $$;

create or replace function record_media_orphan(p_actor uuid, p_club uuid, p_path text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_club_editor_as(p_actor, p_club);
  perform assert_media_path(p_club, p_path);          -- only this club's own files
  if exists (select 1 from club_media where path = p_path) then raise exception 'still_in_use'; end if;
  insert into media_orphans (club_id, path, reason) values (p_club, p_path, p_reason);
end $$;

-- Publication is server-only. The old signatures are removed so nothing can call them.
drop function if exists set_club_image(uuid, text, text, int, int, uuid);
drop function if exists add_club_gallery(uuid, text, text, int, int);
drop function if exists set_gallery_caption(uuid, text);
drop function if exists reorder_club_gallery(uuid, uuid[]);
drop function if exists remove_club_media(uuid);
drop function if exists record_media_orphan(uuid, text, text);

do $$
declare f text;
begin
  foreach f in array array[
    'set_club_image(uuid, uuid, text, text, int, int, uuid)',
    'add_club_gallery(uuid, uuid, text, text, int, int)',
    'set_gallery_caption(uuid, uuid, text)',
    'reorder_club_gallery(uuid, uuid, uuid[])',
    'remove_club_media(uuid, uuid)',
    'record_media_orphan(uuid, uuid, text, text)',
    'assert_media_path(uuid, text)',
    'assert_club_editor_as(uuid, uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- 4 ----------------------------------------------------------------------------------------------
-- Restrictive policies AND with every permissive policy, so an existing broad write policy on
-- storage.objects cannot let anything into this bucket. The service role bypasses RLS entirely.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    execute $p$drop policy if exists "club-media: no client insert" on storage.objects$p$;
    execute $p$create policy "club-media: no client insert" on storage.objects
              as restrictive for insert to anon, authenticated
              with check (bucket_id <> 'club-media')$p$;
    execute $p$drop policy if exists "club-media: no client update" on storage.objects$p$;
    execute $p$create policy "club-media: no client update" on storage.objects
              as restrictive for update to anon, authenticated
              using (bucket_id <> 'club-media') with check (bucket_id <> 'club-media')$p$;
    execute $p$drop policy if exists "club-media: no client delete" on storage.objects$p$;
    execute $p$create policy "club-media: no client delete" on storage.objects
              as restrictive for delete to anon, authenticated
              using (bucket_id <> 'club-media')$p$;
  end if;
end $$;
