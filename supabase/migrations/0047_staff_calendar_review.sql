-- Review of 0046, three findings, all valid.

-- 1. staff_book() was the only caller in the app, but "bookings: staff insert" (0001) still let a
--    browser insert a booking directly — skipping duration, opening hours, the grid, the court's club
--    and the price. The function is security definer, so it does not need the policy; nothing else
--    inserts into bookings outside hold_slot(), which is also security definer.
drop policy if exists "bookings: staff insert" on bookings;

-- 2. Suggestions grouped by name only, so two different customers with the same name became one row
--    and could hand the desk the other person's phone number. Group by the pair instead: each
--    name-and-phone combination is its own suggestion, and a customer stored without a phone stays
--    without one.
create or replace function club_recent_guests(p_club uuid, p_query text default null)
returns table (name text, phone text, last_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;
  return query
    select b.guest_name, b.guest_phone, max(b.start_at)
    from bookings b
    where b.club_id = p_club and b.guest_name is not null
      and b.status in ('confirmed', 'no_show')
      and (p_query is null or btrim(p_query) = '' or b.guest_name ilike '%' || btrim(p_query) || '%')
    group by b.guest_name, b.guest_phone
    order by max(b.start_at) desc
    limit 8;
end $$;
revoke execute on function club_recent_guests(uuid, text) from public, anon;
grant execute on function club_recent_guests(uuid, text) to authenticated;

-- 3. free_at took the latest end among the things covering this minute, so a court booked 10:00–11:00
--    and again 11:00–12:00 read as free at 11:00. Follow the chain of back-to-back bookings, holds and
--    blocks to the point where the court is genuinely free.
create or replace function club_courts_free_now(p_club uuid)
returns table (court_id uuid, court_name text, sport sport, busy boolean, free_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare k record; t timestamptz; nxt timestamptz;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;
  for k in select c.id, c.name, c.sport from courts c where c.club_id = p_club and c.active order by c.name loop
    t := now();
    loop
      -- the latest end among everything occupying this court at time t
      select max(x.end_at) into nxt from (
        select b.end_at from bookings b
        where b.club_id = p_club and b.court_id = k.id
          and (b.status = 'confirmed' or (b.status = 'pending' and b.hold_expires_at > now()))
          and b.start_at <= t and b.end_at > t
        union all
        select z.end_at from blocks z
        where z.club_id = p_club and z.court_id = k.id and z.start_at <= t and z.end_at > t
      ) x;
      exit when nxt is null;          -- free from t onwards
      t := nxt;                       -- occupied until nxt; see whether something starts there
    end loop;
    court_id := k.id; court_name := k.name; sport := k.sport;
    busy := t > now();
    free_at := case when t > now() then t else null end;
    return next;
  end loop;
end $$;
revoke execute on function club_courts_free_now(uuid) from public, anon;
grant execute on function club_courts_free_now(uuid) to authenticated;
