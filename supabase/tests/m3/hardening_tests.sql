-- M3-H tests (docs/m3/06-test-plan.md §AP: T-S*, T-RP*, T-GR8*, T-CL*). Run by hardening.sh inside
-- one transaction that is rolled back. psql variable :mig is the migration file under test.
\set ON_ERROR_STOP 1
begin;
\i :mig
\i :mig
create temp table t (id text, pass boolean, detail text);
insert into t values ('T-H0 the migration applies twice without error', true, '');

-- run q as user `who` (null = signed out); returns its single value, 'ok', or 'ERR <message>'
create function pg_temp.r(who uuid, q text) returns text language plpgsql as $f$
declare res text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  execute 'set local role authenticated';
  begin
    if q ~* '^\s*select' then execute q into res; else execute q; end if;
    res := coalesce(nullif(res, ''), 'ok');                      -- a void function returns ''
  exception when others then res := 'ERR ' || sqlerrm;
  end;
  execute 'reset role';
  return res;
end $f$;
create temp table kept (k text primary key, v text);
create function pg_temp.keep(key text, val text) returns text language sql as $$ insert into kept values (key, val) returning v $$;
create function pg_temp.got(key text) returns text language sql as $$ select v from kept where k = key $$;
create function pg_temp.u(n int) returns uuid language sql as $$ select ('e1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.g(n int) returns uuid language sql as $$ select ('f1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.b(n int) returns uuid language sql as $$ select ('b1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
-- days 41+ keep clear of the bookings run.sh leaves on the replica; blocks are removed (rolled back)
create function pg_temp.day(n int) returns timestamptz language sql as $$ select (current_date + 40 + n + time '18:00') at time zone 'Asia/Beirut' $$;
delete from blocks;
create function pg_temp.club() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
-- a game, inserted directly (state set up exactly; the functions under test are called afterwards)
create function pg_temp.game(n int, org uuid, st match_status, reason text, s timestamptz, e timestamptz,
  needed int, mode text default 'open', bk uuid default null) returns void language sql as $$
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, players_needed, status, closed_reason, join_mode, booking_id, note)
  values (pg_temp.g(n), pg_temp.club(), 'padel', org, s, e, needed, st, reason, mode, bk, 'game ' || n) $$;
create function pg_temp.player(n int, who uuid, st text, at timestamptz default now()) returns void language sql as $$
  insert into match_players (match_id, profile_id, status, joined_at) values (pg_temp.g(n), who, st, at) $$;
create function pg_temp.booking(n int, who uuid, court text, d int, start_time time default '18:00') returns void language sql as $$
  insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by)
  select pg_temp.b(n), c.club_id, c.id, who, (current_date + 40 + d + start_time) at time zone 'Asia/Beirut',
         (current_date + 40 + d + start_time) at time zone 'Asia/Beirut' + interval '90 min', 'confirmed', 'app', who
  from courts c where c.club_id = pg_temp.club() and c.name = court $$;
create function pg_temp.notes(who uuid, n int, k text) returns int language sql as $$
  select count(*)::int from notifications where profile_id = who and match_id = pg_temp.g(n) and kind = k $$;
create function pg_temp.st(n int) returns text language sql as $$
  select status || '/' || coalesce(closed_reason, '-') || '/' || case when court_lost_at is null then 'court' else 'lost' end
  from matches where id = pg_temp.g(n) $$;

-- people: 1 O organiser · 2 A · 3 B · 4 P · 5 Q · 6 D · 7 X stranger · 8 ADM · 9 C · 10 E · 11 O2
insert into auth.users (id, email) select pg_temp.u(i), 'h' || i || '@m3h.test' from generate_series(1, 11) i;
update profiles set roles = '{player,admin}' where id = pg_temp.u(8);
\set O  'pg_temp.u(1)'
\set A  'pg_temp.u(2)'
\set B  'pg_temp.u(3)'
\set P  'pg_temp.u(4)'
\set Q  'pg_temp.u(5)'
\set D  'pg_temp.u(6)'
\set X  'pg_temp.u(7)'
\set ADM 'pg_temp.u(8)'
\set C  'pg_temp.u(9)'
\set E  'pg_temp.u(10)'
\set O2 'pg_temp.u(11)'

