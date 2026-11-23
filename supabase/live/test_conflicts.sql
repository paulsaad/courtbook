-- READ ONLY. What occupies the slots the staging smoke (S4) and API (B8) tests used before they had their own
-- test courts: Padel 1–3 of the demo club from 3 h ago to 1 h 30 ahead (S4), and Padel 1 three days ahead
-- 15:00–16:00 Beirut (B8). Shows only kind, court, time and booking status/source: no names, phones, ids or notes.
with c as (select k.id, k.name from courts k join clubs b on b.id = k.club_id where b.slug = 'batroun' and k.name in ('Padel 1', 'Padel 2', 'Padel 3')),
w(test, court, r) as (
  select 'S4', c.id, tstzrange(date_bin('30 minutes', now(), '2000-01-01') - interval '180 minutes', date_bin('30 minutes', now(), '2000-01-01') + interval '90 minutes') from c
  union all select 'B8', c.id, tstzrange(((now() + interval '3 days')::date + time '15:00') at time zone 'Asia/Beirut',
                                         ((now() + interval '3 days')::date + time '16:00') at time zone 'Asia/Beirut') from c where c.name = 'Padel 1'
)
select w.test, c.name as court, x.kind,
       to_char(x.start_at at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI') || ' – ' || to_char(x.end_at at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI') as beirut_time,
       x.detail
from w join c on c.id = w.court
join lateral (
  select 'calendar block' as kind, b.start_at, b.end_at, '' as detail from blocks b where b.court_id = w.court and b.period && w.r
  union all
  select 'booking', k.start_at, k.end_at, k.status::text || ' / ' || coalesce(k.source::text, '?') from bookings k
   where k.court_id = w.court and k.status in ('confirmed', 'pending') and tstzrange(k.start_at, k.end_at) && w.r
) x on true
order by w.test, c.name, x.start_at;
