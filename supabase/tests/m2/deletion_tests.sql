-- M2 tests: account deletion (0079). Run by deletion.sh inside one transaction that is rolled back.
-- psql variable :mig is the migration file under test.
\set ON_ERROR_STOP 1
begin;
\i :mig
\i :mig
create temp table t (id text, pass boolean, detail text);
insert into t values ('A0 the migration applies twice without error', true, '');

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
create function pg_temp.u(n int) returns uuid language sql as $$ select ('d2000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.club() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
-- a court of its own (the seed's bookings and blocks stay out of the way)
insert into courts (id, club_id, name, sport, active, sort)
select 'd2000000-0000-4000-8000-000000000900', id, 'M2 court', 'padel', true, 99 from clubs where slug = 'batroun';
create function pg_temp.court() returns uuid language sql as $$ select 'd2000000-0000-4000-8000-000000000900'::uuid $$;
create function pg_temp.at(d int, h int default 2) returns timestamptz language sql as $$
  select ((current_date + d)::timestamp + c.open_time + make_interval(hours => h)) at time zone c.timezone from clubs c where c.id = pg_temp.club() $$;
create function pg_temp.bk(who uuid, d int, h int, st booking_status) returns uuid language sql as $$
  insert into bookings (club_id, court_id, player_id, created_by, start_at, end_at, status, source, price_usd, fee_usd, hold_expires_at)
  values (pg_temp.club(), pg_temp.court(), who, who, pg_temp.at(d, h), pg_temp.at(d, h) + interval '60 min', st, 'app', 20, 1,
          case when st = 'pending' then now() + interval '10 min' end) returning id $$;
create function pg_temp.pay(b uuid, who uuid, st payment_status) returns void language sql as $$
  insert into payments (booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd, status, paid_at)
  values (b, who, pg_temp.club(), 'simulated', 20, 1, 21, st, case when st = 'paid' then now() end) $$;

-- fixtures. 1 = the person deleting; 2 = another player; 3 = admin; 4 = club staff; 5 = coach with a coach booking;
-- 6 = a reported player under legal hold; 7 = control player (same bookings as 1, cancelled through cancel_booking)
insert into auth.users (id, phone) select pg_temp.u(n), '+9617100' || lpad(n::text, 2, '0') from generate_series(1, 15) n;
update profiles set name = 'Person ' || ltrim(right(id::text, 2), '0'), rules_accepted_at = now() where id in (select pg_temp.u(n) from generate_series(1, 15) n);
update profiles set roles = '{player,admin}' where id = pg_temp.u(3);
insert into club_staff (club_id, profile_id) values (pg_temp.club(), pg_temp.u(4));
-- simulated payments, and a cutoff (200 h) that puts day 5 inside it and day 10 outside it
update clubs set payment_mode = 'simulated', cancel_cutoff_hours = 200, booking_window_days = 14 where slug = 'batroun';

create temp table f (k text primary key, id uuid);
insert into f select 'b_out',  pg_temp.bk(pg_temp.u(1), 10, 2, 'confirmed');    -- paid, before the cutoff → refund due
insert into f select 'b_in',   pg_temp.bk(pg_temp.u(1), 5, 2, 'confirmed');     -- paid, inside the cutoff → no refund
insert into f select 'b_hold', pg_temp.bk(pg_temp.u(1), 6, 2, 'pending');       -- hold → payment expired
insert into f select 'b_past', pg_temp.bk(pg_temp.u(1), 9, 4, 'confirmed');     -- moved to the past below
select pg_temp.pay((select id from f where k = 'b_out'), pg_temp.u(1), 'paid'), pg_temp.pay((select id from f where k = 'b_in'), pg_temp.u(1), 'paid'),
       pg_temp.pay((select id from f where k = 'b_hold'), pg_temp.u(1), 'pending'), pg_temp.pay((select id from f where k = 'b_past'), pg_temp.u(1), 'paid');
insert into f select 'b_now', pg_temp.bk(pg_temp.u(1), 9, 6, 'confirmed');      -- moved to "being played now" below
alter table bookings disable trigger user;      -- history and an ongoing booking: written directly
update bookings set start_at = now() - interval '2 days', end_at = now() - interval '2 days' + interval '60 min' where id = (select id from f where k = 'b_past');
update bookings set start_at = now() - interval '30 min', end_at = now() + interval '30 min' where id = (select id from f where k = 'b_now');
alter table bookings enable trigger user;
-- control: the same three upcoming bookings for player 7
insert into f select 'c_out',  pg_temp.bk(pg_temp.u(7), 10, 4, 'confirmed');
insert into f select 'c_in',   pg_temp.bk(pg_temp.u(7), 5, 4, 'confirmed');
insert into f select 'c_hold', pg_temp.bk(pg_temp.u(7), 6, 4, 'pending');
select pg_temp.pay((select id from f where k = 'c_out'), pg_temp.u(7), 'paid'), pg_temp.pay((select id from f where k = 'c_in'), pg_temp.u(7), 'paid'),
       pg_temp.pay((select id from f where k = 'c_hold'), pg_temp.u(7), 'pending');

-- games: g_own organised by 1 (2 joined); g_full organised by 2, full with 1 in it
insert into matches (id, club_id, sport, organizer_id, start_at, end_at, players_needed, status, join_mode, note)
values (pg_temp.u(101), pg_temp.club(), 'padel', pg_temp.u(1), now() + interval '3 days', now() + interval '3 days 90 min', 3, 'open', 'open', 'm2 own'),
       (pg_temp.u(102), pg_temp.club(), 'padel', pg_temp.u(2), now() + interval '3 days', now() + interval '3 days 90 min', 1, 'closed', 'open', 'm2 full'),
       (pg_temp.u(103), pg_temp.club(), 'padel', pg_temp.u(2), now() + interval '3 days', now() + interval '3 days 90 min', 3, 'open', 'open', 'm2 joinable');
update matches set closed_reason = 'full', closed_at = now() where id = pg_temp.u(102);
insert into match_players (match_id, profile_id, status) values (pg_temp.u(101), pg_temp.u(2), 'accepted'), (pg_temp.u(102), pg_temp.u(1), 'accepted');
-- chat: one message each in g_full; 2 reports 1's message (snapshot kept); 1 reports player 2
insert into match_messages (id, match_id, profile_id, body) values (pg_temp.u(201), pg_temp.u(102), pg_temp.u(1), 'm2 message by 1'),
       (pg_temp.u(202), pg_temp.u(102), pg_temp.u(2), 'm2 message by 2');
insert into reports (id, reporter_id, target_kind, message_id, profile_id, match_id, target_key, reason, snapshot)
values (pg_temp.u(301), pg_temp.u(2), 'message', pg_temp.u(201), pg_temp.u(1), pg_temp.u(102), pg_temp.u(201), 'abuse', 'm2 message by 1'),
       (pg_temp.u(302), pg_temp.u(1), 'player', null, pg_temp.u(2), null, pg_temp.u(2), 'spam', null),
       (pg_temp.u(303), pg_temp.u(2), 'player', null, pg_temp.u(6), null, pg_temp.u(6), 'danger', null);
update reports set legal_hold = true where id = pg_temp.u(303);
insert into reports (id, reporter_id, target_kind, target_key, reason, note) values (pg_temp.u(304), pg_temp.u(1), 'feedback', pg_temp.u(1), 'suggestion', 'm2 feedback: call me on 03 123 456');
-- what others hold about 1: a join notice with their name, a chat excerpt, and an unrelated notice naming Person 11
insert into notifications (profile_id, kind, match_id, actor_id, body) values
  (pg_temp.u(2), 'player_joined', pg_temp.u(102), pg_temp.u(1), 'Person 1 joined your match'),
  (pg_temp.u(2), 'match_message', pg_temp.u(102), pg_temp.u(1), 'Person 1: m2 message by 1'),
  (pg_temp.u(2), 'player_joined', pg_temp.u(102), pg_temp.u(11), 'Person 11 joined your match');
update matches set note = 'm2 own: call 03 999 999' where id = pg_temp.u(101);
-- coach listing for 1 (no coach bookings); coach 5 with a coach booking
insert into coaches (id, profile_id, sports, active) values (pg_temp.u(401), pg_temp.u(1), '{padel}', true), (pg_temp.u(405), pg_temp.u(5), '{padel}', true);
insert into coach_clubs (coach_id, club_id, status) values (pg_temp.u(401), pg_temp.club(), 'approved');
alter table bookings disable trigger user;
insert into bookings (club_id, coach_id, player_id, created_by, start_at, end_at, status, source)
values (pg_temp.club(), pg_temp.u(405), pg_temp.u(2), pg_temp.u(2), now() + interval '4 days', now() + interval '4 days 1 hour', 'confirmed', 'app');
alter table bookings enable trigger user;

create temp table snap as select count(*) as n_pay, sum(total_usd) as total from payments where profile_id = pg_temp.u(1);
grant select on t, f, snap to anon, authenticated;

-- ================= requesting =================
insert into t values
  ('A1 signed out: cannot request', pg_temp.r(null, $$select request_account_deletion()::text$$) like 'ERR%', ''),
  ('A1 staff cannot request (role removed first)', pg_temp.r(pg_temp.u(4), $$select request_account_deletion()::text$$) like 'ERR staff_role%', ''),
  ('A1 an admin cannot request (role removed first)', pg_temp.r(pg_temp.u(3), $$select request_account_deletion()::text$$) like 'ERR admin_role%', ''),
  ('A1 only app or web as the channel', pg_temp.r(pg_temp.u(1), $$select request_account_deletion('support')::text$$) like 'ERR invalid_via%', ''),
  ('A2 a player requests deletion', pg_temp.r(pg_temp.u(1), $$select request_account_deletion('web')->>'status'$$) = 'requested', ''),
  ('A2 requesting again returns the same request', pg_temp.r(pg_temp.u(1), $$select request_account_deletion()->>'status'$$) = 'requested', ''),
  ('A2 the person sees their request', pg_temp.r(pg_temp.u(1), $$select my_account_deletion()->>'status'$$) = 'requested', ''),
  ('A2 another player cannot see it', pg_temp.r(pg_temp.u(2), $$select count(*)::text from account_deletions$$) = '0', ''),
  ('A2 an admin sees it', pg_temp.r(pg_temp.u(3), $$select count(*)::text from account_deletions where subject_id = 'd2000000-0000-4000-8000-000000000001'$$) = '1', ''),
  ('A2 players cannot write the record directly', pg_temp.r(pg_temp.u(1), $$update account_deletions set status = 'done'$$) like 'ERR%', '');
-- (checks that read what a function just wrote go in a later statement: one statement sees one snapshot)
insert into t values ('A2 one open request only', (select count(*) = 1 from account_deletions where subject_id = pg_temp.u(1)), '');

-- ================= while the request is open =================
insert into t values
  ('A3 no new booking', pg_temp.r(pg_temp.u(1), format($$select hold_slot(%L, %L, %L, %L, gen_random_uuid())::text$$,
       pg_temp.club(), pg_temp.court(), pg_temp.at(7, 6), pg_temp.at(7, 6) + interval '60 min')) like 'ERR%account_deletion_requested%', ''),
  ('A3 no new game', pg_temp.r(pg_temp.u(1), $$select post_match((select id from clubs where slug = 'batroun'), 'padel', now() + interval '4 days', now() + interval '4 days 90 min', null, null, 3, 'm2 blocked', null, 'open', gen_random_uuid())::text$$) like 'ERR%account_deletion_requested%', ''),
  ('A3 no joining a game', pg_temp.r(pg_temp.u(1), $$select join_match('d2000000-0000-4000-8000-000000000103')::text$$) like 'ERR%account_deletion_requested%', ''),
  ('A3 no chat message in a game they are already in', pg_temp.r(pg_temp.u(1), $$insert into match_messages (match_id, profile_id, body) values ('d2000000-0000-4000-8000-000000000102', auth.uid(), 'still here')$$) like 'ERR%account_deletion_requested%', ''),
  ('A3 no new coach listing', pg_temp.r(pg_temp.u(1), $$insert into coaches (profile_id, sports, active) values (auth.uid(), '{padel}', true)$$) like 'ERR%', ''),
  ('A3 other players are unaffected', pg_temp.r(pg_temp.u(2), format($$select hold_slot(%L, %L, %L, %L, gen_random_uuid())::text$$,
       pg_temp.club(), pg_temp.court(), pg_temp.at(7, 6), pg_temp.at(7, 6) + interval '60 min')) not like 'ERR%', ''),
  ('A4 the person can cancel the request', pg_temp.r(pg_temp.u(1), $$select cancel_account_deletion()::text$$) = 'ok', '');
insert into t values
  ('A4 the request is marked cancelled', (select status = 'cancelled' from account_deletions where subject_id = pg_temp.u(1)), ''),
  ('A4 cancelling twice is refused', pg_temp.r(pg_temp.u(1), $$select cancel_account_deletion()::text$$) like 'ERR no_open_request%', ''),
  ('A4 after cancelling, a new game can be posted again', pg_temp.r(pg_temp.u(1), $$select post_match((select id from clubs where slug = 'batroun'), 'padel', now() + interval '4 days', now() + interval '4 days 90 min', null, null, 3, 'm2 after cancel', null, 'open', gen_random_uuid())::text$$) not like 'ERR%', pg_temp.r(pg_temp.u(1), $$select post_match((select id from clubs where slug = 'batroun'), 'padel', now() + interval '4 days', now() + interval '4 days 90 min', null, null, 3, 'm2 after cancel x', null, 'open', gen_random_uuid())::text$$));
-- clean up A3/A4 side effects (player 2's hold, player 1's extra game), then request again
delete from payments where booking_id in (select id from bookings where player_id = pg_temp.u(2) and start_at = pg_temp.at(7, 6));
delete from bookings where player_id = pg_temp.u(2) and start_at = pg_temp.at(7, 6);
delete from match_players where match_id in (select id from matches where note like 'm2 after cancel%');
delete from matches where note like 'm2 after cancel%';
insert into t values ('A4 requesting again', pg_temp.r(pg_temp.u(1), $$select request_account_deletion()->>'status'$$) = 'requested', '');
insert into t values ('A4 a new request row; the cancelled one stays as history', (select count(*) = 2 from account_deletions where subject_id = pg_temp.u(1)), '');

-- ================= who may process =================
insert into t values
  ('A5 the person cannot run the deletion themselves', pg_temp.r(pg_temp.u(1), format($$select delete_account_data(%L)::text$$, pg_temp.u(1))) like 'ERR%', ''),
  ('A5 another player cannot', pg_temp.r(pg_temp.u(2), format($$select delete_account_data(%L)::text$$, pg_temp.u(1))) like 'ERR%', ''),
  ('A5 club staff cannot', pg_temp.r(pg_temp.u(4), format($$select delete_account_data(%L)::text$$, pg_temp.u(1))) like 'ERR%', ''),
  ('A5 signed out cannot', pg_temp.r(null, format($$select delete_account_data(%L)::text$$, pg_temp.u(1))) like 'ERR%', ''),
  ('A5 nothing changed after the refused attempts', (select count(*) from bookings where player_id = pg_temp.u(1)) = 5, ''),
  ('A6 no request, no deletion', pg_temp.r(pg_temp.u(3), format($$select delete_account_data(%L)::text$$, pg_temp.u(2))) like 'ERR no_open_request%', ''),
  ('A6 the admin list shows the request with what it will touch',
     pg_temp.r(pg_temp.u(3), format($$select upcoming_bookings || '/' || upcoming_games_organised || '/' || open_reports_about || '/' || coalesce(refusal, '-')
       from admin_account_deletions() where subject_id = %L$$, pg_temp.u(1))) = '3/1/1/-', '');

-- refusals (manual handling)
insert into t values
  ('A7 legal hold: request recorded by support', pg_temp.r(pg_temp.u(3), format($$select admin_record_deletion_request(%L)::text$$, pg_temp.u(6))) = 'ok', ''),
  ('A7 legal hold: processing refused', pg_temp.r(pg_temp.u(3), format($$select delete_account_data(%L)::text$$, pg_temp.u(6))) like 'ERR legal_hold%', ''),
  ('A7 coach with coach bookings: refused', pg_temp.r(pg_temp.u(5), $$select request_account_deletion()->>'status'$$) = 'requested'
     and pg_temp.r(pg_temp.u(3), format($$select delete_account_data(%L)::text$$, pg_temp.u(5))) like 'ERR coach_has_bookings%', '');

-- ================= processing =================
-- 1 is suspended (the deletion record keeps the suspension's date and reason)
insert into account_suspensions (profile_id, reason, suspended_by) values (pg_temp.u(1), 'm2 suspension reason', pg_temp.u(3));
create temp table res (summary jsonb);
grant all on res to authenticated;
-- roles gained after the request are checked again when it is processed (server side, not only at request time)
insert into t values
  ('A8 player 8 and player 9 request', pg_temp.r(pg_temp.u(8), $$select request_account_deletion()->>'status'$$) = 'requested'
     and pg_temp.r(pg_temp.u(9), $$select request_account_deletion()->>'status'$$) = 'requested', '');
insert into club_staff (club_id, profile_id) values (pg_temp.club(), pg_temp.u(8));
update profiles set roles = '{player,admin}' where id = pg_temp.u(9);
insert into t values
  ('A8 became staff after asking: processing refused', pg_temp.r(pg_temp.u(3), format($$select delete_account_data(%L)::text$$, pg_temp.u(8))) like 'ERR staff_role%', ''),
  ('A8 became admin after asking: processing refused', pg_temp.r(pg_temp.u(3), format($$select delete_account_data(%L)::text$$, pg_temp.u(9))) like 'ERR admin_role%', ''),
  ('A8 the refused requests changed nothing', (select count(*) = 2 from account_deletions where subject_id in (pg_temp.u(8), pg_temp.u(9)) and status = 'requested'), '');
-- no dashboard shortcut: an account with history cannot be deleted before its data step; an unused one can
do $$ begin
  delete from auth.users where id = pg_temp.u(2);
  insert into t values ('A9 deleting a sign-in account with history directly is refused', false, 'deleted');
exception when others then
  insert into t values ('A9 deleting a sign-in account with history directly is refused', sqlerrm like '%use_delete_account%', sqlerrm);
end $$;
-- protected accounts without any history: staff (13), admin (14), reported player on legal hold (15)
insert into club_staff (club_id, profile_id) values (pg_temp.club(), pg_temp.u(13));
update profiles set roles = '{player,admin}' where id = pg_temp.u(14);
insert into reports (reporter_id, target_kind, profile_id, target_key, reason, legal_hold) values (pg_temp.u(2), 'player', pg_temp.u(15), pg_temp.u(15), 'danger', true);
do $$ declare n int; v text; begin
  foreach n in array array[13, 14, 15] loop
    begin
      delete from auth.users where id = pg_temp.u(n);
      insert into t values ('A9 direct deletion of protected account ' || n || ' (no history) is refused', false, 'deleted');
    exception when others then
      v := case n when 13 then 'staff_role' when 14 then 'admin_role' else 'legal_hold' end;
      insert into t values ('A9 direct deletion of protected account ' || n || ' (no history) is refused: ' || v, sqlerrm like '%use_delete_account: ' || v || '%', sqlerrm);
    end;
  end loop;
end $$;
do $$ begin
  delete from auth.users where id = pg_temp.u(12);
  insert into t values ('A9 an unused account can still be deleted directly', true, '');
exception when others then
  insert into t values ('A9 an unused account can still be deleted directly', false, sqlerrm);
end $$;
-- a stale hold (its slot time already passed, never swept): player 10 asks, admin processes
insert into f select 'h10', pg_temp.bk(pg_temp.u(10), 13, 2, 'pending');
select pg_temp.pay((select id from f where k = 'h10'), pg_temp.u(10), 'pending');
alter table bookings disable trigger user;
update bookings set start_at = now() - interval '3 hours', end_at = now() - interval '2 hours', hold_expires_at = now() - interval '4 hours' where id = (select id from f where k = 'h10');
alter table bookings enable trigger user;
insert into t values ('A10 player 10 with a stale hold: processed', pg_temp.r(pg_temp.u(10), $$select request_account_deletion()->>'status'$$) = 'requested'
  and pg_temp.r(pg_temp.u(3), format($$select delete_account_data(%L)::text$$, pg_temp.u(10))) not like 'ERR%', '');
insert into t values ('A10 the stale hold is cancelled, not left pending for a nameless owner',
  (select b.status = 'cancelled' and p.status = 'expired' and b.player_id is null from bookings b join payments p on p.booking_id = b.id where b.id = (select id from f where k = 'h10')), '');

insert into t values ('B1 the admin processes the request',
  pg_temp.r(pg_temp.u(3), format($$select delete_account_data(%L)::text$$, pg_temp.u(1))) not like 'ERR%', '');
insert into res select summary from account_deletions where subject_id = pg_temp.u(1) and status = 'data_removed';
insert into t values
  ('B1 status data_removed, processed by the admin', (select status = 'data_removed' and processed_by = pg_temp.u(3) from account_deletions where subject_id = pg_temp.u(1) and status <> 'cancelled'), ''),
  ('B1 summary counts', (select summary->>'games_cancelled' = '1' and summary->>'bookings_cancelled' = '3' and summary->>'refunds_due' = '1'
      and summary->>'bookings_anonymised' = '5' and summary->>'messages_deleted' = '1' and summary->>'game_notes_cleared' = '1' from res), (select summary::text from res)),
  ('B1 the suspension''s date is recorded, not its free-text reason', (select summary->'suspension'->>'suspended_at' is not null and not (summary->'suspension') ? 'reason' from res), ''),
  -- bookings: same outcomes as cancel_booking for the control player
  ('B2 before the cutoff: cancelled, refund due', (select b.status = 'cancelled' and p.status = 'refund_due' from bookings b join payments p on p.booking_id = b.id where b.id = (select id from f where k = 'b_out')), ''),
  ('B2 inside the cutoff: cancelled, payment kept (no refund)', (select b.status = 'cancelled' and p.status = 'paid' from bookings b join payments p on p.booking_id = b.id where b.id = (select id from f where k = 'b_in')), ''),
  ('B2 hold: cancelled, payment expired', (select b.status = 'cancelled' and p.status = 'expired' from bookings b join payments p on p.booking_id = b.id where b.id = (select id from f where k = 'b_hold')), ''),
  ('B2 past booking: kept as it was (confirmed, paid)', (select b.status = 'confirmed' and p.status = 'paid' from bookings b join payments p on p.booking_id = b.id where b.id = (select id from f where k = 'b_past')), ''),
  ('B2 every booking anonymised: no player, "Former player", no phone', (select count(*) = 5 and bool_and(player_id is null and guest_name = 'Former player' and guest_phone is null)
      from bookings where id in (select id from f where k like 'b_%')), ''),
  ('B2 the booking being played now stays as it is (confirmed), anonymised', (select status = 'confirmed' and player_id is null from bookings where id = (select id from f where k = 'b_now')), ''),
  ('B2 no anonymised booking is still upcoming or pending', (select count(*) = 0 from bookings where id in (select id from f where k like 'b_%')
      and (status = 'pending' or (status = 'confirmed' and start_at > now()))), ''),
  ('B2 payments: all kept, same amounts', (select count(*) = (select n_pay from snap) and sum(total_usd) = (select total from snap) from payments where booking_id in (select id from f where k like 'b_%')), '');
insert into t values
  ('B3 control: player 7 cancels the same three bookings through cancel_booking',
     pg_temp.r(pg_temp.u(7), format($$select cancel_booking(%L)::text$$, (select id from f where k = 'c_out'))) = 'ok'
     and pg_temp.r(pg_temp.u(7), format($$select cancel_booking(%L)::text$$, (select id from f where k = 'c_in'))) = 'ok'
     and pg_temp.r(pg_temp.u(7), format($$select cancel_booking(%L)::text$$, (select id from f where k = 'c_hold'))) = 'ok', '');
insert into t values
  ('B3 deletion gives the same outcomes as cancel_booking (booking and payment status)',
     (select string_agg(b.status || ':' || p.status, ',' order by f.k) from f join bookings b on b.id = f.id join payments p on p.booking_id = b.id where f.k in ('c_out', 'c_in', 'c_hold'))
       = (select string_agg(b.status || ':' || p.status, ',' order by f.k) from f join bookings b on b.id = f.id join payments p on p.booking_id = b.id where f.k in ('b_out', 'b_in', 'b_hold')),
     (select string_agg(f.k || '=' || b.status || ':' || p.status, ',' order by f.k) from f join bookings b on b.id = f.id join payments p on p.booking_id = b.id where f.k in ('c_out', 'c_in', 'c_hold', 'b_out', 'b_in', 'b_hold')));
insert into t values
  ('B4 their game: cancelled', (select status = 'cancelled' from matches where id = pg_temp.u(101)), ''),
  ('B4 its player was told', (select count(*) = 1 from notifications where profile_id = pg_temp.u(2) and match_id = pg_temp.u(101) and kind = 'match_cancelled'), ''),
  ('B4 the full game they were in reopens', (select status = 'open' and closed_reason is null from matches where id = pg_temp.u(102)), ''),
  ('B4 its organiser was told a player left', (select count(*) = 1 from notifications where profile_id = pg_temp.u(2) and match_id = pg_temp.u(102) and kind = 'player_left'), ''),
  ('B4 out of every game list', (select count(*) = 0 from match_players where profile_id = pg_temp.u(1)), ''),
  ('B5 their messages deleted, others kept', (select count(*) = 0 from match_messages where profile_id = pg_temp.u(1))
      and (select count(*) = 1 from match_messages where id = pg_temp.u(202)), ''),
  ('B5 the report on their message is kept with its snapshot', (select message_id is null and snapshot = 'm2 message by 1' and target_key = pg_temp.u(201) from reports where id = pg_temp.u(301)), ''),
  ('B6 coach listing removed', (select count(*) = 0 from coaches where profile_id = pg_temp.u(1)) and (select count(*) = 0 from coach_clubs where coach_id = pg_temp.u(401)), ''),
  ('B8 the chat excerpt in another player''s notifications is gone', (select count(*) = 0 from notifications where actor_id = pg_temp.u(1) and kind = 'match_message'), ''),
  ('B8 their name in another player''s notice became "A player"', (select count(*) >= 1 and bool_and(body like 'A player %') from notifications where actor_id = pg_temp.u(1) and kind = 'player_joined'), ''),
  ('B8 a notice naming someone else is untouched (Person 11 is not Person 1)', (select bool_and(body = 'Person 11 joined your match') from notifications where actor_id = pg_temp.u(11)), ''),
  ('B8 no notification anywhere still names them', (select count(*) = 0 from notifications where body ~ '\mPerson 1\M'), ''),
  ('B8 the note on their game is cleared', (select note is null from matches where id = pg_temp.u(101)), ''),
  ('B8 their Help & Feedback message is deleted; their moderation report is kept', (select count(*) = 0 from reports where id = pg_temp.u(304))
      and (select count(*) = 1 from reports where id = pg_temp.u(302)), ''),
  ('B9 still signed in while the sign-in deletion is pending: no new booking', pg_temp.r(pg_temp.u(1), format($$select hold_slot(%L, %L, %L, %L, gen_random_uuid())::text$$,
       pg_temp.club(), pg_temp.court(), pg_temp.at(11, 6), pg_temp.at(11, 6) + interval '60 min')) like 'ERR%account_deletion_requested%', ''),
  ('B9 ...and no chat message', pg_temp.r(pg_temp.u(1), $$insert into match_messages (match_id, profile_id, body) values ('d2000000-0000-4000-8000-000000000102', auth.uid(), 'after')$$) like 'ERR%', ''),
  ('B9 ...and no new game', pg_temp.r(pg_temp.u(1), $$select post_match((select id from clubs where slug = 'batroun'), 'padel', now() + interval '4 days', now() + interval '4 days 90 min', null, null, 3, 'x', null, 'open', gen_random_uuid())::text$$) like 'ERR%', ''),
  ('B6 profile anonymised already (name, phone)', (select name is null and phone is null and not email_notifications from profiles where id = pg_temp.u(1)), ''),
  ('B7 running it again succeeds', pg_temp.r(pg_temp.u(3), format($$select delete_account_data(%L)::text$$, pg_temp.u(1))) not like 'ERR%', ''),
  ('B7 finishing before the sign-in account is gone is refused', pg_temp.r(pg_temp.u(3), format($$select finish_account_deletion(%L)::text$$, pg_temp.u(1))) like 'ERR account_still_exists%', '');
insert into t values
  ('B7 ...and changed nothing: first-run counts kept, the re-run found nothing, no second notice',
     (select (summary - 'last_rerun') = (select r.summary from res r) and summary->'last_rerun'->>'bookings_cancelled' = '0'
        and summary->'last_rerun'->>'bookings_anonymised' = '0' from account_deletions where subject_id = pg_temp.u(1) and status = 'data_removed')
     and (select count(*) = 1 from notifications where profile_id = pg_temp.u(2) and match_id = pg_temp.u(101)),
     (select summary::text from account_deletions where subject_id = pg_temp.u(1) and status = 'data_removed'));
-- a hold that was still being written while the data step ran (lands after it): the re-run cancels and anonymises it
alter table bookings disable trigger user;
insert into f select 'b_late', pg_temp.bk(pg_temp.u(1), 13, 6, 'pending');
alter table bookings enable trigger user;
insert into t values ('B10 a late hold: re-run succeeds', pg_temp.r(pg_temp.u(3), format($$select delete_account_data(%L)::text$$, pg_temp.u(1))) not like 'ERR%', '');
insert into t values ('B10 ...the late hold is cancelled and anonymised', (select status = 'cancelled' and player_id is null and guest_name = 'Former player' from bookings where id = (select id from f where k = 'b_late')), ''),
  ('B10 ...and recorded as a re-run', (select summary->'last_rerun'->>'bookings_cancelled' = '1' from account_deletions where subject_id = pg_temp.u(1) and status = 'data_removed'), '');

-- ================= the server deletes the sign-in account =================
do $$ begin
  delete from auth.users where id = pg_temp.u(1);
  insert into t values ('C0 the sign-in account can be deleted (every reference allows it)', true, '');
exception when others then
  insert into t values ('C0 the sign-in account can be deleted (every reference allows it)', false, sqlerrm);
end $$;
insert into t values
  ('C1 the sign-in account and profile are gone', (select count(*) = 0 from profiles where id = pg_temp.u(1)), ''),
  ('C1 bookings kept', (select count(*) = 6 from bookings where id in (select id from f where k like 'b_%')), ''),
  ('C1 payments kept, payer removed', (select count(*) = (select n_pay from snap) and bool_and(profile_id is null) from payments where booking_id in (select id from f where k like 'b_%')), ''),
  ('C1 bookings they entered: author removed, rows kept', (select count(*) = 6 and bool_and(created_by is null) from bookings where id in (select id from f where k like 'b_%')), ''),
  ('C1 their cancelled game kept, organiser removed', (select organizer_id is null and status = 'cancelled' from matches where id = pg_temp.u(101)), ''),
  ('C1 the report they filed is kept (moderation evidence)', (select reporter_id is null and target_key = pg_temp.u(2) from reports where id = pg_temp.u(302)), ''),
  ('C1 the report about their message is kept', (select count(*) = 1 from reports where id = pg_temp.u(301)), ''),
  ('C1 their own suspension row went with the account (its date and reason are in the summary)', (select count(*) = 0 from account_suspensions where profile_id = pg_temp.u(1)), ''),
  ('C1 a session token that outlives the account cannot book', pg_temp.r(pg_temp.u(1), format($$select hold_slot(%L, %L, %L, %L, gen_random_uuid())::text$$,
       pg_temp.club(), pg_temp.court(), pg_temp.at(12, 6), pg_temp.at(12, 6) + interval '60 min')) like 'ERR%', ''),
  ('C1 ...nor post in chat', pg_temp.r(pg_temp.u(1), $$insert into match_messages (match_id, profile_id, body) values ('d2000000-0000-4000-8000-000000000102', auth.uid(), 'hello')$$) like 'ERR%', ''),
  ('C2 finishing succeeds', pg_temp.r(pg_temp.u(3), format($$select finish_account_deletion(%L)::text$$, pg_temp.u(1))) = 'ok', '');
insert into t values
  ('C2 the request is marked done', (select status = 'done' and done_at is not null from account_deletions where subject_id = pg_temp.u(1) and status <> 'cancelled'), ''),
  ('C2 the record holds no name, phone or email', (select count(*) = 0 from account_deletions d where d::text ~* '(Person 1|\+961710001|@)'), ''),
  ('C2 finishing twice is refused', pg_temp.r(pg_temp.u(3), format($$select finish_account_deletion(%L)::text$$, pg_temp.u(1))) like 'ERR no_removed_request%', '');
-- an admin who suspended someone, then lost the role and was deleted: the suspension stays
update profiles set roles = '{player}' where id = pg_temp.u(3);
insert into account_suspensions (profile_id, reason, suspended_by) values (pg_temp.u(2), 'm2 kept suspension', pg_temp.u(3));
do $$ begin delete from auth.users where id = pg_temp.u(3); exception when others then null; end $$;
insert into t values ('C3 a suspension stays when the admin who made it is deleted', (select suspended_by is null from account_suspensions where profile_id = pg_temp.u(2)), '');

-- ================= grants =================
insert into t values
  ('D1 anon can run none of the deletion functions', not has_function_privilege('anon', 'request_account_deletion(text)', 'execute')
     and not has_function_privilege('anon', 'delete_account_data(uuid)', 'execute') and not has_function_privilege('anon', 'my_account_deletion()', 'execute')
     and not has_function_privilege('anon', 'admin_account_deletions()', 'execute') and not has_function_privilege('anon', 'finish_account_deletion(uuid)', 'execute'), ''),
  ('D1 the internal helpers are not callable by signed-in users', not has_function_privilege('authenticated', 'deletion_requested(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'deletion_refusal(uuid)', 'execute'), ''),
  ('D1 the admin list refuses non-admins', pg_temp.r(pg_temp.u(2), $$select count(*)::text from admin_account_deletions()$$) like 'ERR forbidden%', '');

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
