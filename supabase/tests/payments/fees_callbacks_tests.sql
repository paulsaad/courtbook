-- Payments preparation (Mission 6B/6C): the CourtBook fee at $0, $0.25, $0.50 and $1 end to end, and payment
-- provider answers that arrive late, twice or out of order. No provider is contacted; confirm_payment and
-- fail_payment are what a future gateway's callback would call. ONE transaction, rolled back. Fees on real clubs are
-- not changed: the test club's fee is set inside this transaction only.
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
-- a provider callback, as the server would make it (service role)
create function pg_temp.cb(pay uuid, ref text, total numeric) returns text language plpgsql as $f$
declare res text;
begin
  execute 'set local role service_role';
  begin res := confirm_payment(pay, ref, total); exception when others then res := 'ERR ' || sqlerrm; end;
  execute 'reset role';
  return res;
end $f$;
create function pg_temp.fail(pay uuid) returns text language plpgsql as $f$
declare res text;
begin
  execute 'set local role service_role';
  begin perform fail_payment(pay, 'provider said failed'); res := 'ok'; exception when others then res := 'ERR ' || sqlerrm; end;
  execute 'reset role';
  return res;
end $f$;
create function pg_temp.u(n int) returns uuid language sql as $$ select ('6b000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.club() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
create function pg_temp.c(n int) returns uuid language sql as $$ select ('6b000000-0000-4000-8000-0000000000c' || n)::uuid $$;
create function pg_temp.at(d int, hhmm text) returns timestamptz language sql as $$ select ((current_date + d)::timestamp + hhmm::time) at time zone 'Asia/Beirut' $$;
-- hold as player n: returns 'booking|payment|total' or 'ERR …'
create function pg_temp.hold(n int, court int, d int, s text, e text) returns text language sql as $$
  select pg_temp.r(pg_temp.u(n), format('select booking_id || ''|'' || payment_id || ''|'' || total_usd from hold_slot(%L,%L,%L,%L)', pg_temp.club(), pg_temp.c(court), pg_temp.at(d, s), pg_temp.at(d, e))) $$;
create function pg_temp.part(k text, i int) returns text language sql as $$ select split_part(pg_temp.got(k), '|', i) $$;
create function pg_temp.bk(k text) returns uuid language sql as $$ select nullif(pg_temp.part(k, 1), '')::uuid $$;
create function pg_temp.py(k text) returns uuid language sql as $$ select nullif(pg_temp.part(k, 2), '')::uuid $$;

insert into auth.users (id, phone) select pg_temp.u(n), '+9617660000' || n from generate_series(1, 9) n;
update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id in (select pg_temp.u(n) from generate_series(1, 9) n);
insert into club_staff (club_id, profile_id) values (pg_temp.club(), pg_temp.u(9));   -- u9: the club's desk
insert into courts (id, club_id, name, sport, sort) values (pg_temp.c(1), pg_temp.club(), 'zz-pay-1', 'padel', 911), (pg_temp.c(2), pg_temp.club(), 'zz-pay-2', 'padel', 912);
-- $25 an hour all day on the test courts, so every price below is known exactly
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values
  (pg_temp.club(), pg_temp.c(1), 127, '00:00', '23:59', 25, 'test'), (pg_temp.club(), pg_temp.c(2), 127, '00:00', '23:59', 25, 'test');
update clubs set payment_mode = 'simulated' where id = pg_temp.club();

-- ------------------------------------------------------------------------------------------------ 6B fees
do $$
declare f numeric; i int := 0;
begin
  foreach f in array array[0, 0.25, 0.50, 1.00] loop
    i := i + 1;
    update clubs set service_fee_usd = f where id = pg_temp.club();
    perform pg_temp.keep('fee' || i, pg_temp.hold(i, 1, 2, (9 + i)::text || ':00', (10 + i)::text || ':00'));
    perform pg_temp.keep('fee' || i || '_cb', pg_temp.cb(pg_temp.py('fee' || i), 'fee-ref-' || i, pg_temp.part('fee' || i, 3)::numeric));
  end loop;
end $$;
insert into t select format('F%s fee $%s: frozen on the booking and the payment; total = court + fee to the cent; the callback with that total confirms', n, fee),
  b.fee_usd = fee and p.fee_usd = fee and p.amount_usd = 25 and p.total_usd = 25 + fee and pg_temp.part('fee' || n, 3)::numeric = 25 + fee
  and pg_temp.got('fee' || n || '_cb') = 'confirmed' and b.status = 'confirmed' and p.status = 'paid' and scale(p.total_usd) = 2,
  pg_temp.got('fee' || n) || ' cb=' || pg_temp.got('fee' || n || '_cb')
from (values (1, 0::numeric), (2, 0.25), (3, 0.50), (4, 1.00)) v(n, fee)
left join bookings b on b.id = pg_temp.bk('fee' || n) left join payments p on p.id = pg_temp.py('fee' || n);

-- the fee changes while a player is paying: what they were shown is what is charged
update clubs set service_fee_usd = 0.50 where id = pg_temp.club();
select pg_temp.keep('chg', pg_temp.hold(5, 2, 2, '10:00', '11:00'));
update clubs set service_fee_usd = 1.00 where id = pg_temp.club();
select pg_temp.keep('chg_cb', pg_temp.cb(pg_temp.py('chg'), 'fee-ref-chg', 25.50));
insert into t select 'F5 a fee change during payment does not change the held booking (charged $0.50 as shown, not $1)',
  pg_temp.got('chg_cb') = 'confirmed' and p.fee_usd = 0.50 and p.total_usd = 25.50 and b.fee_usd = 0.50, pg_temp.got('chg') || ' ' || pg_temp.got('chg_cb')
from (select 1) one left join payments p on p.id = pg_temp.py('chg') left join bookings b on b.id = pg_temp.bk('chg');

-- reporting adds up for every fee (the staff export and the monthly summary read these)
select pg_temp.keep('list', pg_temp.r(pg_temp.u(9), format(
  $q$select count(*) || '|' || sum(amount_usd) || '|' || sum(fee_usd) || '|' || sum(total_usd) from payments_list(%L, %L) where provider_ref like 'fee-ref-%%'$q$,
  pg_temp.club(), date_trunc('month', pg_temp.at(2, '12:00') at time zone 'Asia/Beirut')::date)));
insert into t values ('F6 the payments export lists all five with court, fee and total adding up (fees $2.25 in all)',
  pg_temp.got('list') = '5|125.00|2.25|127.25', pg_temp.got('list'));
update profiles set roles = array_append(roles, 'admin') where id = pg_temp.u(8);
select pg_temp.keep('sum', pg_temp.r(pg_temp.u(8), format(
  $q$select simulated_bookings || '|' || simulated_total from payments_summary(%L) where club_id = %L$q$,
  date_trunc('month', pg_temp.at(2, '12:00') at time zone 'Asia/Beirut')::date, pg_temp.club())));
insert into t values ('F7 the monthly summary counts the five as test money (never as real takings)',
  split_part(pg_temp.got('sum'), '|', 1)::int >= 5 and pg_temp.got('sum') !~ '^ERR', pg_temp.got('sum'));
update profiles set roles = array_remove(roles, 'admin') where id = pg_temp.u(8);

-- the fee is whole cents: anything finer is refused, never rounded (0096; the old finding "rounded silently" is fixed)
update clubs set service_fee_usd = 1.00 where id = pg_temp.club();
select pg_temp.keep('subcent', 'unset');
do $$ begin update clubs set service_fee_usd = 0.255 where id = pg_temp.club(); perform pg_temp.keep('subcent', 'stored'); exception when check_violation then perform pg_temp.keep('subcent', 'refused'); end $$;
insert into t select 'F8 a fee with more than two decimals (0.255) is refused, and the fee stays as it was (0096)',
  pg_temp.got('subcent') = 'refused' and service_fee_usd = 1.00, pg_temp.got('subcent') || ' ' || service_fee_usd::text from clubs where id = pg_temp.club();
select pg_temp.keep('neg', (select 'ERR' from (select 1) one where false));
do $$ begin update clubs set service_fee_usd = -0.25 where id = pg_temp.club(); perform pg_temp.keep('neg', 'stored'); exception when check_violation then perform pg_temp.keep('neg', 'refused'); end $$;
insert into t values ('F9 a negative fee is refused', pg_temp.got('neg') = 'refused', pg_temp.got('neg'));

-- bookings the club takes itself never carry a CourtBook fee, whatever the fee is
select pg_temp.keep('staff', pg_temp.r(pg_temp.u(9), format('select staff_book(%L,%L,%L,%L,''Phone: Rami'',null)::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(3,'10:00'), pg_temp.at(3,'11:00'))));
insert into t select 'F10 a phone booking entered by the desk: no CourtBook fee, no payment, at a $1 club taking app payments',
  b.fee_usd = 0 and not exists (select 1 from payments where booking_id = b.id), pg_temp.got('staff')
from (select 1) one left join bookings b on b.id::text = pg_temp.got('staff');
update clubs set payment_mode = 'at_desk' where id = pg_temp.club();
select pg_temp.keep('desk', pg_temp.r(pg_temp.u(6), format('select booking_id::text from book_at_desk(%L,%L,%L,%L)', pg_temp.c(2), pg_temp.at(3,'12:00'), pg_temp.at(3,'13:00'), gen_random_uuid())));
insert into t select 'F11 a player booking at a pay-at-the-desk club: no CourtBook fee, no payment row',
  b.fee_usd = 0 and not exists (select 1 from payments where booking_id = b.id) and b.status = 'confirmed', pg_temp.got('desk')
from (select 1) one left join bookings b on b.id::text = pg_temp.got('desk');
update clubs set payment_mode = 'simulated' where id = pg_temp.club();

-- ------------------------------------------------------------------------------------------------ 6C callbacks
-- C1–C3 on the paid $1 booking (fee4)
select pg_temp.keep('dup', pg_temp.cb(pg_temp.py('fee4'), 'fee-ref-4', 26.00));
insert into t select 'C1 the same success delivered twice: already_paid, nothing changes',
  pg_temp.got('dup') = 'already_paid' and p.status = 'paid' and (select count(*) from payments where booking_id = pg_temp.bk('fee4')) = 1, pg_temp.got('dup')
from payments p where p.id = pg_temp.py('fee4');
select pg_temp.keep('other_ref', pg_temp.cb(pg_temp.py('fee4'), 'some-other-ref', 26.00));
insert into t select 'C2 a second, different success for a paid payment is refused (payment_mismatch), the first stands',
  pg_temp.got('other_ref') = 'ERR payment_mismatch' and p.provider_ref = 'fee-ref-4', pg_temp.got('other_ref') from payments p where p.id = pg_temp.py('fee4');
select pg_temp.keep('late_fail', pg_temp.fail(pg_temp.py('fee4')));
insert into t select 'C3 a failure arriving after the success is ignored: still paid and confirmed',
  pg_temp.got('late_fail') = 'ok' and p.status = 'paid' and b.status = 'confirmed', p.status || '/' || b.status
from payments p join bookings b on b.id = p.booking_id where p.id = pg_temp.py('fee4');

-- C4: failure first, then success (out of order): the slot was released, so the money is owed back
select pg_temp.keep('ooo', pg_temp.hold(6, 1, 4, '10:00', '11:00'));
select pg_temp.keep('ooo_fail', pg_temp.fail(pg_temp.py('ooo')));
select pg_temp.keep('ooo_ok', pg_temp.cb(pg_temp.py('ooo'), 'ooo-ref', pg_temp.part('ooo', 3)::numeric));
insert into t select 'C4 failure then success: no booking is made, the money is recorded as owed back (refund_due)',
  pg_temp.got('ooo_ok') = 'refund_due' and p.status = 'refund_due' and p.provider_ref = 'ooo-ref' and b.status <> 'confirmed', pg_temp.got('ooo_fail') || ' then ' || pg_temp.got('ooo_ok')
from payments p join bookings b on b.id = p.booking_id where p.id = pg_temp.py('ooo');

-- C5: delayed past the hold, and someone else booked the slot meanwhile
select pg_temp.keep('late', pg_temp.hold(7, 1, 5, '10:00', '11:00'));
update bookings set hold_expires_at = now() - interval '1 minute' where id = pg_temp.bk('late');
select pg_temp.keep('taker', pg_temp.hold(5, 1, 5, '10:00', '11:00'));
select pg_temp.keep('late_ok', pg_temp.cb(pg_temp.py('late'), 'late-ref', pg_temp.part('late', 3)::numeric));
insert into t select 'C5 success after the hold ran out and the slot went to someone else: refund_due, one booking on the slot',
  pg_temp.got('late_ok') = 'refund_due' and pg_temp.got('taker') !~ '^ERR'
  and (select count(*) from bookings where court_id = pg_temp.c(1) and status in ('confirmed', 'pending') and period && tstzrange(pg_temp.at(5,'10:00'), pg_temp.at(5,'11:00'))) = 1,
  pg_temp.got('late_ok') || ' taker=' || pg_temp.got('taker');

-- C6: a provider reference already used by another payment
select pg_temp.keep('reuse', pg_temp.cb(pg_temp.py('taker'), 'fee-ref-1', pg_temp.part('taker', 3)::numeric));
insert into t select 'C6 a reference already used for another payment is refused; this payment stays pending',
  pg_temp.got('reuse') = 'ERR duplicate_provider_ref' and p.status = 'pending', pg_temp.got('reuse') from payments p where p.id = pg_temp.py('taker');

-- C7: wrong amount (e.g. the provider took its own fee out)
select pg_temp.keep('amt', pg_temp.cb(pg_temp.py('taker'), 'amt-ref', pg_temp.part('taker', 3)::numeric - 0.25));
insert into t select 'C7 Model 1 (simulated, demo clubs only): a success for a different amount is refused (amount_mismatch). The real gateway path is the fee-only one (0093), where a wrong amount IS recorded as a charge owed back: hard criterion 1, fee_online_tests.sql A6',
  pg_temp.got('amt') = 'ERR amount_mismatch' and p.status = 'pending' and p.provider_ref is null, pg_temp.got('amt') from payments p where p.id = pg_temp.py('taker');

-- C8: the player released the hold, then the success arrives
select pg_temp.keep('rel', pg_temp.r(pg_temp.u(5), format('select release_hold(%L)::text', pg_temp.bk('taker'))));
select pg_temp.keep('rel_ok', pg_temp.cb(pg_temp.py('taker'), 'rel-ref', pg_temp.part('taker', 3)::numeric));
insert into t values ('C8 success after the player let the hold go: refund_due, no booking', pg_temp.got('rel_ok') = 'refund_due', pg_temp.got('rel') || ' then ' || pg_temp.got('rel_ok'));
select pg_temp.keep('rel_again', pg_temp.cb(pg_temp.py('taker'), 'rel-ref', pg_temp.part('taker', 3)::numeric));
insert into t values ('C9 that success delivered again: still refund_due, recorded once', pg_temp.got('rel_again') = 'refund_due'
  and (select count(*) from payments where provider_ref = 'rel-ref') = 1, pg_temp.got('rel_again'));

-- C10 the invariant over everything above
insert into t select 'C10 no money without a booking or a refund obligation: every paid payment has a confirmed booking; every other received payment is refund_due',
  not exists (select 1 from payments p join bookings b on b.id = p.booking_id where p.club_id = pg_temp.club() and p.provider_ref is not null
              and not ((p.status = 'paid' and b.status = 'confirmed') or p.status in ('refund_due', 'refunded'))),
  (select string_agg(p.status || '/' || b.status, ',') from payments p join bookings b on b.id = p.booking_id where p.club_id = pg_temp.club() and p.provider_ref is not null);

select case when coalesce(pass, false) then 'ok   ' else 'FAIL ' end || id || case when coalesce(pass, false) then '' else '  [' || coalesce(detail, '') || ']' end from t order by length(split_part(id, ' ', 1)), id;
select format('%s checks, %s failed', count(*), count(*) filter (where not coalesce(pass, false))) from t;
rollback;
