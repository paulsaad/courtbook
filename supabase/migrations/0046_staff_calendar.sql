-- Phase 9 step (a): the desk's own booking path, and the numbers the Today view needs.
-- Walk-in entry used to insert straight into bookings from the browser: the exclusion constraint
-- still stopped a double booking, but nothing checked duration, opening hours, an inactive court or
-- a court belonging to another club in one place, and no price was recorded.

-- Money rule for a desk booking: the price is saved on the booking so the club has its own record,
-- the CourtBook service fee is 0 (the booking did not go through the app), and NO payments row is
-- created — `payments` is the record of money that moved through CourtBook, and none did. The
-- payments dashboard counts only payments with status 'paid', so a desk booking can never read as
-- money collected. Taking cash at the desk is the club's own business in v0.1.

create or replace function staff_book(
  p_club uuid, p_court uuid, p_start timestamptz, p_end timestamptz, p_name text, p_phone text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
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
end $$;
revoke execute on function staff_book(uuid, uuid, timestamptz, timestamptz, text, text) from public, anon;
grant execute on function staff_book(uuid, uuid, timestamptz, timestamptz, text, text) to authenticated;

-- Type-ahead for the desk: people this club has booked before. Staff of that club only.
-- Returns a name and phone to copy into the form and nothing else — no profile id — so choosing a
-- suggestion can never attach the booking to someone's player account.
create or replace function club_recent_guests(p_club uuid, p_query text default null)
returns table (name text, phone text, last_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;
  return query
    select b.guest_name,
           (array_agg(b.guest_phone order by b.start_at desc) filter (where b.guest_phone is not null))[1],
           max(b.start_at)
    from bookings b
    where b.club_id = p_club and b.guest_name is not null
      and b.status in ('confirmed', 'no_show')
      and (p_query is null or btrim(p_query) = '' or b.guest_name ilike '%' || btrim(p_query) || '%')
    group by b.guest_name
    order by max(b.start_at) desc
    limit 8;
end $$;
revoke execute on function club_recent_guests(uuid, text) from public, anon;
grant execute on function club_recent_guests(uuid, text) to authenticated;

-- The duration this club books most often (last 30 days), for the walk-in sheet's default.
create or replace function club_common_duration(p_club uuid) returns int
language plpgsql stable security definer set search_path = public as $$
declare c clubs%rowtype; v int;
begin
  select * into c from clubs where id = p_club;
  if not found then raise exception 'club_not_found'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;
  select (extract(epoch from (end_at - start_at)) / 60)::int into v
  from bookings
  where club_id = p_club and status in ('confirmed', 'no_show') and start_at > now() - interval '30 days'
  group by (extract(epoch from (end_at - start_at)) / 60)::int
  order by count(*) desc, 1
  limit 1;
  v := coalesce(v, c.min_booking_minutes);
  if v % c.slot_minutes <> 0 or v < c.min_booking_minutes or v > c.max_booking_minutes then
    v := c.min_booking_minutes;
  end if;
  return v;
end $$;
revoke execute on function club_common_duration(uuid) from public, anon;
grant execute on function club_common_duration(uuid) to authenticated;

-- Today view: what is free this minute, and when each busy court frees up.
-- "Busy" counts every reason a court cannot be used right now: a confirmed booking, a hold that has
-- not expired, or a block. Active courts only. This is the state at this moment, not for the day.
create or replace function club_courts_free_now(p_club uuid)
returns table (court_id uuid, court_name text, sport sport, busy boolean, free_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;
  return query
    with k as (
      select c.id, c.name, c.sport from courts c where c.club_id = p_club and c.active
    ),
    busy as (
      select b.court_id, b.end_at from bookings b
      where b.club_id = p_club and b.court_id is not null
        and (b.status = 'confirmed' or (b.status = 'pending' and b.hold_expires_at > now()))
        and b.start_at <= now() and b.end_at > now()
      union all
      select x.court_id, x.end_at from blocks x
      where x.club_id = p_club and x.start_at <= now() and x.end_at > now()
    )
    select k.id, k.name, k.sport,
           exists (select 1 from busy where busy.court_id = k.id),
           (select max(busy.end_at) from busy where busy.court_id = k.id)
    from k
    order by k.name;
end $$;
revoke execute on function club_courts_free_now(uuid) from public, anon;
grant execute on function club_courts_free_now(uuid) to authenticated;
