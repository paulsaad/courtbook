-- 0074 (M3-S chat and player safety) — ROLLBACK. Restores every function 0074 replaced, exactly as
-- before (0073 state), the chat read policy, and removes 0074's functions and trigger.
-- DATA IS KEPT: player_blocks, reports, account_suspensions, blocked_terms and profiles.rules_accepted_at
-- stay in place, unused (a later re-apply finds them). After this rollback nothing reads them: blocks,
-- suspensions and the rules stop applying at once. Roll this back before any rollback of 0073 or 0072.
begin;
do $rb$ begin
  if not ((select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '65b3a0d219612205d3ceacb6d2f55292' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'post_match') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '96298454878cbed0b1623b47f6a738bd' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'join_match') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'f6a5fe93357165780e253f2893d7f5a0' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'decide_join') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'e43d7f4d834289258e4202392028b8d2' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'update_match') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'ecbe1c55f918b4e81608afa7fd7de12d' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'set_match_status') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'cad92ea48548755c3a5aa47e558bcc8b' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'remove_player') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '0800e2288873f06288bbdb43a0f7061c' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_court') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '0cd551de6063cf2fc06f13968b9ebc6a' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_message_guard') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '7395599074053f83ed876dd01af0ea3f' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_message_notify') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '4d43bd35eda37df9ecb9b26bc12d315e' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_messages_list') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '22e8b948d653fbd83f73ad1e5e0d29e9' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'open_matches') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '5ce4fece9915758fd236e9fc594858c7' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_board')) then
    raise exception '0074 rollback: the functions are not the 0074 versions — nothing done';
  end if;
end $rb$;
drop trigger if exists match_players_block_guard on match_players;
CREATE OR REPLACE FUNCTION public.post_match(p_club uuid, p_sport sport, p_start timestamp with time zone, p_end timestamp with time zone, p_level_min integer, p_level_max integer, p_players_needed integer, p_note text, p_booking uuid, p_join_mode text DEFAULT 'open'::text, p_token uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare
  v_id uuid := gen_random_uuid();
  b bookings%rowtype;
  v_court_sport sport;
  v_existing uuid;
  v_constraint text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  -- a repeat of a post that already succeeded: the same game, nothing new (checked before any rule,
  -- so a retry is not refused by a limit the first call itself reached)
  if p_token is not null then
    select id into v_existing from matches where organizer_id = auth.uid() and client_token = p_token;
    if v_existing is not null then return v_existing; end if;
  end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking and player_id = auth.uid() for update;
    if not found or b.status <> 'confirmed' then raise exception 'booking_not_found'; end if;
    select sport into v_court_sport from courts where id = b.court_id;
    if v_court_sport is not null and v_court_sport <> p_sport then raise exception 'sport_mismatch'; end if;
    if exists (select 1 from matches where booking_id = p_booking and status <> 'cancelled') then raise exception 'booking_already_posted'; end if;
    p_club := b.club_id; p_start := b.start_at; p_end := b.end_at;
  else
    if p_club is null then raise exception 'club_required'; end if;
    if p_start is not null and p_start >= now() + interval '60 days' then raise exception 'too_far_ahead'; end if;
  end if;
  if p_start is null or p_start <= now() then raise exception 'slot_in_past'; end if;
  if p_end is not null and p_end <= p_start then raise exception 'bad_range'; end if;
  if p_players_needed is null or p_players_needed < 1 or p_players_needed > 30 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'note_too_long'; end if;
  if (p_level_min is null) <> (p_level_max is null) or (p_level_min is not null and (p_level_min < 1 or p_level_max > 10 or p_level_min > p_level_max)) then raise exception 'bad_level_range'; end if;
  -- S12: live games = not cancelled and not started; one count at a time per organiser, so two
  -- simultaneous posts cannot both see 9 (and two retries with one key wait for each other here)
  perform pg_advisory_xact_lock(hashtextextended('courtbook:post_match:' || auth.uid()::text, 0));
  if p_token is not null then
    select id into v_existing from matches where organizer_id = auth.uid() and client_token = p_token;
    if v_existing is not null then return v_existing; end if;
  end if;
  if (select count(*) from matches where organizer_id = auth.uid() and status <> 'cancelled' and start_at > now()) >= 10 then
    raise exception 'too_many_games';
  end if;
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, level_min, level_max, players_needed, note, booking_id, join_mode, client_token)
  values (v_id, p_club, p_sport, auth.uid(), p_start, p_end, p_level_min, p_level_max, p_players_needed, nullif(trim(p_note), ''), p_booking, p_join_mode, p_token);
  return v_id;
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'matches_organizer_client_token' then
    select id into v_existing from matches where organizer_id = auth.uid() and client_token = p_token;
    if v_existing is not null then return v_existing; end if;
  end if;
  raise exception 'booking_already_posted';
