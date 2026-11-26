-- H4: a deleted chat message leaves no text in other players' Activity. ONE transaction, rolled back.
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
create function pg_temp.u(n int) returns uuid language sql as $$ select ('f5000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.at(d int, hhmm text) returns timestamptz language sql as $$ select ((current_date + d)::timestamp + hhmm::time) at time zone 'Asia/Beirut' $$;
create function pg_temp.notice(who int, m uuid) returns text language sql as $$
  select coalesce(string_agg(body, ' | ' order by created_at), '') from notifications where profile_id = pg_temp.u(who) and match_id = m and kind = 'match_message' $$;
create function pg_temp.say(who int, m uuid, txt text) returns uuid language plpgsql as $f$
declare v uuid;
begin
  perform pg_temp.r(pg_temp.u(who), format('insert into match_messages (match_id, profile_id, body) values (%L, %L, %L)', m, pg_temp.u(who), txt));
  select id into v from match_messages where match_id = m and profile_id = pg_temp.u(who) and body = txt order by created_at desc limit 1;
  return v;
end $f$;

insert into auth.users (id, phone) select pg_temp.u(n), '+9617664000' || lpad(n::text, 2, '0') from generate_series(1, 5) n;
update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app',
  name = (array['Karim Haddad', 'Rana Khoury', 'Lea Saad', 'Sami Aoun', 'Admin'])[right(id::text, 1)::int]
where id in (select pg_temp.u(n) from generate_series(1, 5) n);
update profiles set roles = '{player,admin}' where id = pg_temp.u(5);
-- two games organised by Karim (1); Rana (2) and Lea (3) join the first, Rana the second
create function pg_temp.game(d int) returns uuid language sql as $$
  select pg_temp.r(pg_temp.u(1), format('select post_match(%L, ''padel'', %L, %L, null, null, 3, '''', null, ''open'', null)::text',
    (select id from clubs where slug = 'batroun'), pg_temp.at(d, '18:00'), pg_temp.at(d, '19:30')))::uuid $$;
select pg_temp.keep('g1', pg_temp.game(3)::text);
select pg_temp.keep('g2', pg_temp.game(4)::text);
select pg_temp.r(pg_temp.u(2), format('select join_match(%L)', pg_temp.got('g1')));
select pg_temp.r(pg_temp.u(3), format('select join_match(%L)', pg_temp.got('g1')));
select pg_temp.r(pg_temp.u(2), format('select join_match(%L)', pg_temp.got('g2')));

-- N1 the player deletes their message
select pg_temp.keep('m1', pg_temp.say(1, pg_temp.got('g1')::uuid, 'my private address is 12 Cedar St')::text);
select pg_temp.keep('n1_before', pg_temp.notice(2, pg_temp.got('g1')::uuid));
select pg_temp.keep('n1_del', pg_temp.r(pg_temp.u(1), format('select delete_match_message(%L)', pg_temp.got('m1'))));
insert into t values ('N1 the sender deletes the message: the copy in each other player''s Activity loses the text ("…: message deleted")',
  pg_temp.got('n1_before') = 'Karim Haddad: my private address is 12 Cedar St' and pg_temp.got('n1_del') = 'ok'
  and pg_temp.notice(2, pg_temp.got('g1')::uuid) = 'Karim Haddad: message deleted' and pg_temp.notice(3, pg_temp.got('g1')::uuid) = 'Karim Haddad: message deleted'
  and not exists (select 1 from notifications where body like '%Cedar%'),
  pg_temp.got('n1_before') || ' → ' || pg_temp.notice(2, pg_temp.got('g1')::uuid));

-- N2 an admin hides a reported message (0074/0082)
update notifications set read_at = now() where match_id = pg_temp.got('g1')::uuid;      -- read: the next message makes a new notice
select pg_temp.keep('m2', pg_temp.say(1, pg_temp.got('g1')::uuid, 'call me on 70 123 456')::text);
select pg_temp.keep('n2_hide', pg_temp.r(pg_temp.u(5), format('select admin_hide_message(%L)', pg_temp.got('m2'))));
insert into t values ('N2 an admin hides a reported message: the copies lose the text too',
  pg_temp.got('n2_hide') = 'ok' and not exists (select 1 from notifications where body like '%70 123 456%')
  and pg_temp.notice(2, pg_temp.got('g1')::uuid) like '%Karim Haddad: message deleted',
  pg_temp.got('n2_hide') || ' / ' || pg_temp.notice(2, pg_temp.got('g1')::uuid));

-- N3 nothing else changes: another sender's notice, another game's notice, a live message's notice
update notifications set read_at = now() where match_id = pg_temp.got('g1')::uuid;
select pg_temp.keep('m3', pg_temp.say(3, pg_temp.got('g1')::uuid, 'bring balls')::text);              -- Lea → Karim, Rana
select pg_temp.keep('m4', pg_temp.say(1, pg_temp.got('g2')::uuid, 'court 2 tonight')::text);          -- Karim → Rana (game 2)
select pg_temp.keep('m5', pg_temp.say(1, pg_temp.got('g1')::uuid, 'bring balls')::text);              -- Karim, the same words: a notice for Lea only (Rana has Lea's unread)
select pg_temp.r(pg_temp.u(1), format('select delete_match_message(%L)', pg_temp.got('m5')));
insert into t values ('N3 only the deleting sender''s notices change: Lea''s identical words, Karim''s other game and live messages are untouched',
  pg_temp.notice(2, pg_temp.got('g2')::uuid) = 'Karim Haddad: court 2 tonight'
  and exists (select 1 from notifications where profile_id = pg_temp.u(1) and body = 'Lea Saad: bring balls')
  and exists (select 1 from notifications where profile_id = pg_temp.u(2) and body = 'Lea Saad: bring balls')
  and exists (select 1 from notifications where profile_id = pg_temp.u(3) and match_id = pg_temp.got('g1')::uuid and body = 'Karim Haddad: message deleted'),
  pg_temp.notice(2, pg_temp.got('g2')::uuid) || ' / ' || pg_temp.notice(1, pg_temp.got('g1')::uuid) || ' / ' || pg_temp.notice(3, pg_temp.got('g1')::uuid));

-- N4 deleting twice, or a message with no notice, changes nothing and fails nothing
select pg_temp.keep('n4', pg_temp.r(pg_temp.u(1), format('select delete_match_message(%L)', pg_temp.got('m1'))));
insert into t values ('N4 a second delete is refused as before (not_found); notices unchanged', pg_temp.got('n4') = 'ERR not_found', pg_temp.got('n4'));

-- N5 nobody can call the trigger function directly
select pg_temp.keep('n5', pg_temp.r(pg_temp.u(2), 'select chat_notice_follows_deletion()'));
insert into t values ('N5 the function cannot be called by a player', pg_temp.got('n5') like 'ERR %', pg_temp.got('n5'));

-- N6 the one-off clean-up of notices made before the fix: simulate an old deletion with the trigger off
alter table match_messages disable trigger match_messages_deleted_notice;
update notifications set read_at = now() where match_id = pg_temp.got('g2')::uuid;
select pg_temp.keep('m6', pg_temp.say(1, pg_temp.got('g2')::uuid, 'gate code 4321')::text);
select pg_temp.r(pg_temp.u(1), format('select delete_match_message(%L)', pg_temp.got('m6')));
alter table match_messages enable trigger match_messages_deleted_notice;
select pg_temp.keep('n6_before', pg_temp.notice(2, pg_temp.got('g2')::uuid));
-- the whole draft again (idempotent): the trigger as it is, then the clean-up
\ir ../../../docs/chat-privacy/sql/chat_notice_follows_deletion.draft.sql
insert into t values ('N6 the clean-up removes the text a deletion before the fix left behind; the live notice in that game stays',
  pg_temp.got('n6_before') like '%gate code 4321%' and pg_temp.notice(2, pg_temp.got('g2')::uuid) like '%Karim Haddad: message deleted%'
  and pg_temp.notice(2, pg_temp.got('g2')::uuid) like '%Karim Haddad: court 2 tonight%' and not exists (select 1 from notifications where body like '%4321%'),
  pg_temp.got('n6_before') || ' → ' || pg_temp.notice(2, pg_temp.got('g2')::uuid));

select case when coalesce(pass, false) then 'ok   ' else 'FAIL ' end || id || case when coalesce(pass, false) then '' else '  [' || coalesce(detail, '') || ']' end from t order by id;
select 'checks: ' || count(*) || ', failures: ' || count(*) filter (where not coalesce(pass, false)) from t;
rollback;
