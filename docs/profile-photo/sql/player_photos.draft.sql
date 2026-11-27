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
-- Review of 02e7d06 (B1): versions come from one sequence, so a version is never reused, also after a removal or a
-- hide deletes the row. Viewers' caches (URL ?v= and ETag) can then never show an earlier photo, and every evidence
-- copy has its own version.
create sequence if not exists player_photo_version_seq as integer;
revoke all on sequence player_photo_version_seq from public, anon, authenticated, service_role;
alter table player_photos alter column version set default nextval('player_photo_version_seq');

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
        version = nextval('player_photo_version_seq'), updated_at = now()
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

-- 4b -----------------------------------------------------------------------------------------------------------------
-- Review requirement 3 (26 Nov): a SERVER-side upload limit, checked before the image is decoded. The route calls
-- claim_photo_upload(actor) first; it records the attempt and refuses ('too_many_uploads') once the account has made
-- PHOTO_UPLOADS_PER_HOUR attempts in the last hour. Attempts count, not successes: a stream of undecodable files is
-- the costly case. Server-only, like set_player_photo. Rows older than a day are pruned on each claim.
create table if not exists player_photo_uploads (
  profile_id uuid not null references profiles(id) on delete cascade,
  at         timestamptz not null default clock_timestamp()
);
create index if not exists player_photo_uploads_idx on player_photo_uploads (profile_id, at);
alter table player_photo_uploads enable row level security;   -- no policy: only claim_photo_upload writes it
revoke all on player_photo_uploads from public, anon, authenticated, service_role;

create or replace function claim_photo_upload(p_actor uuid) returns void
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;   -- only the server (service role, no user)
  if p_actor is null or not exists (select 1 from profiles where id = p_actor) then raise exception 'not_found'; end if;
  -- the same refusals as set_player_photo, before any decode
  if deletion_requested(p_actor) then raise exception 'account_closed'; end if;
  if exists (select 1 from account_suspensions where profile_id = p_actor) then raise exception 'suspended'; end if;
  perform pg_advisory_xact_lock(hashtext('photo_upload:' || p_actor::text));   -- concurrent uploads count one by one
  delete from player_photo_uploads where profile_id = p_actor and at < clock_timestamp() - interval '1 day';
  select count(*) into n from player_photo_uploads where profile_id = p_actor and at > clock_timestamp() - interval '1 hour';
  if n >= 10 then raise exception 'too_many_uploads'; end if;            -- PHOTO_UPLOADS_PER_HOUR (10)
  insert into player_photo_uploads (profile_id) values (p_actor);
end $$;
revoke all on function claim_photo_upload(uuid) from public, anon, authenticated;
grant execute on function claim_photo_upload(uuid) to service_role;

-- 4c -----------------------------------------------------------------------------------------------------------------
-- Moderation of photos (Paul, 27 Nov, decision 4): an authorized moderator may HIDE an inappropriate photo; the photo
-- is kept as evidence, under the report's own retention and legal hold; reported-photo evidence is readable only by
-- specifically authorized moderators, and every reading is logged. Being an admin alone gives no access to photos.
--   * photo_moderators: who is authorized. Managed in the Supabase dashboard only (no client, no server key); every
--     change is written to the moderation log by a trigger. A photo moderator must also be an admin (the reports
--     page is admin-only) whose own account is neither suspended nor closing.
--   * photo_evidence: a copy of the photo, tied to a report. Taken when a player is reported (so a later change or
--     removal by the player loses nothing) and when a moderator hides the photo. Nobody reads the table directly.
--   * Retention follows the report: the copy stays while the report is open or on legal hold, and goes when the
--     180-day rule clears the report's own text (enforce_report_retention, 0082, unchanged) or the report is deleted.
--     Account deletion keeps it, like the report's snapshot (0086: "Moderation reports and snapshots stay").
alter table moderation_log drop constraint if exists moderation_log_action_check;
alter table moderation_log add constraint moderation_log_action_check
  check (action in ('resolve', 'reopen', 'suspend', 'unsuspend', 'hide_message', 'legal_hold_on', 'legal_hold_off', 'clear_text',
                    'hide_photo', 'view_photo_evidence', 'photo_moderator_on', 'photo_moderator_off'));

create table if not exists photo_moderators (
  profile_id uuid primary key references profiles(id) on delete cascade,
  note       text check (char_length(coalesce(note, '')) <= 300),
  added_at   timestamptz not null default now()
);
alter table photo_moderators enable row level security;   -- no policy
revoke all on photo_moderators from public, anon, authenticated, service_role;

