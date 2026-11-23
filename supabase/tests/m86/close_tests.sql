-- 0086 tests: one-confirmation account closure, lock-out, the idempotent pipeline (claim, lease, steps, retries),
-- held accounts (legal hold, coach bookings, suspended), attention, privileges. Run by deletion86.sh inside ONE
-- transaction that is rolled back. psql variable :mig is the migration file under test (0086).
\set ON_ERROR_STOP 1
begin;
\i :mig
\i :mig
create temp table t (id text, pass boolean, detail text);
insert into t values ('E0 the migration applies twice without error', true, '');

-- run q as user `who` (null = signed out); returns its single value, 'ok', or 'ERR <message>'
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
-- the same with the service key (no signed-in person): the website's server
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
-- a check that needs the person's id but no role switch (assert_active is not granted to players)
create function pg_temp.as_postgres_with(who uuid, q text) returns text language plpgsql as $f$
declare res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin execute q; res := 'ok'; exception when others then res := 'ERR ' || sqlerrm; end;
  perform set_config('request.jwt.claim.sub', '', true);
  return res;
end $f$;
grant all on t to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql as $$ select ('d8600000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.club() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
insert into courts (id, club_id, name, sport, active, sort)
select 'd8600000-0000-4000-8000-000000000900', id, 'M86 court', 'padel', true, 99 from clubs where slug = 'batroun';
create function pg_temp.court() returns uuid language sql as $$ select 'd8600000-0000-4000-8000-000000000900'::uuid $$;
create function pg_temp.at(d int, h int default 2) returns timestamptz language sql as $$
  select ((current_date + d)::timestamp + c.open_time + make_interval(hours => h)) at time zone c.timezone from clubs c where c.id = pg_temp.club() $$;
create function pg_temp.bk(who uuid, d int, h int, st booking_status) returns uuid language sql as $$
  insert into bookings (club_id, court_id, player_id, created_by, start_at, end_at, status, source, price_usd, fee_usd, hold_expires_at)
  values (pg_temp.club(), pg_temp.court(), who, who, pg_temp.at(d, h), pg_temp.at(d, h) + interval '60 min', st, 'app', 20, 1,
          case when st = 'pending' then now() + interval '10 min' end) returning id $$;
create function pg_temp.pay(b uuid, who uuid, st payment_status) returns void language sql as $$
  insert into payments (booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd, status, paid_at)
  values (b, who, pg_temp.club(), 'simulated', 20, 1, 21, st, case when st = 'paid' then now() end) $$;
-- a fresh token from a claim, as the server would hold it
create function pg_temp.claim(n int) returns uuid language sql as $$ select (pg_temp.s(format('select claim_deletion(%L)::text', pg_temp.u(n)))::jsonb->>'token')::uuid $$;
create function pg_temp.rec(n int) returns account_deletions language sql as $$
  select * from account_deletions where subject_id = pg_temp.u(n) order by requested_at desc limit 1 $$;

-- fixtures. 1 normal player; 2 other player; 3 admin; 4 club staff; 5 reported player under legal hold; 6 coach with a
-- coach booking; 7 suspended player; 8 retry player; 9 asked by email (support); 10 auth-before-data; 11 old request
insert into auth.users (id, phone) select pg_temp.u(n), '+9617860' || lpad(n::text, 2, '0') from generate_series(1, 12) n;
update profiles set name = 'Closer ' || ltrim(right(id::text, 2), '0'), phone = '+96170860' || right(id::text, 2), rules_accepted_at = now()
 where id in (select pg_temp.u(n) from generate_series(1, 12) n);
update profiles set roles = '{player,admin}' where id = pg_temp.u(3);
insert into club_staff (club_id, profile_id) values (pg_temp.club(), pg_temp.u(4));
update clubs set payment_mode = 'simulated', cancel_cutoff_hours = 200, booking_window_days = 14 where slug = 'batroun';
create temp table f (k text primary key, id uuid);
grant all on f to anon, authenticated, service_role;
insert into f select 'b1', pg_temp.bk(pg_temp.u(1), 10, 2, 'confirmed');
select pg_temp.pay((select id from f where k = 'b1'), pg_temp.u(1), 'paid');
insert into f select 'b5', pg_temp.bk(pg_temp.u(5), 10, 4, 'confirmed');
select pg_temp.pay((select id from f where k = 'b5'), pg_temp.u(5), 'paid');
insert into f select 'b7', pg_temp.bk(pg_temp.u(7), 10, 6, 'confirmed');
insert into f select 'b10', pg_temp.bk(pg_temp.u(10), 11, 2, 'confirmed');
-- games: g1 by 1 (2 joined); g2 by 2 (1 and 5 joined); g3 cancelled, 1 was in it; g5 by 5 (2 joined)
insert into matches (id, club_id, sport, organizer_id, start_at, end_at, players_needed, status, join_mode, note) values
  (pg_temp.u(101), pg_temp.club(), 'padel', pg_temp.u(1), now() + interval '3 days', now() + interval '3 days 90 min', 3, 'open', 'open', 'g1'),
  (pg_temp.u(102), pg_temp.club(), 'padel', pg_temp.u(2), now() + interval '3 days', now() + interval '3 days 90 min', 3, 'open', 'open', 'g2'),
  (pg_temp.u(103), pg_temp.club(), 'padel', pg_temp.u(2), now() + interval '3 days', now() + interval '3 days 90 min', 3, 'cancelled', 'open', 'g3'),
  (pg_temp.u(105), pg_temp.club(), 'padel', pg_temp.u(5), now() + interval '3 days', now() + interval '3 days 90 min', 3, 'open', 'open', 'g5');
insert into match_players (match_id, profile_id, status) values
  (pg_temp.u(101), pg_temp.u(2), 'accepted'), (pg_temp.u(102), pg_temp.u(1), 'accepted'), (pg_temp.u(102), pg_temp.u(5), 'accepted'),
  (pg_temp.u(103), pg_temp.u(1), 'accepted'), (pg_temp.u(105), pg_temp.u(2), 'accepted');
insert into match_messages (id, match_id, profile_id, body) values
  (pg_temp.u(201), pg_temp.u(102), pg_temp.u(1), 'm86 message by 1'), (pg_temp.u(205), pg_temp.u(102), pg_temp.u(5), 'm86 message by 5');
insert into notifications (id, profile_id, kind, match_id, body) values (pg_temp.u(301), pg_temp.u(1), 'player_joined', pg_temp.u(101), 'Someone joined');
insert into player_levels (profile_id, sport, level) values (pg_temp.u(1), 'padel', 5);
insert into reports (id, reporter_id, target_kind, profile_id, target_key, reason, legal_hold)
values (pg_temp.u(401), pg_temp.u(2), 'player', pg_temp.u(5), pg_temp.u(5), 'danger', true);
insert into coaches (id, profile_id, sports, active) values (pg_temp.u(406), pg_temp.u(6), '{padel}', true);
alter table bookings disable trigger user;
insert into bookings (club_id, coach_id, player_id, created_by, start_at, end_at, status, source)
values (pg_temp.club(), pg_temp.u(406), pg_temp.u(2), pg_temp.u(2), now() + interval '4 days', now() + interval '4 days 1 hour', 'confirmed', 'app');
alter table bookings enable trigger user;
insert into account_suspensions (profile_id, reason, suspended_by) values (pg_temp.u(7), 'm86 suspension', pg_temp.u(3));
create temp table tok (k text primary key, v uuid);
grant all on tok to service_role;

-- ================= E: schema =================
insert into t values
  ('E1 every table but account_deletions has the closed-account lock-out (a new table must get it too)',
     (select count(*) = 0 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'account_deletions'
        and not exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = 'closed_account_lockout')),
     (select string_agg(c.relname, ', ') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'account_deletions'
        and not exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = 'closed_account_lockout'))),
  ('E2 exactly one delete_account_data (the old one-argument version is gone)', (select count(*) = 1 from pg_proc where proname = 'delete_account_data' and pronamespace = 'public'::regnamespace), ''),
  ('E2 players and signed-out visitors cannot run the server steps',
     not has_function_privilege('authenticated', 'claim_deletion(uuid, integer)', 'execute') and not has_function_privilege('anon', 'claim_deletion(uuid, integer)', 'execute')
     and not has_function_privilege('authenticated', 'record_deletion_step(uuid, uuid, text, text)', 'execute')
     and not has_function_privilege('authenticated', 'deletions_due(integer)', 'execute')
     and not has_function_privilege('authenticated', 'deletions_needing_attention()', 'execute')
     and not has_function_privilege('authenticated', 'mark_deletion_alerted(uuid)', 'execute'), ''),
  ('E2 the inner close is callable by no one directly (only through close_my_account / the admin)',
     not has_function_privilege('authenticated', 'close_account_internal(uuid, text)', 'execute') and not has_function_privilege('anon', 'close_account_internal(uuid, text)', 'execute')
     and not has_function_privilege('service_role', 'close_account_internal(uuid, text)', 'execute'), ''),
  ('E2 close_my_account: signed-in players yes, signed-out no', has_function_privilege('authenticated', 'close_my_account(text)', 'execute') and not has_function_privilege('anon', 'close_my_account(text)', 'execute'), ''),
  ('E3 the server steps refuse a signed-in caller even if granted', pg_temp.r(pg_temp.u(3), format($$select claim_deletion(%L)::text$$, pg_temp.u(1))) like 'ERR%', '');

