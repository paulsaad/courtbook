-- Payments optional at launch (Paul, 26 Nov) and hold replacement against late provider answers (Paul, via the #75
-- handoff). ONE transaction, rolled back. No provider is contacted: record_attempt_result is what the server calls after
-- asking a provider.
--
-- O: with NO payment provider configured, a pay-at-desk club works end to end and nothing touches the payment tables.
-- R: the website retries hold_slot without a token (#75): the retry replaces the first hold. A provider answer that
--    arrives later for the first hold's attempt is recorded and owed back; it never revives that hold, never confirms
--    a second booking and never touches the replacement.
\set ON_ERROR_STOP 1
begin;
create temp table t (id text, pass boolean, detail text);
create temp table kept (k text primary key, v text);
grant all on t, kept to authenticated, service_role;
create function pg_temp.keep(k text, v text) returns void language sql as $$ insert into kept values (k, v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.got(k text) returns text language sql as $$ select v from kept where kept.k = got.k $$;
create function pg_temp.r(who uuid, q text) returns text language plpgsql as $f$
declare res text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  execute 'set local role authenticated';
  begin
    if q ~* '^\s*select' then execute q into res; else execute q; end if;
    res := coalesce(nullif(res, ''), 'ok');
  exception when others then res := 'ERR ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return res;
end $f$;
create function pg_temp.s(q text) returns text language plpgsql as $f$
declare res text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role service_role';
  begin
    if q ~* '^\s*select' then execute q into res; else execute q; end if;
    res := coalesce(nullif(res, ''), 'ok');
  exception when others then res := 'ERR ' || sqlerrm;
  end;
  execute 'reset role';
  return res;
end $f$;
create function pg_temp.u(n int) returns uuid language sql as $$ select ('f3000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.k(n int) returns uuid language sql as $$ select ('f3000000-0000-4000-9000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.c(n int) returns uuid language sql as $$ select ('f3000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.desk() returns uuid language sql as $$ select id from clubs where slug = 'zz-optional-desk' $$;
create function pg_temp.demo() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
create function pg_temp.at(d int, hhmm text) returns timestamptz language sql as $$ select ((current_date + d)::timestamp + hhmm::time) at time zone 'Asia/Beirut' $$;
create function pg_temp.uid(x text) returns uuid language sql as $$ select case when x ~ '^[0-9a-f-]{36}$' then x::uuid end $$;
create function pg_temp.part(k text, i int) returns text language sql as $$ select split_part(pg_temp.got(k), '|', i) $$;
create function pg_temp.bk(k text) returns uuid language sql as $$ select pg_temp.uid(pg_temp.part(k, 1)) $$;
create function pg_temp.py(k text) returns uuid language sql as $$ select pg_temp.uid(pg_temp.part(k, 2)) $$;
-- a hold at the demo club as the website makes it (no token unless given): 'booking|payment' or 'ERR …'
create function pg_temp.hold(n int, court int, d int, s text, e text, tok uuid default null) returns text language sql as $$
  select pg_temp.r(pg_temp.u(n), format('select booking_id || ''|'' || coalesce(payment_id::text, '''') from hold_slot(%L,%L,%L,%L,%L)',
    pg_temp.demo(), pg_temp.c(court), pg_temp.at(d, s), pg_temp.at(d, e), tok)) $$;
create function pg_temp.att(n int, pay uuid, key int) returns text language sql as $$
  select pg_temp.r(pg_temp.u(n), format('select attempt_id::text from start_payment_attempt(%L,%L)', pay, pg_temp.k(key))) $$;
create function pg_temp.res(a uuid, result text, ref text default null, amount numeric default null, cur text default null) returns text language sql as $$
  select pg_temp.s(format('select record_attempt_result(%L,%L,%L,%L,%L)', a, result, ref, amount, cur)) $$;
create function pg_temp.charges(pay uuid) returns text language sql as $$
  select coalesce(string_agg(x, ',' order by x), '') from (select disposition || coalesce(':' || reason, '') x from fee_charges where payment_id = pay) y $$;
create function pg_temp.live(court int, d int, s text, e text) returns bigint language sql as $$
  select count(*) from bookings where court_id = pg_temp.c(court) and status in ('pending', 'confirmed') and period && tstzrange(pg_temp.at(d, s), pg_temp.at(d, e)) $$;
create function pg_temp.money_rows() returns text language sql as $$
  select (select count(*) from payments) || '/' || (select count(*) from payment_attempts) || '/' || (select count(*) from fee_charges) $$;

insert into auth.users (id, phone) select pg_temp.u(n), '+9617662000' || lpad(n::text, 2, '0') from generate_series(1, 12) n;
update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id in (select pg_temp.u(n) from generate_series(1, 12) n);
update profiles set roles = '{player,admin}' where id = pg_temp.u(12);                  -- u12: CourtBook admin

-- ================================================================================================ O: no provider at all
do $$ begin perform set_config('app.payment_provider', '', true); end $$;
-- a new club, created as an admin would (no payment mode given)
insert into clubs (name, slug, location_url, slot_minutes, cancel_cutoff_hours, open_time, close_time, min_booking_minutes, max_booking_minutes)
values ('Optional Desk Club', 'zz-optional-desk', 'https://maps.example/x', 30, 6, '08:00', '23:00', 60, 180);
insert into t select 'O1 a new club takes payment at its desk unless an admin decides otherwise (default at_desk)',
  payment_mode = 'at_desk' and not is_demo, payment_mode from clubs where id = pg_temp.desk();
insert into courts (id, club_id, name, sport, sort) select pg_temp.c(n), pg_temp.desk(), 'zz-opt-' || n, 'padel', 940 + n from generate_series(1, 2) n;
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label)
select pg_temp.desk(), pg_temp.c(n), 127, '00:00', '23:59', 25, 'test' from generate_series(1, 2) n;
insert into club_staff (club_id, profile_id) values (pg_temp.desk(), pg_temp.u(11));     -- u11: the club's desk
update clubs set active = true, service_fee_usd = 0 where id = pg_temp.desk();          -- published (fixture; readiness is O2)

select pg_temp.keep('o_ready', pg_temp.s(format('select ok::text from club_readiness_rows(%L) where item = ''payment''', pg_temp.desk())));
insert into t values ('O2 the readiness check accepts pay-at-the-desk with no provider configured (payment item ok)', pg_temp.got('o_ready') = 'true', pg_temp.got('o_ready'));

select pg_temp.keep('o_fee', pg_temp.r(pg_temp.u(12), format('select set_club_payment_mode(%L, ''fee_online'')::text', pg_temp.desk())));
insert into t select 'O3 with no provider, an admin cannot switch a real club to online fees; it stays at the desk',
  pg_temp.got('o_fee') = 'ERR payments_not_configured' and payment_mode = 'at_desk', pg_temp.got('o_fee') from clubs where id = pg_temp.desk();

select pg_temp.keep('o_before', pg_temp.money_rows());
select pg_temp.keep('o_book', pg_temp.r(pg_temp.u(1), format('select booking_id::text from book_at_desk(%L,%L,%L,%L)', pg_temp.c(1), pg_temp.at(2, '10:00'), pg_temp.at(2, '11:00'), pg_temp.k(1))));
insert into t select 'O4 a player books at the desk with no provider: confirmed at once, court price frozen, no fee, and no payment, attempt or charge row anywhere',
  b.status = 'confirmed' and b.price_usd = 25 and b.fee_usd = 0 and b.hold_expires_at is null and pg_temp.money_rows() = pg_temp.got('o_before'),
  pg_temp.got('o_book') || ' rows ' || pg_temp.got('o_before') || ' -> ' || pg_temp.money_rows()
from bookings b where b.id = pg_temp.uid(pg_temp.got('o_book'));

select pg_temp.keep('o_hold', pg_temp.r(pg_temp.u(2), format('select booking_id::text from hold_slot(%L,%L,%L,%L)', pg_temp.desk(), pg_temp.c(2), pg_temp.at(2, '10:00'), pg_temp.at(2, '11:00'))));
insert into t values ('O5 the online-payment path cannot be entered at a desk club (hold_slot refused)', pg_temp.got('o_hold') = 'ERR wrong_payment_mode', pg_temp.got('o_hold'));

select pg_temp.keep('o_cancel', pg_temp.r(pg_temp.u(1), format('select cancel_booking(%L)::text', pg_temp.uid(pg_temp.got('o_book')))));
insert into t select 'O6 the player cancels the desk booking: cancelled, and still no payment row of any kind',
  pg_temp.got('o_cancel') = 'ok' and b.status = 'cancelled' and pg_temp.money_rows() = pg_temp.got('o_before'), pg_temp.got('o_cancel') || ' rows ' || pg_temp.money_rows()
from bookings b where b.id = pg_temp.uid(pg_temp.got('o_book'));

select pg_temp.keep('o_sweep', pg_temp.s($$select count(*)::text from attempts_to_check(interval '0 seconds', interval '30 days', 100)$$));
select pg_temp.keep('o_refunds', pg_temp.s($$select count(*)::text from fee_refunds_due()$$));
insert into t values ('O7 the server''s payment sweeps run with no provider and find nothing to do',
  pg_temp.got('o_sweep') = '0' and pg_temp.got('o_refunds') = '0', pg_temp.got('o_sweep') || ' / ' || pg_temp.got('o_refunds'));

-- ================================================================================================ R: hold replaced, late answers
-- a real provider configured; the demo club takes its fee online (its courts are ours: c3..c6)
do $$ begin perform set_config('app.payment_provider', 'whish', true); end $$;
insert into courts (id, club_id, name, sport, sort) select pg_temp.c(n), pg_temp.demo(), 'zz-opt-' || n, 'padel', 940 + n from generate_series(3, 6) n;
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label)
select pg_temp.demo(), pg_temp.c(n), 127, '00:00', '23:59', 25, 'test' from generate_series(3, 6) n;
update clubs set service_fee_usd = 1.00, cancel_cutoff_hours = 6, max_upcoming_bookings = 20 where id = pg_temp.demo();
select pg_temp.keep('r_mode', pg_temp.r(pg_temp.u(12), format('select set_club_payment_mode(%L, ''fee_online'')::text', pg_temp.demo())));

-- same slot: hold, payment page opened, the answer to Reserve is lost, the website retries without a token
select pg_temp.keep('r1', pg_temp.hold(3, 3, 3, '10:00', '11:00'));
select pg_temp.keep('r1_a', pg_temp.att(3, pg_temp.py('r1'), 1));
select pg_temp.keep('r1_open', pg_temp.s(format('select open_payment_attempt(%L, ''https://pay.example/r1'', ''sess-r1'')', pg_temp.uid(pg_temp.got('r1_a')))));
select pg_temp.keep('r2', pg_temp.hold(3, 3, 3, '10:00', '11:00'));
insert into t select 'R1 a token-less retry of the same slot replaces the hold: the first hold and its payment expire, one new hold owns the slot',
  pg_temp.got('r_mode') ~ '^[0-9]+$' and pg_temp.got('r1_open') = 'open'
  and b1.status = 'expired' and p1.status = 'expired' and b2.status = 'pending' and b2.id <> b1.id and pg_temp.live(3, 3, '10:00', '11:00') = 1,
  pg_temp.got('r1') || ' -> ' || pg_temp.got('r2') || ' ' || b1.status || '/' || p1.status
from bookings b1 join payments p1 on p1.booking_id = b1.id, bookings b2 where b1.id = pg_temp.bk('r1') and b2.id = pg_temp.bk('r2');

select pg_temp.keep('r1_late', pg_temp.res(pg_temp.uid(pg_temp.got('r1_a')), 'succeeded', 'W-r1', 1.00, 'USD'));
insert into t select 'R2 the first page''s payment succeeds afterwards: recorded and owed back; the replacement hold is untouched; still one live booking on the slot',
  pg_temp.got('r1_late') = 'late' and b1.status = 'expired' and p1.status = 'refund_due' and pg_temp.charges(p1.id) = 'refund_due:not_confirmed'
  and b2.status = 'pending' and p2.status = 'pending' and pg_temp.charges(p2.id) = '' and pg_temp.live(3, 3, '10:00', '11:00') = 1,
  pg_temp.got('r1_late') || ' ' || p1.status || ' ' || pg_temp.charges(p1.id) || ' | ' || b2.status || '/' || p2.status
from bookings b1 join payments p1 on p1.booking_id = b1.id, bookings b2 join payments p2 on p2.booking_id = b2.id
where b1.id = pg_temp.bk('r1') and b2.id = pg_temp.bk('r2');

select pg_temp.keep('r1_dup', pg_temp.res(pg_temp.uid(pg_temp.got('r1_a')), 'succeeded', 'W-r1', 1.00, 'USD'));
insert into t values ('R3 the same late answer again records nothing more', pg_temp.got('r1_dup') = 'already_recorded' and pg_temp.charges(pg_temp.py('r1')) = 'refund_due:not_confirmed', pg_temp.got('r1_dup'));

select pg_temp.keep('r2_a', pg_temp.att(3, pg_temp.py('r2'), 2));
select pg_temp.keep('r2_ok', pg_temp.res(pg_temp.uid(pg_temp.got('r2_a')), 'succeeded', 'W-r2', 1.00, 'USD'));
insert into t select 'R4 the replacement is paid: confirmed with one kept charge; the player is owed exactly the first $1 back; one booking on the slot',
  pg_temp.got('r2_ok') = 'confirmed' and b2.status = 'confirmed' and pg_temp.charges(pg_temp.py('r2')) = 'kept'
  and (select count(*) from fee_charges c join payments p on p.id = c.payment_id where p.profile_id = pg_temp.u(3) and c.disposition = 'refund_due') = 1
  and pg_temp.live(3, 3, '10:00', '11:00') = 1,
  pg_temp.got('r2_ok') || ' ' || b2.status
from bookings b2 where b2.id = pg_temp.bk('r2');

-- another court and time: hold on court 4 at 10:00, payment page opened, the player retries on court 5 at 12:00; the
-- 10:00 money arrives later. (On the same court the retry's own sweep would also expire the old payment; here only
-- the replacement rule does.)
select pg_temp.keep('r5', pg_temp.hold(4, 4, 3, '10:00', '11:00'));
select pg_temp.keep('r5_a', pg_temp.att(4, pg_temp.py('r5'), 5));
select pg_temp.keep('r6', pg_temp.hold(4, 5, 3, '12:00', '13:00'));
select pg_temp.keep('r5_pay', (select status::text from payments where id = pg_temp.py('r5')));
select pg_temp.keep('r5_late', pg_temp.res(pg_temp.uid(pg_temp.got('r5_a')), 'succeeded', 'W-r5', 1.00, 'USD'));
insert into t select 'R5 a retry elsewhere expires the first payment at once; its late success does NOT revive the free slot: owed back; the new hold is untouched',
  pg_temp.got('r5_pay') = 'expired' and pg_temp.got('r5_late') = 'late' and b5.status = 'expired' and pg_temp.charges(pg_temp.py('r5')) = 'refund_due:not_confirmed'
  and b6.status = 'pending' and pg_temp.live(4, 3, '10:00', '11:00') = 0 and pg_temp.live(5, 3, '12:00', '13:00') = 1,
  pg_temp.got('r5_pay') || ' then ' || pg_temp.got('r5_late') || ' ' || b5.status || ' | ' || b6.status
from bookings b5, bookings b6 where b5.id = pg_temp.bk('r5') and b6.id = pg_temp.bk('r6');

-- with a retry token (the app; the website could pass one too): the retry returns the same hold, so nothing is owed back
select pg_temp.keep('r7', pg_temp.hold(5, 5, 3, '10:00', '11:00', pg_temp.k(70)));
select pg_temp.keep('r7_a', pg_temp.att(5, pg_temp.py('r7'), 7));
select pg_temp.keep('r7_again', pg_temp.hold(5, 5, 3, '10:00', '11:00', pg_temp.k(70)));
select pg_temp.keep('r7_ok', pg_temp.res(pg_temp.uid(pg_temp.got('r7_a')), 'succeeded', 'W-r7', 1.00, 'USD'));
insert into t select 'R6 a retry with the same token gets the same hold back; its payment then confirms it with nothing owed back',
  pg_temp.bk('r7_again') = pg_temp.bk('r7') and pg_temp.got('r7_ok') = 'confirmed' and b.status = 'confirmed' and pg_temp.charges(pg_temp.py('r7')) = 'kept',
  pg_temp.got('r7') || ' / ' || pg_temp.got('r7_again') || ' ' || pg_temp.got('r7_ok')
from bookings b where b.id = pg_temp.bk('r7');

-- the first payment completed before the retry: the retry cannot take the slot a second time, nor charge again
select pg_temp.keep('r8', pg_temp.hold(6, 6, 3, '10:00', '11:00'));
select pg_temp.keep('r8_a', pg_temp.att(6, pg_temp.py('r8'), 8));
select pg_temp.keep('r8_ok', pg_temp.res(pg_temp.uid(pg_temp.got('r8_a')), 'succeeded', 'W-r8', 1.00, 'USD'));
select pg_temp.keep('r8_retry', pg_temp.hold(6, 6, 3, '10:00', '11:00'));
insert into t select 'R7 a token-less retry after the payment already confirmed the hold is refused: the paid booking stands, nothing new to pay',
  pg_temp.got('r8_ok') = 'confirmed' and pg_temp.got('r8_retry') like 'ERR %' and b.status = 'confirmed' and pg_temp.live(6, 3, '10:00', '11:00') = 1
  and (select count(*) from payments p where p.profile_id = pg_temp.u(6) and p.status = 'pending') = 0,
  pg_temp.got('r8_ok') || ' / ' || pg_temp.got('r8_retry')
from bookings b where b.id = pg_temp.bk('r8');

select case when coalesce(pass, false) then 'ok   ' else 'FAIL ' end || id || case when coalesce(pass, false) then '' else '  [' || coalesce(detail, '') || ']' end
from t order by left(id, 1) desc, (regexp_replace(split_part(id, ' ', 1), '\D', '', 'g'))::int;
rollback;
