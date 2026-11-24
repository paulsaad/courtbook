-- Club coordinates audit — READ ONLY (select statements only; changes nothing).
-- Lists every active club whose coordinates can't be trusted for "nearest first".
-- Run on the local replica freely; on staging or live only with Paul's approval, read-only.
--   psql -d <db> -X -f supabase/tests/favourites/club_coordinates_audit.sql
--
-- Issues:
--   missing            no lat/lng → the club can't be placed by distance (listed after the rest)
--   half               only one of lat/lng
--   outside_lebanon    inside the table's loose check (lat 33–35, lng 35–37) but outside Lebanon's
--                      own extent (about lat 33.05–34.70, lng 35.10–36.63): sea, Syria, or a typo
--   probably_in_sea    west of a straight-line approximation of the coast (Tyre 33.27N 35.19E to
--                      Akkar 34.63N 35.97E) by more than 0.12° — a heuristic: check, don't trust
--   shared_point       another active club has exactly the same point (copy-paste)
--   map_link_differs   the map link carries coordinates more than 1 km away from lat/lng
--   map_link_only      lat/lng missing but the map link carries coordinates (an easy fix to propose)
--   no_town            no town: invisible to the governorate/district filter as well
with c as (
  select id, slug, name, is_demo, lat::float8 as lat, lng::float8 as lng, location_url, town_id,
         -- coordinates inside a Google Maps link: "@34.2553,35.6586", "q=34.2553,35.6586", "!3d34.2553!4d35.6586"
         coalesce(
           substring(location_url from '@(-?\d+\.\d+),-?\d+\.\d+'),
           substring(location_url from '[?&](?:q|query|ll)=(-?\d+\.\d+),-?\d+\.\d+'),
           substring(location_url from '!3d(-?\d+\.\d+)'))::float8 as url_lat,
         coalesce(
           substring(location_url from '@-?\d+\.\d+,(-?\d+\.\d+)'),
           substring(location_url from '[?&](?:q|query|ll)=-?\d+\.\d+,(-?\d+\.\d+)'),
           substring(location_url from '!4d(-?\d+\.\d+)'))::float8 as url_lng
  from clubs where active
),
issues as (
  select slug, name, is_demo, lat, lng, 'missing' as issue from c where lat is null and lng is null
  union all select slug, name, is_demo, lat, lng, 'half' from c where (lat is null) <> (lng is null)
  union all select slug, name, is_demo, lat, lng, 'outside_lebanon' from c
    where lat is not null and lng is not null and not (lat between 33.05 and 34.70 and lng between 35.10 and 36.63)
  union all select slug, name, is_demo, lat, lng, 'probably_in_sea' from c
    where lat is not null and lng is not null and lng < 35.19 + (lat - 33.27) * 0.5735 - 0.12
  union all select a.slug, a.name, a.is_demo, a.lat, a.lng, 'shared_point' from c a
    where a.lat is not null and exists (select 1 from c b where b.id <> a.id and b.lat = a.lat and b.lng = a.lng)
  union all select slug, name, is_demo, lat, lng, 'map_link_differs' from c
    where lat is not null and lng is not null and url_lat is not null and url_lng is not null
      and 2 * 6371 * asin(sqrt(power(sin(radians(url_lat - lat) / 2), 2)
            + cos(radians(lat)) * cos(radians(url_lat)) * power(sin(radians(url_lng - lng) / 2), 2))) > 1
  union all select slug, name, is_demo, lat, lng, 'map_link_only' from c
    where lat is null and url_lat is not null and url_lng is not null
  union all select slug, name, is_demo, lat, lng, 'no_town' from c where town_id is null
)
select slug, name, case when is_demo then 'demo' else 'real' end as kind, lat, lng, string_agg(issue, ', ' order by issue) as issues
from issues group by slug, name, is_demo, lat, lng order by kind desc, slug;

select count(*) as active_clubs,
       count(*) filter (where lat is not null and lng is not null) as with_coordinates,
       count(*) filter (where is_demo) as demo
from clubs where active;
