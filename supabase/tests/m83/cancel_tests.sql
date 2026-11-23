-- 0083 tests: a player cancels only before the start. Run by cancel.sh inside one transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
\i :mig
\i :mig
create temp table t (id text, pass boolean, detail text);
insert into t values ('C0 the migration applies twice without error', true, '');
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
create function pg_temp.u(n int) returns uuid language sql as $$ select ('c2000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
insert into auth.users (id) values (pg_temp.u(1)), (pg_temp.u(2));
insert into club_staff (club_id, profile_id) select id, pg_temp.u(2) from clubs where slug = 'batroun';
insert into courts (id, club_id, name, sport, active, sort) select pg_temp.u(900), id, 'C court', 'padel', true, 99 from clubs where slug = 'batroun';
alter table bookings disable trigger user;
insert into bookings (id, club_id, court_id, player_id, created_by, start_at, end_at, status, source, price_usd, fee_usd, hold_expires_at)
select pg_temp.u(100 + k), c.id, pg_temp.u(900), pg_temp.u(1), pg_temp.u(1), now() + s, now() + s + interval '1 hour', st::booking_status, 'app', 20, 0,
       case when st = 'pending' then now() + interval '5 min' end
from clubs c, (values (1, interval '-30 hours', 'confirmed'), (2, interval '-20 minutes', 'confirmed'), (3, interval '3 days', 'confirmed'),
                      (4, interval '-50 hours', 'confirmed'), (5, interval '-70 hours', 'pending')) v(k, s, st)
where c.slug = 'batroun';
alter table bookings enable trigger user;
insert into t values
  ('C1 a player cannot cancel a booking that is over', pg_temp.r(pg_temp.u(1), format($$select cancel_booking(%L)::text$$, pg_temp.u(101))) like 'ERR booking_started%', ''),
  ('C1 ...nor one being played now', pg_temp.r(pg_temp.u(1), format($$select cancel_booking(%L)::text$$, pg_temp.u(102))) like 'ERR booking_started%', ''),
  ('C2 a player still cancels an upcoming booking', pg_temp.r(pg_temp.u(1), format($$select cancel_booking(%L)::text$$, pg_temp.u(103))) = 'ok', ''),
  ('C3 the club''s staff can still correct a past booking', pg_temp.r(pg_temp.u(2), format($$select cancel_booking(%L, true)::text$$, pg_temp.u(104))) = 'ok', ''),
  ('C4 a hold can still be released by its player', pg_temp.r(pg_temp.u(1), format($$select cancel_booking(%L)::text$$, pg_temp.u(105))) = 'ok', '');
insert into t values
  ('C5 the refused ones are unchanged', (select bool_and(status = 'confirmed' and cancelled_at is null) from bookings where id in (pg_temp.u(101), pg_temp.u(102))), ''),
  ('C5 the allowed ones are cancelled', (select bool_and(status = 'cancelled') from bookings where id in (pg_temp.u(103), pg_temp.u(104), pg_temp.u(105))), '');
select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
