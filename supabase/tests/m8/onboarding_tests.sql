-- M8 tests: club onboarding readiness (0081). Run by onboarding.sh inside one transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
\i :mig
\i :mig
create temp table t (id text, pass boolean, detail text);
insert into t values ('O0 the migration applies twice without error', true, '');
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
create function pg_temp.u(n int) returns uuid language sql as $$ select ('d1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.x() returns uuid language sql as $$ select id from clubs where slug = 'm8-new-club' $$;
create function pg_temp.at(d int, h int) returns timestamptz language sql as $$
  select ((current_date + d)::timestamp + c.open_time + make_interval(hours => h)) at time zone c.timezone from clubs c where c.id = pg_temp.x() $$;
create function pg_temp.ready(who uuid) returns text language sql as $$
  select pg_temp.r(who, format($q$select string_agg(item || '=' || ok, ',' order by item) from club_readiness(%L)$q$, pg_temp.x())) $$;
-- 1 admin; 2 will be the new club's desk account; 3 staff of the demo club; 4 player
insert into auth.users (id, phone, email) select pg_temp.u(n), '+9617300' || lpad(n::text, 2, '0'), 'm8-' || n || '@courtbook.test' from generate_series(1, 4) n;
update profiles set roles = '{player,admin}' where id = pg_temp.u(1);
insert into club_staff (club_id, profile_id) select id, pg_temp.u(3) from clubs where slug = 'batroun';

-- 1. create
insert into t values ('O1 the admin creates a club (asking for it visible)', pg_temp.r(pg_temp.u(1), $$insert into clubs (name, slug, active) values ('M8 New Club', 'm8-new-club', true)$$) = 'ok', '');
insert into t values
  ('O1 ...it starts hidden anyway', (select not active from clubs where slug = 'm8-new-club'), ''),
  ('O1 a player cannot create a club', pg_temp.r(pg_temp.u(4), $$insert into clubs (name, slug) values ('Sneaky', 'm8-sneaky')$$) like 'ERR%', ''),
  ('O1 staff of another club cannot either', pg_temp.r(pg_temp.u(3), $$insert into clubs (name, slug) values ('Sneaky', 'm8-sneaky')$$) like 'ERR%', ''),
  ('O2 the hidden club is not discoverable', pg_temp.r(null, $$select count(*)::text from club_discovery() where slug = 'm8-new-club'$$) = '0'
     and pg_temp.r(pg_temp.u(4), $$select count(*)::text from clubs where slug = 'm8-new-club' and active$$) = '0', ''),
  ('O3 the checklist shows what is missing', pg_temp.ready(pg_temp.u(1)) = 'contact=false,courts=false,hours=true,location=false,name=true,payment=true,prices=false,prices_unambiguous=true,staff=false', pg_temp.ready(pg_temp.u(1))),
  ('O4 publishing an incomplete club is refused, naming what is missing', pg_temp.r(pg_temp.u(1), format($$update clubs set active = true where id = %L$$, pg_temp.x())) like 'ERR club_not_ready: location, contact, courts, prices, staff%', pg_temp.r(pg_temp.u(1), format($$update clubs set active = true where id = %L$$, pg_temp.x()))),
  ('O5 the checklist is not readable by a player, signed out, or another club''s staff', pg_temp.ready(pg_temp.u(4)) like 'ERR forbidden%'
     and pg_temp.ready(null) like 'ERR%' and pg_temp.ready(pg_temp.u(3)) like 'ERR forbidden%', '');

-- 2. staff
insert into t values ('O6 the admin assigns the desk account', pg_temp.r(pg_temp.u(1), format($$select add_club_staff(%L, 'm8-2@courtbook.test')::text$$, pg_temp.x())) not like 'ERR%', ''),
  ('O6 staff of another club cannot assign staff here', pg_temp.r(pg_temp.u(3), format($$select add_club_staff(%L, 'm8-4@courtbook.test')::text$$, pg_temp.x())) like 'ERR%', '');
-- 3. contact and location
insert into t values
  ('O7 the club''s staff set the contact', pg_temp.r(pg_temp.u(2), format($$select set_club_contact(%L, '+961 6 123 456', 'Desk@Example.test')::text$$, pg_temp.x())) = 'ok', ''),
  ('O7 another club''s staff cannot', pg_temp.r(pg_temp.u(3), format($$select set_club_contact(%L, '+961 6 000 000', null)::text$$, pg_temp.x())) like 'ERR forbidden%', ''),
  ('O7 a player cannot', pg_temp.r(pg_temp.u(4), format($$select set_club_contact(%L, '+961 6 000 000', null)::text$$, pg_temp.x())) like 'ERR forbidden%', ''),
  ('O7 a malformed phone or email is refused', pg_temp.r(pg_temp.u(2), format($$select set_club_contact(%L, 'call me', null)::text$$, pg_temp.x())) like 'ERR bad_contact%'
     and pg_temp.r(pg_temp.u(2), format($$select set_club_contact(%L, '+961 6 123 456', 'not-an-email')::text$$, pg_temp.x())) like 'ERR bad_contact%', '');
insert into t values
  ('O7 stored as given (email lower-cased)', (select contact_phone = '+961 6 123 456' and contact_email = 'desk@example.test' from clubs where id = pg_temp.x()), ''),
  ('O8 another club''s staff cannot change hours or location here', pg_temp.r(pg_temp.u(3), format($$select update_club_settings(%L, '08:00', '23:00', 30, 60, 120, 6, 10, 14, 'https://maps.example.test', null, null, null)::text$$, pg_temp.x())) like 'ERR%', ''),
  ('O8 the club''s staff set the location and hours', pg_temp.r(pg_temp.u(2), format($$select update_club_settings(%L, '08:00', '23:00', 30, 60, 120, 6, 10, 14, 'https://maps.example.test/m8', %L, null, null)::text$$, pg_temp.x(), (select id from towns limit 1))) not like 'ERR%', '');
-- 4. courts
insert into t values
  ('O9 the club''s staff add a court', pg_temp.r(pg_temp.u(2), format($$insert into courts (club_id, name, sport, sort) values (%L, 'M8 Padel 1', 'padel', 1)$$, pg_temp.x())) = 'ok', ''),
  ('O9 another club''s staff cannot add a court here', pg_temp.r(pg_temp.u(3), format($$insert into courts (club_id, name, sport, sort) values (%L, 'M8 Sneaky', 'padel', 2)$$, pg_temp.x())) like 'ERR%', ''),
  ('O9 a player cannot', pg_temp.r(pg_temp.u(4), format($$insert into courts (club_id, name, sport, sort) values (%L, 'M8 Sneaky', 'padel', 2)$$, pg_temp.x())) like 'ERR%', '');
-- 5. prices: weekdays only first
insert into t values ('O10 the club''s staff add a weekday price', pg_temp.r(pg_temp.u(2), format($$insert into price_rules (club_id, weekday_mask, start_time, end_time, price_usd) values (%L, 31, '08:00', '23:00', 30)$$, pg_temp.x())) = 'ok', '');
insert into t values
  ('O10 the checklist names the first start time without a price', pg_temp.r(pg_temp.u(2), format($$select detail from club_readiness(%L) where item = 'prices'$$, pg_temp.x())) like 'no price for M8 Padel 1, Saturday 08:00 and % more start times', pg_temp.r(pg_temp.u(2), format($$select detail from club_readiness(%L) where item = 'prices'$$, pg_temp.x()))),
  ('O10 still not publishable', pg_temp.r(pg_temp.u(1), format($$update clubs set active = true where id = %L$$, pg_temp.x())) like 'ERR club_not_ready: prices%', ''),
  ('O11 another club''s staff cannot add a price here', pg_temp.r(pg_temp.u(3), format($$insert into price_rules (club_id, weekday_mask, start_time, end_time, price_usd) values (%L, 96, '08:00', '23:00', 1)$$, pg_temp.x())) like 'ERR%', '');
insert into t values ('O10 the weekend price', pg_temp.r(pg_temp.u(2), format($$insert into price_rules (club_id, weekday_mask, start_time, end_time, price_usd) values (%L, 96, '08:00', '23:00', 40)$$, pg_temp.x())) = 'ok', '');
create temp table o12 as select pg_temp.r(pg_temp.u(2), format($$insert into price_rules (club_id, weekday_mask, start_time, end_time, price_usd, label) values (%L, 1, '18:00', '20:00', 50, 'm8 overlap')$$, pg_temp.x())) as res;
insert into t select 'O12 an overlapping price is refused by the existing guard (price_rule_overlap)', res like 'ERR price_rule_overlap%', res from o12;
-- older data could hold an overlap written before that guard: the checklist names it (written here with triggers off)
alter table price_rules disable trigger user;
insert into price_rules (club_id, weekday_mask, start_time, end_time, price_usd, label) values (pg_temp.x(), 1, '18:00', '20:00', 50, 'm8 overlap');
alter table price_rules enable trigger user;
insert into t values
  ('O12 ...named in the checklist', pg_temp.r(pg_temp.u(1), format($$select (not ok and detail like 'two prices overlap: all courts%%')::text from club_readiness(%L) where item = 'prices_unambiguous'$$, pg_temp.x())) = 'true', ''),
  ('O12 a court-specific price over a club-wide one is fine (the court''s price wins, as in quote_price)', true, '');
delete from price_rules where label = 'm8 overlap';
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label)
  select pg_temp.x(), id, 1, '18:00', '20:00', 50, 'm8 court peak' from courts where name = 'M8 Padel 1';