create or replace function photo_moderators_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform log_moderation('photo_moderator_on', null, new.profile_id, null, coalesce(new.note, 'added'));
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    perform log_moderation('photo_moderator_off', null, old.profile_id, null, 'removed');
  end if;
  return null;
end $$;
revoke all on function photo_moderators_log() from public, anon, authenticated;
drop trigger if exists photo_moderators_log on photo_moderators;
create trigger photo_moderators_log after insert or update or delete on photo_moderators
  for each row execute function photo_moderators_log();
-- review of 02e7d06 (S4): emptying the list in one statement is logged too, one entry per moderator removed
create or replace function photo_moderators_truncate_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  for m in select profile_id from photo_moderators loop
    perform log_moderation('photo_moderator_off', null, m.profile_id, null, 'removed (truncate)');
  end loop;
  return null;
end $$;
revoke all on function photo_moderators_truncate_log() from public, anon, authenticated;
drop trigger if exists photo_moderators_truncate_log on photo_moderators;
create trigger photo_moderators_truncate_log before truncate on photo_moderators
  for each statement execute function photo_moderators_truncate_log();

create or replace function is_photo_moderator() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and is_admin()
     and exists (select 1 from photo_moderators where profile_id = auth.uid())
     and not exists (select 1 from account_suspensions where profile_id = auth.uid())
     and not deletion_requested(auth.uid());
$$;
revoke all on function is_photo_moderator() from public, anon;
grant execute on function is_photo_moderator() to authenticated;   -- the reports page shows the photo controls by it

create table if not exists photo_evidence (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid not null references reports(id) on delete cascade,
  profile_id  uuid not null,                       -- whose photo; no foreign key: evidence outlives the account
  image       bytea not null check (octet_length(image) between 64 and 65536),
  width       int not null,
  height      int not null,
  version     int not null,
  reason      text not null check (reason in ('reported', 'hidden')),
  captured_at timestamptz not null default clock_timestamp(),
  unique (report_id, version)
);
alter table photo_evidence enable row level security;     -- no policy
revoke all on photo_evidence from public, anon, authenticated, service_role;

-- a player report captures the reported player's current photo
create or replace function photo_evidence_on_report() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.target_kind = 'player' and new.profile_id is not null then
    insert into photo_evidence (report_id, profile_id, image, width, height, version, reason)
    select new.id, p.profile_id, p.image, p.width, p.height, p.version, 'reported' from player_photos p where p.profile_id = new.profile_id
    on conflict (report_id, version) do nothing;
  end if;
  return null;
end $$;
revoke all on function photo_evidence_on_report() from public, anon, authenticated;
drop trigger if exists photo_evidence_on_report on reports;
create trigger photo_evidence_on_report after insert on reports for each row execute function photo_evidence_on_report();

-- Retention (review of 02e7d06, S1): the copy goes 180 days after its report was closed, unless the report is open
-- again or on legal hold. The same time rule as the report's text (0082), but applied to the copy directly, so a report
-- whose text was empty from the start, or one reopened and closed again, is covered. Runs after every change to
-- reports (each new report, each moderator action) and before any copy is listed, read or added.
create or replace function photo_evidence_purge() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from photo_evidence e using reports r
   where r.id = e.report_id and r.status <> 'open' and not r.legal_hold
     and r.closed_at is not null and r.closed_at < now() - interval '180 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function photo_evidence_purge() from public, anon, authenticated;

create or replace function photo_evidence_retention() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform photo_evidence_purge();
  return null;
end $$;
revoke all on function photo_evidence_retention() from public, anon, authenticated;
drop trigger if exists photo_evidence_retention on reports;
create trigger photo_evidence_retention after insert or update on reports for each statement execute function photo_evidence_retention();

-- a report on legal hold that holds photo copies cannot be deleted (review nit: the copies would go with it)
create or replace function photo_evidence_hold_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.legal_hold and exists (select 1 from photo_evidence where report_id = old.id) then raise exception 'report_on_legal_hold'; end if;
  return old;
end $$;
revoke all on function photo_evidence_hold_guard() from public, anon, authenticated;
drop trigger if exists photo_evidence_hold_guard on reports;
create trigger photo_evidence_hold_guard before delete on reports for each row execute function photo_evidence_hold_guard();

