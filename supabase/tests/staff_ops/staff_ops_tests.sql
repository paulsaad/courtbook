-- Staff operations (audit 24 Nov): bookings taken by phone, WhatsApp or at the desk, their price and fee, staff
-- rights by club, moves and cancellations, blocks and whole-club closure. ONE transaction, rolled back.
\set ON_ERROR_STOP 1
begin;
-- CONTROL (psql -v control=1): move_booking as it was before 0091 (no quote_move, no confirmed price), to show the move checks see the defect
\if :{?control}
\i supabase/migrations/0071_staff_past_times.sql
-- F1: the desk's moves go through the 8-argument call; in the control it is the pre-0091 mover (no price rule)
create or replace function move_booking_priced(p_booking uuid, p_court uuid, p_start timestamptz, p_end timestamptz, p_expected_price numeric,
  p_seen_court uuid, p_seen_start timestamptz, p_seen_end timestamptz) returns jsonb language plpgsql as $c$
begin perform move_booking(p_booking, p_court, p_start, p_end); return '{}'::jsonb; end $c$;
\endif
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
create function pg_temp.u(n int) returns uuid language sql as $$ select ('5a000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.club(s text default 'batroun') returns uuid language sql as $$ select id from clubs where slug = s $$;
create function pg_temp.at(d int, hhmm text) returns timestamptz language sql as $$ select ((current_date + d)::timestamp + hhmm::time) at time zone 'Asia/Beirut' $$;
insert into auth.users (id, phone) values (pg_temp.u(1), '+96176500001'), (pg_temp.u(2), '+96176500002'), (pg_temp.u(3), '+96176500003'), (pg_temp.u(4), '+96176500004');
update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id in (pg_temp.u(1), pg_temp.u(2), pg_temp.u(3), pg_temp.u(4));
insert into club_staff (club_id, profile_id) values (pg_temp.club(), pg_temp.u(1));            -- desk of this club
insert into club_staff (club_id, profile_id) values (pg_temp.club('other'), pg_temp.u(2));     -- desk of another club
-- u3: a player; u4: a player at a club that takes app payments
insert into courts (id, club_id, name, sport, sort) values
  ('5a000000-0000-4000-8000-0000000000c1', pg_temp.club(), 'zz-ops-1', 'padel', 901),
  ('5a000000-0000-4000-8000-0000000000c2', pg_temp.club(), 'zz-ops-2', 'padel', 902);
-- a peak price from 18:00 on the test courts, to show the price follows the time
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label)
values (pg_temp.club(), '5a000000-0000-4000-8000-0000000000c1', 127, '18:00', '23:00', 40, 'peak');
create function pg_temp.c(n int) returns uuid language sql as $$ select ('5a000000-0000-4000-8000-0000000000c' || n)::uuid $$;

-- ---------------------------------------------------------------- external bookings (phone, WhatsApp, walk-in)
select pg_temp.keep('w1', pg_temp.r(pg_temp.u(1), format('select staff_book(%L,%L,%L,%L,''Phone: Rami'',''03 123 456'')::text', pg_temp.club(), pg_temp.c(1), pg_temp.at(2,'10:00'), pg_temp.at(2,'11:00'))));
insert into t select 'O1 the desk enters a phone booking: confirmed, priced by the club, no CourtBook fee, no payment row',
  b.status = 'confirmed' and b.source = 'staff' and b.price_usd = quote_price(pg_temp.c(1), pg_temp.at(2,'10:00'), pg_temp.at(2,'11:00')) and b.fee_usd = 0
  and not exists (select 1 from payments p where p.booking_id = b.id) and b.guest_name = 'Phone: Rami' and b.guest_phone = '03 123 456',
  pg_temp.got('w1') from (select 1) one left join bookings b on b.id::text = pg_temp.got('w1');
