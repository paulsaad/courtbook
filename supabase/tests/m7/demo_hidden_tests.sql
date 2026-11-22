-- M7 tests: demo clubs hidden from public discovery (0078). Run by demo_hidden.sh inside one transaction that is
-- rolled back. psql variable :mig is the migration file under test.
\set ON_ERROR_STOP 1
begin;
\i :mig
\i :mig
create temp table t (id text, pass boolean, detail text);
insert into t values ('D0 the migration applies twice without error', true, '');

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
create function pg_temp.u(n int) returns uuid language sql as $$ select ('d7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.demo() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
create function pg_temp.real() returns uuid language sql as $$ select id from clubs where slug = 'm7-real' $$;
-- a start d days ahead, two hours after opening: on the grid, inside the hours and the 14-day booking window
create function pg_temp.at(club uuid, d int) returns timestamptz language sql as $$
  select ((current_date + d)::timestamp + c.open_time + interval '2 hours') at time zone c.timezone from clubs c where c.id = club $$;

-- fixtures: player 1, staff of the demo club 2, admin 3, coach 4, player 5 (books the demo club while shown),
-- player 6 (in the demo game); a real (non-demo) club with one court
insert into auth.users (id, phone) values (pg_temp.u(1), '+961700001'), (pg_temp.u(2), '+961700002'),
  (pg_temp.u(3), '+961700003'), (pg_temp.u(4), '+961700004'), (pg_temp.u(5), '+961700005'), (pg_temp.u(6), '+961700006');
update profiles set name = 'M7 player' where id = pg_temp.u(1);
update profiles set roles = '{player,admin}' where id = pg_temp.u(3);
insert into club_staff (club_id, profile_id) values (pg_temp.demo(), pg_temp.u(2));
insert into clubs (name, slug, is_demo, payment_mode, open_time, close_time, timezone)
  select 'M7 Real Club', 'm7-real', false, 'at_desk', open_time, close_time, timezone from clubs where slug = 'batroun';
insert into courts (club_id, name, sport) values (pg_temp.real(), 'Real 1', 'padel');
insert into price_rules (club_id, weekday_mask, start_time, end_time, price_usd, label, sort)
  select pg_temp.real(), weekday_mask, start_time, end_time, price_usd, label, sort from price_rules where club_id = pg_temp.demo() and court_id is null;
-- games: one at each club, organised by the admin, open
insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed, status, join_mode, note)
values (pg_temp.demo(), 'padel', pg_temp.u(3), now() + interval '3 days', now() + interval '3 days 90 minutes', 3, 'open', 'open', 'm7 demo game'),
       (pg_temp.real(), 'padel', pg_temp.u(3), now() + interval '3 days', now() + interval '3 days 90 minutes', 3, 'open', 'open', 'm7 real game');
-- a coach approved at both clubs
insert into coaches (id, profile_id, sports, active) values (pg_temp.u(40), pg_temp.u(4), '{padel}', true);
insert into coach_clubs (coach_id, club_id, status) values (pg_temp.u(40), pg_temp.demo(), 'approved'), (pg_temp.u(40), pg_temp.real(), 'approved');
insert into match_players (match_id, profile_id) select id, pg_temp.u(6) from matches where note = 'm7 demo game';

-- ================= switch off (default): nothing changes =================
delete from app_settings where key = 'hide_demo_clubs';
update clubs set payment_mode = 'at_desk' where slug = 'batroun';
insert into t values
  ('D1 default: player 5 books the demo club (history for D12)',
     pg_temp.r(pg_temp.u(5), format($$select book_at_desk(%L, %L, %L, gen_random_uuid())::text$$,
       (select id from courts where club_id = pg_temp.demo() order by sort limit 1), pg_temp.at(pg_temp.demo(), 4), pg_temp.at(pg_temp.demo(), 4) + interval '60 min')) not like 'ERR%', '');
insert into t values
  ('D1 default: a signed-out visitor reads the demo club row', pg_temp.r(null, $$select count(*)::text from clubs where slug = 'batroun'$$) = '1', ''),
  ('D1 default: the demo club is in club_discovery', pg_temp.r(null, $$select count(*)::text from club_discovery() where slug = 'batroun'$$) = '1', ''),
  ('D1 default: a player sees the demo game on the board', pg_temp.r(pg_temp.u(1), $$select count(*)::text from open_matches() where note = 'm7 demo game'$$) = '1', '');

