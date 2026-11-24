-- Club set-up (0092): one price for all opening hours with peak exceptions, no ambiguous prices, quoting, and a court
-- with bookings that cannot vanish from the desk. ONE transaction, rolled back.
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
create function pg_temp.u(n int) returns uuid language sql as $$ select ('c5000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
insert into auth.users (id, phone) values (pg_temp.u(1), '+96176600001'), (pg_temp.u(2), '+96176600002'), (pg_temp.u(3), '+96176600003');
update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id in (pg_temp.u(1), pg_temp.u(2), pg_temp.u(3));
-- a new club (as an admin would create it), with two courts; u1 is its desk, u2 another club's desk, u3 a player
insert into clubs (id, name, slug, active, open_time, close_time, slot_minutes, min_booking_minutes, max_booking_minutes, payment_mode)
values ('c5000000-0000-4000-8000-0000000000aa', 'Set-up Club', 'zz-setup', true, '08:00', '23:00', 30, 60, 180, 'at_desk');
create function pg_temp.club() returns uuid language sql as $$ select 'c5000000-0000-4000-8000-0000000000aa'::uuid $$;
insert into courts (id, club_id, name, sport) values ('c5000000-0000-4000-8000-0000000000c1', pg_temp.club(), 'Setup 1', 'padel'), ('c5000000-0000-4000-8000-0000000000c2', pg_temp.club(), 'Setup 2', 'padel');
create function pg_temp.c(n int) returns uuid language sql as $$ select ('c5000000-0000-4000-8000-0000000000c' || n)::uuid $$;
insert into club_staff (club_id, profile_id) values (pg_temp.club(), pg_temp.u(1));
insert into club_staff (club_id, profile_id) select id, pg_temp.u(2) from clubs where slug = 'other';
-- a day of the week: next Monday and next Saturday (isodow 1 and 6)
create function pg_temp.day(isodow int) returns date language sql as $$ select current_date + 7 + ((isodow - extract(isodow from current_date)::int + 7) % 7) $$;
create function pg_temp.at(dw int, hhmm text) returns timestamptz language sql as $$ select (pg_temp.day(dw)::timestamp + hhmm::time) at time zone 'Asia/Beirut' $$;
create function pg_temp.q(court int, dw int, s text, e text) returns numeric language sql as $$ select quote_price(pg_temp.c(court), pg_temp.at(dw, s), pg_temp.at(dw, e)) $$;
create function pg_temp.rules() returns text language sql as $$
  select string_agg(format('%s %s-%s %s%s', weekday_mask, to_char(start_time, 'HH24:MI'), to_char(end_time, 'HH24:MI'), price_usd, coalesce(' ' || label, '')), '; ' order by weekday_mask, start_time)
  from price_rules where club_id = pg_temp.club() and court_id is null $$;
create function pg_temp.ready(item text) returns boolean language sql as $$ select ok from club_readiness_rows(pg_temp.club()) where club_readiness_rows.item = ready.item $$;
create function pg_temp.base(who int, base numeric, peaks text default '[]', repl boolean default false) returns text language sql as $$
  select pg_temp.r(pg_temp.u(who), format('select set_club_base_prices(%L, %s, %L::jsonb, %L::boolean)::text', pg_temp.club(), base, peaks, repl)) $$;

-- ---------------------------------------------------------------- one price for all opening hours
select pg_temp.keep('b1', pg_temp.base(1, 20));
insert into t values ('S1 one price for all opening hours: one rule, every day, opening to closing',
  pg_temp.got('b1') = '1' and pg_temp.rules() = '127 08:00-23:00 20.00', pg_temp.got('b1') || ' | ' || pg_temp.rules());
insert into t values ('S2 the checklist''s price items pass at once (every court, day and start time; nothing ambiguous)',
  pg_temp.ready('prices') and pg_temp.ready('prices_unambiguous'), '');
insert into t values ('S3 quotes: 1 h = $20 on any court and day, 1 h 30 = $30, at opening and up to closing',
  pg_temp.q(1, 1, '10:00', '11:00') = 20 and pg_temp.q(2, 6, '10:00', '11:30') = 30 and pg_temp.q(1, 3, '08:00', '09:00') = 20 and pg_temp.q(1, 7, '22:00', '23:00') = 20, '');
select pg_temp.keep('b2', pg_temp.base(1, 25));
insert into t values ('S4 existing prices are never overwritten silently: refused (prices_exist), prices unchanged',
  pg_temp.got('b2') = 'ERR prices_exist' and pg_temp.rules() = '127 08:00-23:00 20.00', pg_temp.got('b2'));

-- ---------------------------------------------------------------- peak exceptions
select pg_temp.keep('b3', pg_temp.base(1, 20, '[{"start": "18:00", "end": "23:00", "price": 30}]', true));
insert into t values ('S5 replacing on purpose, with a peak 18:00–23:00 at $30: two rules that do not overlap',
  pg_temp.got('b3') = '2' and pg_temp.rules() = '127 08:00-18:00 20.00; 127 18:00-23:00 30.00 peak', pg_temp.got('b3') || ' | ' || pg_temp.rules());
insert into t values ('S6 quotes follow: off-peak $20, peak $30, across the change $25 (half and half)',
  pg_temp.q(1, 1, '10:00', '11:00') = 20 and pg_temp.q(1, 1, '19:00', '20:00') = 30 and pg_temp.q(1, 1, '17:30', '18:30') = 25, '');
select pg_temp.keep('b4', pg_temp.base(1, 20, '[{"start": "17:00", "end": "23:00", "price": 35, "days": 96, "label": "weekend"}]', true));
insert into t values ('S7 a weekend-only peak: weekdays one rule, Saturday and Sunday two',
  pg_temp.rules() = '31 08:00-23:00 20.00; 96 08:00-17:00 20.00; 96 17:00-23:00 35.00 weekend', pg_temp.rules());
insert into t values ('S8 ...Monday 19:00 is $20, Saturday 19:00 is $35',
  pg_temp.q(1, 1, '19:00', '20:00') = 20 and pg_temp.q(1, 6, '19:00', '20:00') = 35 and pg_temp.ready('prices') and pg_temp.ready('prices_unambiguous'), '');
select pg_temp.keep('b5', pg_temp.base(1, 20, '[{"start": "07:00", "end": "09:00", "price": 25}]', true));
select pg_temp.keep('b6', pg_temp.base(1, 20, '[{"start": "17:00", "end": "20:00", "price": 25}, {"start": "19:00", "end": "22:00", "price": 30}]', true));
select pg_temp.keep('b7', pg_temp.base(1, -5, '[]', true));
select pg_temp.keep('b8', pg_temp.base(1, 20, '[{"start": "20:00", "end": "18:00", "price": 25}]', true));
insert into t values ('S9 refused, prices unchanged: a peak before opening, overlapping peaks, a negative price, a backwards peak',
  pg_temp.got('b5') = 'ERR peak_outside_hours' and pg_temp.got('b6') = 'ERR peaks_overlap' and pg_temp.got('b7') = 'ERR bad_price' and pg_temp.got('b8') = 'ERR bad_peaks'
  and pg_temp.rules() = '31 08:00-23:00 20.00; 96 08:00-17:00 20.00; 96 17:00-23:00 35.00 weekend',
  concat_ws(' | ', pg_temp.got('b5'), pg_temp.got('b6'), pg_temp.got('b7'), pg_temp.got('b8')));
select pg_temp.keep('x', pg_temp.r(pg_temp.u(2), format('select set_club_base_prices(%L, 10)::text', pg_temp.club())));
select pg_temp.keep('p', pg_temp.r(pg_temp.u(3), format('select set_club_base_prices(%L, 10)::text', pg_temp.club())));
select pg_temp.keep('a', pg_temp.r(null, format('select set_club_base_prices(%L, 10)::text', pg_temp.club())));
insert into t values ('S10 another club''s desk, a player, a visitor: refused', pg_temp.got('x') = 'ERR forbidden' and pg_temp.got('p') = 'ERR forbidden' and pg_temp.got('a') like 'ERR %',
  concat_ws(' | ', pg_temp.got('x'), pg_temp.got('p'), pg_temp.got('a')));

-- ---------------------------------------------------------------- court-specific rules are never touched, and still win
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values (pg_temp.club(), pg_temp.c(2), 127, '08:00', '23:00', 50, 'covered');
select pg_temp.keep('b9', pg_temp.base(1, 22, '[]', true));
insert into t values ('S11 replacing whole-club prices leaves a court''s own price alone; that court still uses it',
  (select count(*) from price_rules where court_id = pg_temp.c(2)) = 1 and pg_temp.q(2, 1, '10:00', '11:00') = 50 and pg_temp.q(1, 1, '10:00', '11:00') = 22, pg_temp.got('b9'));

-- ---------------------------------------------------------------- overlap prevention for direct writes (the settings page; guard from 0018/0019)
select pg_temp.keep('o1', pg_temp.r(pg_temp.u(1), format($$insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values (%L, null, 1, '18:00', '20:00', 40, 'peak')$$, pg_temp.club())));
insert into t values ('S12 a whole-club rule overlapping another whole-club rule is refused (price_rule_overlap, the existing guard)', pg_temp.got('o1') = 'ERR price_rule_overlap', pg_temp.got('o1'));
select pg_temp.keep('o2', pg_temp.r(pg_temp.u(1), format($$insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values (%L, %L, 1, '18:00', '20:00', 40, 'peak')$$, pg_temp.club(), pg_temp.c(1))));
insert into t values ('S13 a court''s own rule over a whole-club rule is allowed (the court''s wins: not ambiguous)', pg_temp.got('o2') = 'ok' and pg_temp.q(1, 1, '18:00', '19:00') = 40, pg_temp.got('o2'));
select pg_temp.keep('o3', pg_temp.r(pg_temp.u(1), format($$insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd) values (%L, %L, 1, '19:00', '21:00', 45)$$, pg_temp.club(), pg_temp.c(1))));
select pg_temp.keep('o4', pg_temp.r(pg_temp.u(1), format($$insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd) values (%L, %L, 2, '19:00', '21:00', 45)$$, pg_temp.club(), pg_temp.c(1))));
select pg_temp.keep('o5', pg_temp.r(pg_temp.u(1), format($$insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd) values (%L, %L, 1, '20:00', '21:00', 45)$$, pg_temp.club(), pg_temp.c(1))));
insert into t values ('S14 for one court: overlapping refused; another day allowed; ending where another starts allowed',
  pg_temp.got('o3') = 'ERR price_rule_overlap' and pg_temp.got('o4') = 'ok' and pg_temp.got('o5') = 'ok', concat_ws(' | ', pg_temp.got('o3'), pg_temp.got('o4'), pg_temp.got('o5')));
