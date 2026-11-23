-- 0087–0089 tests: favourites only for clubs players can see; saved playing areas and the last browsing area on the
-- account; the first-use question asked once; club map points both-or-neither; publishing needs a map point.
-- Run by repeat_use.sh inside one transaction that is rolled back. psql variables :m87 :m88 :m89 are the migration
-- files under test (a mutated copy replaces one of them for the mutation checks).
\set ON_ERROR_STOP 1
begin;
\i :m87
\i :m88
\i :m89
\i :m87
\i :m88
\i :m89
create temp table t (id text, pass boolean, detail text);
insert into t values ('R0 the three migrations apply twice without error', true, '');

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
  perform set_config('request.jwt.claim.sub', '', true);
  return res;
end $f$;
create function pg_temp.u(n int) returns uuid language sql as $$ select ('d8700000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.town(n text) returns uuid language sql as $$ select id from towns where name_en = n $$;
create function pg_temp.club(s text) returns uuid language sql as $$ select id from clubs where slug = s $$;
create function pg_temp.prefs(who uuid) returns jsonb language plpgsql as $f$
declare res jsonb;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  execute 'set local role authenticated';
  res := my_playing_prefs();
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return res;
end $f$;

-- people: 1 and 2 players, 3 admin, 4 staff of the m87 club
insert into auth.users (id, phone) select pg_temp.u(n), '+9617870' || n from generate_series(1, 4) n;
update profiles set roles = '{player,admin}' where id = pg_temp.u(3);
-- clubs: a published one in Tripoli, an unpublished one (staff 4), and the demo club (batroun) to hide
insert into clubs (name, slug, active, town_id, lat, lng) values
  ('R Tripoli', 'r-tripoli', true, pg_temp.town('Tripoli'), 34.4367, 35.8497),
  ('R Hidden', 'r-hidden', false, pg_temp.town('Chekka'), null, null);
insert into club_staff (club_id, profile_id) values (pg_temp.club('r-hidden'), pg_temp.u(4));

-- =========================================================== favourites: only clubs the player can see (0087)
insert into t values
  ('F1 a player favourites a published club', pg_temp.r(pg_temp.u(1), format('select set_club_favourite(%L, true)::text', pg_temp.club('r-tripoli'))) = 'true', ''),
  ('F1 favourites in different regions: Tripoli and Batroun together',
     pg_temp.r(pg_temp.u(1), format('select set_club_favourite(%L, true)::text', pg_temp.club('batroun'))) = 'true'
     and pg_temp.r(pg_temp.u(1), 'select string_agg(slug, '','' order by created_at desc, slug) from my_favourite_clubs()') in ('batroun,r-tripoli', 'r-tripoli,batroun'), ''),
  ('F2 an unpublished club cannot be favourited by a player (refused like an unknown club)',
     pg_temp.r(pg_temp.u(1), format('select set_club_favourite(%L, true)::text', pg_temp.club('r-hidden'))) = 'ERR club_not_found', ''),
  ('F3 the list carries what Home shows: name, town, area, map point',
     pg_temp.r(pg_temp.u(1), format('select name || ''|'' || town || ''|'' || district_code || ''|'' || governorate_code || ''|'' || lat || '','' || lng from my_favourite_clubs() where club_id = %L', pg_temp.club('r-tripoli')))
       = 'R Tripoli|Tripoli|tripoli|north|34.436700,35.849700', '');
-- the demo club is hidden from players (0078 switch): its favourite stays but is not listed, and cannot be added anew
insert into app_settings (key, value) values ('hide_demo_clubs', 'true') on conflict (key) do update set value = 'true';
insert into t values
  ('F4 a hidden demo club drops out of the list (row kept)',
     pg_temp.r(pg_temp.u(1), 'select string_agg(slug, '','') from my_favourite_clubs()') = 'r-tripoli'
     and (select count(*) from club_favourites where profile_id = pg_temp.u(1)) = 2, ''),
  ('F4 ... and cannot be favourited by another player while hidden',
     pg_temp.r(pg_temp.u(2), format('select set_club_favourite(%L, true)::text', pg_temp.club('batroun'))) = 'ERR club_not_found', '');
update app_settings set value = 'false' where key = 'hide_demo_clubs';
insert into t values
  ('F4 ... and comes back when the demo club is shown again',
     pg_temp.r(pg_temp.u(1), 'select count(*)::text from my_favourite_clubs()') = '2', ''),
  ('F5 signed out: no favourites list', pg_temp.r(null, 'select count(*)::text from my_favourite_clubs()') like 'ERR%', '');

-- =========================================================== playing areas (0088)
-- Every call that changes data runs in its own statement and its answer is kept in k; checks only read. (In one
-- expression Postgres may evaluate a check's subquery before the call it depends on.)
create temp table k (id text primary key, v text);
create function pg_temp.keep(id text, v text) returns void language sql as $$ insert into k values (id, v) $$;
create function pg_temp.got(i text) returns text language sql as $$ select v from k where id = i $$;
create function pg_temp.areas_of(n int) returns text language sql as $$
  select coalesce(string_agg(coalesce(town_id::text, district_code, governorate_code), ',' order by position), '') from player_areas where profile_id = pg_temp.u(n) $$;

select pg_temp.keep('a1_prefs', pg_temp.prefs(pg_temp.u(1))::text);
select pg_temp.keep('a2_set', pg_temp.r(pg_temp.u(1), format($q$select set_playing_areas('[{"governorate":"beirut"},{"governorate":"north","district":"batroun","town":"%s"},{"governorate":"north","district":"tripoli"}]'::jsonb)::text$q$, pg_temp.town('Batroun'))));
select pg_temp.keep('a2_rows', pg_temp.areas_of(1));
select pg_temp.keep('a2_prefs', pg_temp.prefs(pg_temp.u(1))::text);
select pg_temp.keep('a4_set', pg_temp.r(pg_temp.u(1), $q$select set_playing_areas('[{"governorate":"south"},{"governorate":"beirut"},{"governorate":"south"}]'::jsonb)::text$q$));
select pg_temp.keep('a4_rows', pg_temp.areas_of(1));
select pg_temp.keep('a5_set', pg_temp.r(pg_temp.u(2), $q$select set_playing_areas('[]'::jsonb)::text$q$));
select pg_temp.keep('a5_prefs', pg_temp.prefs(pg_temp.u(2))::text);
select pg_temp.keep('a6_cross_gov', pg_temp.r(pg_temp.u(1), $q$select set_playing_areas('[{"governorate":"beirut"},{"governorate":"south","district":"batroun"}]'::jsonb)::text$q$));
select pg_temp.keep('a6_rows', pg_temp.areas_of(1));
select pg_temp.keep('a6_town_elsewhere', pg_temp.r(pg_temp.u(1), format($q$select set_playing_areas('[{"governorate":"north","district":"tripoli","town":"%s"}]'::jsonb)::text$q$, pg_temp.town('Batroun'))));
select pg_temp.keep('a6_town_no_district', pg_temp.r(pg_temp.u(1), format($q$select set_playing_areas('[{"governorate":"north","town":"%s"}]'::jsonb)::text$q$, pg_temp.town('Batroun'))));
select pg_temp.keep('a6_unknown_gov', pg_temp.r(pg_temp.u(1), $q$select set_playing_areas('[{"governorate":"atlantis"}]'::jsonb)::text$q$));
select pg_temp.keep('a6_bad_town', pg_temp.r(pg_temp.u(1), $q$select set_playing_areas('[{"governorate":"north","district":"batroun","town":"x"}]'::jsonb)::text$q$));
select pg_temp.keep('a6_not_object', pg_temp.r(pg_temp.u(1), $q$select set_playing_areas('["beirut"]'::jsonb)::text$q$));
select pg_temp.keep('a6_not_array', pg_temp.r(pg_temp.u(1), $q$select set_playing_areas('{"governorate":"beirut"}'::jsonb)::text$q$));
select pg_temp.keep('a6_rows_after', pg_temp.areas_of(1));
select pg_temp.keep('a7_eleven', pg_temp.r(pg_temp.u(1), (select format('select set_playing_areas(%L::jsonb)::text', jsonb_agg(jsonb_build_object('governorate', governorate_code, 'district', code)))
                                                       from (select code, governorate_code from districts order by code limit 11) x)));
select pg_temp.keep('a7_ten', pg_temp.r(pg_temp.u(1), (select format('select set_playing_areas(%L::jsonb)::text', jsonb_agg(jsonb_build_object('governorate', governorate_code, 'district', code)))
                                                    from (select code, governorate_code from districts order by code limit 10) x)));
select pg_temp.keep('a7_count', (select count(*)::text from player_areas where profile_id = pg_temp.u(1)));

insert into t values
  ('A1 a new player has not been asked, has no areas and no last area',
     pg_temp.got('a1_prefs')::jsonb = '{"asked": false, "areas": [], "last": null}'::jsonb, pg_temp.got('a1_prefs')),
  ('A2 several areas, with town-level refinement, in the player''s order',
     pg_temp.got('a2_set') not like 'ERR%' and pg_temp.got('a2_rows') = 'beirut,' || pg_temp.town('Batroun') || ',tripoli', pg_temp.got('a2_set')),
  ('A2 the areas come back named, with where they are',
     (select string_agg((a->>'label') || '/' || coalesce(a->>'within', '-'), ',') from jsonb_array_elements(pg_temp.got('a2_prefs')::jsonb->'areas') a)
       = 'Beirut/-,Batroun/Batroun,Tripoli/North', pg_temp.got('a2_prefs')),
  ('A3 answering counts as asked: the question is never shown again', (pg_temp.got('a2_prefs')::jsonb->>'asked')::boolean, ''),
  ('A4 replacing keeps only the new list; duplicates are dropped, first kept',
     pg_temp.got('a4_set') not like 'ERR%' and pg_temp.got('a4_rows') = 'south,beirut', pg_temp.got('a4_rows')),
  ('A5 an empty list is allowed ("anywhere") and counts as asked',
     pg_temp.got('a5_set') not like 'ERR%' and pg_temp.got('a5_prefs')::jsonb = '{"asked": true, "areas": [], "last": null}'::jsonb, pg_temp.got('a5_prefs')),
  ('A6 a district from another governorate is refused, nothing changed',
     pg_temp.got('a6_cross_gov') = 'ERR bad_area' and pg_temp.got('a6_rows') = 'south,beirut', pg_temp.got('a6_cross_gov')),
  ('A6 a town outside its district is refused', pg_temp.got('a6_town_elsewhere') = 'ERR bad_area', pg_temp.got('a6_town_elsewhere')),
  ('A6 a town without its district is refused', pg_temp.got('a6_town_no_district') = 'ERR bad_area', pg_temp.got('a6_town_no_district')),
  ('A6 an unknown governorate, a malformed town, a non-object, a non-array: refused',
     pg_temp.got('a6_unknown_gov') = 'ERR bad_area' and pg_temp.got('a6_bad_town') = 'ERR bad_area'
     and pg_temp.got('a6_not_object') = 'ERR bad_area' and pg_temp.got('a6_not_array') = 'ERR bad_request', ''),
  ('A6 ... and none of those changed the list', pg_temp.got('a6_rows_after') = 'south,beirut', pg_temp.got('a6_rows_after')),
  ('A7 at most 10 areas', pg_temp.got('a7_eleven') = 'ERR too_many_areas', pg_temp.got('a7_eleven')),
  ('A7 ten is fine', pg_temp.got('a7_ten') not like 'ERR%' and pg_temp.got('a7_count') = '10', pg_temp.got('a7_ten'));

-- the question: "Not now" also counts; a later answer still works
select pg_temp.keep('q1_dismiss', pg_temp.r(pg_temp.u(3), 'select dismiss_areas_question()'));
select pg_temp.keep('q1_prefs', pg_temp.prefs(pg_temp.u(3))::text);
select pg_temp.keep('q1_at', (select areas_asked_at::text from player_prefs where profile_id = pg_temp.u(3)));
select pg_temp.keep('q2_set', pg_temp.r(pg_temp.u(3), $q$select set_playing_areas('[{"governorate":"north"}]'::jsonb)::text$q$));
select pg_temp.keep('q2_prefs', pg_temp.prefs(pg_temp.u(3))::text);
select pg_temp.keep('q3_dismiss', pg_temp.r(pg_temp.u(3), 'select dismiss_areas_question()'));
select pg_temp.keep('q3_at', (select areas_asked_at::text from player_prefs where profile_id = pg_temp.u(3)));
insert into t values
  ('Q1 "Not now" marks the question answered without areas',
     pg_temp.got('q1_dismiss') = 'ok' and pg_temp.got('q1_prefs')::jsonb = '{"asked": true, "areas": [], "last": null}'::jsonb, pg_temp.got('q1_prefs')),
  ('Q2 the player can still add areas later',
     pg_temp.got('q2_set') not like 'ERR%' and jsonb_array_length(pg_temp.got('q2_prefs')::jsonb->'areas') = 1, pg_temp.got('q2_prefs')),
  ('Q3 answering or "Not now" again keeps the first time', pg_temp.got('q3_dismiss') = 'ok' and pg_temp.got('q3_at') = pg_temp.got('q1_at'), '');

-- last browsing area
select pg_temp.keep('l1_set', pg_temp.r(pg_temp.u(1), $q$select set_last_area('north', 'batroun')$q$));
select pg_temp.keep('l1_last', (pg_temp.prefs(pg_temp.u(1))->'last')::text);
select pg_temp.keep('l1_town', pg_temp.r(pg_temp.u(1), format($q$select set_last_area('north', 'batroun', %L)$q$, pg_temp.town('Batroun'))));
select pg_temp.keep('l1_town_last', pg_temp.prefs(pg_temp.u(1))->'last'->>'town');
select pg_temp.keep('l2_clear', pg_temp.r(pg_temp.u(1), 'select set_last_area(null)'));
select pg_temp.keep('l2_last', (pg_temp.prefs(pg_temp.u(1))->'last')::text);
select pg_temp.keep('l3_a', pg_temp.r(pg_temp.u(1), $q$select set_last_area('beirut', 'batroun')$q$));
select pg_temp.keep('l3_b', pg_temp.r(pg_temp.u(1), $q$select set_last_area(null, 'batroun')$q$));
select pg_temp.keep('l3_c', pg_temp.r(pg_temp.u(1), format($q$select set_last_area('north', null, %L)$q$, pg_temp.town('Batroun'))));
select pg_temp.keep('l3_d', pg_temp.r(pg_temp.u(1), format($q$select set_last_area('north', 'tripoli', %L)$q$, pg_temp.town('Batroun'))));
select pg_temp.keep('l4_set', pg_temp.r(pg_temp.u(4), $q$select set_last_area('beirut')$q$));
select pg_temp.keep('l4_asked', pg_temp.prefs(pg_temp.u(4))->>'asked');
insert into t values
  ('L1 the last area is remembered (district)', pg_temp.got('l1_set') = 'ok'
     and pg_temp.got('l1_last')::jsonb = '{"governorate": "north", "district": "batroun", "town": null, "label": "Batroun"}'::jsonb, pg_temp.got('l1_last')),
  ('L1 ... and a town', pg_temp.got('l1_town') = 'ok' and pg_temp.got('l1_town_last') = pg_temp.town('Batroun')::text, ''),
  ('L2 "All Lebanon" clears it', pg_temp.got('l2_clear') = 'ok' and pg_temp.got('l2_last') = 'null', pg_temp.got('l2_last')),
  ('L3 bad last areas refused (district elsewhere, district without governorate, town without district, town elsewhere)',
     pg_temp.got('l3_a') = 'ERR bad_area' and pg_temp.got('l3_b') = 'ERR bad_area' and pg_temp.got('l3_c') = 'ERR bad_area' and pg_temp.got('l3_d') = 'ERR bad_area', ''),
  ('L4 setting the last area does not answer the question for a new player', pg_temp.got('l4_set') = 'ok' and pg_temp.got('l4_asked') = 'false', '');

-- privacy and access (reads and refusals only: nothing here changes data)
insert into t values
  ('P1 a player reads only their own areas and prefs (table reads)',
     pg_temp.r(pg_temp.u(2), 'select count(*)::text from player_areas') = '0'
     and pg_temp.r(pg_temp.u(2), format('select count(*)::text from player_prefs where profile_id <> %L', pg_temp.u(2))) = '0', ''),
  ('P1 an admin reading the tables sees only their own rows', pg_temp.r(pg_temp.u(3), format('select count(*)::text from player_areas where profile_id <> %L', pg_temp.u(3))) = '0', ''),
  ('P2 no direct writes by players',
     pg_temp.r(pg_temp.u(1), $q$insert into player_areas (profile_id, position, governorate_code) values ('d8700000-0000-4000-8000-000000000001', 9, 'beirut')$q$) like 'ERR permission denied%'
     and pg_temp.r(pg_temp.u(1), $q$update player_prefs set areas_asked_at = null$q$) like 'ERR permission denied%'
     and pg_temp.r(pg_temp.u(1), $q$delete from player_areas$q$) like 'ERR permission denied%', ''),
  ('P3 signed out: nothing readable or callable',
     pg_temp.r(null, 'select count(*)::text from player_areas') like 'ERR permission denied%'
     and pg_temp.r(null, 'select my_playing_prefs()::text') like 'ERR permission denied%'
     and pg_temp.r(null, $q$select set_playing_areas('[]'::jsonb)::text$q$) like 'ERR permission denied%'
     and pg_temp.r(null, $q$select set_last_area('beirut')$q$) like 'ERR permission denied%'
     and pg_temp.r(null, 'select dismiss_areas_question()') like 'ERR permission denied%', ''),
  ('P4 the internal check is not callable by players', pg_temp.r(pg_temp.u(1), $q$select playing_area_checked('beirut', null, null)$q$) like 'ERR permission denied%', ''),
  ('P5 nothing stored is a position: no coordinate columns on the new tables',
     not exists (select 1 from information_schema.columns where table_name in ('player_areas', 'player_prefs') and column_name ~ '(lat|lng|lon|coord|point)'), '');

-- account deletion takes them (profile cascade)
delete from auth.users where id = pg_temp.u(1);
insert into t values
  ('D1 areas, prefs and favourites go with the account',
     (select count(*) from player_areas where profile_id = pg_temp.u(1)) = 0 and (select count(*) from player_prefs where profile_id = pg_temp.u(1)) = 0
     and (select count(*) from club_favourites where profile_id = pg_temp.u(1)) = 0, '');

-- =========================================================== club map points (0088, 0089)
create function pg_temp.settings(who int, lat numeric, lng numeric) returns text language sql as $$
  select pg_temp.r(pg_temp.u(who), format('select update_club_settings(%L, ''08:00'', ''23:00'', 30, 60, 120, 6, 10, 14, null, %L, %s, %s)::text',
         pg_temp.club('r-hidden'), pg_temp.town('Chekka'), coalesce(lat::text, 'null'), coalesce(lng::text, 'null'))) $$;
select pg_temp.keep('c1_half', pg_temp.settings(4, 34.3, null));
select pg_temp.keep('c2_set', pg_temp.settings(4, 34.3050, 35.7310));
select pg_temp.keep('c2_point', (select lat || ',' || lng from clubs where slug = 'r-hidden'));
select pg_temp.keep('c3_other', pg_temp.settings(2, 34.0, 35.5));
select pg_temp.keep('c4_clear', pg_temp.settings(4, null, null));
select pg_temp.keep('c4_point', (select coalesce(lat::text, 'null') || ',' || coalesce(lng::text, 'null') from clubs where slug = 'r-hidden'));
insert into t values
  ('C1 a half-filled map point is refused', pg_temp.got('c1_half') like 'ERR%clubs_map_point_pair%', pg_temp.got('c1_half')),
  ('C2 the club''s own staff correct the map point', pg_temp.got('c2_set') not like 'ERR%' and pg_temp.got('c2_point') = '34.305000,35.731000', pg_temp.got('c2_set')),
  ('C3 another club''s staff and players cannot', pg_temp.got('c3_other') = 'ERR forbidden', pg_temp.got('c3_other')),
  ('C4 clearing both is allowed', pg_temp.got('c4_clear') not like 'ERR%' and pg_temp.got('c4_point') = 'null,null', pg_temp.got('c4_clear')),
  ('C5 existing half-filled rows are not rewritten (the rule is NOT VALID)',
     (select not convalidated from pg_constraint where conname = 'clubs_map_point_pair'), '');

-- 0089: the readiness checklist asks for the map point; publishing waits for it
update clubs set address = 'Main road', contact_phone = '+96170000000' where slug = 'r-hidden';
select pg_temp.keep('m1_item', (select ok::text || '|' || detail from club_readiness_rows(pg_temp.club('r-hidden')) where item = 'location'));
-- publishing is the admin's (0078: only admins update clubs directly); 0081's trigger checks readiness then
select pg_temp.keep('m4_publish', pg_temp.r(pg_temp.u(3), format('update clubs set active = true where id = %L', pg_temp.club('r-hidden'))));
select pg_temp.keep('m4_active', (select active::text from clubs where slug = 'r-hidden'));
select pg_temp.keep('m2_set', pg_temp.settings(4, 34.3050, 35.7310));
select pg_temp.keep('m2_item', (select ok::text from club_readiness_rows(pg_temp.club('r-hidden')) where item = 'location'));
select pg_temp.keep('m3_items', (select string_agg(item, ',') from club_readiness_rows(pg_temp.club('r-hidden'))));
insert into t values
  ('M1 no map point: the location item says so', pg_temp.got('m1_item') = 'false|set the exact map point (latitude and longitude)', pg_temp.got('m1_item')),
  ('M4 publishing (by an admin) is refused while the map point is missing; the club stays unpublished',
     pg_temp.got('m4_publish') like 'ERR club_not_ready: location%' and pg_temp.got('m4_active') = 'false', pg_temp.got('m4_publish')),
  ('M2 with the map point, the location item passes', pg_temp.got('m2_set') not like 'ERR%' and pg_temp.got('m2_item') = 'true', pg_temp.got('m2_item')),
  ('M3 the rest of the checklist is 0081''s, unchanged (same items, same order)',
     pg_temp.got('m3_items') = 'name,location,contact,hours,courts,prices,prices_unambiguous,staff,payment', pg_temp.got('m3_items'));

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