-- ================= chat (S2, S9, S12, S14, GR-11) =================
select pg_temp.game(1, :O, 'open', null, pg_temp.day(3), pg_temp.day(3) + interval '90 min', 4);
select pg_temp.player(1, :A, 'accepted'); select pg_temp.player(1, :B, 'accepted');
select null from pg_temp.keep('s2a', pg_temp.r(:A, format($q$insert into match_messages (id, match_id, profile_id, body, created_at) values ('c0000000-0000-4000-8000-000000000001', %L, %L, 'hi', '2030-01-01')$q$, pg_temp.g(1), :A)));
insert into t select 'T-S2a sender''s created_at is replaced by the server''s', pg_temp.got('s2a') = 'ok'
  and (select abs(extract(epoch from created_at - now())) < 5 from match_messages where id = 'c0000000-0000-4000-8000-000000000001'), '';
select null from pg_temp.keep('s2b', pg_temp.r(:A, format($q$insert into match_messages (id, match_id, profile_id, body, deleted_at) values ('c0000000-0000-4000-8000-000000000002', %L, %L, 'x', now())$q$, pg_temp.g(1), :A)));
insert into t select 'T-S2b a message cannot arrive deleted', pg_temp.got('s2b') = 'ok'
  and (select deleted_at is null from match_messages where id = 'c0000000-0000-4000-8000-000000000002'), '';
insert into t select 'T-S9a 2000 characters refused even when sent as deleted', x like 'ERR %match_messages_body_check%', x
  from (select pg_temp.r(:A, format($q$insert into match_messages (match_id, profile_id, body, deleted_at) values (%L, %L, repeat('a', 2000), now())$q$, pg_temp.g(1), :A)) x) s;
-- A has 2 messages; 28 more reach the limit of 30 in 10 minutes
insert into t select 'T-S12b 30 messages in 10 minutes accepted', count(*) filter (where x = 'ok') = 28, string_agg(distinct x, ',')
  from generate_series(1, 28) i, lateral (select pg_temp.r(:A, format($q$insert into match_messages (match_id, profile_id, body) values (%L, %L, %L)$q$, pg_temp.g(1), :A, 'm' || i)) x) s;
insert into t select 'T-S12b the 31st is refused: slow_down', x = 'ERR slow_down', x
  from (select pg_temp.r(:A, format($q$insert into match_messages (match_id, profile_id, body) values (%L, %L, 'one more')$q$, pg_temp.g(1), :A)) x) s;
insert into t select 'T-S12b the limit is per sender', x = 'ok', x
  from (select pg_temp.r(:B, format($q$insert into match_messages (match_id, profile_id, body) values (%L, %L, 'me too')$q$, pg_temp.g(1), :B)) x) s;
select null from pg_temp.keep('s9b', pg_temp.r(:O, format('select set_match_status(%L, ''cancelled'')', pg_temp.g(1))));
insert into t select 'T-S9b a cancelled game takes no messages: match_cancelled', pg_temp.got('s9b') = 'ok' and x = 'ERR match_cancelled', x
  from (select pg_temp.r(:B, format($q$insert into match_messages (match_id, profile_id, body) values (%L, %L, 'late')$q$, pg_temp.g(1), :B)) x) s;

select pg_temp.game(2, :O, 'open', null, pg_temp.day(3), pg_temp.day(3) + interval '90 min', 4);
select pg_temp.player(2, :A, 'accepted'); select pg_temp.player(2, :B, 'accepted');
insert into match_hidden (profile_id, match_id) values (pg_temp.u(2), pg_temp.g(2));   -- hide_match needs a played game
select null from pg_temp.keep('s14', pg_temp.r(:B, format($q$insert into match_messages (match_id, profile_id, body) values (%L, %L, 'hello')$q$, pg_temp.g(2), :B)));
insert into t select 'T-S14 a member who hid the game gets no chat notice; the others do', pg_temp.got('s14') = 'ok'
  and pg_temp.notes(:A, 2, 'match_message') = 0 and pg_temp.notes(:O, 2, 'match_message') = 1,
  pg_temp.notes(:A, 2, 'match_message') || '/' || pg_temp.notes(:O, 2, 'match_message');

