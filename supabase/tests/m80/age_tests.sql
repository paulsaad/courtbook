-- 18+ tests (0080). Run by age.sh inside one transaction that is rolled back. :mig is the migration under test.
\set ON_ERROR_STOP 1
begin;
\i :mig
\i :mig
create temp table t (id text, pass boolean, detail text);
insert into t values ('E0 the migration applies twice without error', true, '');

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
  perform set_config('request.jwt.claim.sub', '', true);
  return res;
end $f$;
create function pg_temp.u(n int) returns uuid language sql as $$ select ('d8000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.club() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
insert into courts (id, club_id, name, sport, active, sort) select 'd8000000-0000-4000-8000-000000000900', id, 'E court', 'padel', true, 99 from clubs where slug = 'batroun';
create function pg_temp.court() returns uuid language sql as $$ select 'd8000000-0000-4000-8000-000000000900'::uuid $$;
create function pg_temp.at(d int, h int) returns timestamptz language sql as $$
  select ((current_date + d)::timestamp + c.open_time + make_interval(hours => h)) at time zone c.timezone from clubs c where c.id = pg_temp.club() $$;
create function pg_temp.desk(d int, h int) returns text language sql as $$
  select format($q$select book_at_desk(%L, %L, %L, gen_random_uuid())::text$q$, pg_temp.court(), pg_temp.at(d, h), pg_temp.at(d, h) + interval '60 min') $$;
create function pg_temp.post(note text) returns text language sql as $$
  select format($q$select post_match(%L, 'padel', now() + interval '5 days', now() + interval '5 days 90 min', null, null, 3, %L, null, 'open', gen_random_uuid())::text$q$, pg_temp.club(), note) $$;

-- 1 existing player (has a booking and is in a game, never confirmed); 2 new player; 3 staff; 4 admin; 5 organiser
insert into auth.users (id, phone) select pg_temp.u(n), '+9617200' || lpad(n::text, 2, '0') from generate_series(1, 6) n;
update profiles set name = 'E' || right(id::text, 1), rules_accepted_at = now() where id in (select pg_temp.u(n) from generate_series(1, 6) n);
update profiles set roles = '{player,admin}' where id = pg_temp.u(4);
insert into club_staff (club_id, profile_id) values (pg_temp.club(), pg_temp.u(3));
update clubs set payment_mode = 'at_desk' where slug = 'batroun';
insert into t values ('E1 default (switch absent): an unconfirmed existing player books as before', pg_temp.r(pg_temp.u(1), pg_temp.desk(5, 2)) not like 'ERR%', ''),
  ('E1 default: my_age_status says not confirmed, not required', pg_temp.r(pg_temp.u(1), $$select (my_age_status()->>'confirmed') || '/' || (my_age_status()->>'required')$$) = 'false/false', '');
update profiles set age_confirmed_at = now(), age_confirmed_via = 'web' where id = pg_temp.u(5);   -- server context: allowed
insert into matches (id, club_id, sport, organizer_id, start_at, end_at, players_needed, status, join_mode, note)
values (pg_temp.u(101), pg_temp.club(), 'padel', pg_temp.u(5), now() + interval '3 days', now() + interval '3 days 90 min', 4, 'open', 'open', 'e game');
insert into match_players (match_id, profile_id, status) values (pg_temp.u(101), pg_temp.u(1), 'accepted');

-- ================= enforcement on =================
insert into app_settings (key, value) values ('require_age_confirmation', 'true') on conflict (key) do update set value = 'true';
insert into t values
  ('E2 fresh account: my_age_status says confirm first', pg_temp.r(pg_temp.u(2), $$select (my_age_status()->>'confirmed') || '/' || (my_age_status()->>'required')$$) = 'false/true', ''),
  ('E2 fresh account: no booking', pg_temp.r(pg_temp.u(2), pg_temp.desk(6, 2)) like 'ERR age_not_confirmed%', ''),
  ('E2 fresh account: no game posted', pg_temp.r(pg_temp.u(2), pg_temp.post('e2 post')) like 'ERR age_not_confirmed%', ''),
  ('E2 fresh account: no joining', pg_temp.r(pg_temp.u(2), format($$select join_match(%L)::text$$, pg_temp.u(101))) like 'ERR age_not_confirmed%', ''),
  ('E2 fresh account: no coach listing', pg_temp.r(pg_temp.u(2), $$insert into coaches (profile_id, sports, active) values (auth.uid(), '{padel}', true)$$) like 'ERR age_not_confirmed%', ''),
  ('E3 existing account: no new booking', pg_temp.r(pg_temp.u(1), pg_temp.desk(6, 4)) like 'ERR age_not_confirmed%', ''),
  ('E3 existing account: no chat message in a game they are already in', pg_temp.r(pg_temp.u(1), format($$insert into match_messages (match_id, profile_id, body) values (%L, auth.uid(), 'hi')$$, pg_temp.u(101))) like 'ERR age_not_confirmed%', ''),
  ('E3 existing account: cancelling their own booking still works', pg_temp.r(pg_temp.u(1), format($$select cancel_booking(%L)::text$$,
       (select id from bookings where player_id = pg_temp.u(1) order by created_at limit 1))) = 'ok', ''),
  ('E3 existing account: leaving a game still works', pg_temp.r(pg_temp.u(1), format($$select leave_match(%L)::text$$, pg_temp.u(101))) = 'ok', '');
-- refused confirmation
insert into t values
  ('E4 "under 18" is refused and records nothing', pg_temp.r(pg_temp.u(2), $$select confirm_age(false, 'web')::text$$) like 'ERR under_18%', ''),
  ('E4 no answer is refused too', pg_temp.r(pg_temp.u(2), $$select confirm_age(null, 'web')::text$$) like 'ERR under_18%', ''),
  ('E4 an unknown channel is refused', pg_temp.r(pg_temp.u(2), $$select confirm_age(true, 'sms')::text$$) like 'ERR invalid_via%', '');
insert into t values
  ('E4 after refusing: still unconfirmed, nothing stored', (select age_confirmed_at is null and age_confirmed_via is null from profiles where id = pg_temp.u(2)), ''),
  ('E4 after refusing: still no booking', pg_temp.r(pg_temp.u(2), pg_temp.desk(6, 2)) like 'ERR age_not_confirmed%', ''),
  ('E5 signed out cannot confirm', pg_temp.r(null, $$select confirm_age(true, 'web')::text$$) like 'ERR%', '');
-- direct API writes
insert into t values
  ('E6 a player cannot set the confirmation through "update own profile"', pg_temp.r(pg_temp.u(2), $$update profiles set age_confirmed_at = now(), age_confirmed_via = 'web' where id = auth.uid()$$) like 'ERR age_confirmation_by_function_only%', ''),
  ('E6 an admin cannot confirm for someone else', pg_temp.r(pg_temp.u(4), format($$update profiles set age_confirmed_at = now(), age_confirmed_via = 'web' where id = %L$$, pg_temp.u(2))) like 'ERR age_confirmation_by_function_only%', ''),
  ('E6 editing other profile fields still works', pg_temp.r(pg_temp.u(2), $$update profiles set name = 'E2 renamed' where id = auth.uid()$$) = 'ok', '');
-- confirming
insert into t values ('E7 the player confirms (website)', pg_temp.r(pg_temp.u(2), $$select confirm_age(true, 'web')->>'confirmed'$$) = 'true', '');
insert into t values
  ('E7 recorded: a time and the channel, nothing else', (select age_confirmed_at is not null and age_confirmed_via = 'web' from profiles where id = pg_temp.u(2))
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and (column_name ~* 'birth|dob' or (table_name = 'profiles' and column_name ~* '^age' and column_name not in ('age_confirmed_at', 'age_confirmed_via')))), ''),
  ('E7 confirming again keeps the first record', pg_temp.r(pg_temp.u(2), $$select confirm_age(true, 'app')->>'confirmed'$$) = 'true', ''),
  ('E7 my_age_status says confirmed', pg_temp.r(pg_temp.u(2), $$select (my_age_status()->>'confirmed')$$) = 'true', '');