end $fn$;
CREATE OR REPLACE FUNCTION public.join_match(p_match uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare m matches%rowtype; n int; me text; cur text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.status <> 'open' or m.start_at <= now() then raise exception 'match_closed'; end if;
  if m.organizer_id = auth.uid() then raise exception 'organizer_cannot_join'; end if;

  select status into cur from match_players where match_id = p_match and profile_id = auth.uid();
  if cur in ('accepted', 'pending') then return cur; end if;       -- idempotent
  if cur = 'declined' then raise exception 'join_declined'; end if; -- final (GR-5, GR-6)

  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  if n >= m.players_needed then raise exception 'match_full'; end if;
  select coalesce(name, 'A player') into me from profiles where id = auth.uid();

  if m.join_mode = 'approval' then
    -- one count at a time per player: two requests to two different games cannot both see 19 (S12)
    perform pg_advisory_xact_lock(hashtextextended('courtbook:requests:' || auth.uid()::text, 0));
    if (select count(*) from match_players mp join matches x on x.id = mp.match_id
        where mp.profile_id = auth.uid() and mp.status = 'pending'
          and x.status <> 'cancelled' and x.start_at > now()) >= 20 then
      raise exception 'too_many_requests';
    end if;
    insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'pending');
    perform notify(m.organizer_id, 'join_request', p_match, me || ' wants to join your match');
    return 'pending';
  end if;

  insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'accepted');
  perform notify(m.organizer_id, 'player_joined', p_match, me || ' joined your match');
  if n + 1 >= m.players_needed then
    update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
    perform notify_waiting(p_match);
  end if;
  return 'accepted';
