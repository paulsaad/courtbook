-- 0085 tests: an unpublished club is unreadable to visitors and ordinary players. Run by unpublished.sh inside one
-- transaction that is rolled back. psql variable :mig is the migration file under test.
\set ON_ERROR_STOP 1
begin;
\i :mig
\i :mig
create temp table t (id text, pass boolean, detail text);
insert into t values ('U0 the migration applies twice without error', true, '');

-- run q as user `who` (null = signed out, role anon); returns its single value, 'ok', or 'ERR <message>'
create function pg_temp.r(who uuid, q text) returns text language plpgsql as $f$
declare res text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  if who is null then execute 'set local role anon'; else execute 'set local role authenticated'; end if;
  begin
    if q ~* '^\s*select' then execute q into res; else execute q; end if;
    res := coalesce(nullif(res, ''), 'ok');
  exception when others then res := 'ERR ' || sqlerrm;
  end;
  execute 'reset role';
  return res;
end $f$;
create function pg_temp.u(n int) returns uuid language sql as $$ select ('d8500000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.hid() returns uuid language sql as $$ select id from clubs where slug = 'm85-hidden' $$;
create function pg_temp.pub() returns uuid language sql as $$ select id from clubs where slug = 'm85-public' $$;
create function pg_temp.demo() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
create function pg_temp.hc() returns uuid language sql as $$ select id from courts where club_id = pg_temp.hid() $$;
create function pg_temp.at(club uuid, d int) returns timestamptz language sql as $$
  select ((current_date + d)::timestamp + c.open_time + interval '2 hours') at time zone c.timezone from clubs c where c.id = club $$;

-- people: 1 player, 2 staff of the hidden club, 3 admin, 4 coach approved at the hidden club, 5 player with a booking
-- there (history), 6 organiser of a game there
insert into auth.users (id, phone) select pg_temp.u(n), '+9617850' || n from generate_series(1, 6) n;
update profiles set roles = '{player,admin}' where id = pg_temp.u(3);
-- two real clubs, same set-up as the demo club: one published, one not (server work: no signed-in user)
insert into clubs (name, slug, is_demo, active, payment_mode, open_time, close_time, timezone, town_id, address, contact_phone)
  select 'M85 ' || s, 'm85-' || s, false, s = 'public', 'at_desk', open_time, close_time, timezone, town_id, 'Test street', '+96170000000'
  from clubs, (values ('public'), ('hidden')) v(s) where slug = 'batroun';
insert into courts (club_id, name, sport) select id, 'M85 court', 'padel' from clubs where slug like 'm85-%';
insert into price_rules (club_id, weekday_mask, start_time, end_time, price_usd)
  select c.id, 127, '00:00', '23:59', 20 from clubs c where c.slug like 'm85-%';
insert into club_media (club_id, kind, external_url, caption) select id, 'gallery', 'https://example.com/m85.jpg', 'm85' from clubs where slug like 'm85-%';
insert into club_staff (club_id, profile_id) values (pg_temp.hid(), pg_temp.u(2));
insert into coaches (id, profile_id, sports, active) values (pg_temp.u(40), pg_temp.u(4), '{padel}', true);
insert into coach_clubs (coach_id, club_id, status) values (pg_temp.u(40), pg_temp.hid(), 'approved'), (pg_temp.u(40), pg_temp.pub(), 'approved');
-- history: player 5 booked the club while it was published (row written directly: it has since been hidden)
insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd)
  values (pg_temp.hid(), pg_temp.hc(), pg_temp.u(5), pg_temp.at(pg_temp.hid(), 2), pg_temp.at(pg_temp.hid(), 2) + interval '1 hour', 'confirmed', 'app', pg_temp.u(5), 20);
-- a staff block and an open game at the hidden club
insert into blocks (club_id, court_id, start_at, end_at, reason)
  values (pg_temp.hid(), pg_temp.hc(), pg_temp.at(pg_temp.hid(), 3), pg_temp.at(pg_temp.hid(), 3) + interval '1 hour', 'm85');
insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed, status, join_mode, note)
  values (pg_temp.hid(), 'padel', pg_temp.u(6), now() + interval '3 days', now() + interval '3 days 90 minutes', 3, 'open', 'open', 'm85 hidden game');