-- ================= decline is final (S4, GR-5) =================
select pg_temp.game(3, :O, 'open', null, pg_temp.day(3), pg_temp.day(3) + interval '90 min', 4, 'approval');
select null from pg_temp.keep('s4a', pg_temp.r(:D, format('select join_match(%L)', pg_temp.g(3))));
select null from pg_temp.keep('s4b', pg_temp.r(:O, format('select decide_join(%L, %L, false)', pg_temp.g(3), :D)));
select null from pg_temp.keep('s4c', pg_temp.r(:D, format('select leave_match(%L)', pg_temp.g(3))));
select null from pg_temp.keep('s4d', pg_temp.r(:D, format('select join_match(%L)', pg_temp.g(3))));
insert into t select 'T-S4 declined player leaves, asks again: join_declined, one request notice, row kept',
  pg_temp.got('s4a') = 'pending' and pg_temp.got('s4b') = 'ok' and pg_temp.got('s4c') = 'ok' and pg_temp.got('s4d') = 'ERR join_declined'
  and pg_temp.notes(:O, 3, 'join_request') = 1
  and (select status from match_players where match_id = pg_temp.g(3) and profile_id = :D) = 'declined',
  pg_temp.got('s4a') || ' ' || pg_temp.got('s4b') || ' ' || pg_temp.got('s4c') || ' ' || pg_temp.got('s4d');

-- ================= court booking moved / cancelled (S8, S18, S19, GR-9) =================
select pg_temp.booking(4, :O, 'Padel 1', 4);
select pg_temp.game(4, :O, 'open', null, pg_temp.day(4), pg_temp.day(4) + interval '90 min', 4, 'approval', pg_temp.b(4));
select pg_temp.player(4, :A, 'accepted'); select pg_temp.player(4, :P, 'pending');
update bookings set start_at = start_at + interval '90 min', end_at = end_at + interval '90 min' where id = pg_temp.b(4);
insert into t select 'T-S8 booking moved: game follows; organiser, accepted and pending told once each',
  (select start_at = pg_temp.day(4) + interval '90 min' from matches where id = pg_temp.g(4))
  and pg_temp.notes(:O, 4, 'booking_moved') = 1 and pg_temp.notes(:A, 4, 'booking_moved') = 1 and pg_temp.notes(:P, 4, 'booking_moved') = 1,
  pg_temp.notes(:O, 4, 'booking_moved') || '/' || pg_temp.notes(:A, 4, 'booking_moved') || '/' || pg_temp.notes(:P, 4, 'booking_moved');

select pg_temp.booking(5, :O, 'Padel 1', 5);
select pg_temp.game(5, :O, 'open', null, pg_temp.day(5), pg_temp.day(5) + interval '90 min', 4, 'approval', pg_temp.b(5));
select pg_temp.player(5, :A, 'accepted'); select pg_temp.player(5, :P, 'pending'); select pg_temp.player(5, :Q, 'pending');
update bookings set status = 'cancelled' where id = pg_temp.b(5);
insert into t select 'T-CL1 cancelled booking: closed/no_court, court lost, link removed', pg_temp.st(5) = 'closed/no_court/lost'
  and (select booking_id is null from matches where id = pg_temp.g(5)), pg_temp.st(5);
insert into t select 'T-CL1 organiser, accepted and pending told once each',
  pg_temp.notes(:O, 5, 'booking_unlinked') = 1 and pg_temp.notes(:A, 5, 'booking_unlinked') = 1 and pg_temp.notes(:P, 5, 'booking_unlinked') = 1,
  pg_temp.notes(:O, 5, 'booking_unlinked') || '/' || pg_temp.notes(:A, 5, 'booking_unlinked') || '/' || pg_temp.notes(:P, 5, 'booking_unlinked');
