-- M3-S tests (chat and player safety; docs/m3/05-architecture.md §5.6). Run by safety.sh inside one
-- transaction that is rolled back. psql variable :mig is the M3-S draft under test (0072 must be on the replica).
\set ON_ERROR_STOP 1
begin;
\i :mig
\i :mig
create temp table t (id text, pass boolean, detail text);
insert into t values ('T-S0 the draft applies twice without error', true, '');

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
insert into auth.users (id, email) select pg_temp.u(i), 's' || i || '@m3s.test' from generate_series(1, 11) i;
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


update profiles set name = 'Player ' || right(id::text, 2) where id in (select pg_temp.u(i) from generate_series(1, 11) i);
-- game 1: O organises; A and B accepted; X a stranger
select pg_temp.game(1, :O, 'open', null, pg_temp.day(3), pg_temp.day(3) + interval '90 min', 4);
select pg_temp.player(1, :A, 'accepted'); select pg_temp.player(1, :B, 'accepted');

-- ===== community rules =====
select null from pg_temp.keep('r1', pg_temp.r(:A, format($q$insert into match_messages (match_id, profile_id, body) values (%L, %L, 'hi')$q$, pg_temp.g(1), :A)));
select null from pg_temp.keep('r2', pg_temp.r(:A, 'select my_rules_accepted()::text'));
select null from pg_temp.keep('r3', pg_temp.r(:A, 'select accept_community_rules() is not null'));
select null from pg_temp.keep('r3b', (select rules_accepted_at::text from profiles where id = :A));
select null from pg_temp.keep('r4', pg_temp.r(:A, 'select accept_community_rules()::text'));
select null from pg_temp.keep('r5', pg_temp.r(:A, format($q$insert into match_messages (id, match_id, profile_id, body) values ('c5000000-0000-4000-8000-000000000001', %L, %L, 'hello')$q$, pg_temp.g(1), :A)));
select null from pg_temp.keep('r6', pg_temp.r(null, 'select accept_community_rules()::text'));
insert into t values
  ('T-S1 first message without the rules: refused rules_not_accepted', pg_temp.got('r1') like 'ERR rules_not_accepted%', pg_temp.got('r1')),
  ('T-S2 my_rules_accepted false, then accept stores a time', pg_temp.got('r2') = 'false' and pg_temp.got('r3') = 'true', pg_temp.got('r2') || '/' || pg_temp.got('r3')),
  ('T-S3 accepting again keeps the first time', pg_temp.got('r4') = pg_temp.got('r3b'), pg_temp.got('r4') || ' vs ' || pg_temp.got('r3b')),
  ('T-S4 after accepting, messages go through', pg_temp.got('r5') = 'ok', pg_temp.got('r5')),
  ('T-S5 signed out cannot accept', pg_temp.got('r6') like 'ERR not_authenticated%', pg_temp.got('r6'));
update profiles set rules_accepted_at = now() where id in (:O, :B, :X);

-- ===== word filter =====
insert into blocked_terms (term) values ('badword'), ('two words');
select null from pg_temp.keep('w1', pg_temp.r(:A, format($q$insert into match_messages (match_id, profile_id, body) values (%L, %L, 'you are a BadWord!')$q$, pg_temp.g(1), :A)));
select null from pg_temp.keep('w2', pg_temp.r(:A, format($q$insert into match_messages (match_id, profile_id, body) values (%L, %L, 'badwordish is fine')$q$, pg_temp.g(1), :A)));
select null from pg_temp.keep('w3', pg_temp.r(:A, format($q$insert into match_messages (match_id, profile_id, body) values (%L, %L, 'say Two  words? no: two words.')$q$, pg_temp.g(1), :A)));
select null from pg_temp.keep('w4', pg_temp.r(:A, 'select count(*)::text from blocked_terms'));
insert into t values
  ('T-S6 a blocked term (any case, as a word) is refused message_not_allowed', pg_temp.got('w1') like 'ERR message_not_allowed%', pg_temp.got('w1')),
  ('T-S7 a longer word containing it is allowed', pg_temp.got('w2') = 'ok', pg_temp.got('w2')),
  ('T-S8 a blocked phrase is refused', pg_temp.got('w3') like 'ERR message_not_allowed%', pg_temp.got('w3')),
  ('T-S9 the term list is not readable through the API', pg_temp.got('w4') like 'ERR permission denied%' or pg_temp.got('w4') = '0', pg_temp.got('w4'));

