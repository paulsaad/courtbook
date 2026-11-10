-- Phase 6 review (c) P1: browsing is public. Visitors see clubs, towns, sports, prices and which slots are
-- taken; nothing personal. Reserving, joining, messaging and anything with names stays signed-in only.
-- Decision (Paul, 2026-11-10): public discovery, auth at the point of action.

-- Reference and club data readable by visitors
grant select on sports, governorates, districts, towns to anon;
drop policy if exists "sports: read" on sports;              create policy "sports: read" on sports for select using (true);
drop policy if exists "governorates: read" on governorates;  create policy "governorates: read" on governorates for select using (true);
drop policy if exists "districts: read" on districts;        create policy "districts: read" on districts for select using (true);
drop policy if exists "towns: read" on towns;                create policy "towns: read" on towns for select using (true);

-- Taken/free only: no booking ids, no "mine", no status detail. `occupancy` (signed-in) is unchanged.
create or replace view public_occupancy with (security_invoker = false) as
  select club_id, court_id, start_at, end_at, 'booking'::text as kind
  from bookings where status = 'confirmed' or (status = 'pending' and hold_expires_at > now())
  union all
  select club_id, court_id, start_at, end_at, 'block'::text from blocks;
revoke all on public_occupancy from public;
grant select on public_occupancy to anon, authenticated;

-- Discovery RPCs without the signed-in guard
create or replace function next_free_slot(p_club uuid, p_sport sport default null)
returns table (start_at timestamptz, court_id uuid, court_name text)
language plpgsql stable security definer set search_path = public as $$
declare
  c clubs%rowtype; l_now timestamp; day0 timestamp; open_min int; close_min int; m int; t timestamptz; t_end timestamptz; r record;
begin
  select * into c from clubs where id = p_club and active;
  if not found then return; end if;
  l_now := now() at time zone c.timezone;
  day0 := date_trunc('day', l_now);
  open_min := (extract(epoch from c.open_time) / 60)::int;
  close_min := (extract(epoch from c.close_time) / 60)::int;
  m := open_min + (ceil(greatest(0, extract(epoch from (l_now - day0)) / 60 + 5 - open_min) / c.slot_minutes))::int * c.slot_minutes;
  while m + c.min_booking_minutes <= close_min loop
    t := (day0 + make_interval(mins => m)) at time zone c.timezone;
    t_end := t + make_interval(mins => c.min_booking_minutes);
    for r in select k.id, k.name from courts k where k.club_id = p_club and k.active and (p_sport is null or k.sport = p_sport) order by k.sort loop
      if not exists (select 1 from bookings b where b.court_id = r.id and b.start_at < t_end and b.end_at > t
                       and (b.status = 'confirmed' or (b.status = 'pending' and b.hold_expires_at > now())))
         and not exists (select 1 from blocks x where x.court_id = r.id and x.start_at < t_end and x.end_at > t) then
        start_at := t; court_id := r.id; court_name := r.name;
        return next; return;
      end if;
    end loop;
    m := m + c.slot_minutes;
  end loop;
end $$;
revoke execute on function next_free_slot(uuid, sport) from public;
grant execute on function next_free_slot(uuid, sport) to anon, authenticated;

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
  where c.active
    and (p_sport is null or exists (select 1 from courts k where k.club_id = c.id and k.active and k.sport = p_sport))
    and (p_governorate is null or g.code = p_governorate)
    and (p_district is null or d.code = p_district)
    and (q.text is null or c.name ilike '%' || q.text || '%' or t.name_en ilike '%' || q.text || '%' or t.name_ar like '%' || q.text || '%')
  order by (nf.start_at is null), g.sort_order nulls last, d.sort_order nulls last, c.name
  limit 100;
$$;
revoke execute on function club_discovery(sport, text, text, text) from public;
grant execute on function club_discovery(sport, text, text, text) to anon, authenticated;

create or replace function areas() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', g.code, 'name_en', g.name_en, 'name_ar', g.name_ar,
    'districts', (select coalesce(jsonb_agg(jsonb_build_object('code', d.code, 'name_en', d.name_en, 'name_ar', d.name_ar) order by d.sort_order), '[]'::jsonb)
                  from districts d where d.governorate_code = g.code)
  ) order by g.sort_order), '[]'::jsonb)
  from governorates g;
$$;
revoke execute on function areas() from public;
grant execute on function areas() to anon, authenticated;

revoke execute on function club_sports(uuid) from public;
grant execute on function club_sports(uuid) to anon, authenticated;

-- Price quote is public (price rules already are); hold_slot stays signed-in only.
revoke execute on function quote_price(uuid, timestamptz, timestamptz) from public;
grant execute on function quote_price(uuid, timestamptz, timestamptz) to anon, authenticated;