insert into t select 'T-CL1 players and the game record are kept', (select count(*) from match_players where match_id = pg_temp.g(5)) = 3, '';
insert into t select 'T-CL2 a stranger cannot join: match_closed', x = 'ERR match_closed', x
  from (select pg_temp.r(:X, format('select join_match(%L)', pg_temp.g(5))) x) s;
insert into t select 'T-CL3 accepting is paused: match_closed', x = 'ERR match_closed', x
  from (select pg_temp.r(:O, format('select decide_join(%L, %L, true)', pg_temp.g(5), :P)) x) s;
insert into t select 'T-CL3 declining still works', x = 'ok', x
  from (select pg_temp.r(:O, format('select decide_join(%L, %L, false)', pg_temp.g(5), :Q)) x) s;
insert into t select 'T-CL4 reopen and make private refused while the court is lost', a = 'ERR court_lost' and b = 'ERR court_lost', a || ' ' || b
  from (select pg_temp.r(:O, format('select set_match_status(%L, ''open'')', pg_temp.g(5))) a,
               pg_temp.r(:O, format('select set_match_status(%L, ''closed'')', pg_temp.g(5))) b) s;
insert into t select 'T-CL9 a player cannot resolve: forbidden', x = 'ERR forbidden', x
  from (select pg_temp.r(:A, format('select resolve_court(%L)', pg_temp.g(5))) x) s;
insert into t select 'T-CL9 resolving a game whose court is not lost: court_not_lost', x = 'ERR court_not_lost', x
  from (select pg_temp.r(:O, format('select resolve_court(%L)', pg_temp.g(2))) x) s;
select null from pg_temp.keep('cl5', pg_temp.r(:O, format('select resolve_court(%L)', pg_temp.g(5))));
insert into t select 'T-CL5 go ahead without a court: open, court not lost, accepted and pending told',
  pg_temp.got('cl5') = 'ok' and pg_temp.st(5) = 'open/-/court'
  and pg_temp.notes(:A, 5, 'court_resolved') = 1 and pg_temp.notes(:P, 5, 'court_resolved') = 1, pg_temp.st(5);

select pg_temp.booking(6, :O, 'Padel 1', 6);
select pg_temp.game(6, :O, 'closed', 'full', pg_temp.day(6), pg_temp.day(6) + interval '90 min', 2, 'open', pg_temp.b(6));
select pg_temp.player(6, :A, 'accepted'); select pg_temp.player(6, :B, 'accepted');
update bookings set status = 'cancelled' where id = pg_temp.b(6);
insert into t select 'T-CL6 a full game that loses its court is no_court', pg_temp.st(6) = 'closed/no_court/lost', pg_temp.st(6);
select null from pg_temp.keep('k9', pg_temp.r(:O, format('select resolve_court(%L)', pg_temp.g(6))));
insert into t select 'T-CL6 resolved while full: closed/full', pg_temp.got('k9') = 'ok'
  and pg_temp.st(6) = 'closed/full/court', pg_temp.st(6);

select pg_temp.booking(8, :O, 'Padel 1', 8);
select pg_temp.game(8, :O, 'closed', 'organizer', pg_temp.day(8), pg_temp.day(8) + interval '90 min', 4, 'open', pg_temp.b(8));
select pg_temp.player(8, :A, 'accepted');
update bookings set status = 'cancelled' where id = pg_temp.b(8);
insert into t select 'T-CL7 a private game stays private when the court is lost', pg_temp.st(8) = 'closed/organizer/lost', pg_temp.st(8);
select null from pg_temp.keep('k10', pg_temp.r(:O, format('select resolve_court(%L)', pg_temp.g(8))));
insert into t select 'T-CL7 and after resolving', pg_temp.got('k10') = 'ok'
  and pg_temp.st(8) = 'closed/organizer/court', pg_temp.st(8);