select pg_temp.keep('w1_again', pg_temp.r(pg_temp.u(1), format('select staff_book(%L,%L,%L,%L,''WhatsApp: Joe'',null)::text', pg_temp.club(), pg_temp.c(1), pg_temp.at(2,'10:30'), pg_temp.at(2,'11:30'))));
insert into t values ('O2 the same court at an overlapping time is refused (slot_taken)', pg_temp.got('w1_again') = 'ERR slot_taken', pg_temp.got('w1_again'));
select pg_temp.keep('hold_over', pg_temp.r(pg_temp.u(3), format('select booking_id::text from hold_slot(%L,%L,%L,%L)', pg_temp.club(), pg_temp.c(1), pg_temp.at(2,'10:00'), pg_temp.at(2,'11:00'))));
insert into t values ('O3 ...and a player cannot book over it in the app', pg_temp.got('hold_over') ~ '^ERR (slot_taken|wrong_payment_mode)', pg_temp.got('hold_over'));
select pg_temp.keep('no_name', pg_temp.r(pg_temp.u(1), format('select staff_book(%L,%L,%L,%L,''  '',null)::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(2,'10:00'), pg_temp.at(2,'11:00'))));
insert into t values ('O4 a booking needs a name', pg_temp.got('no_name') = 'ERR name_required', pg_temp.got('no_name'));
select pg_temp.keep('off_grid', pg_temp.r(pg_temp.u(1), format('select staff_book(%L,%L,%L,%L,''X'',null)::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(2,'10:10'), pg_temp.at(2,'11:10'))));
select pg_temp.keep('after_close', pg_temp.r(pg_temp.u(1), format('select staff_book(%L,%L,%L,%L,''X'',null)::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(2,'22:30'), pg_temp.at(2,'23:30'))));
select pg_temp.keep('too_long', pg_temp.r(pg_temp.u(1), format('select staff_book(%L,%L,%L,%L,''X'',null)::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(2,'10:00'), pg_temp.at(2,'14:00'))));
select pg_temp.keep('too_old', pg_temp.r(pg_temp.u(1), format('select staff_book(%L,%L,%L,%L,''X'',null)::text', pg_temp.club(), pg_temp.c(2), now() - interval '1 day', now() - interval '23 hours')));
insert into t values ('O5 off the grid, after closing, over the maximum length, or a day ago: refused',
  pg_temp.got('off_grid') like 'ERR %' and pg_temp.got('after_close') like 'ERR %' and pg_temp.got('too_long') = 'ERR bad_duration' and pg_temp.got('too_old') like 'ERR %',
  concat_ws(' | ', pg_temp.got('off_grid'), pg_temp.got('after_close'), pg_temp.got('too_long'), pg_temp.got('too_old')));

-- ---------------------------------------------------------------- staff rights by club
select pg_temp.keep('x_book', pg_temp.r(pg_temp.u(2), format('select staff_book(%L,%L,%L,%L,''X'',null)::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(2,'12:00'), pg_temp.at(2,'13:00'))));
select pg_temp.keep('x_block', pg_temp.r(pg_temp.u(2), format('select staff_block(%L,%L,%L,%L,''X'')::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(2,'12:00'), pg_temp.at(2,'13:00'))));
select pg_temp.keep('x_close', pg_temp.r(pg_temp.u(2), format('select close_club(%L,%L,%L,''X'')::text', pg_temp.club(), pg_temp.at(9,'08:00'), pg_temp.at(9,'12:00'))));
select pg_temp.keep('x_move', pg_temp.r(pg_temp.u(2), format('select (case when move_booking_priced(%1$L,%2$L,%3$L,%4$L,null,(select court_id from bookings where id = %1$L),(select start_at from bookings where id = %1$L),(select end_at from bookings where id = %1$L)) is not null then ''''::text end)::text', pg_temp.got('w1'), pg_temp.c(2), pg_temp.at(2,'12:00'), pg_temp.at(2,'13:00'))));
select pg_temp.keep('x_cancel', pg_temp.r(pg_temp.u(2), format('select cancel_booking(%L)::text', pg_temp.got('w1'))));
select pg_temp.keep('x_read', pg_temp.r(pg_temp.u(2), format('select count(*)::text from bookings where id = %L', pg_temp.got('w1'))));
insert into t values ('O6 another club''s desk can do nothing here: book, block, close, move, cancel; and cannot see the booking',
  pg_temp.got('x_book') = 'ERR forbidden' and pg_temp.got('x_block') = 'ERR forbidden' and pg_temp.got('x_close') = 'ERR forbidden'
  and pg_temp.got('x_move') = 'ERR forbidden' and pg_temp.got('x_cancel') = 'ERR forbidden' and pg_temp.got('x_read') = '0',
  concat_ws(' | ', pg_temp.got('x_book'), pg_temp.got('x_block'), pg_temp.got('x_close'), pg_temp.got('x_move'), pg_temp.got('x_cancel'), pg_temp.got('x_read')));
select pg_temp.keep('p_book', pg_temp.r(pg_temp.u(3), format('select staff_book(%L,%L,%L,%L,''X'',null)::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(2,'12:00'), pg_temp.at(2,'13:00'))));
select pg_temp.keep('p_block', pg_temp.r(pg_temp.u(3), format('select staff_block(%L,%L,%L,%L,''X'')::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(2,'12:00'), pg_temp.at(2,'13:00'))));
select pg_temp.keep('p_move', pg_temp.r(pg_temp.u(3), format('select (case when move_booking_priced(%1$L,%2$L,%3$L,%4$L,null,(select court_id from bookings where id = %1$L),(select start_at from bookings where id = %1$L),(select end_at from bookings where id = %1$L)) is not null then ''''::text end)::text', pg_temp.got('w1'), pg_temp.c(2), pg_temp.at(2,'12:00'), pg_temp.at(2,'13:00'))));
select pg_temp.keep('p_insert', pg_temp.r(pg_temp.u(3), format('insert into bookings (club_id, court_id, guest_name, start_at, end_at, status, source, created_by, price_usd, fee_usd) values (%L,%L,''X'',%L,%L,''confirmed'',''staff'',%L,0,0)', pg_temp.club(), pg_temp.c(2), pg_temp.at(2,'14:00'), pg_temp.at(2,'15:00'), pg_temp.u(3))));
insert into t values ('O7 a player can do none of the desk''s actions, nor write a desk booking directly',
  pg_temp.got('p_book') = 'ERR forbidden' and pg_temp.got('p_block') = 'ERR forbidden' and pg_temp.got('p_move') = 'ERR forbidden' and pg_temp.got('p_insert') like 'ERR %',
  concat_ws(' | ', pg_temp.got('p_book'), pg_temp.got('p_block'), pg_temp.got('p_move'), pg_temp.got('p_insert')));

-- ---------------------------------------------------------------- moves and their price (0091)
create function pg_temp.mv(who int, bk text, court uuid, s timestamptz, e timestamptz, expected numeric default null) returns text language sql as $$
  select pg_temp.r(pg_temp.u(who), case when expected is null and false then '' else
    format('select move_booking_priced(%1$L,%2$L,%3$L,%4$L,%5$s,(select court_id from bookings where id = %1$L),(select start_at from bookings where id = %1$L),(select end_at from bookings where id = %1$L))::text', bk, court, s, e, coalesce(expected::text, 'null')) end) $$;
create function pg_temp.q(who int, bk text, court uuid, s timestamptz, e timestamptz) returns text language sql as $$
  select pg_temp.r(pg_temp.u(who), format('select quote_move(%L,%L,%L,%L)::text', bk, court, s, e)) $$;
create function pg_temp.j(k text) returns jsonb language sql as $$ select case when pg_temp.got(k) ~ '^\{' then pg_temp.got(k)::jsonb end $$;
create function pg_temp.price(bk text) returns numeric language sql as $$ select price_usd from bookings where id::text = bk $$;
create function pg_temp.span(bk text) returns text language sql as $$ select court_id || ' ' || start_at || ' ' || end_at from bookings where id::text = bk $$;

select pg_temp.keep('span0', pg_temp.span(pg_temp.got('w1')));
select pg_temp.keep('mv_old', pg_temp.r(pg_temp.u(1), format('select (case when move_booking_priced(%1$L,%2$L,%3$L,%4$L,null,(select court_id from bookings where id = %1$L),(select start_at from bookings where id = %1$L),(select end_at from bookings where id = %1$L)) is not null then ''''::text end)::text', pg_temp.got('w1'), pg_temp.c(1), pg_temp.at(2,'10:00'), pg_temp.at(2,'12:00'))));
insert into t values ('O8a the older move call cannot change a price without showing it: refused, nothing moved',
  pg_temp.got('mv_old') = 'ERR price_confirmation_needed' and pg_temp.span(pg_temp.got('w1')) = pg_temp.got('span0') and pg_temp.price(pg_temp.got('w1')) = 20,
  pg_temp.got('mv_old'));
select pg_temp.keep('q_long', pg_temp.q(1, pg_temp.got('w1'), pg_temp.c(1), pg_temp.at(2,'10:00'), pg_temp.at(2,'12:00')));
insert into t values ('O8b the desk is shown the old and new price first (quote_move: walk-in reprice $20 → $40)',
  pg_temp.j('q_long') = '{"current": 20.00, "new": 40.00, "kind": "reprice"}'::jsonb, pg_temp.got('q_long'));
select pg_temp.keep('mv_wrong', pg_temp.mv(1, pg_temp.got('w1'), pg_temp.c(1), pg_temp.at(2,'10:00'), pg_temp.at(2,'12:00'), 30));
insert into t values ('O8c a move confirmed at a price that is no longer right is refused (price_changed), nothing moved',
  pg_temp.got('mv_wrong') = 'ERR price_changed' and pg_temp.span(pg_temp.got('w1')) = pg_temp.got('span0'), pg_temp.got('mv_wrong'));
select pg_temp.keep('mv_long', pg_temp.mv(1, pg_temp.got('w1'), pg_temp.c(1), pg_temp.at(2,'10:00'), pg_temp.at(2,'12:00'), 40));
insert into t select 'O8 confirmed at $40: the walk-in is stretched to 2 h and priced for 2 h; the fee stays 0',
  pg_temp.got('mv_long') !~ '^ERR' and b.price_usd = 40 and b.price_usd = quote_price(pg_temp.c(1), pg_temp.at(2,'10:00'), pg_temp.at(2,'12:00')) and b.fee_usd = 0,
  pg_temp.got('mv_long') || ' price=' || b.price_usd from (select 1) one left join bookings b on b.id::text = pg_temp.got('w1');
select pg_temp.keep('mv_peak', pg_temp.mv(1, pg_temp.got('w1'), pg_temp.c(1), pg_temp.at(2,'19:00'), pg_temp.at(2,'21:00'), quote_price(pg_temp.c(1), pg_temp.at(2,'19:00'), pg_temp.at(2,'21:00'))));
insert into t select 'O9 moved into the peak hours (confirmed), the walk-in takes the peak price',
  pg_temp.got('mv_peak') !~ '^ERR' and b.price_usd = 80 and b.fee_usd = 0,
  pg_temp.got('mv_peak') || ' price=' || b.price_usd from (select 1) one left join bookings b on b.id::text = pg_temp.got('w1');
select pg_temp.keep('mv_court', pg_temp.mv(1, pg_temp.got('w1'), pg_temp.c(2), pg_temp.at(2,'19:00'), pg_temp.at(2,'21:00'), quote_price(pg_temp.c(2), pg_temp.at(2,'19:00'), pg_temp.at(2,'21:00'))));
insert into t select 'O10 moved to a court without the peak rule, the price follows that court',
  pg_temp.got('mv_court') !~ '^ERR' and b.price_usd = quote_price(pg_temp.c(2), pg_temp.at(2,'19:00'), pg_temp.at(2,'21:00')) and b.court_id = pg_temp.c(2),
  pg_temp.got('mv_court') || ' price=' || b.price_usd from (select 1) one left join bookings b on b.id::text = pg_temp.got('w1');
select pg_temp.keep('x_quote', pg_temp.q(2, pg_temp.got('w1'), pg_temp.c(2), pg_temp.at(2,'19:00'), pg_temp.at(2,'20:00')));
select pg_temp.keep('x_priced', pg_temp.mv(2, pg_temp.got('w1'), pg_temp.c(2), pg_temp.at(2,'19:00'), pg_temp.at(2,'20:00'), 20));
insert into t values ('O10b another club''s desk can neither quote nor move', pg_temp.got('x_quote') = 'ERR forbidden' and pg_temp.got('x_priced') = 'ERR forbidden', pg_temp.got('x_quote') || ' | ' || pg_temp.got('x_priced'));

-- an app booking PAID through CourtBook: the amount is never changed
update clubs set payment_mode = 'simulated' where id = pg_temp.club();
select pg_temp.keep('app', pg_temp.r(pg_temp.u(4), format('select booking_id::text from hold_slot(%L,%L,%L,%L)', pg_temp.club(), pg_temp.c(1), pg_temp.at(3,'10:00'), pg_temp.at(3,'11:00'))));
set local role service_role;
do $$ begin perform confirm_payment(p.id, 'ops-ref-1', p.total_usd) from payments p where p.booking_id::text = (select v from kept where k = 'app'); end $$;
reset role;
select pg_temp.keep('app_price', pg_temp.price(pg_temp.got('app'))::text);
select pg_temp.keep('q_app_peak', pg_temp.q(1, pg_temp.got('app'), pg_temp.c(1), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:00')));
select pg_temp.keep('mv_app', pg_temp.r(pg_temp.u(1), format('select (case when move_booking_priced(%1$L,%2$L,%3$L,%4$L,null,(select court_id from bookings where id = %1$L),(select start_at from bookings where id = %1$L),(select end_at from bookings where id = %1$L)) is not null then ''''::text end)::text', pg_temp.got('app'), pg_temp.c(1), pg_temp.at(3,'19:00'), pg_temp.at(3,'20:00'))));
insert into t select 'O11 a paid app booking moved into the peak (same length) keeps the price the player paid',
  pg_temp.got('mv_app') = 'ok' and pg_temp.j('q_app_peak')->>'kind' = 'same' and b.price_usd::text = pg_temp.got('app_price') and b.start_at = pg_temp.at(3,'19:00'),
  pg_temp.got('mv_app') || ' ' || pg_temp.got('q_app_peak') from (select 1) one left join bookings b on b.id::text = pg_temp.got('app');
select pg_temp.keep('q_app_long', pg_temp.q(1, pg_temp.got('app'), pg_temp.c(1), pg_temp.at(3,'19:00'), pg_temp.at(3,'21:00')));
select pg_temp.keep('mv_app_long', pg_temp.mv(1, pg_temp.got('app'), pg_temp.c(1), pg_temp.at(3,'19:00'), pg_temp.at(3,'21:00'), pg_temp.got('app_price')::numeric));
insert into t values ('O11b a paid app booking''s LENGTH cannot change (the amount taken would no longer match): quoted refused, move refused',
  pg_temp.j('q_app_long')->>'kind' = 'refused' and pg_temp.got('mv_app_long') = 'ERR paid_length_change'
  and (select end_at from bookings where id::text = pg_temp.got('app')) = pg_temp.at(3,'20:00'),
  pg_temp.got('q_app_long') || ' | ' || pg_temp.got('mv_app_long'));
update clubs set payment_mode = 'at_desk' where id = pg_temp.club();

-- an app booking at a club that takes payment at its desk (book_at_desk: no payment row)
select pg_temp.keep('desk', pg_temp.r(pg_temp.u(3), format('select booking_id::text from book_at_desk(%L,%L,%L,gen_random_uuid())', pg_temp.c(1), pg_temp.at(4,'14:00'), pg_temp.at(4,'15:00'))));
select pg_temp.keep('desk_q_same', pg_temp.q(1, pg_temp.got('desk'), pg_temp.c(1), pg_temp.at(4,'19:00'), pg_temp.at(4,'20:00')));
select pg_temp.keep('desk_mv_same', pg_temp.r(pg_temp.u(1), format('select (case when move_booking_priced(%1$L,%2$L,%3$L,%4$L,null,(select court_id from bookings where id = %1$L),(select start_at from bookings where id = %1$L),(select end_at from bookings where id = %1$L)) is not null then ''''::text end)::text', pg_temp.got('desk'), pg_temp.c(1), pg_temp.at(4,'19:00'), pg_temp.at(4,'20:00'))));
insert into t select 'O12a a desk-paid app booking moved (same length, into the peak) keeps the price the player saw',
  pg_temp.got('desk') !~ '^ERR' and pg_temp.j('desk_q_same')->>'kind' = 'same' and pg_temp.got('desk_mv_same') = 'ok' and b.price_usd = 20 and b.fee_usd = 0,
  concat_ws(' | ', pg_temp.got('desk'), pg_temp.got('desk_q_same'), pg_temp.got('desk_mv_same'), b.price_usd) from (select 1) one left join bookings b on b.id::text = pg_temp.got('desk');
select pg_temp.keep('desk_q_long', pg_temp.q(1, pg_temp.got('desk'), pg_temp.c(1), pg_temp.at(4,'19:00'), pg_temp.at(4,'21:00')));
select pg_temp.keep('desk_mv_old', pg_temp.r(pg_temp.u(1), format('select (case when move_booking_priced(%1$L,%2$L,%3$L,%4$L,null,(select court_id from bookings where id = %1$L),(select start_at from bookings where id = %1$L),(select end_at from bookings where id = %1$L)) is not null then ''''::text end)::text', pg_temp.got('desk'), pg_temp.c(1), pg_temp.at(4,'19:00'), pg_temp.at(4,'21:00'))));
insert into t values ('O12b its LENGTH change needs the player''s agreement: quoted as agreement $20 → $80; never changed silently',
  pg_temp.j('desk_q_long') = '{"current": 20.00, "new": 80.00, "kind": "agreement"}'::jsonb and pg_temp.got('desk_mv_old') = 'ERR price_confirmation_needed' and pg_temp.price(pg_temp.got('desk')) = 20,
  pg_temp.got('desk_q_long') || ' | ' || pg_temp.got('desk_mv_old'));
select pg_temp.keep('desk_mv_agreed', pg_temp.mv(1, pg_temp.got('desk'), pg_temp.c(1), pg_temp.at(4,'19:00'), pg_temp.at(4,'21:00'), 80));
insert into t select 'O12c with the agreed amount confirmed, the length and the price change together',
  pg_temp.got('desk_mv_agreed') !~ '^ERR' and b.price_usd = 80 and b.end_at = pg_temp.at(4,'21:00') and b.fee_usd = 0,
  pg_temp.got('desk_mv_agreed') from (select 1) one left join bookings b on b.id::text = pg_temp.got('desk');

-- ---------------------------------------------------------------- cancellations
select pg_temp.keep('cx', pg_temp.r(pg_temp.u(1), format('select cancel_booking(%L)::text', pg_temp.got('w1'))));
insert into t select 'O13 the desk cancels a walk-in: cancelled, the time is free again, no money moves',
  pg_temp.got('cx') = 'ok' and b.status = 'cancelled' and not exists (select 1 from payments where booking_id = b.id),
  pg_temp.got('cx') from (select 1) one left join bookings b on b.id::text = pg_temp.got('w1');
select pg_temp.keep('rebook', pg_temp.r(pg_temp.u(1), format('select staff_book(%L,%L,%L,%L,''Next caller'',null)::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(2,'19:00'), pg_temp.at(2,'20:00'))));
insert into t values ('O13b ...and the next caller can have that time', pg_temp.got('rebook') !~ '^ERR', pg_temp.got('rebook'));

-- ---------------------------------------------------------------- blocks and whole-club closure
select pg_temp.keep('blk', pg_temp.r(pg_temp.u(1), format('select staff_block(%L,%L,%L,%L,''Lights repair'')::text', pg_temp.club(), pg_temp.c(1), pg_temp.at(4,'10:00'), pg_temp.at(4,'12:00'))));
select pg_temp.keep('blk_book', pg_temp.r(pg_temp.u(1), format('select staff_book(%L,%L,%L,%L,''X'',null)::text', pg_temp.club(), pg_temp.c(1), pg_temp.at(4,'11:00'), pg_temp.at(4,'12:00'))));
insert into t values ('O14 a blocked court cannot be booked by the desk either', pg_temp.got('blk') !~ '^ERR' and pg_temp.got('blk_book') like 'ERR %', pg_temp.got('blk') || ' | ' || pg_temp.got('blk_book'));
select pg_temp.keep('bk5', pg_temp.r(pg_temp.u(1), format('select staff_book(%L,%L,%L,%L,''Booked first'',null)::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(7,'15:00'), pg_temp.at(7,'16:00'))));
select pg_temp.keep('blocks_before', (select count(*)::text from blocks where club_id = pg_temp.club()));
select pg_temp.keep('close_over', pg_temp.r(pg_temp.u(1), format('select close_club(%L,%L,%L,''Tournament'')::text', pg_temp.club(), pg_temp.at(7,'14:00'), pg_temp.at(7,'18:00'))));
insert into t values ('O15 closing the whole club over an existing booking is refused, and no court is half-closed',
  pg_temp.got('close_over') = 'ERR block_overlaps_booking' and (select count(*)::text from blocks where club_id = pg_temp.club()) = pg_temp.got('blocks_before'),
  pg_temp.got('close_over'));
select pg_temp.keep('close_ok', pg_temp.r(pg_temp.u(1), format('select close_club(%L,%L,%L,''Holiday'')::text', pg_temp.club(), pg_temp.at(8,'08:00'), pg_temp.at(8,'23:00'))));
insert into t values ('O16 closing a free day closes every active court of the club, and nothing can be booked then',
  pg_temp.got('close_ok') = (select count(*)::text from courts where club_id = pg_temp.club() and active)
  and pg_temp.r(pg_temp.u(1), format('select staff_book(%L,%L,%L,%L,''X'',null)::text', pg_temp.club(), pg_temp.c(2), pg_temp.at(8,'10:00'), pg_temp.at(8,'11:00'))) like 'ERR %',
  pg_temp.got('close_ok'));

select case when coalesce(pass, false) then 'ok   ' else 'FAIL ' end || id || case when coalesce(pass, false) then '' else '  [' || coalesce(detail, '') || ']' end from t order by length(split_part(id, ' ', 1)), id;
select format('%s checks, %s failed', count(*), count(*) filter (where not coalesce(pass, false))) from t;
rollback;
