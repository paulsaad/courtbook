-- 0072 (M3-H game hardening) — ROLLBACK, all or nothing. Only if 0072 must be undone.
-- Restores the 0001–0071 (+0067) schema exactly: the eight game functions return to their previous
-- definitions (copied below from a 0001–0071 + 0067 build; checked by supabase/tests/m3/live_0072.sh),
-- and 0072's new functions and chat trigger are dropped. Grants on the eight functions are unchanged
-- by either direction (create or replace keeps them).
--
-- It STOPS, changing nothing, if any live game is in the court-lost state: before 0072 nothing can
-- resolve it, so those games would be stuck. Resolve or cancel them first (the app or SQL), then run.
-- What stays after a rollback, harmlessly: players removed under 0072 stay declined; notices of the
-- new kinds stay in Activity with their text.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $pre$ begin
  if not ((select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'join_match') = '47e042026bc084f8da0664020b77e1fb' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'leave_match') = '0bb6d58b5415a58c61878d0f4df230dd' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'decide_join') = '504c193753ecdda87b461204e1e0243f' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'set_match_status') = '883dc68e447d0f8a5af681d8f395bf3b' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'update_match') = 'efc91a08d70e84de15fced731b99a03c' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'post_match') = '33b26aae02b8861858f86de235b66264' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'sync_match_with_booking') = '6d2108ade98ace105a863878e8bf9b3d' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_message_notify') = 'c063c6d3f6071aa1a6446682cad26491') then
    raise exception 'STOPPED, nothing changed: this database does not have the verified 0072 functions';
  end if;
  if exists (select 1 from matches where status <> 'cancelled' and (court_lost_at is not null or closed_reason = 'no_court')) then
    raise exception 'STOPPED, nothing changed: some games are waiting for their organiser after a cancelled court booking — resolve or cancel them first';
  end if;
end $pre$;
drop trigger if exists match_messages_guard on match_messages;
drop function if exists match_message_guard();
drop function if exists remove_player(uuid, uuid);
drop function if exists resolve_court(uuid, uuid);
drop function if exists push_text(uuid);
-- ===== the 0001–0071 definitions of the eight functions 0072 replaced =====
CREATE OR REPLACE FUNCTION public.join_match(p_match uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m matches%rowtype; n int; me text; cur text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.status <> 'open' or m.start_at <= now() then raise exception 'match_closed'; end if;
  if m.organizer_id = auth.uid() then raise exception 'organizer_cannot_join'; end if;

  select status into cur from match_players where match_id = p_match and profile_id = auth.uid();
  if cur in ('accepted', 'pending') then return cur; end if;       -- idempotent
  if cur = 'declined' then raise exception 'join_declined'; end if; -- policy: no re-apply after a decline

  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  if n >= m.players_needed then raise exception 'match_full'; end if;
  select coalesce(name, 'A player') into me from profiles where id = auth.uid();

  if m.join_mode = 'approval' then
    insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'pending');
    perform notify(m.organizer_id, 'join_request', p_match, me || ' wants to join your match');
    return 'pending';
  end if;

  insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'accepted');
  perform notify(m.organizer_id, 'player_joined', p_match, me || ' joined your match');
  if n + 1 >= m.players_needed then
    update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
  end if;
  return 'accepted';
end $function$;