insert into t values
  ('O12 checklist complete', pg_temp.ready(pg_temp.u(2)) = 'contact=true,courts=true,hours=true,location=true,name=true,payment=true,prices=true,prices_unambiguous=true,staff=true', pg_temp.ready(pg_temp.u(2))),
  ('O13 the club''s staff cannot publish (an admin decision)', pg_temp.r(pg_temp.u(2), format($$update clubs set active = true where id = %L$$, pg_temp.x())) = 'ok', '');
insert into t values
  ('O13 ...the staff update changed nothing', (select not active from clubs where id = pg_temp.x()), ''),
  ('O13 the admin publishes the ready club', pg_temp.r(pg_temp.u(1), format($$update clubs set active = true where id = %L$$, pg_temp.x())) = 'ok', '');
insert into t values
  ('O14 the club is now discoverable', pg_temp.r(null, $$select count(*)::text from club_discovery() where slug = 'm8-new-club'$$) = '1', ''),
  ('O14 a player books it; the price comes from its rules', pg_temp.r(pg_temp.u(4), format($$select book_at_desk(%L, %L, %L, gen_random_uuid())::text$$,
       (select id from courts where name = 'M8 Padel 1'), pg_temp.at(5, 2), pg_temp.at(5, 2) + interval '60 min')) not like 'ERR%', '');