-- ===== blocks =====
select null from pg_temp.keep('b1', pg_temp.r(:A, format('select block_player(%L)', :A)));
select null from pg_temp.keep('b2', pg_temp.r(:A, format('select block_player(%L)', 'e1000000-0000-4000-8000-000000009999')));
select null from pg_temp.keep('b3', pg_temp.r(:A, format('select block_player(%L)', :B)));
select null from pg_temp.keep('b4', pg_temp.r(:A, format('select block_player(%L)', :B)));   -- again: no-op
select null from pg_temp.keep('b5', pg_temp.r(:A, 'select count(*)::text from my_blocked_players()'));
select null from pg_temp.keep('b6', pg_temp.r(:B, 'select count(*)::text from my_blocked_players()'));
select null from pg_temp.keep('b7', pg_temp.r(:B, 'select count(*)::text from player_blocks'));
insert into t values
  ('T-S10 cannot block yourself or nobody', pg_temp.got('b1') like 'ERR bad_target%' and pg_temp.got('b2') like 'ERR not_found%', pg_temp.got('b1') || '/' || pg_temp.got('b2')),
  ('T-S11 blocking twice is one block', pg_temp.got('b3') = 'ok' and pg_temp.got('b4') = 'ok' and pg_temp.got('b5') = '1', pg_temp.got('b5')),
  ('T-S12 the blocked player cannot see who blocked them', pg_temp.got('b6') = '0' and pg_temp.got('b7') = '0', pg_temp.got('b6') || '/' || pg_temp.got('b7'));

-- chat: A blocked B. B's message reaches A flagged and withheld; A gets no notice from B; others unaffected
update notifications set read_at = now() where match_id = pg_temp.g(1);
select null from pg_temp.keep('c1', pg_temp.r(:B, format($q$insert into match_messages (id, match_id, profile_id, body) values ('c5000000-0000-4000-8000-000000000002', %L, %L, 'from B')$q$, pg_temp.g(1), :B)));
select null from pg_temp.keep('c2', pg_temp.r(:A, format($q$select blocked || '/' || body || '/' || deleted from match_messages_list(%L, null) where id = 'c5000000-0000-4000-8000-000000000002'$q$, pg_temp.g(1))));
select null from pg_temp.keep('c3', pg_temp.r(:O, format($q$select blocked || '/' || body from match_messages_list(%L, null) where id = 'c5000000-0000-4000-8000-000000000002'$q$, pg_temp.g(1))));
select null from pg_temp.keep('c4', (select count(*)::text from notifications where profile_id = :A and match_id = pg_temp.g(1) and kind = 'match_message' and read_at is null));
select null from pg_temp.keep('c5', (select count(*)::text from notifications where profile_id = :O and match_id = pg_temp.g(1) and kind = 'match_message' and read_at is null));
insert into t values
  ('T-S13 the blocker sees the message flagged, its text withheld', pg_temp.got('c1') = 'ok' and pg_temp.got('c2') = 'true//false', pg_temp.got('c2')),
  ('T-S14 others see it as usual', pg_temp.got('c3') = 'false/from B', pg_temp.got('c3')),
  ('T-S15 no chat notice to the blocker; others notified', pg_temp.got('c4') = '0' and pg_temp.got('c5') = '1', pg_temp.got('c4') || '/' || pg_temp.got('c5'));