end $fn$;
CREATE OR REPLACE FUNCTION public.decide_join(p_match uuid, p_profile uuid, p_accept boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
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
    if n + 1 >= m.players_needed then
      update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
      perform notify_waiting(p_match);
    end if;
  else
    -- declining a stale request is allowed (cleans up), no notification if the match is gone
    update match_players set status = 'declined', decided_at = now() where match_id = p_match and profile_id = p_profile;
    if m.status = 'open' then perform notify(p_profile, 'join_declined', p_match, 'The organizer could not take you for this match'); end if;
  end if;
end $fn$;
CREATE OR REPLACE FUNCTION public.update_match(p_match uuid, p_players_needed integer, p_level_min integer, p_level_max integer, p_note text, p_join_mode text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare m matches%rowtype; n int; st match_status; r record;
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
  -- a private or no_court game stays as it is: only a game closed because it filled up reopens
  st := m.status;
  if m.status = 'open' and n >= p_players_needed then
    update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
    perform notify_waiting(p_match);
    st := 'closed';
  elsif m.status = 'closed' and m.closed_reason = 'full' and n < p_players_needed then
    update matches set status = 'open', closed_at = null, closed_reason = null where id = p_match;
    st := 'open';
  end if;
  -- S15: approval → open while the game takes players: waiting requests are accepted in the order
  -- they were made, up to capacity; the rest keep waiting (and are told once if it fills)
  if m.join_mode = 'approval' and p_join_mode = 'open' and st = 'open' then
    for r in select profile_id from match_players where match_id = p_match and status = 'pending'
             order by joined_at, profile_id loop
      exit when n >= p_players_needed;
      update match_players set status = 'accepted', decided_at = now() where match_id = p_match and profile_id = r.profile_id;
      perform notify(r.profile_id, 'join_accepted', p_match, 'You are in: ' || coalesce((select name from profiles where id = m.organizer_id), 'the organizer') || ' accepted you');
      n := n + 1;
    end loop;
    if n >= p_players_needed then
      update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
      perform notify_waiting(p_match);
    end if;
  end if;
end $fn$;
CREATE OR REPLACE FUNCTION public.set_match_status(p_match uuid, p_status match_status)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare m matches%rowtype; r record; n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' and p_status <> 'cancelled' then raise exception 'cannot_reopen'; end if;
  if m.status = 'cancelled' then return; end if;                       -- cancelling twice: nothing to do
  if p_status = 'cancelled' then
    if coalesce(m.end_at, m.start_at + interval '3 hours') <= now() then raise exception 'match_over'; end if;
  else
    if m.start_at <= now() then raise exception 'match_started'; end if;
    if m.court_lost_at is not null then raise exception 'court_lost'; end if;  -- one way out: resolve_court
  end if;
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
end $fn$;
CREATE OR REPLACE FUNCTION public.remove_player(p_match uuid, p_profile uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare m matches%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' then raise exception 'match_cancelled'; end if;
  if m.start_at <= now() then raise exception 'match_started'; end if;
  if not exists (select 1 from match_players where match_id = p_match and profile_id = p_profile and status = 'accepted') then
    raise exception 'not_accepted';                                    -- a request is declined, not removed
  end if;
  update match_players set status = 'declined', decided_at = now() where match_id = p_match and profile_id = p_profile;
  perform notify(p_profile, 'player_removed', p_match, 'The organizer removed you from this match');
  if m.status = 'closed' and m.closed_reason = 'full' then
    update matches set status = 'open', closed_at = null, closed_reason = null where id = p_match;
  end if;
end $fn$;
CREATE OR REPLACE FUNCTION public.resolve_court(p_match uuid, p_booking uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare m matches%rowtype; b bookings%rowtype; v_court_sport sport; n int; r record; msg text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' then raise exception 'match_cancelled'; end if;
  if m.court_lost_at is null then raise exception 'court_not_lost'; end if;
  if coalesce(m.end_at, m.start_at + interval '3 hours') <= now() then raise exception 'match_over'; end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking and player_id = m.organizer_id for update;
    if not found or b.status <> 'confirmed' then raise exception 'booking_not_found'; end if;
    if b.start_at <= now() then raise exception 'slot_in_past'; end if;
    select sport into v_court_sport from courts where id = b.court_id;
    if v_court_sport is not null and v_court_sport <> m.sport then raise exception 'sport_mismatch'; end if;
    if exists (select 1 from matches where booking_id = p_booking and status <> 'cancelled') then raise exception 'booking_already_posted'; end if;
    update matches set booking_id = b.id, club_id = b.club_id, start_at = b.start_at, end_at = b.end_at where id = p_match;
    msg := 'The organizer linked a new court booking to your match — check the time and court';
  else
    msg := 'Your match goes ahead. No court is booked through CourtBook — the organizer is arranging it';
  end if;
  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  update matches set court_lost_at = null,
    status = case when m.closed_reason = 'no_court' then (case when n >= m.players_needed then 'closed' else 'open' end)::match_status else m.status end,
    closed_reason = case when m.closed_reason = 'no_court' then (case when n >= m.players_needed then 'full' end) else m.closed_reason end,
    closed_at = case when m.closed_reason = 'no_court' then (case when n >= m.players_needed then now() end) else m.closed_at end
  where id = p_match;
  for r in select profile_id from match_players where match_id = p_match and status in ('accepted', 'pending') loop
    perform notify(r.profile_id, 'court_resolved', p_match, msg);
  end loop;
exception when unique_violation then
  raise exception 'booking_already_posted';
end $fn$;
CREATE OR REPLACE FUNCTION public.match_message_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
begin
  new.created_at := now();        -- S2: the server's clock, never the sender's
  new.deleted_at := null;         -- S9: a message cannot arrive deleted (and so skip the length check)
  if (select status from matches where id = new.match_id) = 'cancelled' then raise exception 'match_cancelled'; end if;
  -- one count at a time per sender and game: parallel inserts cannot all see 29 (S12)
  perform pg_advisory_xact_lock(hashtextextended('courtbook:chat:' || new.match_id::text || ':' || new.profile_id::text, 0));
  if (select count(*) from match_messages where match_id = new.match_id and profile_id = new.profile_id
      and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'slow_down';
  end if;
  return new;
end $fn$;
CREATE OR REPLACE FUNCTION public.match_message_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare r record; who text;
begin
  select coalesce(name, 'A player') into who from profiles where id = new.profile_id;
  for r in
    select m.organizer_id as pid from matches m where m.id = new.match_id
    union
    select mp.profile_id from match_players mp where mp.match_id = new.match_id and mp.status = 'accepted'
  loop
    if r.pid <> new.profile_id
       and not exists (select 1 from match_hidden h where h.profile_id = r.pid and h.match_id = new.match_id)
       and not exists (
         select 1 from notifications n where n.profile_id = r.pid and n.match_id = new.match_id and n.kind = 'match_message' and n.read_at is null
       ) then
      insert into notifications (profile_id, kind, match_id, actor_id, body) values (r.pid, 'match_message', new.match_id, new.profile_id, who || ': ' || left(new.body, 80));
    end if;
  end loop;
  return new;
end $fn$;
drop function match_messages_list(uuid, timestamptz);
CREATE OR REPLACE FUNCTION public.match_messages_list(p_match uuid, p_after timestamp with time zone)
 RETURNS TABLE(id uuid, profile_id uuid, name text, body text, created_at timestamp with time zone, deleted boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
  select x.id, x.profile_id, p.name, case when x.deleted_at is null then x.body else '' end, x.created_at, x.deleted_at is not null
  from match_messages x join profiles p on p.id = x.profile_id
  where x.match_id = p_match and is_match_member(p_match) and (p_after is null or x.created_at > p_after)
    and not exists (select 1 from match_hidden h where h.match_id = p_match and h.profile_id = auth.uid())
  order by x.created_at;
$fn$;
revoke all on function match_messages_list(uuid, timestamptz) from public, anon;
grant execute on function match_messages_list(uuid, timestamptz) to authenticated, service_role;
CREATE OR REPLACE FUNCTION public.open_matches(p_sport sport DEFAULT NULL::sport, p_fit text DEFAULT NULL::text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_governorate text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_limit integer DEFAULT 50)
 RETURNS TABLE(match_id uuid, club_id uuid, club_name text, club_slug text, town text, sport sport, start_at timestamp with time zone, end_at timestamp with time zone, level_min integer, level_max integer, level_legacy boolean, my_level integer, players_needed integer, joined integer, note text, organizer_name text, join_mode text, i_joined boolean, booking_id uuid, court_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
  select m.id, m.club_id, c.name, c.slug, t.name_en, m.sport, m.start_at, m.end_at,
         (match_level_bounds(m))[1], (match_level_bounds(m))[2], m.level_min is null and m.level is not null,
         pl.level,
         m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         m.note, o.name, m.join_mode,
         exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid() and mp.status in ('accepted', 'pending')),
         m.booking_id, k.name
  from matches m
  join clubs c on c.id = m.club_id
  left join towns t on t.id = c.town_id
  left join districts d on d.code = t.district_code
  left join profiles o on o.id = m.organizer_id
  left join bookings b on b.id = m.booking_id
  left join courts k on k.id = b.court_id
  left join player_levels pl on pl.profile_id = auth.uid() and pl.sport = m.sport
  where auth.uid() is not null and m.status = 'open' and m.organizer_id <> auth.uid()
    and m.start_at > coalesce(p_from, now()) and m.start_at < coalesce(p_to, now() + interval '14 days')
    and (p_sport is null or m.sport = p_sport)
    and (p_fit is distinct from 'mine' or pl.level is null or match_level_bounds(m) is null
         or (pl.level between (match_level_bounds(m))[1] and (match_level_bounds(m))[2]))
    and (p_governorate is null or d.governorate_code = p_governorate)
    and (p_district is null or d.code = p_district)
  order by m.start_at
  limit least(coalesce(p_limit, 50), 100);
$fn$;
CREATE OR REPLACE FUNCTION public.match_board(p_club uuid, p_days integer)
 RETURNS TABLE(match_id uuid, club_id uuid, club_name text, club_slug text, sport sport, start_at timestamp with time zone, end_at timestamp with time zone, level_min integer, level_max integer, level_legacy boolean, my_level integer, players_needed integer, joined integer, pending integer, status match_status, closed_reason text, note text, join_mode text, organizer_id uuid, organizer_name text, my_status text, i_organize boolean, booking_id uuid, court_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
  select m.id, m.club_id, c.name, c.slug, m.sport, m.start_at, m.end_at,
         (match_level_bounds(m))[1], (match_level_bounds(m))[2], m.level_min is null and m.level is not null,
         (select pl.level from player_levels pl where pl.profile_id = auth.uid() and pl.sport = m.sport),
         m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'pending')::int,
         m.status, m.closed_reason, m.note, m.join_mode, m.organizer_id, o.name,
         (select mp.status from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()),
         m.organizer_id = auth.uid(),
         m.booking_id, k.name
  from matches m
  left join clubs c on c.id = m.club_id
  left join profiles o on o.id = m.organizer_id
  left join bookings b on b.id = m.booking_id
  left join courts k on k.id = b.court_id
  where auth.uid() is not null
    and (p_club is null or m.club_id = p_club)
    and m.start_at > now() and m.start_at < now() + make_interval(days => coalesce(p_days, 14))
    and (m.status = 'open' or m.organizer_id = auth.uid()
         or exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()
                      and mp.status in ('accepted', 'pending')))
  order by m.start_at;
$fn$;
drop policy if exists "match_messages: members read" on match_messages;
create policy "match_messages: members read" on match_messages for select using (is_match_member(match_id));
drop function if exists match_players_block_guard();
drop function if exists block_player(uuid);
drop function if exists unblock_player(uuid);
drop function if exists my_blocked_players();
drop function if exists accept_community_rules();
drop function if exists my_rules_accepted();
drop function if exists report_content(text, uuid, text, text);
drop function if exists admin_reports(text);
drop function if exists admin_report_messages(uuid);
drop function if exists admin_resolve_report(uuid, text, text);
drop function if exists admin_hide_message(uuid);
drop function if exists admin_suspend(uuid, text);
drop function if exists admin_unsuspend(uuid);
drop function if exists my_account_status();
drop function if exists send_feedback(text, text, text);
drop function if exists my_recent_players();
drop function if exists message_has_blocked_term(text);
drop function if exists players_blocked(uuid, uuid);
drop function if exists assert_active();
do $rb$ begin
  if not ((select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '6a8feb9a5b8c59e81d8d72ac49076635' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'post_match') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '47e042026bc084f8da0664020b77e1fb' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'join_match') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '504c193753ecdda87b461204e1e0243f' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'decide_join') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'efc91a08d70e84de15fced731b99a03c' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'update_match') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '883dc68e447d0f8a5af681d8f395bf3b' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'set_match_status') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '16aa48b9507019f62b35e77d4fb63763' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'remove_player') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'a1fb427e8c034c6fee12876f342d3460' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_court') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'd58b98d66bb5d8d5033a99069c411615' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_message_guard') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'c063c6d3f6071aa1a6446682cad26491' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_message_notify') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'c0159407235a7e78b86cc3fa11592861' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_messages_list') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'fe591842860b76aa55f31440f4c0ee72' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'open_matches') and (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '7ee31e25c3b937e5bf1316d8907d1117' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_board')) then raise exception '0074 rollback: the functions are not back to the 0073 state'; end if;
end $rb$;
commit;
notify pgrst, 'reload schema';