-- ================= switch on =================
insert into app_settings (key, value) values ('hide_demo_clubs', 'true');
insert into t values
  ('D2 hidden: a signed-out visitor cannot read the demo club row',
     pg_temp.r(null, $$select count(*)::text from clubs where slug = 'batroun'$$) = '0', ''),
  ('D2 hidden: a player cannot read the demo club row',
     pg_temp.r(pg_temp.u(1), $$select count(*)::text from clubs where slug = 'batroun'$$) = '0', ''),
  ('D2 hidden: the real club stays readable',
     pg_temp.r(null, $$select count(*)::text from clubs where slug = 'm7-real'$$) = '1', ''),
  ('D3 hidden: club_discovery leaves the demo club out (signed out)',
     pg_temp.r(null, $$select count(*)::text from club_discovery() where slug = 'batroun'$$) = '0', ''),
  ('D3 hidden: club_discovery keeps the real club',
     pg_temp.r(null, $$select count(*)::text from club_discovery() where slug = 'm7-real'$$) = '1', ''),
  ('D3 hidden: club_day_slots leaves the demo club out',
     pg_temp.r(pg_temp.u(1), format($$select count(*)::text from club_day_slots(%L::date) where slug = 'batroun'$$, current_date + 2)) = '0', ''),
  ('D3 hidden: club_day_slots keeps the real club',
     pg_temp.r(pg_temp.u(1), format($$select (count(*) > 0)::text from club_day_slots(%L::date) where slug = 'm7-real'$$, current_date + 2)) = 'true', ''),
  ('D4 hidden: the board leaves out the demo game',
     pg_temp.r(pg_temp.u(1), $$select count(*)::text from open_matches() where note = 'm7 demo game'$$) = '0', ''),
  ('D4 hidden: the board keeps the real game',
     pg_temp.r(pg_temp.u(1), $$select count(*)::text from open_matches() where note = 'm7 real game'$$) = '1', ''),
  ('D5 hidden: the coach directory leaves out the demo club listing',
     pg_temp.r(pg_temp.u(1), $$select count(*)::text from coaches_directory() d where d::text like '%Batroun%'$$) = '0', ''),
  ('D5 hidden: the coach directory keeps the real club listing',
     pg_temp.r(pg_temp.u(1), $$select (count(*) > 0)::text from coaches_directory() d where d::text like '%M7 Real Club%'$$) = 'true', '');

-- authorised testing access
insert into t values
  ('D6 hidden: staff of the demo club still read it', pg_temp.r(pg_temp.u(2), $$select count(*)::text from clubs where slug = 'batroun'$$) = '1', ''),
  ('D6 hidden: an admin still reads it', pg_temp.r(pg_temp.u(3), $$select count(*)::text from clubs where slug = 'batroun'$$) = '1', ''),
  ('D6 hidden: staff still see it in club_discovery', pg_temp.r(pg_temp.u(2), $$select count(*)::text from club_discovery() where slug = 'batroun'$$) = '1', ''),
  ('D6 hidden: staff of the demo club still see its game on the board', pg_temp.r(pg_temp.u(2), $$select count(*)::text from open_matches() where note = 'm7 demo game'$$) = '1', '');

-- booking: desk mode for the desk test, simulated for the hold test (each path reaches the shared slot check)
update clubs set payment_mode = 'at_desk' where slug = 'batroun';
insert into t values
  ('D7 hidden: a player cannot book the demo club at the desk',
     pg_temp.r(pg_temp.u(1), format($$select book_at_desk(%L, %L, %L, gen_random_uuid())::text$$,
       (select id from courts where club_id = pg_temp.demo() order by sort limit 1), pg_temp.at(pg_temp.demo(), 5), pg_temp.at(pg_temp.demo(), 5) + interval '60 min')) like 'ERR club_not_found%', '');
update clubs set payment_mode = 'simulated' where slug = 'batroun';
insert into t values
  ('D7 hidden: a player cannot hold a demo court (simulated payment)',
     pg_temp.r(pg_temp.u(1), format($$select hold_slot(%L, %L, %L, %L, gen_random_uuid())::text$$, pg_temp.demo(),
       (select id from courts where club_id = pg_temp.demo() order by sort limit 1), pg_temp.at(pg_temp.demo(), 6), pg_temp.at(pg_temp.demo(), 6) + interval '60 min')) like 'ERR club_not_found%', '');
update clubs set payment_mode = 'at_desk' where slug = 'batroun';
insert into t values
  ('D8 hidden: staff of the demo club can still book at it',
     pg_temp.r(pg_temp.u(2), format($$select staff_book(%L, %L, %L, %L, 'Walk-in', null)::text$$, pg_temp.demo(),
       (select id from courts where club_id = pg_temp.demo() order by sort limit 1), pg_temp.at(pg_temp.demo(), 9), pg_temp.at(pg_temp.demo(), 9) + interval '60 min')) not like 'ERR%', ''),
  ('D8 hidden: a player still books the real club',
     pg_temp.r(pg_temp.u(1), format($$select book_at_desk(%L, %L, %L, gen_random_uuid())::text$$,
       (select id from courts where club_id = pg_temp.real() limit 1), pg_temp.at(pg_temp.real(), 7), pg_temp.at(pg_temp.real(), 7) + interval '60 min')) not like 'ERR%', '');
