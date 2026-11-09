-- Phase 1 schema additions.
-- (a) booking window: players book at most N days ahead (per club). Staff unaffected.
-- (b) close_club(): whole-club closure = one block per active court, one transaction.
--     Existing trigger rejects a block over a confirmed booking, so staff resolve those first.
-- (c) player_public: id/name/level/sports (no phone) so the staff calendar and the match board
--     can show who booked/joined. Contact details for staff come via bookings (guest_phone) or
--     an explicit staff path later.

alter table clubs add column booking_window_days int not null default 14 check (booking_window_days between 1 and 365);

create or replace function book_slot(
  p_club uuid, p_court uuid, p_coach uuid, p_start timestamptz, p_end timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_player uuid := auth.uid();
  c clubs%rowtype;
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
  if p_end - p_start <> make_interval(mins => c.slot_minutes) then
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

create or replace function close_club(p_club uuid, p_start timestamptz, p_end timestamptz, p_reason text)
returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_staff_of(p_club) then raise exception 'forbidden'; end if;
  if p_start >= p_end then raise exception 'bad_range'; end if;
  insert into blocks (club_id, court_id, start_at, end_at, reason, created_by)
  select p_club, id, p_start, p_end, coalesce(p_reason, 'closed'), auth.uid()
  from courts where club_id = p_club and active;
  get diagnostics n = row_count;
  return n;
exception
  when exclusion_violation then
    if sqlerrm = 'block_overlaps_booking' then
      raise exception 'block_overlaps_booking';   -- staff must cancel/move those bookings first
    end if;
    raise exception 'overlaps_existing_block';
end $$;
revoke execute on function close_club(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function close_club(uuid, timestamptz, timestamptz, text) to authenticated;

create view player_public with (security_invoker = false) as
  select id, name, level, sports from profiles;
revoke all on player_public from public, anon;
grant select on player_public to authenticated;
