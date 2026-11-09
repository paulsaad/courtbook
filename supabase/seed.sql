-- Demo club for Milestone A (fictional Batroun club, per spec default).
-- Idempotent: safe to run more than once.

insert into clubs (name, slug, location_url, slot_minutes, cancel_cutoff_hours, open_time, close_time, min_booking_minutes, max_booking_minutes)
values ('Batroun Padel & Tennis Club', 'batroun', 'https://maps.google.com/?q=Batroun', 30, 12, '08:00', '23:00', 60, 180)
on conflict (slug) do nothing;

with c as (select id from clubs where slug = 'batroun')
insert into courts (club_id, name, sport, surface, sort)
select c.id, v.name, v.sport::sport, v.surface, v.sort
from c, (values
  ('Padel 1',  'padel',  'artificial grass', 1),
  ('Padel 2',  'padel',  'artificial grass', 2),
  ('Padel 3',  'padel',  'artificial grass', 3),
  ('Tennis 1', 'tennis', 'hard',             4),
  ('Tennis 2', 'tennis', 'clay',             5)
) as v(name, sport, surface, sort)
on conflict (club_id, name) do nothing;

-- Prices per hour: whole-club rules by time band. Off-peak 08:00-17:00, peak 17:00-23:00.
-- (Court-specific overrides go in with court_id set.)
with c as (select id from clubs where slug = 'batroun')
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label)
select c.id, null, 127, v.s::time, v.e::time, v.p, v.l
from c, (values
  ('08:00', '17:00', 20.00, 'off-peak'),
  ('17:00', '23:00', 30.00, 'peak')
) as v(s, e, p, l)
where not exists (select 1 from price_rules pr where pr.club_id = c.id);

insert into credit_packs (name, credits, price_usd, sort)
select * from (values
  ('Starter', 5,  5.00,  1),
  ('Regular', 12, 10.00, 2)
) as v(name, credits, price_usd, sort)
where not exists (select 1 from credit_packs);
