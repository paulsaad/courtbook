-- Paul, 12 Nov: a football organiser needs far more than three players. The number of players a match
-- is looking for was capped at 20 by the table and by both RPCs, and the form only offered 1, 2 or 3.
-- The limit becomes 1–30: enough for a 24-a-side request with room above it, and still a number a
-- person could plausibly be organising.
--
-- The number means players still wanted, not counting the organiser or anyone arranged outside the app.
-- Everything derived from it — spots left, auto-Full, reopening when someone drops out, and the rule
-- that it cannot go below the players already accepted — keeps working off the same number.

alter table matches drop constraint if exists matches_players_needed_check;
alter table matches add constraint matches_players_needed_check check (players_needed between 1 and 30);

create or replace function post_match(
  p_club uuid, p_sport sport, p_start timestamptz, p_end timestamptz, p_level_min int, p_level_max int,
  p_players_needed int, p_note text, p_booking uuid, p_join_mode text default 'open'
) returns uuid
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
end $$;
revoke execute on function post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text) from public, anon;
grant execute on function post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text) to authenticated;

create or replace function update_match(p_match uuid, p_players_needed int, p_level_min int, p_level_max int, p_note text, p_join_mode text) returns void
language plpgsql security definer set search_path = public as $$
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
end $$;
revoke execute on function update_match(uuid, int, int, int, text, text) from public, anon;
grant execute on function update_match(uuid, int, int, int, text, text) to authenticated;
