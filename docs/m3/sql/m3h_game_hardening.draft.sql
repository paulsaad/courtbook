-- M3-H — game hardening (DRAFT: not a migration yet; its number is assigned when Paul approves it,
-- as the next free number after 0071, docs/audit/fixes.md §3). Applied nowhere.
--
-- Fixes the reproduced defects before the app can write to games (decision D1). Rules: game rules
-- GR-4 … GR-12 in docs/m3/03-journeys.md; findings in docs/m3/02-safety-review.md; tests §AP in
-- docs/m3/06-test-plan.md, run by supabase/tests/m3/hardening.sh. S1 and S5 are NOT here: release fix
-- 0069 delivered them. Requires 0067 (matches.court_lost_at, closed_reason 'no_court').
--
--   S2, S9, S12  chat insert: server sets created_at, deleted_at null, refused in a cancelled game,
--                at most 30 messages per sender per game per 10 minutes
--   S4  (GR-5)   leave_match keeps a declined row: a declined player cannot ask again
--   S8, S18, S19 (GR-9)  booking trigger: only confirmed → cancelled acts; the game keeps players and
--                chat, joins pause (closed / no_court), organiser, accepted and pending players told;
--                a no-show mark changes nothing; booking_moved also reaches pending players
--   GR-9         resolve_court(game, booking or null): organiser or admin
--   GR-8         set_match_status: private / reopen only before start and not while the court is
--                lost; cancel until the game is played
--   S10          post_match without a booking: club required, start within 60 days
--   S11 (GR-4)   each waiting request gets one match_full_waiting notice each time the game fills
--   S12          at most 10 live games per organiser; at most 20 waiting requests per player
--   S14          a member who hid the game gets no chat notices for it
--   S15          switching approval → open accepts waiting requests in request order up to capacity
--   GR-6         remove_player(game, player): organiser or admin, accepted players, before start;
--                stored as declined (final); a game closed as full reopens
--
-- Web: one behaviour the web can see changes: a cancelled court booking now closes the game
-- (closed_reason 'no_court') instead of leaving it open. The web shows an unknown closed reason as
-- "Private"; its two strings for no_court ship with this migration (P4). New refusals the web can
-- meet: court_lost, match_over, match_started (status), club_required, too_far_ahead, too_many_games,
-- too_many_requests, match_cancelled and slow_down (chat).
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------------------------
-- Waiting list notice (S11, GR-4). Internal: not callable through the API.
create or replace function notify_waiting(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select profile_id from match_players where match_id = p_match and status = 'pending' loop
    insert into notifications (profile_id, kind, match_id, actor_id, body)
    values (r.profile_id, 'match_full_waiting', p_match, auth.uid(),
            'The match is full. You''re on the waiting list; the organizer can still add you if a place opens');
  end loop;
end $$;
revoke all on function notify_waiting(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Joining (GR-3, GR-4, S11, S12). Unchanged apart from the request limit and the waiting notice.
create or replace function join_match(p_match uuid) returns text
language plpgsql security definer set search_path = public as $$
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
end $$;

-- ---------------------------------------------------------------------------------------------
-- Leaving (GR-7, S4). A declined row is kept and nothing happens: no notice, no new request later.
create or replace function leave_match(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; was text; me text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.start_at <= now() then raise exception 'match_started'; end if;
  select status into was from match_players where match_id = p_match and profile_id = auth.uid();
  if was is null or was = 'declined' then return; end if;
  delete from match_players where match_id = p_match and profile_id = auth.uid();
  if was = 'accepted' then
    select coalesce(name, 'A player') into me from profiles where id = auth.uid();
    perform notify(m.organizer_id, 'player_left', p_match, me || ' left your match');
    -- only a game closed because it was full reopens; private and no_court stay as they are
    if m.status = 'closed' and m.closed_reason = 'full'
       and (select count(*) from match_players where match_id = p_match and status = 'accepted') < m.players_needed then
      update matches set status = 'open', closed_at = null, closed_reason = null where id = p_match;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Accept / decline (GR-4, GR-5, GR-8). Accept fills → waiting notice (S11). Otherwise unchanged.
create or replace function decide_join(p_match uuid, p_profile uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
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
end $$;

-- ---------------------------------------------------------------------------------------------
-- Private / reopen / cancel (GR-8, GR-9, GR-11).
create or replace function set_match_status(p_match uuid, p_status match_status) returns void
language plpgsql security definer set search_path = public as $$
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
end $$;

-- ---------------------------------------------------------------------------------------------
-- Edit (GR-8, S11, S15).
create or replace function update_match(p_match uuid, p_players_needed integer, p_level_min integer,
  p_level_max integer, p_note text, p_join_mode text) returns void
language plpgsql security definer set search_path = public as $$
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
end $$;

-- ---------------------------------------------------------------------------------------------
-- Post (S10, S12). With a booking: unchanged (club, time and end follow the booking).
create or replace function post_match(p_club uuid, p_sport sport, p_start timestamptz, p_end timestamptz,
  p_level_min integer, p_level_max integer, p_players_needed integer, p_note text, p_booking uuid,
  p_join_mode text default 'open') returns uuid
language plpgsql security definer set search_path = public as $$
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
  -- S12: live games = not cancelled and not started
  if (select count(*) from matches where organizer_id = auth.uid() and status <> 'cancelled' and start_at > now()) >= 10 then
    raise exception 'too_many_games';
  end if;
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, level_min, level_max, players_needed, note, booking_id, join_mode)
  values (v_id, p_club, p_sport, auth.uid(), p_start, p_end, p_level_min, p_level_max, p_players_needed, nullif(trim(p_note), ''), p_booking, p_join_mode);
  return v_id;
exception when unique_violation then
  raise exception 'booking_already_posted';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Remove a player (GR-6). Stored as declined: final for this game, like a declined request.
create or replace function remove_player(p_match uuid, p_profile uuid) returns void
language plpgsql security definer set search_path = public as $$
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
end $$;
revoke all on function remove_player(uuid, uuid) from public, anon;
grant execute on function remove_player(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Court booking changes (GR-9, S8, S18, S19). Acts only on confirmed → cancelled, and on time or
-- court moves of a confirmed booking. No booking is ever made or changed here.
create or replace function sync_match_with_booking() returns trigger
language plpgsql security definer set search_path = public as $$
declare m record; r record;
begin
  for m in select * from matches where booking_id = new.id and status <> 'cancelled' loop
    if old.status = 'confirmed' and new.status = 'cancelled' then
      if coalesce(m.end_at, m.start_at + interval '3 hours') <= now() then
        -- already played: the record stays; only the link to a cancelled booking goes
        update matches set booking_id = null where id = m.id;
        continue;
      end if;
      update matches set booking_id = null, court_lost_at = now(),
        status = case when m.status = 'open' or m.closed_reason = 'full' then 'closed'::match_status else m.status end,
        closed_reason = case when m.status = 'open' or m.closed_reason = 'full' then 'no_court' else m.closed_reason end,
        closed_at = case when m.status = 'open' or m.closed_reason = 'full' then now() else m.closed_at end
      where id = m.id;
      insert into notifications (profile_id, kind, match_id, body)
      values (m.organizer_id, 'booking_unlinked', m.id,
              'The court booking for your match was cancelled. Choose what to do: link another booking, go ahead without one, or cancel the match');
      for r in select mp.profile_id from match_players mp
               where mp.match_id = m.id and mp.status in ('accepted', 'pending') and mp.profile_id <> m.organizer_id loop
        insert into notifications (profile_id, kind, match_id, body)
        values (r.profile_id, 'booking_unlinked', m.id,
                'The court booking for this match was cancelled. Joining is paused until the organizer decides');
      end loop;
    elsif new.status = 'confirmed' and (new.start_at <> old.start_at or new.end_at <> old.end_at or new.court_id is distinct from old.court_id) then
      update matches set start_at = new.start_at, end_at = new.end_at where id = m.id;
      for r in select m.organizer_id as pid
               union select mp.profile_id from match_players mp where mp.match_id = m.id and mp.status in ('accepted', 'pending') loop
        insert into notifications (profile_id, kind, match_id, body)
        values (r.pid, 'booking_moved', m.id, 'The club moved the court booking for your match — check the new time and court');
      end loop;
    end if;
    -- any other change (no-show, …) leaves the game and its link alone (S18)
  end loop;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Resolve a lost court (GR-9). Organiser or admin, while court_lost_at is set, before the game is
-- played. p_booking: another confirmed, future booking of the organiser, same sport, not already
-- linked to a live game — the game takes its club, time and end. null: the game goes ahead with no
-- court booked through CourtBook (P1).
create or replace function resolve_court(p_match uuid, p_booking uuid default null) returns void
language plpgsql security definer set search_path = public as $$
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
end $$;
revoke all on function resolve_court(uuid, uuid) from public, anon;
grant execute on function resolve_court(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Chat insert (S2, S9, S12, GR-11, GR-12). Membership stays the RLS policy's job.
create or replace function match_message_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();        -- S2: the server's clock, never the sender's
  new.deleted_at := null;         -- S9: a message cannot arrive deleted (and so skip the length check)
  if (select status from matches where id = new.match_id) = 'cancelled' then raise exception 'match_cancelled'; end if;
  if (select count(*) from match_messages where match_id = new.match_id and profile_id = new.profile_id
      and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'slow_down';
  end if;
  return new;
end $$;
drop trigger if exists match_messages_guard on match_messages;
create trigger match_messages_guard before insert on match_messages
  for each row execute function match_message_guard();

-- Chat notices skip members who hid the game (S14). Otherwise unchanged.
create or replace function match_message_notify() returns trigger
language plpgsql security definer set search_path = public as $$
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
end $$;