-- server context (no signed-in user, e.g. a sweeper or the service key): unaffected
insert into t
  select 'D9 hidden: a server-side write at the demo club is not refused',
         (select count(*) = 1 from bookings b where b.club_id = pg_temp.demo() and b.guest_name = 'Walk-in'), '';
do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);
  update bookings set end_at = end_at where club_id = (select id from clubs where slug = 'batroun') and guest_name = 'Walk-in';
  insert into t values ('D9 hidden: a server-side update of a demo booking passes the slot check', true, '');
exception when others then
  insert into t values ('D9 hidden: a server-side update of a demo booking passes the slot check', false, sqlerrm);
end $$;

-- own history at a hidden club: the row stays readable (existing screens keep working), nothing else opens up
insert into t values
  ('D12 hidden: a player with a booking there still reads the club row',
     pg_temp.r(pg_temp.u(5), $$select count(*)::text from clubs where slug = 'batroun'$$) = '1', ''),
  ('D12 hidden: their booking still joins to the club name (booking and pay screens)',
     pg_temp.r(pg_temp.u(5), $$select count(*)::text from bookings b join clubs c on c.id = b.club_id where c.slug = 'batroun'$$) = '1', ''),
  ('D12 hidden: a player in a game there still reads the club row',
     pg_temp.r(pg_temp.u(6), $$select count(*)::text from clubs where slug = 'batroun'$$) = '1', ''),
  ('D12 hidden: a coach linked there still reads the club row',
     pg_temp.r(pg_temp.u(4), $$select count(*)::text from clubs where slug = 'batroun'$$) = '1', ''),
  ('D12 hidden: history does not bring it back into club_discovery',
     pg_temp.r(pg_temp.u(5), $$select count(*)::text from club_discovery() where slug = 'batroun'$$) = '0', ''),
  ('D12 hidden: history does not bring it back into club_day_slots',
     pg_temp.r(pg_temp.u(5), format($$select count(*)::text from club_day_slots(%L::date) where slug = 'batroun'$$, current_date + 2)) = '0', ''),
  ('D12 hidden: history does not bring its game back onto the board',
     pg_temp.r(pg_temp.u(6), $$select count(*)::text from open_matches() where note = 'm7 demo game'$$) = '0', ''),
  ('D12 hidden: history does not allow a new booking there',
     pg_temp.r(pg_temp.u(5), format($$select book_at_desk(%L, %L, %L, gen_random_uuid())::text$$,
       (select id from courts where club_id = pg_temp.demo() order by sort limit 1), pg_temp.at(pg_temp.demo(), 3), pg_temp.at(pg_temp.demo(), 3) + interval '60 min')) like 'ERR club_not_found%', '');

-- switch back off
update app_settings set value = 'false' where key = 'hide_demo_clubs';
insert into t values
  ('D10 off again: visible to a signed-out visitor', pg_temp.r(null, $$select count(*)::text from clubs where slug = 'batroun'$$) = '1', ''),
  ('D10 off again: a player can book the demo club', pg_temp.r(pg_temp.u(1), format($$select book_at_desk(%L, %L, %L, gen_random_uuid())::text$$,
       (select id from courts where club_id = pg_temp.demo() order by sort limit 1), pg_temp.at(pg_temp.demo(), 8), pg_temp.at(pg_temp.demo(), 8) + interval '60 min')) not like 'ERR club_not_found%', '');

-- grants
insert into t values
  ('D11 the clubs read policy function is callable by anon and signed-in users',
     has_function_privilege('anon', 'club_readable_by_me(uuid,boolean)', 'execute')
     and has_function_privilege('authenticated', 'club_readable_by_me(uuid,boolean)', 'execute'), ''),
  ('D11 the other helpers are not exposed to anon; the switch and history checks not to signed-in users either',
     not has_function_privilege('anon', 'club_visible_to_me(uuid,boolean)', 'execute')
     and not has_function_privilege('anon', 'demo_clubs_hidden()', 'execute')
     and not has_function_privilege('authenticated', 'demo_clubs_hidden()', 'execute')
     and not has_function_privilege('anon', 'club_has_my_history(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'club_has_my_history(uuid)', 'execute'), ''),
  ('D11 players still cannot write club rows', not has_table_privilege('anon', 'clubs', 'insert'), '');

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
