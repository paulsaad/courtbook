-- DRAFT rollback of player_photos.draft.sql (not numbered, applied nowhere). Returns the schema to exactly what it was
-- (supabase/tests/photo/player_photos_rollback.sh: schema fingerprint identical to a plain build).
--
-- Removing the feature removes the stored photos with it. So it REFUSES, changing nothing, while any photo exists,
-- unless the person running it confirms in the same transaction:
--     set local courtbook.discard_player_photos = 'yes';
-- (players then see initials again; the website and app already handle "no photo schema" by showing no photos).

do $$
begin
  if to_regclass('public.player_photos') is null then raise exception 'player photo draft is not applied: nothing to roll back'; end if;
  if exists (select 1 from player_photos) and coalesce(current_setting('courtbook.discard_player_photos', true), '') <> 'yes' then
    raise exception 'rollback_blocked: % stored photo(s) would be deleted; set local courtbook.discard_player_photos = ''yes'' to confirm',
      (select count(*) from player_photos);
  end if;
end $$;

drop trigger if exists player_photo_on_closure on account_deletions;
drop function if exists player_photo_on_closure();
drop function if exists remove_player_photo();
drop function if exists set_player_photo(uuid, bytea, int, int);
drop function if exists my_photo_version();
drop function if exists match_photo_versions(uuid);
drop function if exists player_photo(uuid);
drop function if exists can_see_player_photo(uuid, uuid);
drop table if exists player_photos;   -- its closed-account lock-out trigger goes with it
