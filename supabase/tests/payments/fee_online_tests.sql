-- M12.1 (0093): Model 2 — the club collects the court price; CourtBook collects its booking fee online through
-- provider-verified attempts. No provider is contacted: record_attempt_result and reconcile_provider_charge are what the
-- server calls after asking a provider. ONE transaction, rolled back. The demo club is switched to fee_online inside it.
\set ON_ERROR_STOP 1
begin;
create temp table t (id text, pass boolean, detail text);
create temp table kept (k text primary key, v text);
grant all on t, kept to authenticated, service_role;
create function pg_temp.keep(k text, v text) returns void language sql as $$ insert into kept values (k, v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.got(k text) returns text language sql as $$ select v from kept where kept.k = got.k $$;
-- as a signed-in person
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
-- as the server (service role, no user)
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
create function pg_temp.u(n int) returns uuid language sql as $$ select ('f1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.k(n int) returns uuid language sql as $$ select ('f1000000-0000-4000-9000-' || lpad(n::text, 12, '0'))::uuid $$;  -- request keys
create function pg_temp.club() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
create function pg_temp.c(n int) returns uuid language sql as $$ select ('f1000000-0000-4000-8000-0000000000c' || n)::uuid $$;
create function pg_temp.at(d int, hhmm text) returns timestamptz language sql as $$ select ((current_date + d)::timestamp + hhmm::time) at time zone 'Asia/Beirut' $$;
-- hold as player n: 'booking|payment|total|hold_expires_at' or 'ERR …'
create function pg_temp.hold(n int, court int, d int, s text, e text, tok uuid default null) returns text language sql as $$
  select pg_temp.r(pg_temp.u(n), format('select booking_id || ''|'' || coalesce(payment_id::text, '''') || ''|'' || coalesce(total_usd::text, '''') || ''|'' || coalesce(hold_expires_at::text, '''') from hold_slot(%L,%L,%L,%L,%L)',
    pg_temp.club(), pg_temp.c(court), pg_temp.at(d, s), pg_temp.at(d, e), tok)) $$;
create function pg_temp.part(k text, i int) returns text language sql as $$ select split_part(pg_temp.got(k), '|', i) $$;
-- a refusal ('ERR …') yields null, so a later check FAILS instead of the script stopping
create function pg_temp.uid(x text) returns uuid language sql as $$ select case when x ~ '^[0-9a-f-]{36}$' then x::uuid end $$;
create function pg_temp.bk(k text) returns uuid language sql as $$ select pg_temp.uid(pg_temp.part(k, 1)) $$;
create function pg_temp.py(k text) returns uuid language sql as $$ select pg_temp.uid(pg_temp.part(k, 2)) $$;
-- start an attempt as player n: 'attempt|no|already' or 'ERR …'
create function pg_temp.att(n int, pay uuid, key int) returns text language sql as $$
  select pg_temp.r(pg_temp.u(n), format('select attempt_id || ''|'' || attempt_no || ''|'' || already from start_payment_attempt(%L,%L)', pay, pg_temp.k(key))) $$;
create function pg_temp.aid(k text) returns uuid language sql as $$ select pg_temp.uid(split_part(pg_temp.got(k), '|', 1)) $$;
-- what the provider said about an attempt
create function pg_temp.res(a uuid, result text, ref text default null, amount numeric default null, cur text default null) returns text language sql as $$
  select pg_temp.s(format('select record_attempt_result(%L,%L,%L,%L,%L)', a, result, ref, amount, cur)) $$;
create function pg_temp.charges(pay uuid) returns text language sql as $$
  select coalesce(string_agg(x, ',' order by x), '') from (select disposition || coalesce(':' || reason, '') x from fee_charges where payment_id = pay) y $$;  -- sorted, so the text is stable

insert into auth.users (id, phone) select pg_temp.u(n), '+9617661000' || lpad(n::text, 2, '0') from generate_series(1, 30) n;
update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id in (select pg_temp.u(n) from generate_series(1, 30) n);
insert into club_staff (club_id, profile_id) values (pg_temp.club(), pg_temp.u(29));   -- u29: the club's desk
update profiles set roles = '{player,admin}' where id = pg_temp.u(30);                  -- u30: CourtBook admin
insert into courts (id, club_id, name, sport, sort) select pg_temp.c(n), pg_temp.club(), 'zz-fee-' || n, 'padel', 920 + n from generate_series(1, 6) n;
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label)
select pg_temp.club(), pg_temp.c(n), 127, '00:00', '23:59', 25, 'test' from generate_series(1, 6) n;
update clubs set service_fee_usd = 1.00, cancel_cutoff_hours = 6, max_upcoming_bookings = 20 where id = pg_temp.club();

-- a real (non-demo) club of the test's own, so the suite also runs on staging (rolled back; the local seed's 'other' club
-- does not exist there)
insert into clubs (name, slug, is_demo) values ('M12.1 test real club', 'zz-m121-real', false);
insert into courts (club_id, name, sport, sort) select id, 'zz-m121-real-1', 'padel', 990 from clubs where slug = 'zz-m121-real';

-- ------------------------------------------------------------------------------------------------ M mode
select pg_temp.keep('m_nondemo', pg_temp.r(pg_temp.u(30), format('select set_club_payment_mode(%L, ''fee_online'')::text', (select id from clubs where slug = 'zz-m121-real'))));
insert into t values ('M1 a real club cannot take fees online while no real provider is configured', pg_temp.got('m_nondemo') = 'ERR payments_not_configured', pg_temp.got('m_nondemo'));
select pg_temp.keep('m_staff', pg_temp.r(pg_temp.u(29), format('select set_club_payment_mode(%L, ''fee_online'')::text', pg_temp.club())));
insert into t values ('M2 club staff cannot change the payment mode', pg_temp.got('m_staff') = 'ERR forbidden', pg_temp.got('m_staff'));
select pg_temp.keep('m_demo', pg_temp.r(pg_temp.u(30), format('select set_club_payment_mode(%L, ''fee_online'')::text', pg_temp.club())));
insert into t select 'M3 an admin switches the demo club to fee_online', pg_temp.got('m_demo') ~ '^[0-9]+$' and payment_mode = 'fee_online', pg_temp.got('m_demo') from clubs where id = pg_temp.club();
-- a real club set to fee_online behind the admin function's back still never takes a simulated fee
update clubs set payment_mode = 'fee_online' where slug = 'zz-m121-real';
select pg_temp.keep('m_hold_nondemo', pg_temp.r(pg_temp.u(1), format('select booking_id::text from hold_slot(%L,%L,%L,%L)',
  (select id from clubs where slug = 'zz-m121-real'), (select id from courts where club_id = (select id from clubs where slug = 'zz-m121-real') limit 1), pg_temp.at(2, '10:00'), pg_temp.at(2, '11:00'))));
insert into t values ('M4 a hold at a real club with the simulated provider is refused (never a simulated fee for real)', pg_temp.got('m_hold_nondemo') = 'ERR payments_not_configured', pg_temp.got('m_hold_nondemo'));
update clubs set payment_mode = 'at_desk' where slug = 'zz-m121-real';

-- ------------------------------------------------------------------------------------------------ H holds
select pg_temp.keep('h1', pg_temp.hold(1, 1, 2, '10:00', '11:00'));
insert into t select 'H1 a fee_online hold: booking pending with the court price frozen ($25, paid at the desk) and a fee-only payment of exactly $1',
  b.status = 'pending' and b.price_usd = 25 and b.fee_usd = 1 and p.kind = 'fee_only' and p.amount_usd = 0 and p.fee_usd = 1 and p.total_usd = 1
  and p.status = 'pending' and pg_temp.part('h1', 3)::numeric = 1, pg_temp.got('h1')
from bookings b join payments p on p.booking_id = b.id where b.id = pg_temp.bk('h1');

update clubs set service_fee_usd = 0 where id = pg_temp.club();
select pg_temp.keep('h0', pg_temp.hold(2, 2, 2, '10:00', '11:00', pg_temp.k(900)));
select pg_temp.keep('h0_again', pg_temp.hold(2, 2, 2, '10:00', '11:00', pg_temp.k(900)));
update clubs set service_fee_usd = 1.00 where id = pg_temp.club();
insert into t select 'H2 HARD CRITERION 2: a $0 fee confirms at once and creates no payment row of any kind (a retry with the same token too)',
  b.status = 'confirmed' and b.fee_usd = 0 and b.price_usd = 25 and pg_temp.py('h0') is null and pg_temp.bk('h0_again') = pg_temp.bk('h0')
  and not exists (select 1 from payments where booking_id = b.id), pg_temp.got('h0') || ' / ' || pg_temp.got('h0_again')
from bookings b where b.id = pg_temp.bk('h0');
select pg_temp.keep('h_shape', pg_temp.s(format($$insert into payments (booking_id, club_id, provider, kind, amount_usd, fee_usd, total_usd) values (%L, %L, 'simulated', 'fee_only', 0, 0, 0)$$, pg_temp.bk('h0'), pg_temp.club())));
insert into t values ('H3 the database itself refuses a $0 fee-only payment row', pg_temp.got('h_shape') like 'ERR %payments_fee_only_shape%', pg_temp.got('h_shape'));
update clubs set max_upcoming_bookings = 1 where id = pg_temp.club();
select pg_temp.keep('h_cap', pg_temp.hold(2, 3, 3, '10:00', '11:00'));
update clubs set max_upcoming_bookings = 20 where id = pg_temp.club();
insert into t values ('H4 the club''s cap on upcoming bookings applies as at the desk', pg_temp.got('h_cap') = 'ERR too_many_upcoming', pg_temp.got('h_cap'));

-- ------------------------------------------------------------------------------------------------ A attempts
select pg_temp.keep('a1', pg_temp.att(1, pg_temp.py('h1'), 1));
select pg_temp.keep('a1_again', pg_temp.att(1, pg_temp.py('h1'), 1));
insert into t select 'A1 starting payment makes attempt 1 for $1 USD; the same request again returns the same attempt',
  split_part(pg_temp.got('a1'), '|', 2) = '1' and split_part(pg_temp.got('a1'), '|', 3) = 'false'
  and pg_temp.aid('a1_again') = pg_temp.aid('a1') and split_part(pg_temp.got('a1_again'), '|', 3) = 'true'
  and a.amount_usd = 1 and a.currency = 'USD' and a.status = 'starting' and (select count(*) from payment_attempts where payment_id = pg_temp.py('h1')) = 1,
  pg_temp.got('a1') || ' / ' || pg_temp.got('a1_again')
from payment_attempts a where a.id = pg_temp.aid('a1');
select pg_temp.keep('a_other', pg_temp.att(3, pg_temp.py('h1'), 2));
insert into t values ('A2 another player cannot start an attempt on someone else''s payment', pg_temp.got('a_other') = 'ERR not_found', pg_temp.got('a_other'));
select pg_temp.keep('a_direct', pg_temp.r(pg_temp.u(1), format('select record_attempt_result(%L, ''succeeded'', ''x'', 1, ''USD'')', pg_temp.aid('a1'))));
select pg_temp.keep('a_direct2', pg_temp.r(pg_temp.u(1), format('select reconcile_provider_charge(''simulated'', %L, ''x'', 1, ''USD'')', pg_temp.aid('a1'))));
select pg_temp.keep('a_direct3', pg_temp.r(pg_temp.u(1), $$insert into payment_attempts (payment_id, club_id, attempt_no, request_key, provider, amount_usd) select id, club_id, 3, gen_random_uuid(), 'simulated', 1 from payments limit 1$$));
insert into t values ('A3 a player can neither record a provider result, reconcile, nor write attempts directly',
  pg_temp.got('a_direct') like 'ERR permission denied%' and pg_temp.got('a_direct2') like 'ERR permission denied%' and pg_temp.got('a_direct3') like 'ERR permission denied%',
  pg_temp.got('a_direct') || ' / ' || pg_temp.got('a_direct2') || ' / ' || pg_temp.got('a_direct3'));

select pg_temp.keep('a1_open', pg_temp.s(format('select open_payment_attempt(%L, ''https://pay.example/1'', ''sess-1'')', pg_temp.aid('a1'))));
select pg_temp.keep('a1_fail', pg_temp.res(pg_temp.aid('a1'), 'failed'));
insert into t select 'A4 a failed attempt ends only the attempt: the hold, its deadline and the payment are untouched',
  pg_temp.got('a1_open') = 'open' and pg_temp.got('a1_fail') = 'failed' and b.status = 'pending' and p.status = 'pending'
  and b.hold_expires_at::text = pg_temp.part('h1', 4), pg_temp.got('a1_fail') || ' ' || b.status || '/' || p.status
from bookings b join payments p on p.booking_id = b.id where b.id = pg_temp.bk('h1');
select pg_temp.keep('a2', pg_temp.att(1, pg_temp.py('h1'), 3));
select pg_temp.keep('a2_bad_ev', pg_temp.res(pg_temp.aid('a2'), 'succeeded', null, 1, 'USD'));
insert into t values ('A5 a success without its evidence (reference, amount, currency) is refused', pg_temp.got('a2_bad_ev') = 'ERR evidence_incomplete', pg_temp.got('a2_bad_ev'));
select pg_temp.keep('a2_wrong', pg_temp.res(pg_temp.aid('a2'), 'succeeded', 'W-amt-1', 0.75, 'USD'));
insert into t select 'A6 HARD CRITERION 1: a success for a different amount is recorded as a charge owed back (amount received kept); the booking is not confirmed and stays payable',
  pg_temp.got('a2_wrong') = 'wrong_amount' and b.status = 'pending' and p.status = 'pending'
  and c.disposition = 'refund_due' and c.reason = 'wrong_amount' and c.amount = 0.75 and c.provider_ref = 'W-amt-1' and c.refund_due_at is not null,
  pg_temp.got('a2_wrong') || ' ' || pg_temp.charges(pg_temp.py('h1'))
from bookings b join payments p on p.booking_id = b.id join fee_charges c on c.attempt_id = pg_temp.aid('a2') where b.id = pg_temp.bk('h1');
select pg_temp.keep('a3', pg_temp.att(1, pg_temp.py('h1'), 4));
select pg_temp.keep('a4', pg_temp.att(1, pg_temp.py('h1'), 5));
insert into t values ('A7 at most three attempts per hold', split_part(pg_temp.got('a3'), '|', 2) = '3' and pg_temp.got('a4') = 'ERR attempts_exhausted', pg_temp.got('a3') || ' / ' || pg_temp.got('a4'));
select pg_temp.keep('a3_ok', pg_temp.res(pg_temp.aid('a3'), 'succeeded', 'W-ok-3', 1.00, 'usd'));
insert into t select 'A8 a verified success for the right amount confirms the booking; the payment records the attempt; exactly one kept charge',
  pg_temp.got('a3_ok') = 'confirmed' and b.status = 'confirmed' and b.hold_expires_at is null and p.status = 'paid' and p.provider_ref = pg_temp.aid('a3')::text
  and not p.collected and pg_temp.charges(p.id) = 'kept,refund_due:wrong_amount',
  pg_temp.got('a3_ok') || ' ' || pg_temp.charges(p.id)
from bookings b join payments p on p.booking_id = b.id where b.id = pg_temp.bk('h1');
select pg_temp.keep('a3_again', pg_temp.res(pg_temp.aid('a3'), 'succeeded', 'W-ok-3', 1.00, 'USD'));
select pg_temp.keep('a3_recon', pg_temp.s(format('select reconcile_provider_charge(''simulated'', %L, ''W-ok-3'', 1.00, ''USD'')', pg_temp.aid('a3'))));
insert into t select 'A9 the same success again (callback, return page, reconciliation): already recorded, nothing twice',
  pg_temp.got('a3_again') = 'already_recorded' and pg_temp.got('a3_recon') = 'already_recorded' and pg_temp.charges(pg_temp.py('h1')) = 'kept,refund_due:wrong_amount',
  pg_temp.got('a3_again') || ' / ' || pg_temp.got('a3_recon');
select pg_temp.keep('a3_conflict', pg_temp.res(pg_temp.aid('a3'), 'succeeded', 'W-other', 1.00, 'USD'));
insert into t values ('A10 the provider contradicting itself about the same attempt is refused, nothing changes', pg_temp.got('a3_conflict') = 'ERR attempt_evidence_conflict'
  and pg_temp.charges(pg_temp.py('h1')) = 'kept,refund_due:wrong_amount', pg_temp.got('a3_conflict'));
select pg_temp.keep('a3_failafter', pg_temp.res(pg_temp.aid('a3'), 'failed'));
insert into t select 'A11 a failure arriving after the success is ignored: booking stays confirmed', pg_temp.got('a3_failafter') = 'ignored' and b.status = 'confirmed', pg_temp.got('a3_failafter')
from bookings b where b.id = pg_temp.bk('h1');
-- the open attempt 1 (we marked it failed) now turns out to have taken the money too: a second success
select pg_temp.keep('a1_late_ok', pg_temp.res(pg_temp.aid('a1'), 'succeeded', 'W-dup-1', 1.00, 'USD'));
insert into t select 'A12 a second success for an already paid booking is recorded as a duplicate charge owed back; the booking is unchanged',
  pg_temp.got('a1_late_ok') = 'duplicate' and b.status = 'confirmed' and p.status = 'paid' and p.provider_ref = pg_temp.aid('a3')::text
  and pg_temp.charges(p.id) = 'kept,refund_due:duplicate,refund_due:wrong_amount',
  pg_temp.got('a1_late_ok') || ' ' || pg_temp.charges(p.id)
from bookings b join payments p on p.booking_id = b.id where b.id = pg_temp.bk('h1');
select pg_temp.keep('a_cur', pg_temp.hold(4, 1, 3, '10:00', '11:00'));
select pg_temp.keep('a_cur_a', pg_temp.att(4, pg_temp.py('a_cur'), 10));
select pg_temp.keep('a_cur_r', pg_temp.res(pg_temp.aid('a_cur_a'), 'succeeded', 'W-lbp-1', 1.00, 'LBP'));
insert into t select 'A13 a success in another currency is recorded and owed back; never a confirmation',
  pg_temp.got('a_cur_r') = 'wrong_currency' and b.status = 'pending' and pg_temp.charges(pg_temp.py('a_cur')) = 'refund_due:wrong_currency', pg_temp.got('a_cur_r')
from bookings b where b.id = pg_temp.bk('a_cur');
select pg_temp.keep('a_ref_reuse', pg_temp.res(pg_temp.aid('a_cur_a'), 'succeeded', 'W-ok-3', 1.00, 'USD'));
select pg_temp.keep('a_cur_b', pg_temp.att(4, pg_temp.py('a_cur'), 11));
select pg_temp.keep('a_ref_reuse2', pg_temp.res(pg_temp.aid('a_cur_b'), 'succeeded', 'W-ok-3', 1.00, 'USD'));
insert into t values ('A14 one provider charge can never pay for a second attempt', pg_temp.got('a_ref_reuse2') = 'ERR duplicate_provider_ref', pg_temp.got('a_ref_reuse') || ' / ' || pg_temp.got('a_ref_reuse2'));
select pg_temp.keep('a_cp', pg_temp.s(format('select confirm_payment(%L, ''legacy-1'', 1)', pg_temp.py('a_cur'))));
select pg_temp.keep('a_fp', pg_temp.s(format('select fail_payment(%L, ''legacy'')::text', pg_temp.py('a_cur'))));
insert into t values ('A15 the old Model 1 functions refuse a fee-only payment (no confirmation without an attempt; no hold killed by a failure)',
  pg_temp.got('a_cp') = 'ERR use_payment_attempts' and pg_temp.got('a_fp') = 'ERR use_payment_attempts', pg_temp.got('a_cp') || ' / ' || pg_temp.got('a_fp'));
-- the hold runs out: no new attempt, and the deadline was never moved by the attempts
update bookings set hold_expires_at = now() - interval '1 second' where id = pg_temp.bk('a_cur');
select pg_temp.keep('a_cur_c', pg_temp.att(4, pg_temp.py('a_cur'), 12));
insert into t values ('A16 no new attempt once the hold''s deadline has passed', pg_temp.got('a_cur_c') = 'ERR hold_expired', pg_temp.got('a_cur_c'));
-- another player takes the slot (sweeping the expired hold); then attempt b succeeds late
select pg_temp.keep('a_taker', pg_temp.hold(5, 1, 3, '10:00', '11:00'));
select pg_temp.keep('a_late', pg_temp.res(pg_temp.aid('a_cur_b'), 'succeeded', 'W-late-1', 1.00, 'USD'));
insert into t select 'A17 a success after the hold ended and the slot was taken: recorded and owed back; still exactly one live booking on the slot',
  pg_temp.got('a_late') = 'late' and b.status = 'expired' and p.status = 'refund_due' and p.provider_ref = pg_temp.aid('a_cur_b')::text
  and pg_temp.charges(p.id) = 'refund_due:not_confirmed,refund_due:wrong_currency'
  and (select count(*) from bookings where court_id = pg_temp.c(1) and status in ('pending', 'confirmed') and period && tstzrange(pg_temp.at(3, '10:00'), pg_temp.at(3, '11:00'))) = 1,
  pg_temp.got('a_late') || ' ' || b.status || '/' || p.status || ' ' || pg_temp.charges(p.id)
from bookings b join payments p on p.booking_id = b.id where b.id = pg_temp.bk('a_cur');
-- the player lets the hold go, then the success arrives
select pg_temp.keep('rel_a', pg_temp.att(5, pg_temp.py('a_taker'), 20));
select pg_temp.keep('rel', pg_temp.r(pg_temp.u(5), format('select release_hold(%L)::text', pg_temp.bk('a_taker'))));
select pg_temp.keep('rel_ok', pg_temp.res(pg_temp.aid('rel_a'), 'succeeded', 'W-rel-1', 1.00, 'USD'));
insert into t select 'A18 a success after the player released the hold: recorded and owed back, no booking',
  pg_temp.got('rel_ok') = 'late' and b.status = 'expired' and p.status = 'refund_due' and pg_temp.charges(p.id) = 'refund_due:not_confirmed', pg_temp.got('rel') || ' then ' || pg_temp.got('rel_ok')
from bookings b join payments p on p.booking_id = b.id where b.id = pg_temp.bk('a_taker');
-- an attempt we marked expired (no answer) turns out to have succeeded while the hold is still live: it confirms
select pg_temp.keep('ex_h', pg_temp.hold(6, 2, 3, '10:00', '11:00'));
select pg_temp.keep('ex_a', pg_temp.att(6, pg_temp.py('ex_h'), 30));
select pg_temp.keep('ex_exp', pg_temp.res(pg_temp.aid('ex_a'), 'expired'));
select pg_temp.keep('ex_ok', pg_temp.res(pg_temp.aid('ex_a'), 'succeeded', 'W-exp-1', 1.00, 'USD'));
insert into t select 'A19 money taken on an attempt we had given up on is still recorded (here the hold was live: confirmed)',
  pg_temp.got('ex_exp') = 'expired' and pg_temp.got('ex_ok') = 'confirmed' and b.status = 'confirmed', pg_temp.got('ex_exp') || ' then ' || pg_temp.got('ex_ok')
from bookings b where b.id = pg_temp.bk('ex_h');
select pg_temp.keep('ab_h', pg_temp.hold(7, 3, 3, '10:00', '11:00'));
select pg_temp.keep('ab_a', pg_temp.att(7, pg_temp.py('ab_h'), 40));
select pg_temp.keep('ab_x', pg_temp.s(format('select abandon_payment_attempt(%L, ''gateway refused'')', pg_temp.aid('ab_a'))));
select pg_temp.keep('ab_pending', pg_temp.res(pg_temp.aid('ab_a'), 'pending'));
insert into t select 'A20 an attempt the provider refused to start is failed and counts as one of the three; the hold is untouched',
  pg_temp.got('ab_x') = 'failed' and b.status = 'pending' and (select count(*) from payment_attempts where payment_id = pg_temp.py('ab_h')) = 1, pg_temp.got('ab_x')
from bookings b where b.id = pg_temp.bk('ab_h');

-- ------------------------------------------------------------------------------------------------ R reconciliation
select pg_temp.keep('rc_h', pg_temp.hold(8, 4, 2, '10:00', '11:00'));
select pg_temp.keep('rc_a', pg_temp.att(8, pg_temp.py('rc_h'), 50));
select pg_temp.keep('rc1', pg_temp.s(format('select reconcile_provider_charge(''simulated'', %L, ''R-1'', 1.00, ''USD'')', pg_temp.aid('rc_a'))));
select pg_temp.keep('rc2', pg_temp.s(format('select reconcile_provider_charge(''simulated'', %L, ''R-1'', 1.00, ''USD'')', pg_temp.aid('rc_a'))));
select pg_temp.keep('rc_cb', pg_temp.res(pg_temp.aid('rc_a'), 'succeeded', 'R-1', 1.00, 'USD'));
insert into t select 'R1 reconciliation of a known attempt confirms exactly like a callback; repeating it, or the callback arriving after, changes nothing',
  pg_temp.got('rc1') = 'confirmed' and pg_temp.got('rc2') = 'already_recorded' and pg_temp.got('rc_cb') = 'already_recorded' and b.status = 'confirmed'
  and pg_temp.charges(pg_temp.py('rc_h')) = 'kept', pg_temp.got('rc1') || ' / ' || pg_temp.got('rc2') || ' / ' || pg_temp.got('rc_cb')
from bookings b where b.id = pg_temp.bk('rc_h');
select pg_temp.keep('rc_conf', pg_temp.s(format('select reconcile_provider_charge(''simulated'', %L, ''R-1'', 2.00, ''USD'')', pg_temp.aid('rc_a'))));
insert into t values ('R2 the provider''s records disagreeing with a recorded charge are refused (for a person to look at)', pg_temp.got('rc_conf') = 'ERR charge_evidence_conflict', pg_temp.got('rc_conf'));
select pg_temp.keep('rc_un', pg_temp.s($$select reconcile_provider_charge('whish', 'not-ours-123', 'R-UN-1', 1.00, 'USD')$$));
select pg_temp.keep('rc_un2', pg_temp.s($$select reconcile_provider_charge('whish', 'not-ours-123', 'R-UN-1', 1.00, 'USD')$$));
insert into t select 'R3 a charge nobody can match is recorded as owed back (once), never dropped',
  pg_temp.got('rc_un') = 'unmatched' and pg_temp.got('rc_un2') = 'already_recorded' and c.disposition = 'refund_due' and c.reason = 'unmatched' and c.collected and c.payment_id is null,
  pg_temp.got('rc_un') || ' / ' || pg_temp.got('rc_un2')
from (select 1) one left join fee_charges c on c.provider = 'whish' and c.provider_ref = 'R-UN-1';
select pg_temp.keep('rc_sweep', pg_temp.s($$select count(*)::text from attempts_to_check(interval '-1 minute', interval '1 day', 50)$$));
insert into t values ('R4 the sweeper''s list holds the attempts still open, and only those',
  pg_temp.got('rc_sweep')::int = (select count(*) from payment_attempts where status in ('starting', 'open')), pg_temp.got('rc_sweep'));

-- review of PR #34, correction 4: the provider's own records prove a second, distinct charge on an attempt already paid
select pg_temp.keep('x_extra', pg_temp.s(format('select reconcile_provider_charge(''simulated'', %L, ''R-1-second'', 1.00, ''USD'')', pg_temp.aid('rc_a'))));
select pg_temp.keep('x_extra_again', pg_temp.s(format('select reconcile_provider_charge(''simulated'', %L, ''R-1-second'', 1.00, ''USD'')', pg_temp.aid('rc_a'))));
insert into t select 'R5 a second, distinct charge the provider''s records prove on a paid attempt is recorded and owed back; the booking, the payment and the attempt''s own charge are untouched; once only',
  pg_temp.got('x_extra') = 'extra_charge' and pg_temp.got('x_extra_again') = 'already_recorded'
  and b.status = 'confirmed' and p.status = 'paid' and p.provider_ref = pg_temp.aid('rc_a')::text and a.provider_ref = 'R-1' and a.outcome = 'confirmed'
  and pg_temp.charges(p.id) = 'kept,refund_due:extra_charge'
  and (select attempt_id from fee_charges where provider_ref = 'R-1-second') = pg_temp.aid('rc_a'),
  pg_temp.got('x_extra') || ' / ' || pg_temp.got('x_extra_again') || ' ' || pg_temp.charges(p.id)
from (select 1) one left join bookings b on b.id = pg_temp.bk('rc_h') left join payments p on p.booking_id = b.id left join payment_attempts a on a.id = pg_temp.aid('rc_a');
select pg_temp.keep('x_cb', pg_temp.res(pg_temp.aid('rc_a'), 'succeeded', 'R-1-third', 1.00, 'USD'));
select pg_temp.keep('x_amt', pg_temp.s(format('select reconcile_provider_charge(''simulated'', %L, ''R-1-second'', 5.00, ''USD'')', pg_temp.aid('rc_a'))));
insert into t values ('R6 a callback (or anything posing as the provider) still cannot add a charge to a paid attempt; records contradicting a recorded charge are still refused',
  pg_temp.got('x_cb') = 'ERR attempt_evidence_conflict' and pg_temp.got('x_amt') = 'ERR charge_evidence_conflict'
  and pg_temp.charges(pg_temp.py('rc_h')) = 'kept,refund_due:extra_charge', pg_temp.got('x_cb') || ' / ' || pg_temp.got('x_amt'));

-- review of PR #34 at 45f53dd: a reference already recorded counts as recorded only if amount, currency AND attempt agree
select pg_temp.keep('y_other_attempt', pg_temp.s(format('select reconcile_provider_charge(''simulated'', %L, ''R-1'', 1.00, ''USD'')', pg_temp.aid('a3'))));
select pg_temp.keep('y_unmatched_vs_attempt', pg_temp.s($$select reconcile_provider_charge('simulated', 'not-an-attempt', 'R-1', 1.00, 'USD')$$));
select pg_temp.keep('y_un_first', pg_temp.s($$select reconcile_provider_charge('simulated', 'not-ours-777', 'R-UN-S', 1.00, 'USD')$$));
select pg_temp.keep('y_attempt_vs_unmatched', pg_temp.s(format('select reconcile_provider_charge(''simulated'', %L, ''R-UN-S'', 1.00, ''USD'')', pg_temp.aid('rc_a'))));
select pg_temp.keep('y_cur', pg_temp.s($$select reconcile_provider_charge('whish', 'not-ours-123', 'R-UN-1', 1.00, 'EUR')$$));
insert into t values ('R7 the same provider reference under another attempt, under no attempt, or in another currency is a conflict, never already_recorded',
  pg_temp.got('y_other_attempt') = 'ERR charge_evidence_conflict' and pg_temp.got('y_unmatched_vs_attempt') = 'ERR charge_evidence_conflict'
  and pg_temp.got('y_cur') = 'ERR charge_evidence_conflict'
  and pg_temp.got('y_un_first') = 'unmatched' and pg_temp.got('y_attempt_vs_unmatched') = 'ERR charge_evidence_conflict'
  and (select count(*) from fee_charges where provider_ref in ('R-1', 'R-UN-1', 'R-UN-S')) = 3
  and (select attempt_id from fee_charges where provider_ref = 'R-UN-S') is null,
  concat_ws(' / ', pg_temp.got('y_other_attempt'), pg_temp.got('y_unmatched_vs_attempt'), pg_temp.got('y_attempt_vs_unmatched'), pg_temp.got('y_cur')));

-- review of PR #34, corrections 2 and 3: one unresolved attempt at a time; a provider timeout is not a failure
select pg_temp.keep('u_h', pg_temp.hold(15, 3, 4, '10:00', '11:00'));
select pg_temp.keep('u_a1', pg_temp.att(15, pg_temp.py('u_h'), 70));          -- the provider call then times out: no answer
select pg_temp.keep('u_a2', pg_temp.att(15, pg_temp.py('u_h'), 71));          -- a second tap, new key
select pg_temp.keep('u_a1_same', pg_temp.att(15, pg_temp.py('u_h'), 70));     -- the first tap retried, same key
select pg_temp.keep('u_listed', pg_temp.s(format($$select count(*)::text from attempts_to_check(interval '-1 minute', interval '1 day', 200) where attempt_id = %L$$, pg_temp.aid('u_a1'))));
insert into t select 'U1 while an attempt is unresolved (provider timed out: still ''starting''), a new attempt is refused; the same tap gets the same attempt; the sweeper keeps asking about it',
  pg_temp.got('u_a2') = 'ERR attempt_in_progress' and pg_temp.aid('u_a1_same') = pg_temp.aid('u_a1') and a.status = 'starting' and pg_temp.got('u_listed') = '1'
  and (select count(*) from payment_attempts where payment_id = pg_temp.py('u_h')) = 1,
  concat_ws(' / ', pg_temp.got('u_a2'), pg_temp.got('u_listed'), a.status)
from (select 1) one left join payment_attempts a on a.id = pg_temp.aid('u_a1');
-- the provider HAD created the session and the player paid; the callback was lost; the sweeper asks: confirmed
select pg_temp.keep('u_sweep', pg_temp.res(pg_temp.aid('u_a1'), 'succeeded', 'U-timeout-1', 1.00, 'USD'));
insert into t select 'U2 money taken on an attempt whose start timed out and whose callback was lost is found by asking the provider: the booking is confirmed',
  pg_temp.got('u_sweep') = 'confirmed' and b.status = 'confirmed' and pg_temp.charges(pg_temp.py('u_h')) = 'kept', pg_temp.got('u_sweep')
from (select 1) one left join bookings b on b.id = pg_temp.bk('u_h');
select pg_temp.keep('u2_h', pg_temp.hold(16, 4, 4, '10:00', '11:00'));
select pg_temp.keep('u2_a1', pg_temp.att(16, pg_temp.py('u2_h'), 72));
select pg_temp.keep('u2_open', pg_temp.s(format('select open_payment_attempt(%L, ''https://pay.example/u2'', ''s'')', pg_temp.aid('u2_a1'))));
select pg_temp.keep('u2_a2', pg_temp.att(16, pg_temp.py('u2_h'), 73));
select pg_temp.keep('_u2_exp', pg_temp.res(pg_temp.aid('u2_a1'), 'expired'));
select pg_temp.keep('u2_a3', pg_temp.att(16, pg_temp.py('u2_h'), 74));
insert into t values ('U3 an open payment page blocks a second attempt too; once the provider says it expired, the next attempt is made',
  pg_temp.got('u2_a2') = 'ERR attempt_in_progress' and split_part(pg_temp.got('u2_a3'), '|', 2) = '2', pg_temp.got('u2_a2') || ' / ' || pg_temp.got('u2_a3'));

-- ------------------------------------------------------------------------------------------------ C cancellations (D1)
-- real money from here (Whish), so refunds can be completed
do $$ begin perform set_config('app.payment_provider', 'whish', true); end $$;
create function pg_temp.paid(n int, court int, d int, s text, e text, key int, ref text) returns text language plpgsql as $f$
declare h text; a text;
begin
  h := pg_temp.hold(n, court, d, s, e);
  a := pg_temp.att(n, pg_temp.uid(split_part(h, '|', 2)), key);
  perform pg_temp.res(pg_temp.uid(split_part(a, '|', 1)), 'succeeded', ref, 1.00, 'USD');
  return h;
end $f$;
select pg_temp.keep('c_far', pg_temp.paid(10, 5, 4, '10:00', '11:00', 60, 'C-far'));
select pg_temp.keep('c_far_x', pg_temp.r(pg_temp.u(10), format('select cancel_booking(%L)::text', pg_temp.bk('c_far'))));
insert into t select 'C1 the player cancels days ahead (well before the 6-hour cutoff): the $1 fee is kept',
  pg_temp.got('c_far_x') = 'ok' and b.status = 'cancelled' and p.status = 'paid' and p.collected and pg_temp.charges(p.id) = 'kept', pg_temp.got('c_far_x') || ' ' || p.status || ' ' || pg_temp.charges(p.id)
from bookings b join payments p on p.booking_id = b.id where b.id = pg_temp.bk('c_far');
update clubs set cancel_cutoff_hours = 1000 where id = pg_temp.club();   -- every booking below is now inside the cutoff
select pg_temp.keep('c_near', pg_temp.paid(11, 6, 5, '10:00', '11:00', 61, 'C-near'));
select pg_temp.keep('c_near_x', pg_temp.r(pg_temp.u(11), format('select cancel_booking(%L)::text', pg_temp.bk('c_near'))));
update clubs set cancel_cutoff_hours = 6 where id = pg_temp.club();
insert into t select 'C2 the player cancels inside the cutoff: the fee is kept',
  pg_temp.got('c_near_x') = 'ok' and b.status = 'cancelled' and p.status = 'paid' and pg_temp.charges(p.id) = 'kept', pg_temp.got('c_near') || ' / ' || pg_temp.got('c_near_x')
from bookings b join payments p on p.booking_id = b.id where b.id = pg_temp.bk('c_near');
select pg_temp.keep('c_desk', pg_temp.paid(12, 5, 5, '10:00', '11:00', 62, 'C-desk'));
select pg_temp.keep('c_desk_x', pg_temp.r(pg_temp.u(29), format('select cancel_booking(%L, false)::text', pg_temp.bk('c_desk'))));
insert into t select 'C3 the desk cancels on the player''s behalf (not club-caused): the fee is kept',
  pg_temp.got('c_desk_x') = 'ok' and p.status = 'paid' and pg_temp.charges(p.id) = 'kept', pg_temp.got('c_desk_x')
from payments p where p.id = pg_temp.py('c_desk');
select pg_temp.keep('c_club', pg_temp.paid(13, 5, 6, '10:00', '11:00', 63, 'C-club'));
select pg_temp.keep('c_club_x', pg_temp.r(pg_temp.u(29), format('select cancel_booking(%L, true)::text', pg_temp.bk('c_club'))));
insert into t select 'C4 the club cancels (or closes the court): the fee is owed back, reason club_cancelled; the payment says so',
  pg_temp.got('c_club_x') = 'ok' and p.status = 'refund_due' and pg_temp.charges(p.id) = 'refund_due:club_cancelled', pg_temp.got('c_club_x') || ' ' || pg_temp.charges(p.id)
from payments p where p.id = pg_temp.py('c_club');
select pg_temp.keep('c_club_x2', pg_temp.r(pg_temp.u(29), format('select cancel_booking(%L, true)::text', pg_temp.bk('c_club'))));
insert into t values ('C5 cancelling again creates no second refund', pg_temp.got('c_club_x2') = 'ERR not_confirmed' and pg_temp.charges(pg_temp.py('c_club')) = 'refund_due:club_cancelled', pg_temp.got('c_club_x2'));
-- account deletion: a confirmed fee-only booking, plus a duplicate charge already owed back
select pg_temp.keep('c_del', pg_temp.hold(14, 6, 6, '10:00', '11:00'));
select pg_temp.keep('c_del_dup_a', pg_temp.att(14, pg_temp.py('c_del'), 64));
select pg_temp.keep('_c_del_exp', pg_temp.res(pg_temp.aid('c_del_dup_a'), 'expired'));                     -- given up on (no answer)
select pg_temp.keep('c_del_a', pg_temp.att(14, pg_temp.py('c_del'), 65));
select pg_temp.keep('c_del_ok', pg_temp.res(pg_temp.aid('c_del_a'), 'succeeded', 'C-del', 1.00, 'USD'));
select pg_temp.keep('c_del_dup', pg_temp.res(pg_temp.aid('c_del_dup_a'), 'succeeded', 'C-del-dup', 1.00, 'USD'));   -- it had taken the money after all
select pg_temp.keep('c_del_req', pg_temp.r(pg_temp.u(14), $$select request_account_deletion('web')->>'status'$$));
select pg_temp.keep('c_del_run', pg_temp.s(format('select delete_account_data(%L)->>''refunds_due''', pg_temp.u(14))));
insert into t select 'C6 account deletion cancels like the player: the fee is kept; the duplicate charge already owed back stays owed back',
  pg_temp.got('c_del_ok') = 'confirmed' and pg_temp.got('c_del_dup') = 'duplicate' and pg_temp.got('c_del_run') = '0'
  and b.status = 'cancelled' and p.status = 'paid' and pg_temp.charges(p.id) = 'kept,refund_due:duplicate',
  pg_temp.got('c_del_ok') || ' / ' || pg_temp.got('c_del_dup') || ' / ' || pg_temp.got('c_del_req') || ' / ' || pg_temp.got('c_del_run') || ' ' || b.status || ' ' || pg_temp.charges(p.id)
from bookings b join payments p on p.booking_id = b.id where b.id = pg_temp.bk('c_del');

-- ------------------------------------------------------------------------------------------------ F fee refunds (admin only)
select pg_temp.keep('f_staff_mark', pg_temp.r(pg_temp.u(29), format('select mark_refunded(%L)::text', pg_temp.py('c_club'))));
select pg_temp.keep('f_admin_mark', pg_temp.r(pg_temp.u(30), format('select mark_refunded(%L)::text', pg_temp.py('c_club'))));
insert into t values ('F1 club staff cannot mark CourtBook''s fee refunded (nor can mark_refunded be used for it at all)',
  pg_temp.got('f_staff_mark') = 'ERR courtbook_fee_refund' and pg_temp.got('f_admin_mark') = 'ERR courtbook_fee_refund', pg_temp.got('f_staff_mark') || ' / ' || pg_temp.got('f_admin_mark'));
select pg_temp.keep('f_staff_q', pg_temp.r(pg_temp.u(29), $$select count(*)::text from refunds_due() where payment_id in (select id from payments where kind = 'fee_only')$$));
select pg_temp.keep('f_staff_badge', pg_temp.r(pg_temp.u(29), format('select refunds_due::text from payments_summary(current_date) where club_id = %L', pg_temp.club())));
select pg_temp.keep('f_staff_fq', pg_temp.r(pg_temp.u(29), $$select count(*)::text from fee_refunds_due()$$));
select pg_temp.keep('f_staff_read', pg_temp.r(pg_temp.u(29), $$select count(*)::text from fee_charges$$));
insert into t values ('F2 the club''s refund queue and badge never list CourtBook fees; staff see no fee charges',
  pg_temp.got('f_staff_q') = '0' and coalesce(pg_temp.got('f_staff_badge'), '0') = '0' and pg_temp.got('f_staff_fq') = '0' and pg_temp.got('f_staff_read') = '0',
  concat_ws(' / ', pg_temp.got('f_staff_q'), pg_temp.got('f_staff_badge'), pg_temp.got('f_staff_fq'), pg_temp.got('f_staff_read')));
select pg_temp.keep('f_queue', pg_temp.r(pg_temp.u(30), format('select string_agg(reason, '','' order by reason) from fee_refunds_due() where club_name is not null and charge_id in (select id from fee_charges where payment_id in (%L, %L))',
  pg_temp.py('c_club'), pg_temp.py('c_del'))));
select pg_temp.keep('f_queue_sim', pg_temp.r(pg_temp.u(30), $$select count(*)::text from fee_refunds_due() f join fee_charges c on c.id = f.charge_id where not c.collected$$));
insert into t values ('F3 the admin''s queue lists real fees owed back (simulated ones never)', pg_temp.got('f_queue') = 'club_cancelled,duplicate'
  and pg_temp.got('f_queue_sim') = '0', pg_temp.got('f_queue') || ' / ' || pg_temp.got('f_queue_sim'));
create function pg_temp.club_charge() returns uuid language sql as $$ select id from fee_charges where payment_id = pg_temp.py('c_club') order by disposition limit 1 $$;
select pg_temp.keep('f_staff_done', pg_temp.r(pg_temp.u(29), format('select complete_fee_refund(%L, 1.00, ''provider_portal'', ''WR-1'')', pg_temp.club_charge())));
select pg_temp.keep('f_amt', pg_temp.r(pg_temp.u(30), format('select complete_fee_refund(%L, 0.50, ''provider_portal'', ''WR-1'')', pg_temp.club_charge())));
select pg_temp.keep('f_noref', pg_temp.r(pg_temp.u(30), format('select complete_fee_refund(%L, 1.00, ''provider_portal'', ''  '')', pg_temp.club_charge())));
select pg_temp.keep('f_ok', pg_temp.r(pg_temp.u(30), format('select complete_fee_refund(%L, 1.00, ''provider_portal'', ''WR-1'')', pg_temp.club_charge())));
insert into t select 'F4 only an admin completes a fee refund, for the exact amount, with a reference; amount, method, reference, time and who are recorded; the payment follows',
  pg_temp.got('f_staff_done') = 'ERR forbidden' and pg_temp.got('f_amt') = 'ERR refund_amount_mismatch' and pg_temp.got('f_noref') = 'ERR reference_required'
  and pg_temp.got('f_ok') = 'refunded' and c.disposition = 'refunded' and c.refund_amount = 1.00 and c.refund_method = 'provider_portal'
  and c.refund_reference = 'WR-1' and c.refunded_at is not null and c.refunded_by = pg_temp.u(30) and p.status = 'refunded' and p.refunded_at is not null,
  concat_ws(' / ', pg_temp.got('f_staff_done'), pg_temp.got('f_amt'), pg_temp.got('f_noref'), pg_temp.got('f_ok'))
from fee_charges c join payments p on p.id = c.payment_id where c.id = pg_temp.club_charge();
select pg_temp.keep('f_again', pg_temp.r(pg_temp.u(30), format('select complete_fee_refund(%L, 1.00, ''provider_portal'', ''WR-1'')', pg_temp.club_charge())));
select pg_temp.keep('f_again2', pg_temp.r(pg_temp.u(30), format('select complete_fee_refund(%L, 1.00, ''provider_portal'', ''WR-2'')', pg_temp.club_charge())));
select pg_temp.keep('f_reuse', pg_temp.r(pg_temp.u(30), format('select complete_fee_refund(%L, 1.00, ''provider_portal'', ''WR-1'')',
  (select id from fee_charges where payment_id = pg_temp.py('c_del') and reason = 'duplicate' limit 1))));
insert into t values ('F5 a refund is recorded once: the same entry again is a no-op; a different one is refused; one provider refund cannot settle two charges',
  pg_temp.got('f_again') = 'already_refunded' and pg_temp.got('f_again2') = 'ERR already_refunded' and pg_temp.got('f_reuse') = 'ERR refund_reference_used',
  concat_ws(' / ', pg_temp.got('f_again'), pg_temp.got('f_again2'), pg_temp.got('f_reuse')));
select pg_temp.keep('f_kept', pg_temp.r(pg_temp.u(30), format('select complete_fee_refund(%L, 1.00, ''provider_portal'', ''WR-9'')', (select id from fee_charges where payment_id = pg_temp.py('c_far') order by disposition limit 1))));
select pg_temp.keep('f_sim', pg_temp.r(pg_temp.u(30), format('select complete_fee_refund(%L, 0.75, ''provider_portal'', ''WR-8'')', (select id from fee_charges where provider_ref = 'W-amt-1' limit 1))));
select pg_temp.keep('f_extra_h', pg_temp.paid(17, 6, 7, '10:00', '11:00', 80, 'X-own'));
select pg_temp.keep('f_extra', pg_temp.s(format('select reconcile_provider_charge(''whish'', %L, ''X-second'', 1.00, ''USD'')',
  (select id from payment_attempts where payment_id = pg_temp.py('f_extra_h') limit 1))));
select pg_temp.keep('_f_extra_cx', pg_temp.r(pg_temp.u(29), format('select cancel_booking(%L, true)::text', pg_temp.bk('f_extra_h'))));   -- the attempt's own charge owed back too
select pg_temp.keep('f_extra_done', pg_temp.r(pg_temp.u(30), format('select complete_fee_refund(%L, 1.00, ''provider_portal'', ''WR-X2'')', (select id from fee_charges where provider_ref = 'X-second'))));
insert into t select 'F7 refunding an extra charge does not mark the booking''s own fee refunded (it is still owed)',
  pg_temp.got('f_extra') = 'extra_charge' and pg_temp.got('f_extra_done') = 'refunded' and p.status = 'refund_due'
  and pg_temp.charges(p.id) = 'refund_due:club_cancelled,refunded:extra_charge', concat_ws(' / ', pg_temp.got('f_extra'), pg_temp.got('f_extra_done'), p.status, pg_temp.charges(p.id))
from (select 1) one left join payments p on p.id = pg_temp.py('f_extra_h');
insert into t values ('F6 a kept fee cannot be "refunded"; simulated money is never refunded',
  pg_temp.got('f_kept') = 'ERR not_refund_due' and pg_temp.got('f_sim') = 'ERR never_collected', pg_temp.got('f_kept') || ' / ' || pg_temp.got('f_sim'));

-- ------------------------------------------------------------------------------------------------ V moves and descriptions
select pg_temp.keep('v_move', (select kind from move_price_plan((select b from bookings b where id = pg_temp.bk('ex_h')), pg_temp.c(2), pg_temp.at(3, '10:00'), pg_temp.at(3, '11:30'))));
insert into t values ('V1 a fee-only booking prices a move like an unpaid app booking (court still due at the desk), not like a court paid online',
  pg_temp.got('v_move') = 'agreement', pg_temp.got('v_move'));

-- ------------------------------------------------------------------------------------------------ I invariants over everything above
insert into t select 'I1 every successful attempt has exactly one charge, and every attempt-linked charge comes from a successful attempt',
  not exists (select 1 from payment_attempts a where a.status = 'succeeded' and (select count(*) from fee_charges c where c.attempt_id = a.id and c.reason is distinct from 'extra_charge') <> 1)
  and not exists (select 1 from fee_charges c join payment_attempts a on a.id = c.attempt_id where a.status <> 'succeeded'), null;
insert into t select 'I2 a fee-only payment is paid exactly when it has one kept charge; no booking ever has two kept charges',
  not exists (select 1 from payments p where p.kind = 'fee_only' and (p.status = 'paid') <> exists (select 1 from fee_charges c where c.payment_id = p.id and c.disposition = 'kept'))
  and not exists (select payment_id from fee_charges where disposition = 'kept' group by payment_id having count(*) > 1), null;
insert into t select 'I3 every confirmed fee-only booking was confirmed by a kept, provider-verified charge',
  not exists (select 1 from bookings b join payments p on p.booking_id = b.id where p.kind = 'fee_only' and b.status = 'confirmed'
              and not exists (select 1 from fee_charges c join payment_attempts a on a.id = c.attempt_id where c.payment_id = p.id and c.disposition = 'kept' and a.outcome = 'confirmed')), null;
insert into t select 'I4 no fee-only payment row for $0, and no payment row for a $0-fee booking',
  not exists (select 1 from payments where kind = 'fee_only' and (fee_usd <= 0 or total_usd <= 0))
  and not exists (select 1 from bookings b join payments p on p.booking_id = b.id where b.source = 'app' and b.fee_usd = 0 and b.club_id = pg_temp.club()), null;
insert into t select 'I5 money in = kept + owed back + refunded, charge by charge (nothing dropped)',
  (select count(*) from fee_charges) = (select count(*) from fee_charges where disposition in ('kept', 'refund_due', 'refunded'))
  and (select count(*) from payment_attempts where status = 'succeeded') + (select count(*) from fee_charges where reason in ('unmatched', 'extra_charge')) = (select count(*) from fee_charges), null;
insert into t select 'I7 never two unresolved attempts on one payment',
  not exists (select payment_id from payment_attempts where status in ('starting', 'open') group by payment_id having count(*) > 1), null;
insert into t select 'I6 still exactly one live booking per slot (no overlap on any court)',
  not exists (select 1 from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id and a.status in ('confirmed', 'pending') and b.status in ('confirmed', 'pending') and a.period && b.period), null;

-- every check above produced its row (a check reading a row that a mistake removed must fail, not vanish)
insert into t select 'Z1 all 59 checks ran', (select count(*) from t) = 59, (select count(*) from t)::text;

select case when coalesce(pass, false) then 'ok   ' else 'FAIL ' end || id || case when coalesce(pass, false) then '' else '  [' || coalesce(detail, '') || ']' end from t order by left(id, 1), (regexp_replace(split_part(id, ' ', 1), '\D', '', 'g'))::int;
select format('%s checks, %s failed', count(*), count(*) filter (where not coalesce(pass, false))) from t;
rollback;