-- T-CL8: resolving with another booking
select pg_temp.booking(9, :O, 'Padel 1', 9);
select pg_temp.game(9, :O, 'open', null, pg_temp.day(9), pg_temp.day(9) + interval '90 min', 4, 'open', pg_temp.b(9));
update bookings set status = 'cancelled' where id = pg_temp.b(9);
select pg_temp.booking(90, :A, 'Padel 2', 9);                    -- someone else's
select pg_temp.booking(91, :O, 'Tennis 1', 9);                   -- other sport
select pg_temp.booking(92, :O, 'Padel 3', 9);                    -- already linked to a live game
select pg_temp.game(10, :O, 'open', null, pg_temp.day(9), pg_temp.day(9) + interval '90 min', 4, 'open', pg_temp.b(92));
select pg_temp.booking(93, :O, 'Padel 2', 12, '19:30');          -- valid
set local session_replication_role = replica;      -- a booking already under way: skip the grid check
insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by)
select pg_temp.b(94), c.club_id, c.id, pg_temp.u(1), now() - interval '1 hour', now() + interval '30 min', 'confirmed', 'app', pg_temp.u(1)
from courts c where c.club_id = pg_temp.club() and c.name = 'Padel 3';  -- already started
set local session_replication_role = origin;
insert into t select 'T-CL8 ' || label, x = expect, x
  from (values ('not mine → booking_not_found', 90, 'ERR booking_not_found'),
               ('other sport → sport_mismatch', 91, 'ERR sport_mismatch'),
               ('already linked → booking_already_posted', 92, 'ERR booking_already_posted'),
               ('already started → slot_in_past', 94, 'ERR slot_in_past')) v(label, n, expect),
       lateral (select pg_temp.r(:O, format('select resolve_court(%L, %L)', pg_temp.g(9), pg_temp.b(n))) x) s;
select null from pg_temp.keep('k2', pg_temp.r(:O, format('select resolve_court(%L, %L)', pg_temp.g(9), pg_temp.b(93))));
insert into t select 'T-CL8 valid booking: linked; time, end and club follow it; court restored', pg_temp.got('k2') = 'ok'
  and (select booking_id = pg_temp.b(93) and start_at = (current_date + 52 + time '19:30') at time zone 'Asia/Beirut'
          and end_at = start_at + interval '90 min' and club_id = pg_temp.club() from matches where id = pg_temp.g(9))
  and pg_temp.st(9) = 'open/-/court', pg_temp.st(9);

select pg_temp.booking(11, :O, 'Padel 1', 11);
select pg_temp.game(11, :O, 'open', null, pg_temp.day(11), pg_temp.day(11) + interval '90 min', 4, 'open', pg_temp.b(11));
select pg_temp.player(11, :A, 'accepted');
update bookings set status = 'no_show' where id = pg_temp.b(11);
insert into t select 'T-CL10 a no-show mark changes nothing and tells nobody (S18)',
  pg_temp.st(11) = 'open/-/court' and (select booking_id = pg_temp.b(11) from matches where id = pg_temp.g(11))
  and (select count(*) from notifications where match_id = pg_temp.g(11)) = 0, pg_temp.st(11);

select pg_temp.booking(7, :O, 'Padel 1', 7);
select pg_temp.game(7, :O, 'closed', 'full', pg_temp.day(7), pg_temp.day(7) + interval '90 min', 2, 'open', pg_temp.b(7));
select pg_temp.player(7, :A, 'accepted'); select pg_temp.player(7, :B, 'accepted');
update bookings set status = 'cancelled' where id = pg_temp.b(7);
select null from pg_temp.keep('cl11', pg_temp.r(:A, format('select leave_match(%L)', pg_temp.g(7))));
insert into t select 'T-CL11 a player leaving a no_court game does not reopen it',
  pg_temp.got('cl11') = 'ok' and pg_temp.st(7) = 'closed/no_court/lost', pg_temp.st(7);
select null from pg_temp.keep('cl12', pg_temp.r(:O, format('select set_match_status(%L, ''cancelled'')', pg_temp.g(7))));
insert into t select 'T-CL12 a no_court game can be cancelled; its players are told', pg_temp.got('cl12') = 'ok'
  and (select status from matches where id = pg_temp.g(7)) = 'cancelled' and pg_temp.notes(:B, 7, 'match_cancelled') = 1, pg_temp.st(7);

