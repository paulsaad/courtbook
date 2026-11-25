-- 0093 (pilot, PR-8) functional checks after applying 0093: a closed account is refused by book_at_desk and
-- hold_slot with account_closed and leaves no booking; an open account still books (and a retry gets the same booking);
-- the older-app request still works and then refuses that person's next booking. Uses the demo club ('batroun'), one
-- temporary court and two temporary accounts (ids f0930000-…). ONE transaction, rolled back: nothing it does persists.
-- These answers are the SAME before 0093 (the insert guards refused a closed account too, only later): this run shows
-- that players see no change. That the refusal now comes before any court lock is shown by the postcheck (the text) and
-- the local race suite (supabase/tests/races/closed_account_booking.sh); concurrency is not tested on staging.
\set ON_ERROR_STOP 1
begin;
create temp table t (id text, pass boolean, detail text);
create temp table kept (k text primary key, v text);
grant all on t, kept to authenticated, service_role, anon;
create function pg_temp.keep(k text, v text) returns void language sql as $$ insert into kept values (k, v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.got(k text) returns text language sql as $$ select v from kept where kept.k = got.k $$;
-- runs q as a signed-in person; returns its first column as text, 'ok', or 'ERR <message>'
create function pg_temp.as_(who uuid, q text) returns text language plpgsql as $f$
declare res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', who, 'role', 'authenticated')::text, true);
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

-- setup (all rolled back): two people, one temporary court at the demo club, the club taking payment at the desk
insert into auth.users (id, email) values
  ('f0930000-0000-4000-8000-000000000001', 'pilot93-open@courtbook.test'),
  ('f0930000-0000-4000-8000-000000000002', 'pilot93-closed@courtbook.test');
update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app'
 where id in ('f0930000-0000-4000-8000-000000000001', 'f0930000-0000-4000-8000-000000000002');
insert into courts (club_id, name, sport, surface, sort)
  select id, 'zz-pilot93-1', 'padel', 'test', 993 from clubs where slug = 'batroun';
update clubs set payment_mode = 'at_desk' where slug = 'batroun';
insert into account_deletions (subject_id, requested_via, status, closing_at)
  values ('f0930000-0000-4000-8000-000000000002', 'app', 'closed', now());
select pg_temp.keep('court', (select id::text from courts where name = 'zz-pilot93-1'));
select pg_temp.keep('s', (((current_date + 2) + time '10:00') at time zone 'Asia/Beirut')::text);
select pg_temp.keep('e', (((current_date + 2) + time '11:30') at time zone 'Asia/Beirut')::text);
select pg_temp.keep('s2', (((current_date + 2) + time '14:00') at time zone 'Asia/Beirut')::text);
select pg_temp.keep('e2', (((current_date + 2) + time '15:30') at time zone 'Asia/Beirut')::text);
select pg_temp.keep('tok', gen_random_uuid()::text);

insert into t select 'F0 setup: the demo club, the temporary court and both accounts exist',
  pg_temp.got('court') is not null and (select count(*) from profiles where id::text like 'f0930000-%') = 2, pg_temp.got('court');

-- F1 a closed account at the desk: account_closed, and no booking row
insert into t select 'F1 a closed account is refused by book_at_desk (account_closed)', r ~ '^ERR account_closed', r
  from (select pg_temp.as_('f0930000-0000-4000-8000-000000000002',
    format('select booking_id::text from book_at_desk(%L, %L, %L, gen_random_uuid())', pg_temp.got('court'), pg_temp.got('s'), pg_temp.got('e')))) x(r);
insert into t select 'F2 ...and it left no booking', not exists (select 1 from bookings where player_id = 'f0930000-0000-4000-8000-000000000002'), null;

-- F3 an open account still books the same slot; a retry with the same token gets the same booking
insert into t select 'F3 an open account books at the desk', r ~ '^[0-9a-f-]{36}$', r
  from (select pg_temp.as_('f0930000-0000-4000-8000-000000000001',
    format('select booking_id::text from book_at_desk(%L, %L, %L, %L)', pg_temp.got('court'), pg_temp.got('s'), pg_temp.got('e'), pg_temp.got('tok')))) x(r);
insert into t select 'F4 a retry with the same token answers with the same booking',
  r = (select id::text from bookings where player_id = 'f0930000-0000-4000-8000-000000000001'), r
  from (select pg_temp.as_('f0930000-0000-4000-8000-000000000001',
    format('select booking_id::text from book_at_desk(%L, %L, %L, %L)', pg_temp.got('court'), pg_temp.got('s'), pg_temp.got('e'), pg_temp.got('tok')))) x(r);

-- F5 hold_slot (demo club in simulated mode): the closed account is refused the same way
update clubs set payment_mode = 'simulated' where slug = 'batroun';
insert into t select 'F5 a closed account is refused by hold_slot (account_closed)', r ~ '^ERR account_closed', r
  from (select pg_temp.as_('f0930000-0000-4000-8000-000000000002',
    format('select booking_id::text from hold_slot((select club_id from courts where id = %L), %L, %L, %L, gen_random_uuid())', pg_temp.got('court'), pg_temp.got('court'), pg_temp.got('s2'), pg_temp.got('e2')))) x(r);
update clubs set payment_mode = 'at_desk' where slug = 'batroun';

-- F6 the older-app request still works, and that person's next booking is then refused
insert into t select 'F6 the older-app request still records a request', r ~ 'requested', r
  from (select pg_temp.as_('f0930000-0000-4000-8000-000000000001', 'select request_account_deletion(''app'')::text')) x(r);
insert into t select 'F7 ...after which that person''s next desk booking is refused (account_closed)', r ~ '^ERR account_closed', r
  from (select pg_temp.as_('f0930000-0000-4000-8000-000000000001',
    format('select booking_id::text from book_at_desk(%L, %L, %L, gen_random_uuid())', pg_temp.got('court'), pg_temp.got('s2'), pg_temp.got('e2')))) x(r);
insert into t select 'F8 one live booking on the temporary court in all (F3''s)',
  (select count(*) from bookings where court_id = pg_temp.got('court')::uuid and status in ('confirmed', 'pending')) = 1, null;

insert into t select 'Z1 the 9 checks above all ran', (select count(*) from t) = 9, (select count(*) from t)::text;
select case when coalesce(pass, false) then 'ok   ' else 'FAIL ' end || id || case when coalesce(pass, false) then '' else '  [' || coalesce(detail, '') || ']' end from t order by id;
select format('%s checks, %s failed', count(*), count(*) filter (where not coalesce(pass, false))) from t;
rollback;