-- ================= F: closing =================
insert into t values
  ('F1 signed out cannot close', pg_temp.r(null, $$select close_my_account()::text$$) like 'ERR%', ''),
  ('F1 a player cannot pick the support channel', pg_temp.r(pg_temp.u(1), $$select close_my_account('support')::text$$) like 'ERR invalid_via%', ''),
  ('F1 club staff: refused (support removes the role first)', pg_temp.r(pg_temp.u(4), $$select close_my_account()::text$$) like 'ERR staff_role%', ''),
  ('F1 admin: refused', pg_temp.r(pg_temp.u(3), $$select close_my_account()::text$$) like 'ERR admin_role%', '');
insert into t values ('F1 refused closes wrote nothing', (select count(*) = 0 from account_deletions where subject_id in (pg_temp.u(3), pg_temp.u(4))), '');
insert into t values ('F2 player 1 closes (website): a new record', pg_temp.r(pg_temp.u(1), $$select (close_my_account('web')->>'status')$$) = 'closing', '');
insert into t values ('F2 closing again (second tap, second device): the same record, nothing new', pg_temp.r(pg_temp.u(1), $$select close_my_account('web')->>'new'$$) = 'false', '');
insert into t values
  ('F2 one record, closing, with its time; nothing deleted yet', (select count(*) = 1 and bool_and(status = 'closing' and closing_at is not null and banned_at is null and attempts = 0)
     from account_deletions where subject_id = pg_temp.u(1)) and (select name = 'Closer 1' from profiles where id = pg_temp.u(1)), ''),
  ('F2 the person sees "closed" (another device signs out on this)', pg_temp.r(pg_temp.u(1), $$select my_account_deletion()->>'closed'$$) = 'true', ''),
  ('F2 the record holds no name, phone or email', (select count(*) = 0 from account_deletions d where d::text ~* '(Closer|\+961|@)'), '');

