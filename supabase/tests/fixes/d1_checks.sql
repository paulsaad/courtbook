-- D1 data test, part 2 of 2: after 0070 was applied to the data from d1_fixtures.sql. Prints id|pass|detail.
\set ON_ERROR_STOP 1
create temp table r (id text, pass boolean, detail text);
create function pg_temp.st(key text) returns text language sql as $f$
  select b.status::text || '/' || coalesce(p.status::text, '-') from d1_fixture f join bookings b on b.id = f.booking_id
  left join payments p on p.id = f.payment_id where f.k = key $f$;
insert into r select 'D1-M1 the real club left in simulated mode now takes payment at the desk', (select payment_mode from clubs where slug = 'realsim') = 'at_desk', (select payment_mode from clubs where slug = 'realsim');
insert into r select 'D1-M2 its live hold and pending payment were released (expired/expired)', pg_temp.st('realsim_hold') = 'expired/expired', pg_temp.st('realsim_hold');
insert into r select 'D1-M3 its confirmed, paid booking is untouched (confirmed/paid)', pg_temp.st('realsim_paid') = 'confirmed/paid', pg_temp.st('realsim_paid');
insert into r select 'D1-M4 the demo club stays simulated and its live hold is untouched (pending/pending)',
  (select payment_mode from clubs where slug = 'batroun') = 'simulated' and pg_temp.st('demo_hold') = 'pending/pending', pg_temp.st('demo_hold');
insert into r select 'D1-M5 the club already at the desk and its booking are unchanged',
  (select payment_mode from clubs where slug = 'realdesk') = 'at_desk' and pg_temp.st('realdesk_booking') = 'confirmed/-', pg_temp.st('realdesk_booking');
insert into r select 'D1-M6 the rule is in force for every row (constraint validated, not NOT VALID)',
  (select convalidated from pg_constraint where conname = 'clubs_simulated_only_demo'), '';
insert into r select 'D1-M7 no simulated non-demo club remains', not exists (select 1 from clubs where payment_mode = 'simulated' and not is_demo), '';
insert into r select 'D1-M8 fees untouched: realsim''s service fee and the paid booking''s fee',
  (select service_fee_usd from clubs where slug = 'realsim') = (select service_fee_usd from clubs where slug = 'batroun')
  and (select fee_usd from bookings where id = (select booking_id from d1_fixture where k = 'realsim_paid')) > 0, '';
select id || '|' || coalesce(pass::text, 'f') || '|' || coalesce(detail, '') from r order by id;
