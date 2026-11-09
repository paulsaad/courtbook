-- Spec amendment (Paul, 2026-11-09): bookings from 30 min up, in 30-min steps.
-- slot_minutes is now the grid step (30/60/90). Players may book between
-- min_booking_minutes and max_booking_minutes (multiples of the grid); staff any multiple.
-- One credit per booking regardless of length. price_rules.price_usd is per hour.

alter table clubs drop constraint clubs_slot_minutes_check;
alter table clubs add constraint clubs_slot_minutes_check check (slot_minutes in (30, 60, 90));
alter table clubs alter column slot_minutes set default 30;
alter table clubs add column min_booking_minutes int not null default 60;
alter table clubs add column max_booking_minutes int not null default 180;
-- existing clubs: make the new columns consistent with their current grid before adding the rule
update clubs set min_booking_minutes = slot_minutes, max_booking_minutes = slot_minutes * 2
where min_booking_minutes % slot_minutes <> 0 or max_booking_minutes % slot_minutes <> 0;
alter table clubs add constraint clubs_booking_minutes_check check (
  min_booking_minutes > 0 and max_booking_minutes >= min_booking_minutes
  and min_booking_minutes % slot_minutes = 0 and max_booking_minutes % slot_minutes = 0
);

create or replace function book_slot(
  p_club uuid, p_court uuid, p_coach uuid, p_start timestamptz, p_end timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_player uuid := auth.uid();
  c clubs%rowtype;
  v_mins numeric;
  v_tx uuid;
  v_booking uuid;
begin
  if v_player is null then raise exception 'not_authenticated'; end if;
  if p_coach is not null then raise exception 'coach_booking_not_available'; end if;  -- Phase 4
  if p_court is null then raise exception 'court_required'; end if;
  if p_start <= now() then raise exception 'slot_in_past'; end if;

  select * into c from clubs where id = p_club and active;
  if not found then raise exception 'club_not_found'; end if;
  if p_start > now() + make_interval(days => c.booking_window_days) then
    raise exception 'beyond_booking_window';
  end if;
  if not exists (select 1 from courts where id = p_court and club_id = p_club and active) then
    raise exception 'court_not_found';
  end if;

  v_mins := extract(epoch from (p_end - p_start)) / 60;
  if v_mins < c.min_booking_minutes or v_mins > c.max_booking_minutes or v_mins % c.slot_minutes <> 0 then
    raise exception 'bad_duration';   -- grid/hours are re-checked by the bookings trigger
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

-- Demo club: 30-min grid, players 60–180 min. (Prices in seed are now per hour.)
update clubs set slot_minutes = 30, min_booking_minutes = 60, max_booking_minutes = 180 where slug = 'batroun';