-- ================= F3: a closed account changes nothing, whatever the path =================
insert into t values
  ('F3 no new booking', pg_temp.r(pg_temp.u(1), format($$select hold_slot(%L, %L, %L, %L, gen_random_uuid())::text$$,
     pg_temp.club(), pg_temp.court(), pg_temp.at(7, 6), pg_temp.at(7, 6) + interval '60 min')) like 'ERR%account_closed%', ''),
  ('F3 no cancelling a booking (the server does it under the rules)', pg_temp.r(pg_temp.u(1), format($$select cancel_booking(%L, false)::text$$, (select id from f where k = 'b1'))) like 'ERR%account_closed%', ''),
  ('F3 no new game', pg_temp.r(pg_temp.u(1), $$select post_match((select id from clubs where slug = 'batroun'), 'padel', now() + interval '4 days', now() + interval '4 days 90 min', null, null, 3, 'm86', null, 'open', gen_random_uuid())::text$$) like 'ERR%account_closed%', ''),
  ('F3 no leaving a game', pg_temp.r(pg_temp.u(1), format($$select leave_match(%L)::text$$, pg_temp.u(102))) like 'ERR%account_closed%', ''),
  ('F3 no hiding a game', pg_temp.r(pg_temp.u(1), format($$select hide_match(%L, true)::text$$, pg_temp.u(103))) like 'ERR%account_closed%', ''),
  ('F3 no chat message', pg_temp.r(pg_temp.u(1), format($$insert into match_messages (match_id, profile_id, body) values (%L, auth.uid(), 'x')$$, pg_temp.u(102))) like 'ERR%account_closed%', ''),
  ('F3 no blocking a player', pg_temp.r(pg_temp.u(1), format($$select block_player(%L)::text$$, pg_temp.u(2))) like 'ERR%account_closed%', ''),
  ('F3 no report', pg_temp.r(pg_temp.u(1), format($$select report_content('player', %L, 'spam', null)::text$$, pg_temp.u(2))) like 'ERR%account_closed%', ''),
  ('F3 no feedback message', pg_temp.r(pg_temp.u(1), $$select send_feedback('suggestion', 'x', null)::text$$) like 'ERR%account_closed%', ''),
  ('F3 no marking notices read', pg_temp.r(pg_temp.u(1), format($$select mark_notifications_read(array[%L]::uuid[])::text$$, pg_temp.u(301))) like 'ERR%account_closed%', ''),
  ('F3 no re-entering a name in the profile', pg_temp.r(pg_temp.u(1), $$update profiles set name = 'Back again' where id = auth.uid()$$) like 'ERR%account_closed%', ''),
  ('F3 no changing levels', pg_temp.r(pg_temp.u(1), $$update player_levels set level = 6 where profile_id = auth.uid()$$) like 'ERR%account_closed%', ''),
  ('F3 no coach listing', pg_temp.r(pg_temp.u(1), $$insert into coaches (profile_id, sports, active) values (auth.uid(), '{padel}', true)$$) like 'ERR%account_closed%', ''),
  ('F3 assert_active (used by every game function) answers account_closed (backup to the lock-out)',
     (select pg_temp.as_postgres_with(pg_temp.u(1), 'select assert_active()')) like 'ERR account_closed%', ''),
  ('F3 reading still works (nothing to hide from the person; the app signs out)', pg_temp.r(pg_temp.u(1), $$select count(*)::text from bookings where player_id = auth.uid()$$) = '1', '');