-- ================= posting (S10, S12) =================
insert into t select 'T-S10a no booking and no club: club_required', x = 'ERR club_required', x
  from (select pg_temp.r(:X, format('select post_match(null, ''padel'', %L, null, null, null, 4, null, null)', pg_temp.day(5))) x) s;
insert into t select 'T-S10b start in 61 days: too_far_ahead', x = 'ERR too_far_ahead', x
  from (select pg_temp.r(:X, format('select post_match(%L, ''padel'', %L, null, null, null, 4, null, null)', pg_temp.club(), now() + interval '61 days')) x) s;
insert into t select 'T-S10b start in 59 days: posted', x not like 'ERR%', x
  from (select pg_temp.r(:X, format('select post_match(%L, ''padel'', %L, null, null, null, 4, null, null)', pg_temp.club(), now() + interval '59 days')) x) s;
insert into t select 'T-S12a ten live games accepted', count(*) filter (where x not like 'ERR%') = 10, string_agg(distinct left(x, 30), ',')
  from generate_series(1, 10) i, lateral (select pg_temp.r(:O2, format('select post_match(%L, ''padel'', %L, null, null, null, 4, null, null)', pg_temp.club(), pg_temp.day(i))) x) s;
insert into t select 'T-S12a the 11th: too_many_games', x = 'ERR too_many_games', x
  from (select pg_temp.r(:O2, format('select post_match(%L, ''padel'', %L, null, null, null, 4, null, null)', pg_temp.club(), pg_temp.day(11))) x) s;
select null from pg_temp.keep('k4', pg_temp.r(:O2, format('select set_match_status(%L, ''cancelled'')', (select id from matches where organizer_id = :O2 limit 1))));
select null from pg_temp.keep('s12c', pg_temp.r(:O2, format('select post_match(%L, ''padel'', %L, null, null, null, 4, null, null)', pg_temp.club(), pg_temp.day(11))));
insert into t select 'T-S12a a cancelled game frees a place', pg_temp.got('k4') = 'ok' and pg_temp.got('s12c') not like 'ERR%', pg_temp.got('s12c');
-- 21 approval games by C; E asks to join each
select pg_temp.game(100 + i, :C, 'open', null, pg_temp.day(20) + i * interval '1 hour', null, 4, 'approval') from generate_series(1, 21) i;
insert into t select 'T-S12 twenty waiting requests accepted', count(*) filter (where x = 'pending') = 20, string_agg(distinct x, ',')
  from generate_series(1, 20) i, lateral (select pg_temp.r(:E, format('select join_match(%L)', pg_temp.g(100 + i))) x) s;
insert into t select 'T-S12 the 21st: too_many_requests', x = 'ERR too_many_requests', x
  from (select pg_temp.r(:E, format('select join_match(%L)', pg_temp.g(121))) x) s;

-- ================= waiting list (S11, GR-4) and approval → open (S15) =================
select pg_temp.game(12, :O, 'open', null, pg_temp.day(3), pg_temp.day(3) + interval '90 min', 2, 'approval');
select pg_temp.player(12, :A, 'accepted');
select pg_temp.player(12, :P, 'pending', now() - interval '3 min');
select pg_temp.player(12, :Q, 'pending', now() - interval '2 min');
select pg_temp.player(12, :C, 'pending', now() - interval '1 min');
select null from pg_temp.keep('s11a', pg_temp.r(:O, format('select decide_join(%L, %L, true)', pg_temp.g(12), :P)));
insert into t select 'T-S11 first fill: each waiting player told once, the accepted one not', a = 'ok' and pg_temp.st(12) = 'closed/full/court'
  and pg_temp.notes(:Q, 12, 'match_full_waiting') = 1 and pg_temp.notes(:C, 12, 'match_full_waiting') = 1
  and pg_temp.notes(:P, 12, 'match_full_waiting') = 0, a || ' ' || pg_temp.st(12)
  from (select pg_temp.got('s11a') a) s;
