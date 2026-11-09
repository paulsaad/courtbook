-- Review round 2, finding 1: slot validity must hold for every court booking, not only
-- for book_slot(). Rule: inside opening hours (club local time), start on the slot grid,
-- duration = k × slot_minutes with k ≥ 1. Players (book_slot) are further limited to k = 1.
-- Enforced by a trigger so staff inserts and move_booking() cannot bypass it.
-- Blocks are deliberately not constrained: maintenance/events may span any range.

create or replace function assert_valid_court_slot(p_club uuid, p_court uuid, p_start timestamptz, p_end timestamptz)
returns void
language plpgsql stable set search_path = public as $$
declare
  c clubs%rowtype;
  v_start time;
  v_end   time;
  v_mins  int;
begin
  select * into c from clubs where id = p_club;
  if not found then raise exception 'club_not_found'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = p_club) then
    raise exception 'court_not_found';
  end if;

  v_mins := extract(epoch from (p_end - p_start))::int / 60;
  if v_mins <= 0 or v_mins % c.slot_minutes <> 0 then
    raise exception 'bad_duration';
  end if;

  v_start := (p_start at time zone c.timezone)::time;
  v_end   := (p_end   at time zone c.timezone)::time;
  -- same local day; end may equal close_time exactly
  if (p_start at time zone c.timezone)::date <> (p_end at time zone c.timezone)::date and v_end <> '00:00' then
    raise exception 'outside_opening_hours';
  end if;
  if v_start < c.open_time or (v_end > c.close_time and v_end <> '00:00') then
    raise exception 'outside_opening_hours';
  end if;
  if (extract(epoch from (v_start - c.open_time))::int / 60) % c.slot_minutes <> 0 then
    raise exception 'not_on_grid';
  end if;
end $$;

create or replace function bookings_validate_slot() returns trigger
language plpgsql as $$
begin
  if new.court_id is not null and new.status = 'confirmed' then
    perform assert_valid_court_slot(new.club_id, new.court_id, new.start_at, new.end_at);
  end if;
  return new;
end $$;

create trigger bookings_slot_validation
  before insert or update of court_id, start_at, end_at on bookings
  for each row execute function bookings_validate_slot();

-- book_slot: players get exactly one slot; the rest is now the trigger's job.
create or replace function book_slot(
  p_club uuid, p_court uuid, p_coach uuid, p_start timestamptz, p_end timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_player uuid := auth.uid();
  v_slot int;
  v_tx uuid;
  v_booking uuid;
begin
  if v_player is null then raise exception 'not_authenticated'; end if;
  if p_coach is not null then raise exception 'coach_booking_not_available'; end if;  -- Phase 4
  if p_court is null then raise exception 'court_required'; end if;
  if p_start <= now() then raise exception 'slot_in_past'; end if;

  select slot_minutes into v_slot from clubs where id = p_club and active;
  if not found then raise exception 'club_not_found'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = p_club and active) then
    raise exception 'court_not_found';
  end if;
  if p_end - p_start <> make_interval(mins => v_slot) then
    raise exception 'bad_duration';
  end if;

  perform 1 from profiles where id = v_player for update;
  if credit_balance(v_player) < 1 then raise exception 'insufficient_credits'; end if;

  v_booking := gen_random_uuid();
  insert into credit_transactions (profile_id, delta, kind, created_by)
  values (v_player, -1, 'booking', v_player) returning id into v_tx;

  insert into bookings (id, club_id, court_id, coach_id, player_id, start_at, end_at, source, credit_tx_id, created_by)
  values (v_booking, p_club, p_court, null, v_player, p_start, p_end, 'app', v_tx, v_player);

  update credit_transactions set booking_id = v_booking where id = v_tx;
  return v_booking;
exception
  when exclusion_violation then
    raise exception 'slot_taken';
end $$;

revoke execute on function assert_valid_court_slot(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function assert_valid_court_slot(uuid, uuid, timestamptz, timestamptz) to authenticated;
