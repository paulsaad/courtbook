-- 0073 tests (post_match idempotency key). Run by post_token.sh in one transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
-- start from the state 0073 is applied to (0072's ten-argument post_match, no key column or index)
drop function if exists post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text, uuid);
drop index if exists matches_organizer_client_token;
alter table matches drop column if exists client_token;
\i supabase/migrations/0072_game_hardening.sql
\i :mig
\i :mig
create temp table t (id text, pass boolean, detail text);
insert into t values ('K0 applies twice without error', true, '');
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
  return res;
end $f$;
create temp table kept (k text primary key, v text);
create function pg_temp.keep(key text, val text) returns text language sql as $$ insert into kept values (key, val) returning v $$;
create function pg_temp.got(key text) returns text language sql as $$ select v from kept where k = key $$;
create function pg_temp.u(n int) returns uuid language sql as $$ select ('e3000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.club() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
create function pg_temp.post(d int, tok text) returns text language sql as $$
  select format('select post_match(%L, ''padel'', now() + interval ''%s days'', now() + interval ''%s days 90 minutes'', null, null, 3, null, null, ''open'', %s)',
    pg_temp.club(), d, d, coalesce(quote_literal(tok) || '::uuid', 'null')) $$;
insert into auth.users (id, email) select pg_temp.u(i), 'k' || i || '@0073.test' from generate_series(1, 3) i;
\set A 'pg_temp.u(1)'
\set B 'pg_temp.u(2)'
delete from blocks;

-- same key twice: the same game, one row
select null from pg_temp.keep('a1', pg_temp.r(:A, pg_temp.post(45, 'a0000000-0000-4000-8000-000000000001')));
select null from pg_temp.keep('a2', pg_temp.r(:A, pg_temp.post(45, 'a0000000-0000-4000-8000-000000000001')));
select null from pg_temp.keep('a3', (select count(*)::text from matches where organizer_id = :A));
insert into t values ('K1 a repeat with the same key returns the same game; one game', pg_temp.got('a1') = pg_temp.got('a2') and pg_temp.got('a3') = '1', pg_temp.got('a1') || ' / ' || pg_temp.got('a2') || ' / ' || pg_temp.got('a3'));

-- a repeat even with other details (a retry sends the same request; the key decides)
select null from pg_temp.keep('a4', pg_temp.r(:A, pg_temp.post(46, 'a0000000-0000-4000-8000-000000000001')));
insert into t values ('K2 the key decides: a repeat with other details still returns the first game', pg_temp.got('a4') = pg_temp.got('a1'), pg_temp.got('a4'));

-- another organiser's key with the same value is independent
select null from pg_temp.keep('b1', pg_temp.r(:B, pg_temp.post(45, 'a0000000-0000-4000-8000-000000000001')));
insert into t values ('K3 keys are per organiser', pg_temp.got('b1') ~ '^[0-9a-f-]{36}$' and pg_temp.got('b1') <> pg_temp.got('a1'), pg_temp.got('b1'));

-- without a key: as before (two posts, two games) — the website's call
select null from pg_temp.keep('c1', pg_temp.r(:A, pg_temp.post(47, null)));
select null from pg_temp.keep('c2', pg_temp.r(:A, pg_temp.post(47, null)));
select null from pg_temp.keep('c3', pg_temp.r(:A, format($q$select post_match(p_club => %L, p_sport => 'padel', p_start => now() + interval '48 days', p_end => null, p_level_min => null, p_level_max => null, p_players_needed => 2, p_note => 'web', p_booking => null, p_join_mode => 'approval')$q$, pg_temp.club())));
insert into t values
  ('K4 without a key: two posts make two games (unchanged)', pg_temp.got('c1') <> pg_temp.got('c2') and pg_temp.got('c1') ~ '^[0-9a-f-]{36}$', pg_temp.got('c1') || ' / ' || pg_temp.got('c2')),
  ('K5 the website''s named ten-argument call still works', pg_temp.got('c3') ~ '^[0-9a-f-]{36}$', pg_temp.got('c3'));

-- the repeat is answered before the limits: at 10 live games a retry still returns its game
insert into matches (club_id, sport, organizer_id, start_at, players_needed) select pg_temp.club(), 'padel', :A, now() + (50 + i || ' days')::interval, 3 from generate_series(1, 6) i;
select null from pg_temp.keep('d0', (select count(*)::text from matches where organizer_id = :A and status <> 'cancelled' and start_at > now()));
select null from pg_temp.keep('d1', pg_temp.r(:A, pg_temp.post(45, 'a0000000-0000-4000-8000-000000000001')));
select null from pg_temp.keep('d2', pg_temp.r(:A, pg_temp.post(49, 'a0000000-0000-4000-8000-000000000009')));
insert into t values ('K6 at the 10-game limit a retry returns its game; a new key is refused', pg_temp.got('d0') = '10' and pg_temp.got('d1') = pg_temp.got('a1') and pg_temp.got('d2') like 'ERR too_many_games%', pg_temp.got('d0') || ' / ' || pg_temp.got('d2'));

-- from a booking: the retry returns the game, not booking_already_posted
insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by)
select 'b3000000-0000-4000-8000-000000000001', c.club_id, c.id, :B, (current_date + 55 + time '10:00') at time zone 'Asia/Beirut', (current_date + 55 + time '11:30') at time zone 'Asia/Beirut', 'confirmed', 'app', :B
from courts c where c.club_id = pg_temp.club() and c.sport = 'padel' limit 1;
select null from pg_temp.keep('e1', pg_temp.r(:B, $q$select post_match(null, 'padel', null, null, null, null, 1, null, 'b3000000-0000-4000-8000-000000000001', 'open', 'a0000000-0000-4000-8000-0000000000b1')$q$));
select null from pg_temp.keep('e2', pg_temp.r(:B, $q$select post_match(null, 'padel', null, null, null, null, 1, null, 'b3000000-0000-4000-8000-000000000001', 'open', 'a0000000-0000-4000-8000-0000000000b1')$q$));
select null from pg_temp.keep('e3', pg_temp.r(:B, $q$select post_match(null, 'padel', null, null, null, null, 1, null, 'b3000000-0000-4000-8000-000000000001', 'open', 'a0000000-0000-4000-8000-0000000000b2')$q$));
insert into t values
  ('K7 from a booking: a retry with the key returns the game', pg_temp.got('e1') = pg_temp.got('e2') and pg_temp.got('e1') ~ '^[0-9a-f-]{36}$', pg_temp.got('e1') || ' / ' || pg_temp.got('e2')),
  ('K8 a different key for the same booking is still booking_already_posted', pg_temp.got('e3') like 'ERR booking_already_posted%', pg_temp.got('e3'));

-- a cancelled game keeps its key: the retry of that post returns it (no new game behind the player's back)
update matches set status = 'cancelled' where id = pg_temp.got('c1')::uuid;
update matches set client_token = 'a0000000-0000-4000-8000-0000000000c1' where id = pg_temp.got('c1')::uuid;
select null from pg_temp.keep('f1', pg_temp.r(:A, pg_temp.post(47, 'a0000000-0000-4000-8000-0000000000c1')));
insert into t values ('K9 the key of a cancelled game returns that game', pg_temp.got('f1') = pg_temp.got('c1'), pg_temp.got('f1'));

insert into t values
  ('K10 signed in only', has_function_privilege('authenticated', 'post_match(uuid,sport,timestamptz,timestamptz,int,int,int,text,uuid,text,uuid)', 'execute')
     and not has_function_privilege('anon', 'post_match(uuid,sport,timestamptz,timestamptz,int,int,int,text,uuid,text,uuid)', 'execute'), ''),
  ('K11 one post_match only (no ambiguous overload)', (select count(*) = 1 from pg_proc where proname = 'post_match' and pronamespace = 'public'::regnamespace), '');

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
