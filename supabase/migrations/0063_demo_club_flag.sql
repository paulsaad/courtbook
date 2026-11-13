-- The fictional club has to be labelled as fictional everywhere it appears, and the label cannot
-- live inside the cover image.
--
-- It did, and I claimed it was legible in a listing. It is not: the badge is 15.5px tall in a
-- 1600px-wide picture, and a listing shows that picture about 344px wide, which leaves the words
-- 3.3px high — a white smudge. Text drawn into an image does not survive the resize that a thumbnail
-- is. The badge stays, because it is right at full size and travels with the file if it is reused,
-- but what a player actually reads has to come from the database.
--
-- Also the honest reason this needs a column rather than a check on the slug: when a real club signs
-- up it must be impossible for it to inherit the label by accident, and when the demo club is shown
-- to that real club it must be impossible for the label to go missing.
alter table clubs add column if not exists is_demo boolean not null default false;
comment on column clubs.is_demo is
  'This club does not exist. Every surface that shows it must say so — listing, club page, info tab.';

-- The two seeded clubs are the fictional ones.
update clubs set is_demo = true where slug in ('batroun', 'other');

-- Discovery carries it, so a listing never has to guess from the name or the slug.
--
-- Rebuilt from 0032, which is the live definition — not from 0030, where the function was first
-- written. My first attempt at this migration copied 0030 and would have silently undone two later
-- changes: public browsing (0032 dropped the `auth.uid() is not null` requirement) and
-- `next_free_court_id` (0031), which the listing uses to link straight to the free slot. The test
-- suite caught it. **When replacing a function, start from what the database currently has
-- (`pg_get_functiondef`), not from the first migration that mentions it.**
drop function if exists club_discovery(sport, text, text, text);
create or replace function club_discovery(p_sport sport default null, p_governorate text default null, p_district text default null, p_query text default null)
returns table (
  club_id uuid, name text, slug text, town text, district text, governorate text, district_code text, governorate_code text,
  sports sport[], price_from numeric, next_free_at timestamptz, next_free_court text, next_free_court_id uuid, cover_url text, location_url text,
  open_time time, close_time time, is_demo boolean
)
language sql stable security definer set search_path = public as $$
  with q as (select nullif(trim(p_query), '') as text)
  select c.id, c.name, c.slug, t.name_en, d.name_en, g.name_en, d.code, g.code,
         club_sports(c.id),
         (select min(pr.price_usd) from price_rules pr
           where pr.club_id = c.id
             and (pr.court_id is null or exists (select 1 from courts k where k.id = pr.court_id and k.active and (p_sport is null or k.sport = p_sport)))),
         nf.start_at, nf.court_name, nf.court_id, c.cover_url, c.location_url, c.open_time, c.close_time, c.is_demo
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