insert into t values
  ('O14 ...booked at a configured price', (select price_usd in (30, 40) from bookings where player_id = pg_temp.u(4) and club_id = pg_temp.x()), ''),
  ('O15 booking safety unchanged: the same slot cannot be booked twice', pg_temp.r(pg_temp.u(1), format($$select book_at_desk(%L, %L, %L, gen_random_uuid())::text$$,
       (select id from courts where name = 'M8 Padel 1'), pg_temp.at(5, 2), pg_temp.at(5, 2) + interval '60 min')) like 'ERR%', '');
-- 6. after publishing: hiding is always possible; republishing needs the checks again
-- 0092: a court with an upcoming booking cannot be deactivated (its bookings would vanish from the desk's calendar)
insert into t values ('O16a deactivating a court that still has an upcoming booking is refused (court_has_bookings)',
  pg_temp.r(pg_temp.u(2), format($$update courts set active = false where club_id = %L$$, pg_temp.x())) = 'ERR court_has_bookings', '');
update bookings set status = 'cancelled' where club_id = pg_temp.x() and status in ('confirmed', 'pending');   -- the desk cancels it first
insert into t values ('O16 deactivating the only court: the checklist warns, the club is not hidden by surprise',
  pg_temp.r(pg_temp.u(2), format($$update courts set active = false where club_id = %L$$, pg_temp.x())) = 'ok', '');
insert into t values
  ('O16 ...warned', pg_temp.r(pg_temp.u(1), format($$select ok::text from club_readiness(%L) where item = 'courts'$$, pg_temp.x())) = 'false'
     and (select active from clubs where id = pg_temp.x()), ''),
  ('O17 the admin can always hide a club', pg_temp.r(pg_temp.u(1), format($$update clubs set active = false where id = %L$$, pg_temp.x())) = 'ok', '');
insert into t values
  ('O17 republishing it incomplete is refused', pg_temp.r(pg_temp.u(1), format($$update clubs set active = true where id = %L$$, pg_temp.x())) like 'ERR club_not_ready: courts, prices%', ''),
  ('O18 other admin edits of a visible club are not blocked by the checklist', pg_temp.r(pg_temp.u(1), $$update clubs set name = name where slug = 'batroun'$$) = 'ok', '');
-- server context
do $$ begin
  insert into clubs (name, slug, active) values ('M8 Seeded', 'm8-seeded', true);
  insert into t values ('O19 server work (seeds, SQL editor) is trusted: a seeded club keeps active', (select active from clubs where slug = 'm8-seeded'), '');
exception when others then insert into t values ('O19 server work (seeds, SQL editor) is trusted: a seeded club keeps active', false, sqlerrm);
end $$;
insert into t values
  ('O20 grants: signed-out visitors can run none of it', not has_function_privilege('anon', 'club_readiness(uuid)', 'execute')
     and not has_function_privilege('anon', 'set_club_contact(uuid,text,text)', 'execute'), ''),
  ('O20 the internal checklist is not callable by signed-in users', not has_function_privilege('authenticated', 'club_readiness_rows(uuid)', 'execute'), '');

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