select null from pg_temp.keep('k5', pg_temp.r(:P, format('select leave_match(%L)', pg_temp.g(12))));
select null from pg_temp.keep('s11b', pg_temp.r(:O, format('select decide_join(%L, %L, true)', pg_temp.g(12), :Q)));
insert into t select 'T-S11 a leave reopens; the next fill tells the remaining waiting player again', pg_temp.got('k5') = 'ok'
  and pg_temp.got('s11b') = 'ok'
  and pg_temp.notes(:C, 12, 'match_full_waiting') = 2 and pg_temp.notes(:Q, 12, 'match_full_waiting') = 1,
  pg_temp.notes(:C, 12, 'match_full_waiting') || '/' || pg_temp.notes(:Q, 12, 'match_full_waiting');

select pg_temp.game(13, :O, 'open', null, pg_temp.day(3), pg_temp.day(3) + interval '90 min', 3, 'approval');
select pg_temp.player(13, :A, 'accepted');
select pg_temp.player(13, :Q, 'pending', now() - interval '1 min');   -- asked second
select pg_temp.player(13, :P, 'pending', now() - interval '5 min');   -- asked first
select null from pg_temp.keep('k6', pg_temp.r(:O, format('select update_match(%L, 2, null, null, null, ''open'')', pg_temp.g(13))));
insert into t select 'T-S15 approval → open with 2 waiting and 1 place: the earliest is accepted and told, the other waits', pg_temp.got('k6') = 'ok'
  and (select status from match_players where match_id = pg_temp.g(13) and profile_id = :P) = 'accepted'
  and (select status from match_players where match_id = pg_temp.g(13) and profile_id = :Q) = 'pending'
  and pg_temp.notes(:P, 13, 'join_accepted') = 1 and pg_temp.notes(:Q, 13, 'match_full_waiting') = 1
  and pg_temp.st(13) = 'closed/full/court', pg_temp.st(13);

-- ================= removing a player (GR-6) =================
select pg_temp.game(14, :O, 'closed', 'full', pg_temp.day(3), pg_temp.day(3) + interval '90 min', 2);
select pg_temp.player(14, :A, 'accepted'); select pg_temp.player(14, :B, 'accepted'); select pg_temp.player(14, :P, 'pending');
insert into match_messages (match_id, profile_id, body) values (pg_temp.g(14), pg_temp.u(1), 'see you');
select null from pg_temp.keep('k7', pg_temp.r(:O, format('select remove_player(%L, %L)', pg_temp.g(14), :A)));
insert into t select 'T-RP1 organiser removes an accepted player: declined, told, full game reopens', pg_temp.got('k7') = 'ok'
  and (select status from match_players where match_id = pg_temp.g(14) and profile_id = :A) = 'declined'
  and pg_temp.notes(:A, 14, 'player_removed') = 1 and pg_temp.st(14) = 'open/-/court', pg_temp.st(14);
insert into t select 'T-RP2 a player cannot remove: forbidden', x = 'ERR forbidden', x
  from (select pg_temp.r(:B, format('select remove_player(%L, %L)', pg_temp.g(14), :B)) x) s;
insert into t select 'T-RP2 a request is declined, not removed: not_accepted', x = 'ERR not_accepted', x
  from (select pg_temp.r(:O, format('select remove_player(%L, %L)', pg_temp.g(14), :P)) x) s;
insert into t select 'T-RP4 a removed player cannot come back: join_declined', x = 'ERR join_declined', x
  from (select pg_temp.r(:A, format('select join_match(%L)', pg_temp.g(14))) x) s;
insert into t select 'T-RP5 a removed player reads no chat and no players', a = '0' and b = '0', a || '/' || b
  from (select pg_temp.r(:A, format('select count(*) from match_messages where match_id = %L', pg_temp.g(14))) a,
               pg_temp.r(:A, format('select count(*) from match_participants(%L)', pg_temp.g(14))) b) s;
insert into t select 'T-RP2 an admin can remove', x = 'ok', x
  from (select pg_temp.r(:ADM, format('select remove_player(%L, %L)', pg_temp.g(14), :B)) x) s;