CREATE OR REPLACE FUNCTION public.leave_match(p_match uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m matches%rowtype; was text; me text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.start_at <= now() then raise exception 'match_started'; end if;
  select status into was from match_players where match_id = p_match and profile_id = auth.uid();
  delete from match_players where match_id = p_match and profile_id = auth.uid();
  if was = 'accepted' then
    select coalesce(name, 'A player') into me from profiles where id = auth.uid();
    perform notify(m.organizer_id, 'player_left', p_match, me || ' left your match');
    if m.status = 'closed' and m.closed_reason = 'full'
       and (select count(*) from match_players where match_id = p_match and status = 'accepted') < m.players_needed then
      update matches set status = 'open', closed_at = null, closed_reason = null where id = p_match;
    end if;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.decide_join(p_match uuid, p_profile uuid, p_accept boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m matches%rowtype; n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() then raise exception 'forbidden'; end if;
  if not exists (select 1 from match_players where match_id = p_match and profile_id = p_profile and status = 'pending') then
    raise exception 'not_pending';
  end if;
  if p_accept then
    if m.status <> 'open' or m.start_at <= now() then raise exception 'match_closed'; end if;
    select count(*) into n from match_players where match_id = p_match and status = 'accepted';
    if n >= m.players_needed then raise exception 'match_full'; end if;
    update match_players set status = 'accepted', decided_at = now() where match_id = p_match and profile_id = p_profile;
    perform notify(p_profile, 'join_accepted', p_match, 'You are in: ' || coalesce((select name from profiles where id = m.organizer_id), 'the organizer') || ' accepted you');
    if n + 1 >= m.players_needed then update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match; end if;
  else
    -- declining a stale request is allowed (cleans up), no notification if the match is gone
    update match_players set status = 'declined', decided_at = now() where match_id = p_match and profile_id = p_profile;
    if m.status = 'open' then perform notify(p_profile, 'join_declined', p_match, 'The organizer could not take you for this match'); end if;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.set_match_status(p_match uuid, p_status match_status)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m matches%rowtype; r record; n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' and p_status <> 'cancelled' then raise exception 'cannot_reopen'; end if;
  if p_status = 'open' and m.status <> 'open' then
    select count(*) into n from match_players where match_id = p_match and status = 'accepted';
    if n >= m.players_needed then raise exception 'match_full'; end if;
  end if;
  update matches set status = p_status,
    closed_at = case when p_status = 'open' then null else now() end,
    closed_reason = case when p_status = 'closed' then 'organizer' else null end
  where id = p_match;
  if p_status = 'closed' then
    for r in select profile_id from match_players where match_id = p_match and status = 'pending' loop
      delete from match_players where match_id = p_match and profile_id = r.profile_id and status = 'pending';
      perform notify(r.profile_id, 'join_declined', p_match, 'The organizer made this match private');
    end loop;
  end if;
  if p_status = 'cancelled' then
    for r in select profile_id from match_players where match_id = p_match and status in ('accepted', 'pending') loop
      perform notify(r.profile_id, 'match_cancelled', p_match, 'Match cancelled by the organizer');
    end loop;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.update_match(p_match uuid, p_players_needed integer, p_level_min integer, p_level_max integer, p_note text, p_join_mode text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m matches%rowtype; n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' or m.start_at <= now() then raise exception 'match_closed'; end if;
  if p_players_needed is null or p_players_needed < 1 or p_players_needed > 30 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'note_too_long'; end if;
  if (p_level_min is null) <> (p_level_max is null) or (p_level_min is not null and (p_level_min < 1 or p_level_max > 10 or p_level_min > p_level_max)) then raise exception 'bad_level_range'; end if;
  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  if p_players_needed < n then raise exception 'below_accepted'; end if;
  update matches set players_needed = p_players_needed, level_min = p_level_min, level_max = p_level_max, level = null,
    note = nullif(trim(p_note), ''), join_mode = p_join_mode where id = p_match;
  -- a private match stays private: only a match closed because it filled up reopens on its own
  if m.status = 'open' and n >= p_players_needed then
    update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
  elsif m.status = 'closed' and m.closed_reason = 'full' and n < p_players_needed then
    update matches set status = 'open', closed_at = null, closed_reason = null where id = p_match;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.post_match(p_club uuid, p_sport sport, p_start timestamp with time zone, p_end timestamp with time zone, p_level_min integer, p_level_max integer, p_players_needed integer, p_note text, p_booking uuid, p_join_mode text DEFAULT 'open'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid := gen_random_uuid();
  b bookings%rowtype;
  v_court_sport sport;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking and player_id = auth.uid() for update;
    if not found or b.status <> 'confirmed' then raise exception 'booking_not_found'; end if;
    select sport into v_court_sport from courts where id = b.court_id;
    if v_court_sport is not null and v_court_sport <> p_sport then raise exception 'sport_mismatch'; end if;
    if exists (select 1 from matches where booking_id = p_booking and status <> 'cancelled') then raise exception 'booking_already_posted'; end if;
    p_club := b.club_id; p_start := b.start_at; p_end := b.end_at;
  end if;
  if p_start is null or p_start <= now() then raise exception 'slot_in_past'; end if;
  if p_end is not null and p_end <= p_start then raise exception 'bad_range'; end if;
  if p_players_needed is null or p_players_needed < 1 or p_players_needed > 30 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'note_too_long'; end if;
  if (p_level_min is null) <> (p_level_max is null) or (p_level_min is not null and (p_level_min < 1 or p_level_max > 10 or p_level_min > p_level_max)) then raise exception 'bad_level_range'; end if;
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, level_min, level_max, players_needed, note, booking_id, join_mode)
  values (v_id, p_club, p_sport, auth.uid(), p_start, p_end, p_level_min, p_level_max, p_players_needed, nullif(trim(p_note), ''), p_booking, p_join_mode);
  return v_id;
exception when unique_violation then
  raise exception 'booking_already_posted';
end $function$;

CREATE OR REPLACE FUNCTION public.sync_match_with_booking()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m record; r record; who text;
begin
  for m in select * from matches where booking_id = new.id and status <> 'cancelled' loop
    if new.status <> 'confirmed' then
      -- booking cancelled / no-show: the court is no longer reserved
      update matches set booking_id = null where id = m.id;
      for r in select m.organizer_id as pid union select mp.profile_id from match_players mp where mp.match_id = m.id and mp.status = 'accepted' loop
        insert into notifications (profile_id, kind, match_id, body)
        values (r.pid, 'booking_unlinked', m.id, 'The court booking for your match was cancelled — the match is no longer linked to a court');
      end loop;
    elsif new.start_at <> old.start_at or new.end_at <> old.end_at or new.court_id is distinct from old.court_id then
      update matches set start_at = new.start_at, end_at = new.end_at where id = m.id;
      for r in select m.organizer_id as pid union select mp.profile_id from match_players mp where mp.match_id = m.id and mp.status = 'accepted' loop
        insert into notifications (profile_id, kind, match_id, body)
        values (r.pid, 'booking_moved', m.id, 'The club moved the court booking for your match — check the new time and court');
      end loop;
    end if;
  end loop;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.match_message_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; who text;
begin
  select coalesce(name, 'A player') into who from profiles where id = new.profile_id;
  for r in
    select m.organizer_id as pid from matches m where m.id = new.match_id
    union
    select mp.profile_id from match_players mp where mp.match_id = new.match_id and mp.status = 'accepted'
  loop
    if r.pid <> new.profile_id and not exists (
      select 1 from notifications n where n.profile_id = r.pid and n.match_id = new.match_id and n.kind = 'match_message' and n.read_at is null
    ) then
      insert into notifications (profile_id, kind, match_id, actor_id, body) values (r.pid, 'match_message', new.match_id, new.profile_id, who || ': ' || left(new.body, 80));
    end if;
  end loop;
  return new;
end $function$;
-- notify_waiting goes last: the restored functions no longer call it
drop function if exists notify_waiting(uuid);
do $post$ begin
  if not ((select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'join_match') = '07d5432f9f203da2a0c7c69ebd72451f' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'leave_match') = 'db6bb484d82740641b72d8448f86ebfa' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'decide_join') = 'bce21b2e4e717051f838cc1714cc4e96' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'set_match_status') = '68feb36c10f79ae33bd6c67db955846f' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'update_match') = 'aa37b42e834acc500cd1f115e2aa4ee3' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'post_match') = '548b94f7c81c4805494564c14f213d73' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'sync_match_with_booking') = '791e9d4948f61fcf788a451ed681420c' and (select max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_message_notify') = '485b766738b909d27c67c1435c7d28a6')
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('notify_waiting','remove_player','resolve_court','match_message_guard','push_text'))
     or exists (select 1 from pg_trigger where tgname = 'match_messages_guard') then
    raise exception 'ROLLED BACK: the rollback did not land on the 0001–0071 functions';
  end if;
end $post$;
notify pgrst, 'reload schema';
commit;
select '0072 rolled back' as result;
