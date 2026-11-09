-- Phase 0 review fixes (ChatGPT review, 2026-11-09). Numbers refer to the review findings.

-- ---------------------------------------------------------------------------
-- #2 A court must belong to the club named on the row (cross-club tenant escape)
-- ---------------------------------------------------------------------------
alter table courts add constraint courts_id_club_unique unique (id, club_id);
alter table bookings    add constraint bookings_court_club_fk    foreign key (court_id, club_id) references courts(id, club_id);
alter table blocks      add constraint blocks_court_club_fk      foreign key (court_id, club_id) references courts(id, club_id);
alter table price_rules add constraint price_rules_court_club_fk foreign key (court_id, club_id) references courts(id, club_id);
-- (MATCH SIMPLE: rows with court_id null are not checked, which is what we want.)

-- ---------------------------------------------------------------------------
-- #3 / #7 Function privileges: nothing callable by PUBLIC or anon
-- ---------------------------------------------------------------------------
revoke execute on function book_slot(uuid, uuid, uuid, timestamptz, timestamptz) from public, anon;
revoke execute on function cancel_booking(uuid) from public, anon;
revoke execute on function credit_balance(uuid) from public, anon;
revoke execute on function is_admin() from public, anon;
revoke execute on function is_staff_of(uuid) from public, anon;
revoke execute on function my_coach_id() from public, anon;
grant execute on function is_admin() to authenticated;
grant execute on function is_staff_of(uuid) to authenticated;
grant execute on function my_coach_id() to authenticated;

-- #7 Balance is own-only (admin may read anyone's)
create or replace function credit_balance(p_profile uuid) returns int
language plpgsql stable security definer set search_path = public as $$
begin
  -- auth.uid() is null for the SQL editor / service role (trusted)
  if auth.uid() is not null and p_profile <> auth.uid() and not is_admin() then
    raise exception 'forbidden';
  end if;
  return coalesce((select sum(delta) from credit_transactions where profile_id = p_profile), 0)::int;
end $$;

-- #7 Profiles are created only by the signup trigger
drop policy "profiles: insert own" on profiles;

-- ---------------------------------------------------------------------------
-- #8 occupancy: authenticated only; booking ids only for the caller's own rows
-- ---------------------------------------------------------------------------
drop view occupancy;
create view occupancy with (security_invoker = false) as
  select case when player_id = auth.uid() then id end as id,
         club_id, court_id, coach_id, start_at, end_at,
         (player_id = auth.uid()) as mine,
         'booking'::text as kind
  from bookings where status = 'confirmed'
  union all
  select null::uuid, club_id, court_id, null::uuid, start_at, end_at, false, 'block'::text
  from blocks;
-- Supabase default privileges grant anon select on new views: revoke explicitly.
revoke all on occupancy from public, anon;
grant select on occupancy to authenticated;

-- ---------------------------------------------------------------------------
-- #1 / #5 book_slot: serialize per player, validate the slot, reject coach path until Phase 4
-- ---------------------------------------------------------------------------
create or replace function book_slot(
  p_club uuid, p_court uuid, p_coach uuid, p_start timestamptz, p_end timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_player uuid := auth.uid();
  c clubs%rowtype;
  v_local_start time;
  v_local_end   time;
  v_tx uuid;
  v_booking uuid;
begin
  if v_player is null then raise exception 'not_authenticated'; end if;
  if p_coach is not null then raise exception 'coach_booking_not_available'; end if;  -- Phase 4
  if p_court is null then raise exception 'court_required'; end if;
  if p_start <= now() then raise exception 'slot_in_past'; end if;

  select * into c from clubs where id = p_club and active;
  if not found then raise exception 'club_not_found'; end if;

  if not exists (select 1 from courts where id = p_court and club_id = p_club and active) then
    raise exception 'court_not_found';
  end if;

  -- exactly one slot, on the club's grid, inside opening hours (club local time)
  if p_end - p_start <> make_interval(mins => c.slot_minutes) then
    raise exception 'bad_duration';
  end if;
  v_local_start := (p_start at time zone c.timezone)::time;
  v_local_end   := (p_end   at time zone c.timezone)::time;
  if v_local_start < c.open_time or v_local_end > c.close_time or v_local_end <= v_local_start then
    raise exception 'outside_opening_hours';
  end if;
  if (extract(epoch from (v_local_start - c.open_time))::int / 60) % c.slot_minutes <> 0 then
    raise exception 'not_on_grid';
  end if;

  -- #1: serialize this player's bookings so the balance check cannot race itself
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
    raise exception 'slot_taken';   -- whole transaction rolls back: no credit spent
end $$;

-- ---------------------------------------------------------------------------
-- #3 / #6 cancel_booking: must be authenticated. Policy (pending Paul's confirmation):
--   player may cancel any time; credit refunded only before the cutoff.
--   staff cancellation is club-caused and always refunds an app booking.
-- ---------------------------------------------------------------------------
create or replace function cancel_booking(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  b bookings%rowtype;
  cutoff int;
  is_staff boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select * into b from bookings where id = p_booking for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;

  is_staff := is_staff_of(b.club_id);
  if not is_staff and (b.player_id is null or b.player_id <> auth.uid()) then
    raise exception 'forbidden';
  end if;

  select cancel_cutoff_hours into cutoff from clubs where id = b.club_id;

  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking;

  if b.credit_tx_id is not null and (is_staff or b.start_at - make_interval(hours => cutoff) > now()) then
    insert into credit_transactions (profile_id, delta, kind, booking_id, created_by)
    values (b.player_id, +1, 'refund', b.id, auth.uid());
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- #4 Staff never update bookings directly; narrow RPCs instead
-- ---------------------------------------------------------------------------
drop policy "bookings: staff update" on bookings;

create or replace function move_booking(p_booking uuid, p_court uuid, p_start timestamptz, p_end timestamptz)
returns void
language plpgsql security definer set search_path = public as $$
declare
  b bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into b from bookings where id = p_booking for update;
  if not found then raise exception 'not_found'; end if;
  if not is_staff_of(b.club_id) then raise exception 'forbidden'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;
  if b.court_id is null then raise exception 'not_a_court_booking'; end if;
  if p_start >= p_end then raise exception 'bad_range'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = b.club_id and active) then
    raise exception 'court_not_found';
  end if;
  update bookings set court_id = p_court, start_at = p_start, end_at = p_end where id = p_booking;
exception
  when exclusion_violation then
    raise exception 'slot_taken';
end $$;

create or replace function mark_no_show(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  b bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into b from bookings where id = p_booking for update;
  if not found then raise exception 'not_found'; end if;
  if not is_staff_of(b.club_id) then raise exception 'forbidden'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;
  if b.start_at > now() then raise exception 'not_started'; end if;
  update bookings set status = 'no_show' where id = p_booking;   -- credit is kept (spec)
end $$;

revoke execute on function move_booking(uuid, uuid, timestamptz, timestamptz) from public, anon;
revoke execute on function mark_no_show(uuid) from public, anon;
grant execute on function move_booking(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function mark_no_show(uuid) to authenticated;
