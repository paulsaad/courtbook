-- Phase 11b: venue information.
--
-- 0056 added the description, the arrival notes and the seven facilities. The one thing missing is
-- the address itself: `location_url` is a maps link, which a phone can open but a person cannot read
-- out to a taxi driver, and `arrival_notes` is for "the gate is on the main road, past the bakery" —
-- directions once you are close, not where the place is.
alter table clubs add column if not exists address text;
alter table clubs drop constraint if exists clubs_address_len;
alter table clubs add constraint clubs_address_len check (char_length(coalesce(address, '')) <= 200);

-- The three states of a facility are the point of this phase, so they are worth writing down:
--   true   the club says yes
--   false  the club says no
--   null   the club has not answered, which a player must never see as "no"
-- `facilities_confirmed_at` records that someone answered the form at all, so "all seven are null
-- because nobody has filled this in" reads differently from "we went through it and left some blank".
create or replace function set_club_venue(
  p_club uuid, p_description text, p_arrival text, p_address text,
  p_parking boolean, p_changing boolean, p_showers boolean, p_rental boolean,
  p_cafe boolean, p_floodlights boolean, p_water boolean
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_club_editor(p_club);
  update clubs set
    description = nullif(btrim(coalesce(p_description, '')), ''),
    arrival_notes = nullif(btrim(coalesce(p_arrival, '')), ''),
    address = nullif(btrim(coalesce(p_address, '')), ''),
    has_parking = p_parking, has_changing_rooms = p_changing, has_showers = p_showers,
    has_equipment_rental = p_rental, has_cafe = p_cafe, has_floodlights = p_floodlights,
    has_drinking_water = p_water,
    facilities_confirmed_at = now()
  where id = p_club;
end $$;

-- The 10-argument form from 0056 goes, so nothing can call it and silently leave the address behind.
drop function if exists set_club_venue(uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean);
revoke execute on function set_club_venue(uuid, text, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function set_club_venue(uuid, text, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) to authenticated;