-- join: game 2 organised by B (blocked by A); game 3 organised by A (who blocked B); game 4 by O
select pg_temp.game(2, :B, 'open', null, pg_temp.day(4), pg_temp.day(4) + interval '90 min', 4);
select pg_temp.game(3, :A, 'open', null, pg_temp.day(5), pg_temp.day(5) + interval '90 min', 4, 'approval');
select pg_temp.game(4, :O, 'open', null, pg_temp.day(6), pg_temp.day(6) + interval '90 min', 4);
select null from pg_temp.keep('j1', pg_temp.r(:A, format('select join_match(%L)::text', pg_temp.g(2))));
select null from pg_temp.keep('j2', pg_temp.r(:B, format('select join_match(%L)::text', pg_temp.g(3))));
select null from pg_temp.keep('j3', pg_temp.r(:B, format('select join_match(%L)::text', pg_temp.g(4))));
insert into t values
  ('T-S16 blocker cannot join the blocked player''s game', pg_temp.got('j1') like 'ERR blocked%', pg_temp.got('j1')),
  ('T-S17 the blocked player cannot ask to join the blocker''s game', pg_temp.got('j2') like 'ERR blocked%', pg_temp.got('j2')),
  ('T-S18 a third player''s game is unaffected', pg_temp.got('j3') in ('accepted', 'pending'), pg_temp.got('j3'));

-- board: neither sees the other's open games; a shared game stays
select null from pg_temp.keep('o1', pg_temp.r(:A, format('select count(*)::text from open_matches(null, null, now(), now() + interval ''60 days'') where match_id = %L', pg_temp.g(2))));
select null from pg_temp.keep('o2', pg_temp.r(:B, format('select count(*)::text from open_matches(null, null, now(), now() + interval ''60 days'') where match_id = %L', pg_temp.g(3))));
select null from pg_temp.keep('o3', pg_temp.r(:A, format('select count(*)::text from open_matches(null, null, now(), now() + interval ''60 days'') where match_id = %L', pg_temp.g(4))));
select null from pg_temp.keep('o4', pg_temp.r(:A, format('select count(*)::text from match_board(null, 60) where match_id in (%L, %L)', pg_temp.g(2), pg_temp.g(1))));
select null from pg_temp.keep('o5', pg_temp.r(:B, format('select count(*)::text from match_board(null, 60) where match_id = %L', pg_temp.g(3))));
select null from pg_temp.keep('u1', pg_temp.r(:A, format('select unblock_player(%L)', :B)));
select null from pg_temp.keep('o6', pg_temp.r(:A, format('select count(*)::text from open_matches(null, null, now(), now() + interval ''60 days'') where match_id = %L', pg_temp.g(2))));
insert into t values
  ('T-S19 open_matches hides the other side''s games both ways', pg_temp.got('o1') = '0' and pg_temp.got('o2') = '0', pg_temp.got('o1') || '/' || pg_temp.got('o2')),
  ('T-S20 other games stay on the board', pg_temp.got('o3') = '1', pg_temp.got('o3')),
  ('T-S21 match_board: blocked side''s open game hidden, the shared game kept', pg_temp.got('o4') = '1' and pg_temp.got('o5') = '0', pg_temp.got('o4') || '/' || pg_temp.got('o5')),
  ('T-S22 unblocking brings the game back', pg_temp.got('u1') = 'ok' and pg_temp.got('o6') = '1', pg_temp.got('o6'));

