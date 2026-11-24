-- M2 (0086) × M14 (0087–0089) on one database: a closed account cannot change its favourites, saved areas, last
-- area or first-use answer, whatever the path; an old app's open request locks them too; when the sign-in is deleted
-- (pipeline step D) they go with the account. ONE transaction, rolled back. Run by m2_m14.sh on the local replica.
\set ON_ERROR_STOP 1
begin;
create temp table t (id text, pass boolean, detail text);
grant all on t to authenticated, service_role;
create function pg_temp.r(who uuid, q text) returns text language plpgsql as $f$
declare res text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', who, 'role', 'authenticated', 'amr',
    jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', extract(epoch from now())::bigint)))::text, true);
  execute 'set local role authenticated';
  begin
    if q ~* '^\s*select' then execute q into res; else execute q; end if;
    res := coalesce(nullif(res, ''), 'ok');
  exception when others then res := 'ERR ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;
create function pg_temp.u(n int) returns uuid language sql as $$ select ('e1400000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.club() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
create temp table kept (k text primary key, v text);
grant all on kept to authenticated, service_role;
create function pg_temp.keep(k text, v text) returns void language sql as $$ insert into kept values (k, v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.got(k text) returns text language sql as $$ select v from kept where kept.k = got.k $$;
insert into deletion_worker (id, last_run_at) values (true, now()) on conflict (id) do update set last_run_at = now();
-- the demo club 'batroun' is published (active) on the replica
insert into auth.users (id, phone) values (pg_temp.u(1), '+9617114001'), (pg_temp.u(2), '+9617114002');
update profiles set rules_accepted_at = now() where id in (pg_temp.u(1), pg_temp.u(2));
update profiles set age_confirmed_at = now(), age_confirmed_via = 'app' where id in (pg_temp.u(1), pg_temp.u(2));

-- each player sets everything up while active
select pg_temp.keep('a_fav_' || n, pg_temp.r(pg_temp.u(n), format('select set_club_favourite(%L, true)::text', pg_temp.club()))) from generate_series(1, 2) n;
select pg_temp.keep('a_areas_' || n, pg_temp.r(pg_temp.u(n), 'select set_playing_areas(''[{"governorate":"north"}]''::jsonb)::text')) from generate_series(1, 2) n;
select pg_temp.keep('a_last_' || n, pg_temp.r(pg_temp.u(n), 'select set_last_area(''north'')')) from generate_series(1, 2) n;
insert into t select 'I1 active players set favourites, areas and last area',
  pg_temp.got('a_fav_1') !~ '^ERR' and pg_temp.got('a_areas_1') !~ '^ERR' and pg_temp.got('a_last_1') !~ '^ERR' and pg_temp.got('a_fav_2') !~ '^ERR',
  (select string_agg(k || '=' || v, '; ') from kept);

-- player 1 closes (one confirmation); player 2 asks the old app's way (request-and-wait)
select pg_temp.keep('close', pg_temp.r(pg_temp.u(1), 'select close_my_account(''web'')::text'));
select pg_temp.keep('request', pg_temp.r(pg_temp.u(2), 'select request_account_deletion(''app'')::text'));
insert into t values ('I2 closed and requested', pg_temp.got('close') !~ '^ERR' and pg_temp.got('request') !~ '^ERR', pg_temp.got('close') || ' / ' || pg_temp.got('request'));

do $$ declare n int; who text; begin
  for n in 1..2 loop
    who := case n when 1 then 'closed' else 'requested' end;
    perform pg_temp.keep(who || '_fav_add', pg_temp.r(pg_temp.u(n), format('select set_club_favourite(%L, true)::text', (select id from clubs where slug = 'other'))));
    perform pg_temp.keep(who || '_fav_remove', pg_temp.r(pg_temp.u(n), format('select set_club_favourite(%L, false)::text', pg_temp.club())));
    perform pg_temp.keep(who || '_areas', pg_temp.r(pg_temp.u(n), 'select set_playing_areas(''[]''::jsonb)::text'));
    perform pg_temp.keep(who || '_last', pg_temp.r(pg_temp.u(n), 'select set_last_area(null)'));
    perform pg_temp.keep(who || '_dismiss', pg_temp.r(pg_temp.u(n), 'select dismiss_areas_question()'));
    perform pg_temp.keep(who || '_direct', pg_temp.r(pg_temp.u(n), 'delete from club_favourites where profile_id = auth.uid()'));
  end loop;
end $$;
insert into t select format('I3 %s account: every M14 change refused (favourite add/remove, areas, last area, Not now, direct)', w),
  (select bool_and(v ~ 'account_closed|permission denied|row-level security') from kept where k like w || '\_%' escape '\'),
  (select string_agg(k || '=' || v, '; ') from kept where k like w || '\_%' escape '\')
from unnest(array['closed', 'requested']) w;
insert into t select 'I4 nothing changed for either: favourite, areas and last area as before',
  (select count(*) from club_favourites where profile_id in (pg_temp.u(1), pg_temp.u(2)) and club_id = pg_temp.club()) = 2
  and (select count(*) from player_areas where profile_id in (pg_temp.u(1), pg_temp.u(2))) = 2
  and (select count(*) from player_prefs where profile_id in (pg_temp.u(1), pg_temp.u(2)) and last_governorate = 'north') = 2, '';

-- the new app's first-use question for a closed account: the server answers account_closed, which the app now shows
-- as "Couldn't save that" instead of pretending it was saved (M14 review C)
insert into t values ('I5 a closed account''s Not now answers account_closed (the screen keeps the question)', pg_temp.got('closed_dismiss') like 'ERR account_closed%', pg_temp.got('closed_dismiss'));

-- the service finishes player 1 (steps B–E; D is the Auth deletion, which removes the sign-in row)
delete from auth.users where id = pg_temp.u(1);   -- what Auth's deleteUser does
insert into t values ('I6 after the sign-in is deleted, favourites, areas and prefs are gone with the account',
  (select count(*) from club_favourites where profile_id = pg_temp.u(1)) = 0 and (select count(*) from player_areas where profile_id = pg_temp.u(1)) = 0
  and (select count(*) from player_prefs where profile_id = pg_temp.u(1)) = 0, '');
insert into t values ('I7 the other player''s rows are untouched', (select count(*) from club_favourites where profile_id = pg_temp.u(2)) = 1, '');

-- the lock-out covers every table, including the three M14 tables (0086 E1 on this combined schema)
insert into t select 'I8 the lock-out trigger is on club_favourites, player_areas and player_prefs',
  count(*) = 3, string_agg(tgrelid::regclass::text, ', ')
from pg_trigger where tgname = 'closed_account_lockout' and tgrelid::regclass::text in ('club_favourites', 'player_areas', 'player_prefs');

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by id;
select format('%s checks, %s failed', count(*), count(*) filter (where not pass)) from t;
rollback;
