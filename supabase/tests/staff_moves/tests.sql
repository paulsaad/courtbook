-- F1 after 0099_staff_moves_check_what_desk_saw.sql: a staff move applies only if the booking is still where the desk saw it.
-- Deterministic checks (the race harness is race.mjs). Rolled back. Fictional people.
\set ON_ERROR_STOP 1
begin;
\ir helpers.sql
create temp table t (id text, pass boolean, detail text);
create temp table kept (k text primary key, v text);
grant all on t, kept to authenticated, service_role;
create function pg_temp.keep(k text, v text) returns void language sql as $$ insert into kept values (k, v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.got(k text) returns text language sql as $$ select v from kept where kept.k = got.k $$;

-- Rana books Padel 2, day+3 18:00–19:00 (pay at the desk). Both desks open it there.
select pg_temp.keep('b', pg_temp.r(pg_temp.u(1), format('select booking_id::text from book_at_desk(%L,%L,%L,%L)',
  pg_temp.c('Padel 2'), pg_temp.at(3,'18:00'), pg_temp.at(3,'19:00'), gen_random_uuid())));
create function pg_temp.b() returns uuid language sql as $$ select pg_temp.got('b')::uuid $$;
insert into t select 'M0 fixture: Rana''s booking is on Padel 2 18:00-19:00', pg_temp.pos(pg_temp.b()) = 'Padel 2 18:00-19:00 confirmed', pg_temp.got('b');

-- Reproduction 1: Dina moves it to Padel 1 (she saw Padel 2); Maya, still seeing Padel 2, moves it to Padel 3
select pg_temp.keep('m1', pg_temp.mv(3, pg_temp.b(), 'Padel 1', 3, '18:00', '19:00', 30, 'Padel 2', 3, '18:00', '19:00'));
insert into t select 'M1 a move from what the desk saw (the current position) is applied',
  pg_temp.got('m1') like '{%' and pg_temp.pos(pg_temp.b()) = 'Padel 1 18:00-19:00 confirmed', pg_temp.got('m1') || ' / ' || pg_temp.pos(pg_temp.b());
select pg_temp.keep('m2', pg_temp.mv(2, pg_temp.b(), 'Padel 3', 3, '18:00', '19:00', 30, 'Padel 2', 3, '18:00', '19:00'));
insert into t select 'M2 a move from an out-of-date court (Maya still saw Padel 2) is refused; the booking stays on Padel 1',
  pg_temp.got('m2') = 'ERR booking_changed_elsewhere' and pg_temp.pos(pg_temp.b()) = 'Padel 1 18:00-19:00 confirmed', pg_temp.got('m2') || ' / ' || pg_temp.pos(pg_temp.b());

-- the same, for the time and for the length only
select pg_temp.keep('m3a', pg_temp.mv(3, pg_temp.b(), 'Padel 1', 3, '19:00', '20:00', 30, 'Padel 1', 3, '18:00', '19:00'));   -- Dina: to 19:00
select pg_temp.keep('m3b', pg_temp.mv(2, pg_temp.b(), 'Padel 3', 3, '18:00', '19:00', 30, 'Padel 1', 3, '18:00', '19:00'));   -- Maya saw 18:00
insert into t select 'M3 out-of-date start time: refused; the booking stays at 19:00',
  pg_temp.got('m3a') like '{%' and pg_temp.got('m3b') = 'ERR booking_changed_elsewhere' and pg_temp.pos(pg_temp.b()) = 'Padel 1 19:00-20:00 confirmed',
  pg_temp.got('m3a') || ' / ' || pg_temp.got('m3b') || ' / ' || pg_temp.pos(pg_temp.b());
select pg_temp.keep('m4a', pg_temp.mv(3, pg_temp.b(), 'Padel 1', 3, '19:00', '20:30', 45, 'Padel 1', 3, '19:00', '20:00'));   -- Dina: 1 h 30
select pg_temp.keep('m4b', pg_temp.mv(2, pg_temp.b(), 'Padel 1', 3, '21:00', '22:00', 30, 'Padel 1', 3, '19:00', '20:00'));   -- Maya saw 1 h
insert into t select 'M4 out-of-date length (same court and start): refused; the 1 h 30 stays',
  pg_temp.got('m4a') like '{%' and pg_temp.got('m4b') = 'ERR booking_changed_elsewhere' and pg_temp.pos(pg_temp.b()) = 'Padel 1 19:00-20:30 confirmed',
  pg_temp.got('m4a') || ' / ' || pg_temp.got('m4b') || ' / ' || pg_temp.pos(pg_temp.b());

-- nothing seen (null) never matches
select pg_temp.keep('m5', pg_temp.r(pg_temp.u(2), format('select move_booking_priced(%L,%L,%L,%L,45,null,null,null)::text',
  pg_temp.b(), pg_temp.c('Padel 2'), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'))));
select pg_temp.keep('m5c', pg_temp.r(pg_temp.u(2), format('select move_booking_priced(%L,%L,%L,%L,45,%L,%L,null)::text',
  pg_temp.b(), pg_temp.c('Padel 2'), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'), pg_temp.c('Padel 1'), pg_temp.at(3,'19:00'))));
-- each seen value missing on its own, the other two right (R101-1: a "<>" on any line would let that null through)
select pg_temp.keep('m5a', pg_temp.r(pg_temp.u(2), format('select move_booking_priced(%L,%L,%L,%L,45,null,%L,%L)::text',
  pg_temp.b(), pg_temp.c('Padel 2'), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'))));
select pg_temp.keep('m5b', pg_temp.r(pg_temp.u(2), format('select move_booking_priced(%L,%L,%L,%L,45,%L,null,%L)::text',
  pg_temp.b(), pg_temp.c('Padel 2'), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'), pg_temp.c('Padel 1'), pg_temp.at(3,'20:30'))));
insert into t select 'M5 a missing seen value is refused: all three, only the court, only the start, only the end',
  pg_temp.got('m5') = 'ERR booking_changed_elsewhere' and pg_temp.got('m5a') = 'ERR booking_changed_elsewhere'
  and pg_temp.got('m5b') = 'ERR booking_changed_elsewhere' and pg_temp.got('m5c') = 'ERR booking_changed_elsewhere'
  and pg_temp.pos(pg_temp.b()) = 'Padel 1 19:00-20:30 confirmed',
  pg_temp.got('m5') || ' / ' || pg_temp.got('m5a') || ' / ' || pg_temp.got('m5b') || ' / ' || pg_temp.got('m5c');

-- the calls without what the desk saw are refused, for staff and players alike
select pg_temp.keep('m6a', pg_temp.r(pg_temp.u(2), format('select move_booking_priced(%L,%L,%L,%L,45)::text', pg_temp.b(), pg_temp.c('Padel 3'), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'))));
select pg_temp.keep('m6b', pg_temp.r(pg_temp.u(2), format('select move_booking(%L,%L,%L,%L)::text', pg_temp.b(), pg_temp.c('Padel 3'), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'))));
select pg_temp.keep('m6c', pg_temp.r(pg_temp.u(4), format('select move_booking(%L,%L,%L,%L)::text', pg_temp.b(), pg_temp.c('Padel 3'), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'))));
insert into t select 'M6 the 0091 calls (5-argument move_booking_priced, move_booking) refuse every move: move_needs_reload; nothing moves',
  pg_temp.got('m6a') = 'ERR move_needs_reload' and pg_temp.got('m6b') = 'ERR move_needs_reload' and pg_temp.got('m6c') = 'ERR move_needs_reload'
  and pg_temp.pos(pg_temp.b()) = 'Padel 1 19:00-20:30 confirmed', pg_temp.got('m6a') || ' / ' || pg_temp.got('m6b') || ' / ' || pg_temp.got('m6c');

-- cross-club and non-staff: refused before the comparison, so they learn nothing about where the booking is
select pg_temp.keep('m7a', pg_temp.mv(4, pg_temp.b(), 'Padel 3', 3, '19:00', '20:30', 45, 'Padel 1', 3, '19:00', '20:30'));   -- right position
select pg_temp.keep('m7b', pg_temp.mv(4, pg_temp.b(), 'Padel 3', 3, '19:00', '20:30', 45, 'Padel 2', 3, '18:00', '19:00'));   -- wrong position
select pg_temp.keep('m7c', pg_temp.mv(1, pg_temp.b(), 'Padel 3', 3, '19:00', '20:30', 45, 'Padel 1', 3, '19:00', '20:30'));   -- Rana herself
select pg_temp.keep('m7d', pg_temp.r(null, format('select move_booking_priced(%L,%L,%L,%L,45,%L,%L,%L)::text', pg_temp.b(), pg_temp.c('Padel 3'),
  pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'), pg_temp.c('Padel 1'), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'))));
insert into t select 'M7 staff of another club: forbidden whether its seen values are right or wrong; the player: forbidden; signed out: refused',
  pg_temp.got('m7a') = 'ERR forbidden' and pg_temp.got('m7b') = 'ERR forbidden' and pg_temp.got('m7c') = 'ERR forbidden'
  and pg_temp.got('m7d') like 'ERR %' and pg_temp.got('m7d') <> 'ERR booking_changed_elsewhere'
  and pg_temp.pos(pg_temp.b()) = 'Padel 1 19:00-20:30 confirmed',
  pg_temp.got('m7a') || ' / ' || pg_temp.got('m7b') || ' / ' || pg_temp.got('m7c') || ' / ' || pg_temp.got('m7d');
-- …and another club's staff cannot even call it on a booking of their own club with Batroun's court
select pg_temp.keep('m7e', pg_temp.r(pg_temp.u(2), format('select move_booking_priced(%L,(select id from courts where name = ''Other 1''),%L,%L,45,%L,%L,%L)::text',
  pg_temp.b(), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'), pg_temp.c('Padel 1'), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:30'))));
insert into t select 'M7e a Batroun desk cannot move a booking onto another club''s court (court_not_found)', pg_temp.got('m7e') = 'ERR court_not_found', pg_temp.got('m7e');

-- direct writes stay impossible: no update policy on bookings for signed-in users
select pg_temp.keep('m8', pg_temp.r(pg_temp.u(2), format('update bookings set court_id = %L, start_at = %L, end_at = %L where id = %L',
  pg_temp.c('Padel 3'), pg_temp.at(3,'08:00'), pg_temp.at(3,'09:30'), pg_temp.b())));
insert into t select 'M8 a desk''s direct UPDATE of the booking changes nothing (row-level security: no update policy)',
  pg_temp.got('m8') in ('ok', 'ERR permission denied for table bookings') and pg_temp.pos(pg_temp.b()) = 'Padel 1 19:00-20:30 confirmed',
  pg_temp.got('m8') || ' / ' || pg_temp.pos(pg_temp.b());

-- the other rules still apply with a fresh view (they come after the comparison)
-- the walk-in's id, or null if creating it was refused: M9e then fails by name instead of the file stopping
create function pg_temp.wid() returns uuid language sql as $$ select case when pg_temp.got('w') ~ '^[0-9a-f-]{36}$' then pg_temp.got('w')::uuid end $$;
select pg_temp.keep('w', pg_temp.r(pg_temp.u(2), format('select staff_book(%L,%L,%L,%L,''Walk-in Sami'')::text', pg_temp.club(), pg_temp.c('Padel 3'), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:00'))));
select pg_temp.keep('m9a', pg_temp.mv(2, pg_temp.b(), 'Padel 3', 3, '19:00', '20:30', 45, 'Padel 1', 3, '19:00', '20:30'));   -- onto Sami
select pg_temp.keep('m9b', pg_temp.mv(2, pg_temp.b(), 'Padel 2', 3, '19:00', '20:00', 99, 'Padel 1', 3, '19:00', '20:30'));   -- wrong price
select pg_temp.keep('m9c', pg_temp.mv(2, pg_temp.b(), 'Padel 2', 3, '19:00', '19:30', 15, 'Padel 1', 3, '19:00', '20:30'));   -- 30 min
select pg_temp.keep('m9d', pg_temp.mv(2, pg_temp.b(), 'Padel 2', -1, '19:00', '20:30', 45, 'Padel 1', 3, '19:00', '20:30')); -- the past
insert into t select 'M9 with a fresh view the other rules still refuse: slot_taken, price_changed, bad_duration, move_into_past',
  pg_temp.got('m9a') = 'ERR slot_taken' and pg_temp.got('m9b') = 'ERR price_changed' and pg_temp.got('m9c') = 'ERR bad_duration' and pg_temp.got('m9d') = 'ERR move_into_past'
  and pg_temp.pos(pg_temp.b()) = 'Padel 1 19:00-20:30 confirmed',
  pg_temp.got('m9a') || ' / ' || pg_temp.got('m9b') || ' / ' || pg_temp.got('m9c') || ' / ' || pg_temp.got('m9d');
select pg_temp.keep('m9e', pg_temp.mv(2, pg_temp.wid(), 'Padel 2', 3, '20:00', '21:30', 45, 'Padel 3', 3, '19:00', '20:00'));  -- walk-in: new length, new price
insert into t select 'M9e a walk-in moved with what the desk saw and the confirmed new price: applied, priced',
  pg_temp.got('m9e') like '%"price": 45%' and pg_temp.pos(pg_temp.wid()) = 'Padel 2 20:00-21:30 confirmed', pg_temp.got('m9e');

-- ABA: moved away and back by others; this desk's view is current again, so its move applies (documented)
select pg_temp.keep('m10a', pg_temp.mv(3, pg_temp.b(), 'Padel 3', 3, '19:00', '20:30', 45, 'Padel 1', 3, '19:00', '20:30'));
select pg_temp.keep('m10b', pg_temp.mv(3, pg_temp.b(), 'Padel 1', 3, '19:00', '20:30', 45, 'Padel 3', 3, '19:00', '20:30'));
select pg_temp.keep('m10', pg_temp.mv(2, pg_temp.b(), 'Padel 3', 3, '17:00', '18:30', 45, 'Padel 1', 3, '19:00', '20:30'));
insert into t select 'M10 moved away and back by another desk: the booking is where this desk saw it, so its move applies',
  pg_temp.got('m10a') like '{%' and pg_temp.got('m10b') like '{%' and pg_temp.got('m10') like '{%' and pg_temp.pos(pg_temp.b()) = 'Padel 3 17:00-18:30 confirmed', pg_temp.got('m10');

-- move versus cancel, one after the other (the race is in race.mjs)
select pg_temp.keep('m11c', pg_temp.r(pg_temp.u(1), format('select cancel_booking(%L)::text', pg_temp.b())));
select pg_temp.keep('m11m', pg_temp.mv(3, pg_temp.b(), 'Padel 2', 3, '17:00', '18:30', 45, 'Padel 3', 3, '17:00', '18:30'));
insert into t select 'M11 Rana cancels, then a desk with the right position moves it: not_confirmed; it stays cancelled where it was',
  pg_temp.got('m11c') = 'ok' and pg_temp.got('m11m') = 'ERR not_confirmed' and pg_temp.pos(pg_temp.b()) = 'Padel 3 17:00-18:30 cancelled',
  pg_temp.got('m11c') || ' / ' || pg_temp.got('m11m') || ' / ' || pg_temp.pos(pg_temp.b());

-- rights: who may call it, and how it runs
insert into t select 'M12 the new function: security definer, fixed search_path, executable by signed-in users only (not anon, not public)',
  p.prosecdef and p.proconfig @> array['search_path=public']
  and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
  and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  p.proacl::text
  from pg_proc p where p.oid = 'move_booking_priced(uuid,uuid,timestamptz,timestamptz,numeric,uuid,timestamptz,timestamptz)'::regprocedure;

select case when pass then 'ok    ' else 'FAIL  ' end || id || case when pass then '' else '  [' || coalesce(detail, 'null') || ']' end from t order by (regexp_replace(id, '^M(\d+).*', '\1'))::int, id;
select 'checks: ' || count(*) || ', failures: ' || count(*) filter (where not pass) from t;
rollback;
