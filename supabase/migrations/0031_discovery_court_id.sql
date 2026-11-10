-- Phase 6 (c): club_discovery also returns the court id of the next free slot so Home can preselect it.
drop function if exists club_discovery(sport, text, text, text);
create or replace function club_discovery(p_sport sport default null, p_governorate text default null, p_district text default null, p_query text default null)
returns table (
  club_id uuid, name text, slug text, town text, district text, governorate text, district_code text, governorate_code text,
  sports sport[], price_from numeric, next_free_at timestamptz, next_free_court text, next_free_court_id uuid, cover_url text, location_url text,
  open_time time, close_time time
)
language sql stable security definer set search_path = public as $$
  with q as (select nullif(trim(p_query), '') as text)
  select c.id, c.name, c.slug, t.name_en, d.name_en, g.name_en, d.code, g.code,
         club_sports(c.id),
         (select min(pr.price_usd) from price_rules pr
           where pr.club_id = c.id
             and (pr.court_id is null or exists (select 1 from courts k where k.id = pr.court_id and k.active and (p_sport is null or k.sport = p_sport)))),
         nf.start_at, nf.court_name, nf.court_id, c.cover_url, c.location_url, c.open_time, c.close_time
  from clubs c
  left join towns t on t.id = c.town_id
  left join districts d on d.code = t.district_code
  left join governorates g on g.code = d.governorate_code
  left join lateral next_free_slot(c.id, p_sport) nf on true
  cross join q
  where auth.uid() is not null and c.active
    and (p_sport is null or exists (select 1 from courts k where k.club_id = c.id and k.active and k.sport = p_sport))
    and (p_governorate is null or g.code = p_governorate)
    and (p_district is null or d.code = p_district)
    and (q.text is null or c.name ilike '%' || q.text || '%' or t.name_en ilike '%' || q.text || '%' or t.name_ar like '%' || q.text || '%')
  order by (nf.start_at is null), g.sort_order nulls last, d.sort_order nulls last, c.name
  limit 100;
$$;
revoke execute on function club_discovery(sport, text, text, text) from public, anon;
grant execute on function club_discovery(sport, text, text, text) to authenticated;