insert into t values
  ('F3 ...and nothing changed: booking, game membership, name, level, no new row anywhere',
     (select status = 'confirmed' and player_id = pg_temp.u(1) from bookings where id = (select id from f where k = 'b1'))
     and (select count(*) = 2 from match_players where profile_id = pg_temp.u(1))
     and (select name = 'Closer 1' from profiles where id = pg_temp.u(1))
     and (select level = 5 from player_levels where profile_id = pg_temp.u(1))
     and (select count(*) = 0 from player_blocks where blocker_id = pg_temp.u(1))
     and (select count(*) = 0 from reports where reporter_id = pg_temp.u(1))
     and (select count(*) = 0 from match_hidden where profile_id = pg_temp.u(1)), ''),
  ('F4 another player is unaffected (books, chats)', pg_temp.r(pg_temp.u(2), format($$select hold_slot(%L, %L, %L, %L, gen_random_uuid())::text$$,
     pg_temp.club(), pg_temp.court(), pg_temp.at(8, 6), pg_temp.at(8, 6) + interval '60 min')) not like 'ERR%'
     and pg_temp.r(pg_temp.u(2), format($$insert into match_messages (match_id, profile_id, body) values (%L, auth.uid(), 'still here')$$, pg_temp.u(102))) = 'ok', ''),
  ('F5 no undo (D1): cancel is not available to players', pg_temp.r(pg_temp.u(1), $$select cancel_account_deletion()::text$$) like 'ERR%permission denied%', ''),
  ('F5 the old request function is not available to players', not has_function_privilege('authenticated', 'request_account_deletion(text)', 'execute'), '');