select pg_temp.keep('o6', pg_temp.r(pg_temp.u(1), format($$update price_rules set start_time = '19:30' where club_id = %L and court_id = %L and start_time = '20:00'$$, pg_temp.club(), pg_temp.c(1))));
insert into t values ('S15 an edit that makes rules overlap is refused too', pg_temp.got('o6') = 'ERR price_rule_overlap', pg_temp.got('o6'));

-- ---------------------------------------------------------------- a court with bookings stays visible to the desk
select pg_temp.keep('bk', pg_temp.r(pg_temp.u(1), format($$select staff_book(%L, %L, %L, %L, 'Booked', null)::text$$, pg_temp.club(), pg_temp.c(1), pg_temp.at(3, '10:00'), pg_temp.at(3, '11:00'))));
select pg_temp.keep('d1', pg_temp.r(pg_temp.u(1), format($$update courts set active = false where id = %L$$, pg_temp.c(1))));
insert into t values ('S16 a court with an upcoming booking cannot be deactivated (court_has_bookings); booking and court unchanged',
  pg_temp.got('d1') = 'ERR court_has_bookings' and (select active from courts where id = pg_temp.c(1)) and (select status from bookings where id::text = pg_temp.got('bk')) = 'confirmed',
  pg_temp.got('bk') || ' | ' || pg_temp.got('d1'));
