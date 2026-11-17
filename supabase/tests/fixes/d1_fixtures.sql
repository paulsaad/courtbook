-- D1 data test, part 1 of 2: existing data as it could be on staging or live BEFORE 0070.
-- run_fixes.sh applies this to a 0001–0069 database (committed), then applies 0070, then d1_checks.sql.
--   realsim  — a real club still on the old default (simulated): one live hold, one confirmed paid booking
--   realdesk — a real club already at the desk, with a confirmed desk booking
--   batroun  — the demo club (simulated): one live hold
\set ON_ERROR_STOP 1
create table public.d1_fixture (k text primary key, booking_id uuid, payment_id uuid);
insert into auth.users (id, email) values
  ('f2000000-0000-4000-8000-0000000000a1', 'd1-p1@fix.test'), ('f2000000-0000-4000-8000-0000000000a2', 'd1-p2@fix.test'),
  ('f2000000-0000-4000-8000-0000000000a3', 'd1-p3@fix.test');
insert into clubs (name, slug) values ('Real Club Left Simulated', 'realsim');
insert into clubs (name, slug, payment_mode) values ('Real Desk Club', 'realdesk', 'at_desk');
insert into courts (club_id, name, sport) select id, 'RS 1', 'padel' from clubs where slug = 'realsim';
insert into courts (club_id, name, sport) select id, 'RD 1', 'padel' from clubs where slug = 'realdesk';
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label)
  select id, null, 127, '08:00', '23:00', 20, 'all day' from clubs where slug in ('realsim', 'realdesk');

set role authenticated;
-- P1: live hold at realsim
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-0000000000a1', false) \g /dev/null
select booking_id as b, payment_id as p from hold_slot((select id from clubs where slug = 'realsim'), (select id from courts where name = 'RS 1'),
  (current_date + 2 + time '10:00') at time zone 'Asia/Beirut', (current_date + 2 + time '11:00') at time zone 'Asia/Beirut', gen_random_uuid()) \gset h1_
-- P2: hold at realsim, then paid (below, as the server)
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-0000000000a2', false) \g /dev/null
select booking_id as b, payment_id as p, total_usd as t from hold_slot((select id from clubs where slug = 'realsim'), (select id from courts where name = 'RS 1'),
  (current_date + 2 + time '12:00') at time zone 'Asia/Beirut', (current_date + 2 + time '13:00') at time zone 'Asia/Beirut', gen_random_uuid()) \gset h2_
-- P3: live hold at the demo club; P1: desk booking at realdesk
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-0000000000a3', false) \g /dev/null
select booking_id as b, payment_id as p from hold_slot((select id from clubs where slug = 'batroun'), (select id from courts where name = 'Padel 1'),
  (current_date + 2 + time '10:00') at time zone 'Asia/Beirut', (current_date + 2 + time '11:00') at time zone 'Asia/Beirut', gen_random_uuid()) \gset h3_
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-0000000000a1', false) \g /dev/null
select booking_id as b from book_at_desk((select id from courts where name = 'RD 1'),
  (current_date + 2 + time '10:00') at time zone 'Asia/Beirut', (current_date + 2 + time '11:00') at time zone 'Asia/Beirut', gen_random_uuid()) \gset d1_
reset role;
select confirm_payment(:'h2_p', 'sim-d1-test', :'h2_t') \g /dev/null
insert into d1_fixture values ('realsim_hold', :'h1_b', :'h1_p'), ('realsim_paid', :'h2_b', :'h2_p'), ('demo_hold', :'h3_b', :'h3_p'), ('realdesk_booking', :'d1_b', null);
select k, b.status, p.status from d1_fixture f join bookings b on b.id = f.booking_id left join payments p on p.id = f.payment_id order by k;