-- ----------------------------------------------------------------- tables, by who is asking
insert into t select 'U1 ' || w.label || ': the hidden club, its courts, prices and photos are not readable',
  pg_temp.r(w.who, 'select ((select count(*) from clubs where slug = ''m85-hidden'') + (select count(*) from courts where club_id = ''' || pg_temp.hid() || ''')
     + (select count(*) from price_rules where club_id = ''' || pg_temp.hid() || ''') + (select count(*) from club_media where club_id = ''' || pg_temp.hid() || '''))::text') = '0', ''
  from (values ('signed out', null::uuid), ('player', pg_temp.u(1))) w(label, who);
insert into t select 'U2 ' || w.label || ': the published club, its court, price and photo are readable',
  pg_temp.r(w.who, 'select ((select count(*) from clubs where slug = ''m85-public'') + (select count(*) from courts where club_id = ''' || pg_temp.pub() || ''')
     + (select count(*) from price_rules where club_id = ''' || pg_temp.pub() || ''') + (select count(*) from club_media where club_id = ''' || pg_temp.pub() || '''))::text') = '4', ''
  from (values ('signed out', null::uuid), ('player', pg_temp.u(1))) w(label, who);
insert into t select 'U3 ' || w.label || ': still reads the hidden club, its court, price and photo',
  pg_temp.r(w.who, 'select ((select count(*) from clubs where slug = ''m85-hidden'') + (select count(*) from courts where club_id = ''' || pg_temp.hid() || ''')
     + (select count(*) from price_rules where club_id = ''' || pg_temp.hid() || ''') + (select count(*) from club_media where club_id = ''' || pg_temp.hid() || '''))::text') = '4', ''
  from (values ('its staff', pg_temp.u(2)), ('an admin', pg_temp.u(3)), ('a player who booked there', pg_temp.u(5)),
               ('the organiser of a game there', pg_temp.u(6)), ('a coach approved there', pg_temp.u(4))) w(label, who);
insert into t values ('U4 a player who booked there still sees the booking with its club and court',
  pg_temp.r(pg_temp.u(5), 'select (select c.name || '' / '' || k.name from bookings b join clubs c on c.id = b.club_id join courts k on k.id = b.court_id where b.player_id = auth.uid())') = 'M85 hidden / M85 court', '');

-- ----------------------------------------------------------------- read functions
insert into t select 'U5 ' || w.label || ': discovery, day slots and the coach directory leave the hidden club out, list the published one',
  pg_temp.r(w.who, 'select ((select count(*) from club_discovery() where slug = ''m85-hidden'') = 0 and (select count(*) from club_discovery() where slug = ''m85-public'') = 1
     and (select count(*) from club_day_slots(current_date + 2) where slug = ''m85-hidden'') = 0 and (select count(*) from club_day_slots(current_date + 2) where slug = ''m85-public'') > 0)::text') = 'true', ''
  from (values ('signed out', null::uuid), ('player', pg_temp.u(1))) w(label, who);
insert into t values ('U5 coach directory (player): the coach is listed at the published club, not at the hidden one',
  pg_temp.r(pg_temp.u(1), 'select count(*)::text from coaches_directory(null, null) d where d.club_slug = ''m85-hidden''') = '0'
  and pg_temp.r(pg_temp.u(1), 'select count(*)::text from coaches_directory(null, null) d where d.club_slug = ''m85-public''') = '1', '');