-- ================= G: the pipeline for player 1 =================
insert into tok select 'p1', pg_temp.claim(1);
insert into t values
  ('G1 a run claims the record', (select v is not null from tok where k = 'p1') and (select attempts = 1 and lease_until > now() from pg_temp.rec(1)), ''),
  ('G1 a second run while the lease holds gets "leased" (no second worker)', pg_temp.s(format($$select claim_deletion(%L)->>'reason'$$, pg_temp.u(1))) = 'leased', ''),
  ('G1 bookkeeping with a wrong token is refused', pg_temp.s(format($$select record_deletion_step(%L, gen_random_uuid(), 'banned')::text$$, pg_temp.u(1))) like 'ERR lease_lost%', ''),
  ('G1 B: sign-in banned, recorded with the token', pg_temp.s(format($$select record_deletion_step(%L, %L, 'banned')->>'status'$$, pg_temp.u(1), (select v from tok where k = 'p1'))) = 'closed', '');
insert into t values
  ('G1 ...banned_at set; a second "banned" changes nothing', pg_temp.s(format($$select record_deletion_step(%L, %L, 'banned')->>'status'$$, pg_temp.u(1), (select v from tok where k = 'p1'))) = 'closed'
     and (select banned_at is not null from pg_temp.rec(1)), ''),
  ('G2 C: the data step with the service key', pg_temp.s(format($$select delete_account_data(%L)::text$$, pg_temp.u(1))) not like 'ERR%', '');
insert into t values
  ('G2 data removed: booking cancelled (refund due) and anonymised, game cancelled, player 2 told, messages gone, name gone',
     (select status = 'data_removed' and data_removed_at is not null from pg_temp.rec(1))
     and (select b.status = 'cancelled' and p.status = 'refund_due' and b.player_id is null from bookings b join payments p on p.booking_id = b.id where b.id = (select id from f where k = 'b1'))
     and (select status = 'cancelled' from matches where id = pg_temp.u(101))
     and (select count(*) = 1 from notifications where profile_id = pg_temp.u(2) and match_id = pg_temp.u(101) and kind = 'match_cancelled')
     and (select count(*) = 0 from match_messages where profile_id = pg_temp.u(1))
     and (select name is null and phone is null from profiles where id = pg_temp.u(1)), ''),
  ('G2 still locked out while the sign-in deletion is pending', pg_temp.r(pg_temp.u(1), format($$select hold_slot(%L, %L, %L, %L, gen_random_uuid())::text$$,
     pg_temp.club(), pg_temp.court(), pg_temp.at(9, 6), pg_temp.at(9, 6) + interval '60 min')) like 'ERR%account_closed%', '');
-- interrupted here: the run dies holding its lease
insert into t values
  ('G3 interrupted: the dead run''s lease blocks others until it expires', pg_temp.s(format($$select claim_deletion(%L)->>'reason'$$, pg_temp.u(1))) = 'leased'
     and pg_temp.s(format($$select (%L = any(array(select deletions_due(100))))::text$$, pg_temp.u(1))) = 'false', '');
update account_deletions set lease_until = now() - interval '1 second' where subject_id = pg_temp.u(1) and status = 'data_removed';   -- the lease expires
insert into t values ('G3 after the lease expires the record is due again', pg_temp.s(format($$select (%L = any(array(select deletions_due(100))))::text$$, pg_temp.u(1))) = 'true', '');
insert into tok select 'p1b', pg_temp.claim(1);
insert into t values
  ('G3 a new run takes over with a new token', (select v is not null and v <> (select v from tok where k = 'p1') from tok where k = 'p1b') and (select attempts = 2 from pg_temp.rec(1)), ''),
  ('G3 the dead run, if it wakes up, can record nothing', pg_temp.s(format($$select record_deletion_step(%L, %L, 'released')::text$$, pg_temp.u(1), (select v from tok where k = 'p1'))) like 'ERR lease_lost%', ''),
  ('G4 C again (re-run after an interruption) is safe', pg_temp.s(format($$select delete_account_data(%L)::text$$, pg_temp.u(1))) not like 'ERR%', '');