select pg_temp.keep('cx', pg_temp.r(pg_temp.u(1), format($$select cancel_booking(%L)::text$$, pg_temp.got('bk'))));
select pg_temp.keep('d2', pg_temp.r(pg_temp.u(1), format($$update courts set active = false where id = %L$$, pg_temp.c(1))));
insert into t values ('S17 once its bookings are moved or cancelled, it can be deactivated', pg_temp.got('cx') = 'ok' and pg_temp.got('d2') = 'ok' and not (select active from courts where id = pg_temp.c(1)), pg_temp.got('d2'));
insert into bookings (club_id, court_id, guest_name, start_at, end_at, status, source, price_usd, fee_usd)
values (pg_temp.club(), pg_temp.c(2), 'Last week', ((current_date - 7)::timestamp + time '10:00') at time zone 'Asia/Beirut', ((current_date - 7)::timestamp + time '11:00') at time zone 'Asia/Beirut', 'confirmed', 'staff', 20, 0);
select pg_temp.keep('d3', pg_temp.r(pg_temp.u(1), format($$update courts set active = false where id = %L$$, pg_temp.c(2))));
insert into t values ('S18 past bookings do not stop it (they stay in the records)', pg_temp.got('d3') = 'ok', pg_temp.got('d3'));

select case when coalesce(pass, false) then 'ok   ' else 'FAIL ' end || id || case when coalesce(pass, false) then '' else '  [' || coalesce(detail, '') || ']' end from t order by length(split_part(id, ' ', 1)), id;
select format('%s checks, %s failed', count(*), count(*) filter (where not coalesce(pass, false))) from t;
rollback;