-- hide: the photo leaves every viewer at once (the player may upload a new one); a copy is kept with the report
create or replace function moderator_hide_player_photo(p_report uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype; ph player_photos%rowtype;
begin
  if not is_photo_moderator() then raise exception 'forbidden'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  select * into r from reports where id = p_report for update;
  if not found or r.target_kind not in ('player', 'message', 'game') or r.profile_id is null then raise exception 'not_found'; end if;
  if r.profile_id = auth.uid() then raise exception 'forbidden'; end if;   -- never one's own (review nit)
  -- a report past the 180-day rule has had its text cleared; a copy tied to it now would never be cleared
  if r.status <> 'open' and not r.legal_hold and r.closed_at < now() - interval '180 days' then raise exception 'report_expired'; end if;
  delete from player_photos where profile_id = r.profile_id returning * into ph;
  if not found then return false; end if;                                 -- nothing to hide: nothing logged
  insert into photo_evidence (report_id, profile_id, image, width, height, version, reason)
  values (r.id, ph.profile_id, ph.image, ph.width, ph.height, ph.version, 'hidden')
  on conflict (report_id, version) do nothing;                            -- already captured at report time
  perform log_moderation('hide_photo', r.id, r.profile_id, null, btrim(p_reason));
  return true;
end $$;
revoke all on function moderator_hide_player_photo(uuid, text) from public, anon;
grant execute on function moderator_hide_player_photo(uuid, text) to authenticated;   -- is_photo_moderator() decides

-- which photo copies a report holds (no bytes); the reports page lists them for photo moderators only
create or replace function moderator_photo_evidence_list(p_report uuid)
returns table (evidence_id uuid, version int, reason text, captured_at timestamptz)
language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_photo_moderator() then raise exception 'forbidden'; end if;
  if exists (select 1 from reports where id = p_report and profile_id = auth.uid()) then raise exception 'forbidden'; end if;
  perform photo_evidence_purge();
  return query select e.id, e.version, e.reason, e.captured_at from photo_evidence e where e.report_id = p_report order by e.captured_at;
end $$;
revoke all on function moderator_photo_evidence_list(uuid) from public, anon;
grant execute on function moderator_photo_evidence_list(uuid) to authenticated;

-- one copy's bytes; every reading is logged, whatever the caller does with it
create or replace function moderator_photo_evidence(p_evidence uuid) returns bytea
language plpgsql volatile security definer set search_path = public as $$
declare e photo_evidence%rowtype;
begin
  if not is_photo_moderator() then raise exception 'forbidden'; end if;
  perform photo_evidence_purge();
  select * into e from photo_evidence where id = p_evidence;
  if not found or e.profile_id = auth.uid() then raise exception 'not_found'; end if;
  perform log_moderation('view_photo_evidence', e.report_id, e.profile_id, null, 'version ' || e.version);
  return e.image;
end $$;
revoke all on function moderator_photo_evidence(uuid) from public, anon;
grant execute on function moderator_photo_evidence(uuid) to authenticated;

-- 5 ------------------------------------------------------------------------------------------------------------------
-- 0086's lock-out: a closed account changes nothing, on every table (0086 test E1 requires it of a new table).
do $$
begin
  if exists (select 1 from pg_proc where proname = 'refuse_writes_by_closed_account') then
    execute 'drop trigger if exists closed_account_lockout on player_photos';
    execute 'create trigger closed_account_lockout before insert or update or delete on player_photos '
         || 'for each statement execute function refuse_writes_by_closed_account()';
    execute 'drop trigger if exists closed_account_lockout on player_photo_uploads';
    execute 'create trigger closed_account_lockout before insert or update or delete on player_photo_uploads '
         || 'for each statement execute function refuse_writes_by_closed_account()';
    -- review of 02e7d06 (S3): the two moderation tables too
    execute 'drop trigger if exists closed_account_lockout on photo_evidence';
    execute 'create trigger closed_account_lockout before insert or update or delete on photo_evidence '
         || 'for each statement execute function refuse_writes_by_closed_account()';
    execute 'drop trigger if exists closed_account_lockout on photo_moderators';
    execute 'create trigger closed_account_lockout before insert or update or delete on photo_moderators '
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
    delete from player_photo_uploads where profile_id = new.subject_id;
  end if;
  return null;
end $$;
revoke all on function player_photo_on_closure() from public, anon, authenticated;
drop trigger if exists player_photo_on_closure on account_deletions;
create trigger player_photo_on_closure after insert or update of status on account_deletions
  for each row execute function player_photo_on_closure();