insert into t values
  ('E7 ...channel still web (first record kept)', (select age_confirmed_via = 'web' from profiles where id = pg_temp.u(2)), ''),
  ('E7 a confirmed player cannot clear it directly', pg_temp.r(pg_temp.u(2), $$update profiles set age_confirmed_at = null, age_confirmed_via = null where id = auth.uid()$$) like 'ERR age_confirmation_by_function_only%', ''),
  ('E8 confirmed: booking works', pg_temp.r(pg_temp.u(2), pg_temp.desk(6, 2)) not like 'ERR%', ''),
  ('E8 confirmed: posting a game works', pg_temp.r(pg_temp.u(2), pg_temp.post('e8 post')) not like 'ERR%', ''),
  ('E8 confirmed: joining works', pg_temp.r(pg_temp.u(2), format($$select join_match(%L)::text$$, pg_temp.u(101))) not like 'ERR%', ''),
  ('E8 confirmed: a coach listing can be created', pg_temp.r(pg_temp.u(2), $$insert into coaches (profile_id, sports, active) values (auth.uid(), '{padel}', true)$$) = 'ok', '');
-- staff and admin work, server work
insert into t values
  ('E9 unconfirmed staff still book a walk-in at the desk', pg_temp.r(pg_temp.u(3), format($$select staff_book(%L, %L, %L, %L, 'Walk-in', null)::text$$,
       pg_temp.club(), pg_temp.court(), pg_temp.at(7, 2), pg_temp.at(7, 2) + interval '60 min')) not like 'ERR%', '');
insert into t values
  ('E9 unconfirmed staff still cancel a booking at their club', pg_temp.r(pg_temp.u(3), format($$select cancel_booking(%L, true)::text$$,
       (select id from bookings where guest_name = 'Walk-in' and court_id = pg_temp.court()))) = 'ok', ''),
  ('E9 ...but no bypass: their own player booking is refused like anyone''s', pg_temp.r(pg_temp.u(3), pg_temp.desk(8, 2)) like 'ERR age_not_confirmed%', ''),
  ('E9 an unconfirmed admin''s own booking is refused too', pg_temp.r(pg_temp.u(4), pg_temp.desk(8, 4)) like 'ERR age_not_confirmed%', ''),
  ('E10 server context (no signed-in user) is unaffected', pg_temp.r(null, 'select 1') = '1', '');
do $$ begin
  insert into bookings (club_id, court_id, player_id, created_by, start_at, end_at, status, source)
  values (pg_temp.club(), pg_temp.court(), pg_temp.u(6), pg_temp.u(6), pg_temp.at(9, 2), pg_temp.at(9, 2) + interval '60 min', 'confirmed', 'app');
  insert into t values ('E10 a server-side booking for an unconfirmed player is written', true, '');
exception when others then insert into t values ('E10 a server-side booking for an unconfirmed player is written', false, sqlerrm);
end $$;
-- grants
insert into t values
  ('E11 anon can run none of it', not has_function_privilege('anon', 'confirm_age(boolean,text)', 'execute') and not has_function_privilege('anon', 'my_age_status()', 'execute'), ''),
  ('E11 the switch reader is not callable by signed-in users', not has_function_privilege('authenticated', 'age_confirmation_required()', 'execute'), '');

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