insert into t values
  ('G4 ...nothing done twice: one cancellation notice, last_rerun found nothing',
     (select count(*) = 1 from notifications where profile_id = pg_temp.u(2) and match_id = pg_temp.u(101) and kind = 'match_cancelled')
     and (select summary->'last_rerun'->>'bookings_cancelled' = '0' and summary->'last_rerun'->>'bookings_anonymised' = '0' from pg_temp.rec(1)), ''),
  ('G5 a failed step: code kept, lease released, retry after the backoff (attempt 2 → 5 min)',
     pg_temp.s(format($$select record_deletion_step(%L, %L, 'failed', 'auth_delete_failed')->>'status'$$, pg_temp.u(1), (select v from tok where k = 'p1b'))) = 'data_removed', '');
insert into t values
  ('G5 ...last_error, no lease, next try in about 5 minutes', (select last_error = 'auth_delete_failed' and lease_until is null and lease_token is null
     and next_attempt_at between now() + interval '4 minutes' and now() + interval '6 minutes' from pg_temp.rec(1)), ''),
  ('G5 not due before then', pg_temp.s(format($$select (%L = any(array(select deletions_due(100))))::text$$, pg_temp.u(1))) = 'false', '');
update account_deletions set next_attempt_at = now() - interval '1 second' where subject_id = pg_temp.u(1) and status = 'data_removed';
insert into tok select 'p1c', pg_temp.claim(1);
insert into t values
  ('G5 an error that is not a code is stored as unknown_error (never free text)',
     pg_temp.s(format($$select record_deletion_step(%L, %L, 'failed', 'Closer 1 +961 failed')->>'status'$$, pg_temp.u(1), (select v from tok where k = 'p1c'))) = 'data_removed', '');
insert into t values ('G5 ...stored as unknown_error; backoff grows (attempt 3 → 15 min)', (select last_error = 'unknown_error'
   and next_attempt_at between now() + interval '14 minutes' and now() + interval '16 minutes' from pg_temp.rec(1)), '');
-- D: the server deletes the sign-in account, then E
do $$ begin
  delete from auth.users where id = pg_temp.u(1);
  insert into t values ('G6 D: the sign-in account can be deleted after C', true, '');
exception when others then insert into t values ('G6 D: the sign-in account can be deleted after C', false, sqlerrm);
end $$;
insert into t values ('G6 E: finish', pg_temp.s(format($$select finish_account_deletion(%L)::text$$, pg_temp.u(1))) = 'ok', '');
insert into t values
  ('G6 done; lease, error and retry cleared', (select status = 'done' and done_at is not null and lease_token is null and last_error is null and next_attempt_at is null from pg_temp.rec(1)), ''),
  ('G6 finishing again is fine (idempotent)', pg_temp.s(format($$select finish_account_deletion(%L)::text$$, pg_temp.u(1))) = 'ok', ''),
  ('G6 claiming a done record: "done", nothing to do', pg_temp.s(format($$select claim_deletion(%L)->>'reason'$$, pg_temp.u(1))) = 'done', ''),
  ('G6 never due again', pg_temp.s(format($$select (%L = any(array(select deletions_due(100))))::text$$, pg_temp.u(1))) = 'false', ''),
  ('G6 the record holds no name, phone or email', (select count(*) = 0 from account_deletions d where d::text ~* '(Closer|\+961|@)'), '');

-- auth before data is refused (0079 guard), so D can never run before C
insert into t values ('G7 player 10 closes', pg_temp.r(pg_temp.u(10), $$select close_my_account()->>'status'$$) = 'closing', '');
do $$ begin
  delete from auth.users where id = pg_temp.u(10);
  insert into t values ('G7 deleting the sign-in account before the data step is refused', false, 'deleted');
exception when others then insert into t values ('G7 deleting the sign-in account before the data step is refused', sqlerrm like '%use_delete_account%', sqlerrm);
end $$;
-- interrupted between A and B: due at once, claimable
insert into t values ('G8 player 8 closes (app); due at once for the server', pg_temp.r(pg_temp.u(8), $$select close_my_account('app')->>'status'$$) = 'closing', '');
insert into t values ('G8 ...in the due list', pg_temp.s(format($$select (%L = any(array(select deletions_due(100))))::text$$, pg_temp.u(8))) = 'true', '');

