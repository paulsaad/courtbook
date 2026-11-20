-- 0073 (post_match idempotency key) — ROLLBACK. Restores 0072's post_match exactly and removes the key.
-- Safe at any time: games posted with a key stay as they are (only the key is dropped). Roll this back
-- BEFORE rolling back 0072 (0072's rollback refuses while 0073's post_match is in place).
begin;
do $rb$ begin
  if not (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '6a8feb9a5b8c59e81d8d72ac49076635' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'post_match') then
    raise exception '0073 rollback: post_match is not the 0073 version — nothing done';
  end if;
end $rb$;
drop function post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text, uuid);
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
  -- S12: live games = not cancelled and not started; one count at a time per organiser, so two
  -- simultaneous posts cannot both see 9
  perform pg_advisory_xact_lock(hashtextextended('courtbook:post_match:' || auth.uid()::text, 0));
  if (select count(*) from matches where organizer_id = auth.uid() and status <> 'cancelled' and start_at > now()) >= 10 then
    raise exception 'too_many_games';
  end if;
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, level_min, level_max, players_needed, note, booking_id, join_mode)
  values (v_id, p_club, p_sport, auth.uid(), p_start, p_end, p_level_min, p_level_max, p_players_needed, nullif(trim(p_note), ''), p_booking, p_join_mode);
  return v_id;
exception when unique_violation then
  raise exception 'booking_already_posted';
end $$;
revoke all on function post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text) from public, anon;
grant execute on function post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text) to authenticated, service_role;
drop index if exists matches_organizer_client_token;
alter table matches drop column if exists client_token;
do $rb$ begin
  if not (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '33b26aae02b8861858f86de235b66264' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'post_match') then raise exception '0073 rollback: post_match is not back to the 0072 version'; end if;
end $rb$;
commit;
notify pgrst, 'reload schema';
