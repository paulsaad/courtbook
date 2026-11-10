-- Phase 5 review round 2: linked-booking creation must be concurrency-safe.
-- post_match locks the booking row (so cancel_booking / move_booking, which also lock it, serialize
-- with match creation) and a partial unique index guarantees at most one live match per booking.

create unique index if not exists matches_one_live_per_booking
  on matches (booking_id) where booking_id is not null and status <> 'cancelled';

create or replace function post_match(
  p_club uuid, p_sport sport, p_start timestamptz, p_end timestamptz, p_level player_level,
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
    -- lock: a concurrent cancel/move waits for us (and we see its result if it went first)
    select * into b from bookings where id = p_booking and player_id = auth.uid() for update;
    if not found or b.status <> 'confirmed' then raise exception 'booking_not_found'; end if;
    select sport into v_court_sport from courts where id = b.court_id;
    if v_court_sport is not null and v_court_sport <> p_sport then raise exception 'sport_mismatch'; end if;
    if exists (select 1 from matches where booking_id = p_booking and status <> 'cancelled') then raise exception 'booking_already_posted'; end if;
    p_club := b.club_id; p_start := b.start_at; p_end := b.end_at;
  end if;
  if p_start is null or p_start <= now() then raise exception 'slot_in_past'; end if;
  if p_end is not null and p_end <= p_start then raise exception 'bad_range'; end if;
  if p_players_needed < 1 or p_players_needed > 20 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'note_too_long'; end if;
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, level, players_needed, note, booking_id, join_mode)
  values (v_id, p_club, p_sport, auth.uid(), p_start, p_end, p_level, p_players_needed, nullif(trim(p_note), ''), p_booking, p_join_mode);
  return v_id;
exception when unique_violation then
  raise exception 'booking_already_posted';
end $$;
