-- What players and visitors see of court availability, as text, for comparing two databases.
-- run_fixes.sh runs this on a 0001–0066 database and on 0001–0071 and requires identical output:
-- R2 must not change anything a player or visitor sees about free and taken times.
-- Fixed ids, courts by name (seeded court ids differ per build), times relative to today; one
-- rolled-back transaction.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.at(d int, t text) returns timestamptz language sql as $f$
  select (current_date + d + t::time) at time zone 'Asia/Beirut' $f$;
grant execute on function pg_temp.at(int, text) to public;
insert into auth.users (id, email) values ('f1000000-0000-4000-8000-0000000000a1', 'snap-p1@fix.test'), ('f1000000-0000-4000-8000-0000000000b1', 'snap-sa@fix.test');
insert into club_staff (club_id, profile_id) select id, 'f1000000-0000-4000-8000-0000000000b1' from clubs where slug = 'batroun';
-- a block, a desk booking, a player's own confirmed booking and a live hold, over three days
insert into blocks (id, club_id, court_id, start_at, end_at, reason, created_by)
  select 'f1000000-0000-4000-8000-0000000b10c1', club_id, id, pg_temp.at(3, '10:00'), pg_temp.at(3, '12:00'), 'Maintenance', 'f1000000-0000-4000-8000-0000000000b1'
  from courts where name = 'Padel 3';
insert into blocks (id, club_id, court_id, start_at, end_at, reason, created_by)
  select 'f1000000-0000-4000-8000-0000000b10c2', club_id, id, pg_temp.at(1, '17:00'), pg_temp.at(1, '19:00'), 'Event', 'f1000000-0000-4000-8000-0000000000b1'
  from courts where name = 'Tennis 1';
insert into bookings (id, club_id, court_id, guest_name, start_at, end_at, status, source, created_by, price_usd, fee_usd)
  select 'f1000000-0000-4000-8000-0000000bb001', club_id, id, 'Walk-in', pg_temp.at(3, '18:00'), pg_temp.at(3, '19:00'), 'confirmed', 'staff', 'f1000000-0000-4000-8000-0000000000b1', 30, 0
  from courts where name = 'Padel 1';
insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd, fee_usd)
  select 'f1000000-0000-4000-8000-0000000bb002', club_id, id, 'f1000000-0000-4000-8000-0000000000a1', pg_temp.at(2, '09:00'), pg_temp.at(2, '10:30'), 'confirmed', 'app', 'f1000000-0000-4000-8000-0000000000a1', 30, 1
  from courts where name = 'Padel 2';
insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd, fee_usd, hold_expires_at)
  select 'f1000000-0000-4000-8000-0000000bb003', club_id, id, 'f1000000-0000-4000-8000-0000000000a1', pg_temp.at(3, '20:00'), pg_temp.at(3, '21:00'), 'pending', 'app', 'f1000000-0000-4000-8000-0000000000a1', 30, 1, now() + interval '10 minutes'
  from courts where name = 'Padel 2';

\echo '--- visitor: public_occupancy'
set role anon;
select (select name from courts k where k.id = court_id) court, start_at, end_at, kind from public_occupancy where start_at >= current_date order by 2, 1, 4;
\echo '--- visitor: club_day_slots, days 1-3'
select d, court_name, start_at, free_minutes from generate_series(1, 3) d, club_day_slots(current_date + d) s order by 1, 2, 3;
\echo '--- visitor: next_free_slot per sport'
select 'padel', start_at, court_name from next_free_slot((select id from clubs where slug = 'batroun'), 'padel');
select 'tennis', start_at, court_name from next_free_slot((select id from clubs where slug = 'batroun'), 'tennis');
\echo '--- visitor: club_discovery'
select name, slug, sports, price_from, next_free_at, next_free_court, is_demo from club_discovery() order by slug;
reset role;
\echo '--- player: occupancy (signed-in grid)'
set role authenticated; select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-0000000000a1', false) \g /dev/null
select id, (select name from courts k where k.id = court_id) court, start_at, end_at, status, mine, kind from occupancy where start_at >= current_date order by 3, 2, 7;
\echo '--- player: club_day_slots day 3, padel'
select court_name, start_at, free_minutes from club_day_slots(current_date + 3, 'padel') order by 1, 2;
\echo '--- staff: club_courts_free_now and own blocks'
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-0000000000b1', false) \g /dev/null
select court_name, sport, busy, free_at from club_courts_free_now((select id from clubs where slug = 'batroun')) order by 1;
select id, (select name from courts k where k.id = court_id) court, start_at, end_at, reason from blocks order by 3;
reset role;
rollback;
