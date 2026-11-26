-- After chat_notices_without_text.draft.sql: no chat text in any notice or email; nothing else changed. Rolled back.
\set ON_ERROR_STOP 1
begin;
\ir helpers.sql
create temp table t (id text, pass boolean, detail text);
create temp table kept (k text primary key, v text);
grant all on t, kept to authenticated, service_role;
create function pg_temp.keep(k text, v text) returns void language sql as $$ insert into kept values (k, v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.got(k text) returns text language sql as $$ select v from kept where kept.k = got.k $$;
-- every text ever written in these games, deleted and hidden ones included
create function pg_temp.leaks() returns text language sql as $$
  select coalesce(string_agg(n.body, ' | '), '') from notifications n
  where n.profile_id::text like 'f6000000%'
    and (n.body ilike any (array['%Cedar%', '%70 123 456%', '%see you at six%', '%gate code%', '%new court booked%', '%second one%', '%meet at the bar%'])) $$;

insert into t select 'C1 historical chat notices rewritten: the deleted, the hidden, the grouped and the live message''s text are all gone',
  pg_temp.leaks() = ''
  and pg_temp.notice(2, pg_temp.game(1)) = 'New message from Karim Haddad | New message from Karim Haddad'
  and pg_temp.notice(3, pg_temp.game(1)) = 'New message from Karim Haddad | New message from Karim Haddad'
  and pg_temp.notice(1, pg_temp.game(1)) = 'New message from Lea Saad'
  and pg_temp.notice(2, pg_temp.game(2)) = 'New message from Karim Haddad',
  pg_temp.leaks() || ' / ' || pg_temp.notice(2, pg_temp.game(1));

-- new messages
update notifications set read_at = now() where match_id = pg_temp.game(2);
select pg_temp.keep('m5', pg_temp.say(1, pg_temp.game(2), 'new court booked for 8pm')::text);
insert into t select 'C2 a new message: the notice names the sender only; the player still reads the text in the game',
  pg_temp.notice(2, pg_temp.game(2)) like '%| New message from Karim Haddad' and pg_temp.leaks() = ''
  and pg_temp.r(pg_temp.u(2), format('select string_agg(body, ''|'') from match_messages_list(%L, null)', pg_temp.game(2))) like '%new court booked for 8pm%',
  pg_temp.notice(2, pg_temp.game(2));

select pg_temp.say(1, pg_temp.game(2), 'second one');
select pg_temp.say(1, pg_temp.game(2), 'second one');                                   -- the same words twice
insert into t select 'C3 more and duplicate messages while the notice is unread: still one notice, no text',
  (select count(*) from notifications where profile_id = pg_temp.u(2) and match_id = pg_temp.game(2) and kind = 'match_message' and read_at is null) = 1
  and pg_temp.leaks() = '', pg_temp.notice(2, pg_temp.game(2));

select pg_temp.keep('c4', pg_temp.r(pg_temp.u(1), format('select delete_match_message(%L)', pg_temp.got('m5'))));
insert into t select 'C4 the sender deletes a message: the chat shows it deleted; the notices had no text to begin with',
  pg_temp.got('c4') = 'ok' and pg_temp.leaks() = ''
  and pg_temp.r(pg_temp.u(2), format('select bool_or(deleted)::text from match_messages_list(%L, null) where id = %L', pg_temp.game(2), pg_temp.got('m5'))) = 'true',
  pg_temp.got('c4');

-- moderation: the report keeps the text, only for admins
update notifications set read_at = now() where match_id = pg_temp.game(1);
select pg_temp.keep('m6', pg_temp.say(3, pg_temp.game(1), 'meet at the bar after')::text);
select pg_temp.keep('c5_rep', pg_temp.r(pg_temp.u(2), format('select report_content(''message'', %L, ''abuse'')', pg_temp.got('m6'))));
select pg_temp.keep('c5_hide', pg_temp.r(pg_temp.u(5), format('select admin_hide_message(%L)', pg_temp.got('m6'))));
insert into t select 'C5 admin moderation: the report keeps the hidden message''s text as evidence; notices never had it',
  pg_temp.got('c5_rep') = 'ok' and pg_temp.got('c5_hide') = 'ok' and pg_temp.leaks() = ''
  and exists (select 1 from reports where message_id = pg_temp.got('m6')::uuid and snapshot = 'meet at the bar after')
  and (select body from match_messages where id = pg_temp.got('m6')::uuid) = ''
  and exists (select 1 from reports where snapshot = 'call me on 70 123 456'),                 -- the old report too
  pg_temp.got('c5_rep') || ' / ' || pg_temp.got('c5_hide');

select pg_temp.keep('c6_player', pg_temp.r(pg_temp.u(2), 'select count(*)::text from reports'));
select pg_temp.keep('c6_admin_fn', pg_temp.r(pg_temp.u(2), 'select count(*)::text from admin_reports(null)'));
select pg_temp.keep('c6_other', pg_temp.r(pg_temp.u(4), format('select count(*)::text from notifications where profile_id = %L', pg_temp.u(2))));
select pg_temp.keep('c6_member', pg_temp.r(pg_temp.u(4), format('select count(*)::text from match_messages where match_id = %L', pg_temp.game(1))));
insert into t select 'C6 privacy boundaries: a player cannot read reports or the admin list; another player sees none of Rana''s notices; a non-member reads no messages',
  pg_temp.got('c6_player') like 'ERR permission denied%' and pg_temp.got('c6_admin_fn') like 'ERR %'
  and pg_temp.got('c6_other') = '0' and pg_temp.got('c6_member') = '0',
  pg_temp.got('c6_player') || ' / ' || pg_temp.got('c6_admin_fn') || ' / ' || pg_temp.got('c6_other') || ' / ' || pg_temp.got('c6_member');

-- email: even a row still holding text (written straight into the table) is sent without it
insert into notifications (profile_id, kind, match_id, actor_id, body) values (pg_temp.u(2), 'match_message', pg_temp.game(1), pg_temp.u(1), 'Karim Haddad: gate code 4321');
select pg_temp.keep('c7', pg_temp.svc('select string_agg(kind || ''='' || body, '' | '' order by kind, body) from claim_notifications_to_email(50)'));
insert into t select 'C7 the email claim sends chat notices as "New message from <name>" only; other kinds keep their text',
  pg_temp.got('c7') not ilike '%gate code%' and pg_temp.got('c7') not ilike '%Cedar%' and pg_temp.got('c7') not ilike '%70 123%'
  and pg_temp.got('c7') like '%match_message=New message from Karim Haddad%' and pg_temp.got('c7') like '%match_message=New message from Lea Saad%'
  and pg_temp.got('c7') like '%player_joined=Rana Khoury joined your match%',
  pg_temp.got('c7');

-- other kinds: unchanged rows, unchanged triggers
select pg_temp.r(pg_temp.u(4), format('select join_match(%L)', pg_temp.game(2)));
insert into t select 'C8 other notification kinds keep their information (a new join notice as before)',
  exists (select 1 from notifications where profile_id = pg_temp.u(1) and kind = 'player_joined' and body = 'Sami Aoun joined your match')
  and (select count(*) from notifications where profile_id = pg_temp.u(1) and kind = 'player_joined' and body like '% joined your match') = 4,
  (select string_agg(body, ' | ') from notifications where profile_id = pg_temp.u(1) and kind = 'player_joined');

insert into t select 'C9 the trigger is otherwise as before: the sender gets no notice; a player who blocked the sender gets none',
  not exists (select 1 from notifications where profile_id = pg_temp.u(1) and kind = 'match_message' and match_id = pg_temp.game(2)), 'sender';
select pg_temp.r(pg_temp.u(2), format('select block_player(%L)', pg_temp.u(3)));
update notifications set read_at = now() where profile_id = pg_temp.u(2);
select pg_temp.say(3, pg_temp.game(1), 'from a blocked player');
update t set pass = pass and not exists (select 1 from notifications where profile_id = pg_temp.u(2) and kind = 'match_message' and read_at is null),
  detail = detail || ' / blocked: ' || (select count(*) from notifications where profile_id = pg_temp.u(2) and kind = 'match_message' and read_at is null)
where id like 'C9%';

select case when coalesce(pass, false) then 'ok   ' else 'FAIL ' end || id || case when coalesce(pass, false) then '' else '  [' || coalesce(detail, '') || ']' end from t order by id;
select 'checks: ' || count(*) || ', failures: ' || count(*) filter (where not coalesce(pass, false)) from t;
rollback;