-- ===== reports =====
select null from pg_temp.keep('p1', pg_temp.r(:O, $q$select report_content('message', 'c5000000-0000-4000-8000-000000000002', 'abuse', 'rude')$q$));
select null from pg_temp.keep('p2', pg_temp.r(:O, $q$select report_content('message', 'c5000000-0000-4000-8000-000000000002', 'abuse', 'again')$q$));
select null from pg_temp.keep('p3', (select count(*) || '/' || max(snapshot) || '/' || max(profile_id::text) from reports where reporter_id = :O and target_kind = 'message'));
select null from pg_temp.keep('p4', pg_temp.r(:X, $q$select report_content('message', 'c5000000-0000-4000-8000-000000000002', 'spam')$q$));
select null from pg_temp.keep('p5', pg_temp.r(:B, $q$select report_content('message', 'c5000000-0000-4000-8000-000000000002', 'spam')$q$));
select null from pg_temp.keep('p6', pg_temp.r(:O, $q$select report_content('message', 'c5000000-0000-4000-8000-000000000002', 'whatever')$q$));
select null from pg_temp.keep('p7', pg_temp.r(:O, format($q$select report_content('player', %L, 'danger', repeat('x', 501))$q$, :B)));
select null from pg_temp.keep('p8', pg_temp.r(:O, format($q$select report_content('player', %L, 'danger')$q$, :B)));
select null from pg_temp.keep('p9', pg_temp.r(:X, format($q$select report_content('player', %L, 'danger')$q$, :B)));
select null from pg_temp.keep('p10', pg_temp.r(:X, format($q$select report_content('game', %L, 'inappropriate')$q$, pg_temp.g(4))));
select null from pg_temp.keep('p11', pg_temp.r(:O, format($q$select report_content('game', %L, 'inappropriate')$q$, pg_temp.g(4))));
select null from pg_temp.keep('p12', pg_temp.r(:A, 'select count(*)::text from reports'));
-- the evidence survives the message being deleted
update match_messages set body = '', deleted_at = now() where id = 'c5000000-0000-4000-8000-000000000002';
select null from pg_temp.keep('p13', (select snapshot from reports where reporter_id = :O and target_kind = 'message'));
insert into t values
  ('T-S23 a member reports a message: one report, snapshot and sender kept; a repeat is a no-op', pg_temp.got('p1') = 'ok' and pg_temp.got('p2') = 'ok' and pg_temp.got('p3') = '1/from B/' || :B::text, pg_temp.got('p3')),
  ('T-S24 a non-member cannot report a message they cannot read', pg_temp.got('p4') like 'ERR not_found%', pg_temp.got('p4')),
  ('T-S25 nobody reports their own message', pg_temp.got('p5') like 'ERR bad_target%', pg_temp.got('p5')),
  ('T-S26 reason and note are checked', pg_temp.got('p6') like 'ERR bad_reason%' and pg_temp.got('p7') like 'ERR note_too_long%', pg_temp.got('p6') || '/' || pg_temp.got('p7')),
  ('T-S27 a player can be reported only by someone who met them in a game', pg_temp.got('p8') = 'ok' and pg_temp.got('p9') like 'ERR not_found%', pg_temp.got('p8') || '/' || pg_temp.got('p9')),
  ('T-S28 an open game can be reported, not by its organiser', pg_temp.got('p10') = 'ok' and pg_temp.got('p11') like 'ERR bad_target%', pg_temp.got('p10') || '/' || pg_temp.got('p11')),
  ('T-S29 reports are not readable through the API', pg_temp.got('p12') like 'ERR permission denied%' or pg_temp.got('p12') = '0', pg_temp.got('p12')),
  ('T-S30 the snapshot survives the message being deleted', pg_temp.got('p13') = 'from B', pg_temp.got('p13'));

-- ===== grants =====
insert into t values
  ('T-S31 safety functions: signed-in only; internals not callable',
     has_function_privilege('authenticated', 'block_player(uuid)', 'execute') and not has_function_privilege('anon', 'block_player(uuid)', 'execute')
     and has_function_privilege('authenticated', 'report_content(text,uuid,text,text)', 'execute') and not has_function_privilege('anon', 'report_content(text,uuid,text,text)', 'execute')
     and not has_function_privilege('authenticated', 'players_blocked(uuid,uuid)', 'execute')
     and not has_function_privilege('authenticated', 'message_has_blocked_term(text)', 'execute'), '');

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