insert into t select 'U6 ' || w.label || ': next free slot, sports, coaches and price quotes reveal nothing of the hidden club',
  pg_temp.r(w.who, 'select ((select count(*) from next_free_slot(''' || pg_temp.hid() || ''', ''padel'')) = 0
     and coalesce(cardinality(club_sports(''' || pg_temp.hid() || ''')), 0) = 0)::text') = 'true'
  and pg_temp.r(w.who, 'select quote_price(''' || pg_temp.hc() || ''', ''' || pg_temp.at(pg_temp.hid(), 4) || ''', ''' || (pg_temp.at(pg_temp.hid(), 4) + interval '1 hour') || ''')::text') like 'ERR %', ''
  from (values ('signed out', null::uuid), ('player', pg_temp.u(1))) w(label, who);
insert into t values ('U6 player: no coaches listed for the hidden club',
  pg_temp.r(pg_temp.u(1), 'select count(*)::text from coaches_at_club(''' || pg_temp.hid() || ''')') = '0', '');
insert into t values ('U7 staff still get the sports of their unpublished club (setting it up; price quotes need a published club, as before)',
  pg_temp.r(pg_temp.u(2), 'select array_to_string(club_sports(''' || pg_temp.hid() || '''), '','')') = 'padel', '');

-- ----------------------------------------------------------------- games
insert into t values
  ('U8 player: the open game at the hidden club is not readable, nor on the board or in Find a game',
     pg_temp.r(pg_temp.u(1), 'select ((select count(*) from matches where note = ''m85 hidden game'') + (select count(*) from match_board(''' || pg_temp.hid() || ''', 14))
       + (select count(*) from open_matches(null, null, null, null, null, null, 50) o where o.club_id = ''' || pg_temp.hid() || '''))::text') in ('0'), ''),
  ('U8 its organiser still sees it',
     pg_temp.r(pg_temp.u(6), 'select count(*)::text from matches where note = ''m85 hidden game''') = '1', '');

-- ----------------------------------------------------------------- occupancy (signed-in busy times)
insert into t values
  ('U9 player: no busy times of the hidden club',
     pg_temp.r(pg_temp.u(1), 'select count(*)::text from occupancy where club_id = ''' || pg_temp.hid() || '''') = '0', ''),
  ('U9 its staff see the booking and the block',
     pg_temp.r(pg_temp.u(2), 'select count(*)::text from occupancy where club_id = ''' || pg_temp.hid() || '''') = '2', ''),
  ('U9 the player who booked there still sees their own booking, not the block',
     pg_temp.r(pg_temp.u(5), 'select string_agg(kind || '':'' || mine, '','')  from occupancy where club_id = ''' || pg_temp.hid() || '''') = 'booking:true', ''),
  ('U9 published clubs unchanged: a player sees the demo club''s busy times as before',
     pg_temp.r(pg_temp.u(1), 'select count(*)::text from occupancy where club_id = ''' || pg_temp.demo() || '''')
       = (select count(*)::text from occupancy where club_id = pg_temp.demo()), '');

-- ----------------------------------------------------------------- booking at the hidden club
insert into t values ('U10 player: cannot book the hidden club',
  pg_temp.r(pg_temp.u(1), 'select hold_slot(''' || pg_temp.hid() || ''', ''' || pg_temp.hc() || ''', ''' || pg_temp.at(pg_temp.hid(), 5) || ''', ''' || (pg_temp.at(pg_temp.hid(), 5) + interval '1 hour') || ''', gen_random_uuid())::text') like 'ERR %', '');

-- ----------------------------------------------------------------- publishing, demo switch
update clubs set active = true where id = pg_temp.hid();
insert into t values ('U11 once published, visitors read it',
  pg_temp.r(null, 'select count(*)::text from clubs where slug = ''m85-hidden''') = '1', '');
update clubs set active = false where id = pg_temp.hid();
insert into t values ('U12 demo club, switch off: readable by visitors as before',
  pg_temp.r(null, 'select count(*)::text from clubs where slug = ''batroun''') = '1', '');
insert into app_settings (key, value) values ('hide_demo_clubs', 'true') on conflict (key) do update set value = 'true';
insert into t values
  ('U13 demo club, switch on: hidden from visitors as before',
     pg_temp.r(null, 'select count(*)::text from clubs where slug = ''batroun''') = '0', ''),
  ('U13 ...and from players with no history there',
     pg_temp.r(pg_temp.u(1), 'select count(*)::text from clubs where slug = ''batroun''') = '0', ''),
  ('U13 ...an admin still reads it',
     pg_temp.r(pg_temp.u(3), 'select count(*)::text from clubs where slug = ''batroun''') = '1', '');

-- ----------------------------------------------------------------- privileges unchanged
insert into t values
  ('U14 the helper is still not callable by visitors directly',
     not has_function_privilege('anon', 'club_visible_to_me(uuid,boolean)', 'execute')
     and has_function_privilege('anon', 'club_readable_by_me(uuid,boolean)', 'execute'), ''),
  ('U14 the occupancy view keeps its grants (signed-in only)',
     has_table_privilege('authenticated', 'occupancy', 'select') and not has_table_privilege('anon', 'occupancy', 'select'), '');

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
