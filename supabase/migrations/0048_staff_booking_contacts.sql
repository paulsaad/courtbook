-- Paul on the phone (12 Nov): the booking sheet shows no phone number for a booking made in the app.
-- It never could: a desk booking stores guest_phone, an app booking stores only the player id, and
-- player_names() returns a name and no contact details. The desk needs to be able to ring the person
-- who booked — that is half of what a front desk does with a calendar.
--
-- Scope: staff (or admin) of a club, for bookings at that club, and nothing else. A player's phone is
-- never exposed to other players, and never for a booking at another club.

create or replace function club_booking_contacts(p_club uuid, p_bookings uuid[])
returns table (booking_id uuid, name text, phone text)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;
  if cardinality(p_bookings) > 500 then raise exception 'too_long'; end if;
  return query
    select b.id, coalesce(b.guest_name, p.name), coalesce(b.guest_phone, p.phone)
    from bookings b
    left join profiles p on p.id = b.player_id
    where b.club_id = p_club and b.id = any (p_bookings);
end $$;
revoke execute on function club_booking_contacts(uuid, uuid[]) from public, anon;
grant execute on function club_booking_contacts(uuid, uuid[]) to authenticated;
