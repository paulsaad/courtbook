-- Release fixes 0068–0071 — ROLLBACK, one section per migration, newest first. Run only the section of
-- the migration being undone, in Supabase → SQL Editor. Each section restores the 0001–0066 state of
-- the objects it names, exactly (function bodies from pg_get_functiondef of a 0001–0066 database).
--
-- Not undone by design: clubs that 0070 switched from simulated to at_desk stay at the desk, and the
-- holds it released stay expired. The NOTICE printed when 0070 ran names those clubs.

-- ===== undo 0071 (staff past times) — restores staff_book (0046) and move_booking (0066)
begin;
create or replace function public.staff_book(p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_name text, p_phone text default null::text)
 returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  c clubs%rowtype;
  v_mins numeric;
  v_price numeric;
  v_id uuid := gen_random_uuid();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;
  if v_name is null then raise exception 'name_required'; end if;
  if length(v_name) > 80 or length(coalesce(p_phone, '')) > 30 then raise exception 'too_long'; end if;

  select * into c from clubs where id = p_club and active;
  if not found then raise exception 'club_not_found'; end if;
  -- the court must belong to THIS club and be active
  if not exists (select 1 from courts where id = p_court and club_id = p_club and active) then
    raise exception 'court_not_found';
  end if;

  v_mins := extract(epoch from (p_end - p_start)) / 60;
  if v_mins < c.min_booking_minutes or v_mins > c.max_booking_minutes then raise exception 'bad_duration'; end if;

  -- same lock order as hold_slot (courts before bookings), and clear any hold that has run out
  perform lock_courts(array[p_court]);
  perform expire_stale_holds(p_court);
  -- grid alignment, slot multiple and opening hours, in the club's timezone — one shared validator
  perform assert_valid_court_slot(p_club, p_court, p_start, p_end);

  v_price := quote_price(p_court, p_start, p_end);

  insert into bookings (id, club_id, court_id, player_id, guest_name, guest_phone,
                        start_at, end_at, status, source, created_by, price_usd, fee_usd)
  values (v_id, p_club, p_court, null, v_name, nullif(btrim(coalesce(p_phone, '')), ''),
          p_start, p_end, 'confirmed', 'staff', auth.uid(), v_price, 0);
  return v_id;
exception
  when exclusion_violation then raise exception 'slot_taken';
end $function$;
create or replace function public.move_booking(p_booking uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_court uuid; b bookings%rowtype; c clubs%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select court_id into v_court from bookings where id = p_booking;
  if not found then raise exception 'not_found'; end if;
  perform lock_courts(array_remove(array[v_court, p_court], null));
  select * into b from bookings where id = p_booking for update;
  if not is_staff_of(b.club_id) then raise exception 'forbidden'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;
  if b.court_id is null then raise exception 'not_a_court_booking'; end if;
  if p_start >= p_end then raise exception 'bad_range'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = b.club_id and active) then
    raise exception 'court_not_found';
  end if;
  select * into c from clubs where id = b.club_id;                                                   -- 0066
  if (p_end - p_start) <> (b.end_at - b.start_at)                                                    -- 0066
     and (p_end - p_start) not between make_interval(mins => c.min_booking_minutes) and make_interval(mins => c.max_booking_minutes) then
    raise exception 'bad_duration';
  end if;
  update bookings set court_id = p_court, start_at = p_start, end_at = p_end where id = p_booking;
exception
  when exclusion_violation then
    raise exception 'slot_taken';
end $function$;
notify pgrst, 'reload schema';
commit;

-- ===== undo 0070 (simulated payment demo-only) — default, constraint and set_club_payment_mode (0051)
begin;
alter table clubs drop constraint if exists clubs_simulated_only_demo;
alter table clubs alter column payment_mode set default 'simulated';
create or replace function public.set_club_payment_mode(p_club uuid, p_mode text)
 returns integer language plpgsql security definer set search_path to 'public'
as $function$
declare n int := 0;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_mode not in ('simulated', 'at_desk') then raise exception 'bad_payment_mode'; end if;
  perform 1 from clubs where id = p_club for update;
  if not found then raise exception 'club_not_found'; end if;

  -- expire the holds BEFORE the club flips, or the trigger below would refuse to expire their payments
  if p_mode = 'at_desk' then
    update bookings set status = 'expired'
    where club_id = p_club and status = 'pending';
    get diagnostics n = row_count;
    update payments p set status = 'expired'
    from bookings b where p.booking_id = b.id and b.club_id = p_club and b.status = 'expired' and p.status = 'pending';
  end if;

  update clubs set payment_mode = p_mode where id = p_club;
  return n;   -- holds released by the switch
end $function$;
notify pgrst, 'reload schema';
commit;

-- ===== undo 0069 (game delete, notification update) — restores S1 and S5 as they were
begin;
grant update on notifications to authenticated;
grant delete on matches to authenticated;
drop policy if exists "matches: organizer delete" on matches;
create policy "matches: organizer delete" on matches for delete using (organizer_id = auth.uid() or is_admin());
commit;

-- ===== undo 0068 (blocks read) — restores the open read policy
begin;
drop policy if exists "blocks: staff read" on blocks;
drop policy if exists "blocks: read" on blocks;
create policy "blocks: read" on blocks for select using (true);
commit;
