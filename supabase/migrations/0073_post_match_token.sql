-- 0073 — post_match idempotency key (CANDIDATE: number assigned for review; applied nowhere).
--
-- A post whose answer is lost could be sent again and make a second game (only a booking's own unique
-- index prevented that, and only for games posted from a booking). With this migration the app sends
-- a key made once per post (p_token); the same organiser sending the same key again gets the SAME
-- game back — whatever its state — and nothing new is created. The key is stored on the game and is
-- unique per organiser, so even two simultaneous retries make one game.
--
-- Website compatibility: p_token is a new LAST argument with default null. The website's existing
-- calls (ten named arguments) and every SQL caller resolve to this function unchanged and behave
-- exactly as before (no key, no change). The ten-argument function is replaced (a second overload
-- would make the API's named-argument call ambiguous).
--
-- Body: 0072's post_match, plus the key lookup before anything else is checked, the key stored on
-- insert, and the unique violation told apart (key → the existing game; booking → booking_already_posted).

alter table matches add column if not exists client_token uuid;
create unique index if not exists matches_organizer_client_token on matches (organizer_id, client_token) where client_token is not null;

drop function if exists post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text);
create or replace function post_match(p_club uuid, p_sport sport, p_start timestamptz, p_end timestamptz,
  p_level_min integer, p_level_max integer, p_players_needed integer, p_note text, p_booking uuid,
  p_join_mode text default 'open', p_token uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
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
end $$;
revoke all on function post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text, uuid) from public, anon;
grant execute on function post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
