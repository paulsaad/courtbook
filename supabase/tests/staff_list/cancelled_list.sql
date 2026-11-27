-- F3: what the staff List view's cancelled read returns, run exactly as the website sends it (PostgREST → the same
-- filters under the caller's row-level security). No migration: RLS "bookings: read" (0001) already scopes it.
-- One transaction, rolled back. Fictional people (f7…). Run on courtbook_test (supabase/tests/run.sh builds it):
--   sudo -u postgres psql -d courtbook_test -X -q -At -f supabase/tests/staff_list/cancelled_list.sql
\set ON_ERROR_STOP 1
begin;
\ir helpers.sql
create temp table t (id text, pass boolean, detail text);
create temp table kept (k text primary key, v text);
grant all on t, kept to authenticated, service_role;
create function pg_temp.keep(k text, v text) returns void language sql as $$ insert into kept values (k, v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.got(k text) returns text language sql as $$ select v from kept where kept.k = got.k $$;

-- people: Rana (player), Maya (Batroun staff), Omar (staff of another club only), Lea (another player)
insert into auth.users (id, phone) select pg_temp.u(n), '+9617071000' || n from generate_series(1, 5) n on conflict do nothing;
update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app',
  name = case id when pg_temp.u(1) then 'Rana Khoury' when pg_temp.u(2) then 'Maya Desk' when pg_temp.u(4) then 'Omar Other' else 'Lea Player' end
  where id in (pg_temp.u(1), pg_temp.u(2), pg_temp.u(4), pg_temp.u(5));
update clubs set payment_mode = 'at_desk' where slug = 'batroun';
insert into club_staff (club_id, profile_id) values (pg_temp.club(), pg_temp.u(2)) on conflict do nothing;
insert into clubs (name, slug, payment_mode) values ('Zz Other Club F3', 'zz-other-f3', 'at_desk') on conflict (slug) do nothing;
insert into courts (club_id, name, sport) select id, 'Other F3', 'padel' from clubs where slug = 'zz-other-f3' on conflict do nothing;
insert into club_staff (club_id, profile_id) select id, pg_temp.u(4) from clubs where slug = 'zz-other-f3' on conflict do nothing;
insert into courts (club_id, name, sport, sort) values (pg_temp.club(), 'zz F3 A', 'padel', 950), (pg_temp.club(), 'zz F3 B', 'padel', 951) on conflict do nothing;
create function pg_temp.other() returns uuid language sql as $$ select id from clubs where slug = 'zz-other-f3' $$;

-- (own courts, so the shared test database's other bookings never collide)
-- Rana books zz F3 A, day+5 18:00 and cancels it; Maya's walk-in at 10:00 is cancelled by Maya; one booking at the other club, cancelled
select pg_temp.keep('rana', pg_temp.r(pg_temp.u(1), format('select booking_id::text from book_at_desk(%L,%L,%L,%L)', pg_temp.c('zz F3 A'), pg_temp.at(5,'18:00'), pg_temp.at(5,'19:00'), gen_random_uuid())));
select pg_temp.keep('rana_c', pg_temp.r(pg_temp.u(1), format('select cancel_booking(%L)::text', pg_temp.got('rana'))));
select pg_temp.keep('walk', pg_temp.r(pg_temp.u(2), format('select staff_book(%L,%L,%L,%L,''Sami Walk In'',''+961 3 111 111'')::text', pg_temp.club(), pg_temp.c('zz F3 B'), pg_temp.at(5,'10:00'), pg_temp.at(5,'11:00'))));
select pg_temp.keep('walk_c', pg_temp.r(pg_temp.u(2), format('select cancel_booking(%L)::text', pg_temp.got('walk'))));
insert into bookings (club_id, court_id, guest_name, guest_phone, start_at, end_at, status, source, cancelled_at, price_usd)
  select pg_temp.other(), (select id from courts where club_id = pg_temp.other()), 'Other Guest', '+961 3 222 222', pg_temp.at(5,'12:00'), pg_temp.at(5,'13:00'), 'cancelled', 'staff', now(), 20;
insert into t select 'L0 fixtures: two Batroun bookings cancelled, one at the other club',
  pg_temp.got('rana_c') = 'ok' and pg_temp.got('walk_c') = 'ok', pg_temp.got('rana') || ' ' || pg_temp.got('rana_c') || ' ' || pg_temp.got('walk_c');

-- the List view's read (DayCalendar loadCancelled): these columns, this club, status cancelled, that day
create function pg_temp.list(who int, club uuid) returns text language sql as $$
  select pg_temp.r(pg_temp.u(who), format($q$select coalesce(string_agg(coalesce(guest_name, '(app)') || ' ' || to_char(start_at at time zone 'Asia/Beirut', 'HH24:MI'), ', ' order by start_at), '-')
    from (select id, court_id, guest_name, start_at, end_at, cancelled_at from bookings
          where club_id = %L and status = 'cancelled' and court_id is not null and start_at < %L and end_at > %L) x$q$,
    club, pg_temp.at(6, '00:00'), pg_temp.at(5, '00:00'))) $$;

insert into t select 'L1 Batroun staff: the day''s two cancelled bookings, at their original times',
  pg_temp.list(2, pg_temp.club()) = 'Sami Walk In 10:00, (app) 18:00', pg_temp.list(2, pg_temp.club());
insert into t select 'L2 staff of another club asking for Batroun''s: nothing',
  pg_temp.list(4, pg_temp.club()) = '-', pg_temp.list(4, pg_temp.club());
insert into t select 'L3 Batroun staff asking for the other club''s: nothing',
  pg_temp.list(2, pg_temp.other()) = '-', pg_temp.list(2, pg_temp.other());
insert into t select 'L4 a player: only their own (Rana) or nothing (Lea); signed out: nothing',
  pg_temp.list(1, pg_temp.club()) = '(app) 18:00' and pg_temp.list(5, pg_temp.club()) = '-'
  and pg_temp.r(null, format('select count(*)::text from bookings where club_id = %L and status = ''cancelled''', pg_temp.club())) in ('0', 'ERR permission denied for table bookings'),
  pg_temp.list(1, pg_temp.club()) || ' / ' || pg_temp.list(5, pg_temp.club());

-- names: club_booking_contacts, as the calendar already calls it (the website drops the phone for cancelled rows)
insert into t select 'L5 names: Batroun staff get Rana''s name for her cancelled booking; another club''s staff are refused',
  pg_temp.r(pg_temp.u(2), format('select name from club_booking_contacts(%L, array[%L]::uuid[])', pg_temp.club(), pg_temp.got('rana'))) = 'Rana Khoury'
  and pg_temp.r(pg_temp.u(4), format('select name from club_booking_contacts(%L, array[%L]::uuid[])', pg_temp.club(), pg_temp.got('rana'))) = 'ERR forbidden'
  and pg_temp.r(pg_temp.u(4), format('select coalesce(max(name), ''-'') from club_booking_contacts(%L, array[%L]::uuid[])', pg_temp.other(), pg_temp.got('rana'))) = '-',
  pg_temp.r(pg_temp.u(4), format('select name from club_booking_contacts(%L, array[%L]::uuid[])', pg_temp.club(), pg_temp.got('rana')));

-- the grid and availability do not see them: the slots are free again
insert into t select 'L6 the cancelled times are free: Batroun staff can book that court at 18:00 again',
  pg_temp.r(pg_temp.u(2), format('select staff_book(%L,%L,%L,%L,''New Walk In'')::text', pg_temp.club(), pg_temp.c('zz F3 A'), pg_temp.at(5,'18:00'), pg_temp.at(5,'19:00'))) ~ '^[0-9a-f-]{36}$', null;

select case when pass then 'ok    ' else 'FAIL  ' end || id || case when pass then '' else '  [' || coalesce(detail, 'null') || ']' end from t order by id;
select 'checks: ' || count(*) || ', failures: ' || count(*) filter (where not pass) from t;
rollback;