-- ================= H: held accounts (D2, D3) =================
insert into t values
  ('H1 legal hold: closes as held', pg_temp.r(pg_temp.u(5), $$select (close_my_account()->>'status') || '/' || (close_my_account()->>'held_reason')$$) = 'held/legal_hold', ''),
  ('H1 ...and is locked out at once', pg_temp.r(pg_temp.u(5), format($$select hold_slot(%L, %L, %L, %L, gen_random_uuid())::text$$,
     pg_temp.club(), pg_temp.court(), pg_temp.at(7, 8), pg_temp.at(7, 8) + interval '60 min')) like 'ERR%account_closed%', ''),
  ('H1 the full data step is refused for a held record', pg_temp.s(format($$select delete_account_data(%L)::text$$, pg_temp.u(5))) like 'ERR held: legal_hold%', ''),
  ('H1 cancel-only is refused for a normal record', pg_temp.s(format($$select delete_account_data(%L, true)::text$$, pg_temp.u(8))) like 'ERR not_held%', ''),
  ('H2 cancel-only for the held record', pg_temp.s(format($$select delete_account_data(%L, true)::text$$, pg_temp.u(5))) not like 'ERR%', '');
insert into t values
  ('H2 cancelled: their upcoming booking (refund due), their game (player 2 told); they left game g2 (organiser told)',
     (select b.status = 'cancelled' and p.status = 'refund_due' from bookings b join payments p on p.booking_id = b.id where b.id = (select id from f where k = 'b5'))
     and (select status = 'cancelled' from matches where id = pg_temp.u(105))
     and (select count(*) = 1 from notifications where profile_id = pg_temp.u(2) and match_id = pg_temp.u(105) and kind = 'match_cancelled')
     and (select count(*) = 0 from match_players where match_id = pg_temp.u(102) and profile_id = pg_temp.u(5)), ''),
  ('H2 kept (required until the hold is lifted): name, phone, booking owner, chat message, the report',
     (select name = 'Closer 5' and phone is not null from profiles where id = pg_temp.u(5))
     and (select player_id = pg_temp.u(5) from bookings where id = (select id from f where k = 'b5'))
     and (select count(*) = 1 from match_messages where id = pg_temp.u(205))
     and (select legal_hold from reports where id = pg_temp.u(401)), ''),
  ('H2 still held, cancellations recorded', (select status = 'held' and cancellations_at is not null from pg_temp.rec(5)), ''),
  ('H2 cancel-only again: nothing twice', pg_temp.s(format($$select delete_account_data(%L, true)::text$$, pg_temp.u(5))) not like 'ERR%', '');
insert into t values ('H2 ...one notice only', (select count(*) = 1 from notifications where profile_id = pg_temp.u(2) and match_id = pg_temp.u(105) and kind = 'match_cancelled'), '');
insert into tok select 'p5', pg_temp.claim(5);
insert into t values ('H3 held: the run bans the sign-in (status stays held)', pg_temp.s(format($$select record_deletion_step(%L, %L, 'banned')->>'status'$$, pg_temp.u(5), (select v from tok where k = 'p5'))) = 'held', '');
insert into t values ('H3 ...and ends', pg_temp.s(format($$select record_deletion_step(%L, %L, 'released')->>'status'$$, pg_temp.u(5), (select v from tok where k = 'p5'))) = 'held', '');
insert into t values
  ('H3 a held record with its work done is not claimed and not due', pg_temp.s(format($$select claim_deletion(%L)->>'reason'$$, pg_temp.u(5))) = 'held'
     and pg_temp.s(format($$select (%L = any(array(select deletions_due(100))))::text$$, pg_temp.u(5))) = 'false', ''),
  ('H4 coach with coach bookings: held', pg_temp.r(pg_temp.u(6), $$select close_my_account()->>'held_reason'$$) = 'coach_has_bookings', ''),
  ('H5 suspended (D3, legal review): held', pg_temp.r(pg_temp.u(7), $$select close_my_account()->>'held_reason'$$) = 'suspended', ''),
  ('H6 release while the hold is still on: refused', pg_temp.r(pg_temp.u(3), format($$select release_held_deletion(%L)::text$$, pg_temp.u(5))) like 'ERR legal_hold%', ''),
  ('H6 release while still suspended: refused', pg_temp.r(pg_temp.u(3), format($$select release_held_deletion(%L)::text$$, pg_temp.u(7))) like 'ERR suspended%', ''),
  ('H6 a player cannot release', pg_temp.r(pg_temp.u(2), format($$select release_held_deletion(%L)::text$$, pg_temp.u(7))) like 'ERR forbidden%', ''),
  ('H6 releasing a record that is not held: refused', pg_temp.r(pg_temp.u(3), format($$select release_held_deletion(%L)::text$$, pg_temp.u(8))) like 'ERR not_held%', '');