select pg_temp.game(15, :O, 'open', null, now() - interval '30 min', now() + interval '60 min', 4);
select pg_temp.player(15, :A, 'accepted');
insert into t select 'T-RP3 after the start: match_started', x = 'ERR match_started', x
  from (select pg_temp.r(:O, format('select remove_player(%L, %L)', pg_temp.g(15), :A)) x) s;

select pg_temp.game(16, :O, 'closed', 'no_court', pg_temp.day(3), pg_temp.day(3) + interval '90 min', 2);
update matches set court_lost_at = now() where id = pg_temp.g(16);
select pg_temp.player(16, :A, 'accepted'); select pg_temp.player(16, :B, 'accepted');
select pg_temp.game(17, :O, 'closed', 'organizer', pg_temp.day(3), pg_temp.day(3) + interval '90 min', 2);
select pg_temp.player(17, :A, 'accepted'); select pg_temp.player(17, :B, 'accepted');
select null from pg_temp.keep('k8', pg_temp.r(:O, format('select remove_player(%L, %L)', pg_temp.g(16), :A)));
select null from pg_temp.keep('rp6', pg_temp.r(:O, format('select remove_player(%L, %L)', pg_temp.g(17), :A)));
insert into t select 'T-RP6 removing from a no_court or private game leaves its state', pg_temp.got('k8') = 'ok'
  and pg_temp.got('rp6') = 'ok'
  and pg_temp.st(16) = 'closed/no_court/lost' and pg_temp.st(17) = 'closed/organizer/court', pg_temp.st(16) || ' ' || pg_temp.st(17);

-- ================= organiser time limits (GR-8) =================
insert into t select 'T-GR8a make private or reopen after the start: match_started', a = 'ERR match_started', a
  from (select pg_temp.r(:O, format('select set_match_status(%L, ''closed'')', pg_temp.g(15))) a) s;
select pg_temp.game(18, :O, 'open', null, now() - interval '4 hours', now() - interval '150 min', 4);
insert into t select 'T-GR8b cancel after the game was played: match_over', x = 'ERR match_over', x
  from (select pg_temp.r(:O, format('select set_match_status(%L, ''cancelled'')', pg_temp.g(18))) x) s;
select pg_temp.game(19, :O, 'open', null, now() - interval '4 hours', null, 4);
insert into t select 'T-GR8b no end time: played after start + 3 h', x = 'ERR match_over', x
  from (select pg_temp.r(:O, format('select set_match_status(%L, ''cancelled'')', pg_temp.g(19))) x) s;
select null from pg_temp.keep('gr8c', pg_temp.r(:O, format('select set_match_status(%L, ''cancelled'')', pg_temp.g(15))));
insert into t select 'T-GR8c cancel while playing: allowed, players told',
  pg_temp.got('gr8c') = 'ok' and pg_temp.notes(:A, 15, 'match_cancelled') = 1, pg_temp.got('gr8c');
insert into t select 'T-GR8d edit after the start: match_closed', x = 'ERR match_closed', x
  from (select pg_temp.r(:O, format('select update_match(%L, 4, null, null, null, ''open'')', pg_temp.g(18))) x) s;
select null from pg_temp.keep('gr8e', pg_temp.r(:O, format('select leave_match(%L)', pg_temp.g(2))));
insert into t select 'T-GR8e the organiser leaving their own game changes nothing',
  pg_temp.got('gr8e') = 'ok' and pg_temp.st(2) = 'open/-/court', pg_temp.st(2);

-- ================= who may call what =================
insert into t values
  ('T-H1 notify_waiting is not callable through the API', not has_function_privilege('authenticated', 'notify_waiting(uuid)', 'execute')
     and not has_function_privilege('anon', 'notify_waiting(uuid)', 'execute'), ''),
  ('T-H1 remove_player and resolve_court: signed-in only', has_function_privilege('authenticated', 'remove_player(uuid,uuid)', 'execute')
     and not has_function_privilege('anon', 'remove_player(uuid,uuid)', 'execute')
     and has_function_privilege('authenticated', 'resolve_court(uuid,uuid)', 'execute')
     and not has_function_privilege('anon', 'resolve_court(uuid,uuid)', 'execute'), '');

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