update reports set legal_hold = false where id = pg_temp.u(401);       -- the hold is lifted
delete from account_suspensions where profile_id = pg_temp.u(7);       -- the suspension ends
insert into t values
  ('H7 after the hold is lifted: released, continues as closed (already banned)', pg_temp.r(pg_temp.u(3), format($$select release_held_deletion(%L)->>'status'$$, pg_temp.u(5))) = 'closed', ''),
  ('H7 after the suspension ends: released, continues as closing (not banned yet)', pg_temp.r(pg_temp.u(3), format($$select release_held_deletion(%L)->>'status'$$, pg_temp.u(7))) = 'closing', '');
insert into t values
  ('H7 released records are due again', pg_temp.s(format($$select (%L = any(array(select deletions_due(100))) and %L = any(array(select deletions_due(100))))::text$$, pg_temp.u(5), pg_temp.u(7))) = 'true', ''),
  ('H7 then the full data step runs', pg_temp.s(format($$select delete_account_data(%L)::text$$, pg_temp.u(5))) not like 'ERR%', '');
insert into t values ('H7 ...data removed', (select status = 'data_removed' from pg_temp.rec(5)) and (select name is null from profiles where id = pg_temp.u(5)), '');

-- ================= I: support path, attention, admin view, the old flow =================
insert into t values ('I1 a request by email: the admin closes the account (support)', pg_temp.r(pg_temp.u(3), format($$select admin_record_deletion_request(%L)::text$$, pg_temp.u(9))) = 'ok', '');
insert into t values ('I1 ...closing, via support', (select status = 'closing' and requested_via = 'support' from pg_temp.rec(9)), '');
update account_deletions set closing_at = now() - interval '2 hours' where subject_id = pg_temp.u(9) and status = 'closing';
insert into t values
  ('I2 attention: the held coach (held) and the 2-hour-old closing (stuck)',
     pg_temp.s(format($$select string_agg(reason, ',' order by reason) from deletions_needing_attention() where subject_id in (%L, %L)$$, pg_temp.u(6), pg_temp.u(9))) = 'held,stuck', ''),
  ('I2 alerted once', pg_temp.s(format($$select mark_deletion_alerted(%L)::text$$, pg_temp.u(9))) = 'ok', '');
insert into t values
  ('I2 ...then no longer listed', pg_temp.s(format($$select count(*)::text from deletions_needing_attention() where subject_id = %L$$, pg_temp.u(9))) = '0', ''),
  ('I3 the admin sees progress (codes and dates only)', pg_temp.r(pg_temp.u(3), format($$select status || '/' || coalesce(held_reason, '-') from admin_deletion_progress() where subject_id = %L$$, pg_temp.u(6))) = 'held/coach_has_bookings', ''),
  ('I3 a player cannot', pg_temp.r(pg_temp.u(2), $$select count(*)::text from admin_deletion_progress()$$) like 'ERR forbidden%', ''),
  ('I3 the admin list (0079 shape) shows the new states', pg_temp.r(pg_temp.u(3), $$select count(*)::text from admin_account_deletions()$$) = (select count(*)::text from account_deletions where status in ('closing', 'closed', 'held', 'data_removed')), '');
-- an open request of the old flow becomes a closure when 0086 is applied
insert into account_deletions (subject_id, requested_via, status) values (pg_temp.u(11), 'app', 'requested');
\i :mig
insert into t values ('I4 an old open request becomes a closure on applying 0086', (select status = 'closing' and closing_at is not null from pg_temp.rec(11)), '');

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
