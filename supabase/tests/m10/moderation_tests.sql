-- M10 tests: moderation readiness (0082). Run by moderation.sh inside one transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
\i :mig
\i :mig
create temp table t (id text, pass boolean, detail text);
insert into t values ('G0 the migration applies twice without error', true, '');
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
create function pg_temp.u(n int) returns uuid language sql as $$ select ('d0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.logs(act text) returns int language sql as $$ select count(*)::int from moderation_log where action = act $$;
-- 1 admin; 2 second admin; 3 reporter; 4 reported player; 5 club staff
insert into auth.users (id, phone) select pg_temp.u(n), '+9617400' || lpad(n::text, 2, '0') from generate_series(1, 5) n;
update profiles set name = 'G' || right(id::text, 1), rules_accepted_at = now() where id in (select pg_temp.u(n) from generate_series(1, 5) n);
update profiles set roles = '{player,admin}' where id in (pg_temp.u(1), pg_temp.u(2));
insert into club_staff (club_id, profile_id) select id, pg_temp.u(5) from clubs where slug = 'batroun';
insert into matches (id, club_id, sport, organizer_id, start_at, end_at, players_needed, status, join_mode)
select pg_temp.u(101), id, 'padel', pg_temp.u(3), now() + interval '2 days', now() + interval '2 days 90 min', 4, 'open', 'open' from clubs where slug = 'batroun';
insert into match_players (match_id, profile_id, status) values (pg_temp.u(101), pg_temp.u(4), 'accepted');
insert into match_messages (id, match_id, profile_id, body) values (pg_temp.u(201), pg_temp.u(101), pg_temp.u(4), 'm10 rude message');
insert into reports (id, reporter_id, target_kind, message_id, profile_id, match_id, target_key, reason, snapshot, note) values
  (pg_temp.u(301), pg_temp.u(3), 'message', pg_temp.u(201), pg_temp.u(4), pg_temp.u(101), pg_temp.u(201), 'abuse', 'm10 rude message', 'he was rude'),
  (pg_temp.u(302), pg_temp.u(3), 'player', null, pg_temp.u(4), null, pg_temp.u(4), 'spam', 'old snapshot a', 'old note a'),
  (pg_temp.u(303), pg_temp.u(3), 'player', null, pg_temp.u(5), null, pg_temp.u(5), 'other', 'old snapshot b', 'old note b'),
  (pg_temp.u(304), pg_temp.u(5), 'player', null, pg_temp.u(3), null, pg_temp.u(3), 'other', 'recent snapshot', 'recent note'),
  (pg_temp.u(305), pg_temp.u(5), 'player', null, pg_temp.u(2), null, pg_temp.u(2), 'other', 'open old snapshot', null);
-- closed long ago: 302 (cleared), 303 (on legal hold: kept); 304 closed recently (kept); 305 open (kept)
update reports set status = 'dismissed', closed_at = now() - interval '200 days' where id in (pg_temp.u(302), pg_temp.u(303));
update reports set legal_hold = true where id = pg_temp.u(303);
update reports set status = 'dismissed', closed_at = now() - interval '100 days' where id = pg_temp.u(304);
update reports set created_at = now() - interval '300 days' where id = pg_temp.u(305);

-- ================= who may do what =================
insert into t select 'G1 ' || who_label || ' cannot run ' || fn, pg_temp.r(who, q) like 'ERR%', pg_temp.r(who, q)
from (values ('the reporter', pg_temp.u(3)), ('the reported player', pg_temp.u(4)), ('club staff', pg_temp.u(5)), ('signed out', null::uuid)) w(who_label, who)
cross join (values
  ('admin_reports', $$select count(*)::text from admin_reports('open')$$),
  ('admin_report_messages', $$select count(*)::text from admin_report_messages('d0000000-0000-4000-8000-000000000301')$$),
  ('admin_resolve_report', $$select admin_resolve_report('d0000000-0000-4000-8000-000000000301', 'dismissed', 'x')::text$$),
  ('admin_reopen_report', $$select admin_reopen_report('d0000000-0000-4000-8000-000000000302', 'x')::text$$),
  ('admin_suspend', $$select admin_suspend('d0000000-0000-4000-8000-000000000004', 'x')::text$$),
  ('admin_unsuspend', $$select admin_unsuspend('d0000000-0000-4000-8000-000000000004', 'x')::text$$),
  ('admin_hide_message', $$select admin_hide_message('d0000000-0000-4000-8000-000000000201')::text$$),
  ('admin_set_legal_hold', $$select admin_set_legal_hold('d0000000-0000-4000-8000-000000000301', true, 'x')::text$$),
  ('clear_old_report_text', $$select clear_old_report_text(180)::text$$),
  ('admin_moderation_log', $$select count(*)::text from admin_moderation_log(null, null)$$),
  ('admin_report_state', $$select count(*)::text from admin_report_state(array['d0000000-0000-4000-8000-000000000301'::uuid])$$)
) f(fn, q);
insert into t values
  ('G2 players cannot read reports, the log or suspensions directly', pg_temp.r(pg_temp.u(3), $$select count(*)::text from reports$$) like 'ERR permission denied%'
     and pg_temp.r(pg_temp.u(3), $$select count(*)::text from moderation_log$$) like 'ERR permission denied%'
     and pg_temp.r(pg_temp.u(4), $$select count(*)::text from account_suspensions$$) like 'ERR permission denied%', ''),
  ('G2 nobody writes them directly', pg_temp.r(pg_temp.u(1), $$update reports set status = 'open'$$) like 'ERR permission denied%'
     and pg_temp.r(pg_temp.u(1), $$insert into moderation_log (action) values ('suspend')$$) like 'ERR permission denied%', ''),
  ('G2 nothing changed after the refused attempts', (select status = 'open' from reports where id = pg_temp.u(301)) and (select count(*) = 0 from moderation_log)
     and (select count(*) = 0 from account_suspensions where profile_id = pg_temp.u(4)), '');

-- ================= resolve, then reopen =================
insert into t values ('G3 the admin resolves a report', pg_temp.r(pg_temp.u(1), format($$select admin_resolve_report(%L, 'actioned', 'message hidden, warned')::text$$, pg_temp.u(301))) = 'ok', '');
insert into t values
  ('G3 ...logged', pg_temp.logs('resolve') = 1, ''),
  ('G3 resolving it again (another admin) is refused: the first decision stays', pg_temp.r(pg_temp.u(2), format($$select admin_resolve_report(%L, 'dismissed', 'no')::text$$, pg_temp.u(301))) like 'ERR already_handled%', '');
insert into t values
  ('G3 ...first decision intact', (select status = 'actioned' and action = 'message hidden, warned' and handled_by = pg_temp.u(1) from reports where id = pg_temp.u(301)), ''),
  ('G4 reopening needs a reason', pg_temp.r(pg_temp.u(2), format($$select admin_reopen_report(%L, '  ')::text$$, pg_temp.u(301))) like 'ERR reason_required%', ''),
  ('G4 reopening an open report is refused', pg_temp.r(pg_temp.u(2), format($$select admin_reopen_report(%L, 'x')::text$$, pg_temp.u(305))) like 'ERR already_open%', ''),
  ('G4 the second admin reopens with a reason', pg_temp.r(pg_temp.u(2), format($$select admin_reopen_report(%L, 'new evidence')::text$$, pg_temp.u(301))) = 'ok', '');
insert into t values
  ('G4 ...open again, clearing clock stopped', (select status = 'open' and closed_at is null from reports where id = pg_temp.u(301)), ''),
  ('G4 ...the earlier decision is in the log', (select count(*) = 1 from moderation_log where action = 'reopen' and note like 'was actioned (message hidden, warned): new evidence'), '');

-- ================= suspend / unsuspend =================
insert into t values
  ('G5 a suspension needs a reason', pg_temp.r(pg_temp.u(1), format($$select admin_suspend(%L, ' ')::text$$, pg_temp.u(4))) like 'ERR reason_required%', ''),
  ('G5 an admin cannot be suspended (remove the role first)', pg_temp.r(pg_temp.u(1), format($$select admin_suspend(%L, 'x')::text$$, pg_temp.u(2))) like 'ERR bad_target%', ''),
  ('G5 nor yourself', pg_temp.r(pg_temp.u(1), format($$select admin_suspend(%L, 'x')::text$$, pg_temp.u(1))) like 'ERR bad_target%', ''),
  ('G5 the admin suspends the reported player', pg_temp.r(pg_temp.u(1), format($$select admin_suspend(%L, 'm10 abuse in chat')::text$$, pg_temp.u(4))) = 'ok', '');
insert into t values
  ('G5 ...suspended and logged', (select count(*) = 1 from account_suspensions where profile_id = pg_temp.u(4)) and pg_temp.logs('suspend') = 1, ''),
  ('G5 ...the suspended player cannot post a game', pg_temp.r(pg_temp.u(4), $$select post_match((select id from clubs where slug = 'batroun'), 'padel', now() + interval '5 days', now() + interval '5 days 90 min', null, null, 3, 'x', null, 'open', gen_random_uuid())::text$$) like 'ERR account_suspended%', ''),
  ('G6 unsuspending needs a reason', pg_temp.r(pg_temp.u(1), format($$select admin_unsuspend(%L)::text$$, pg_temp.u(4))) like 'ERR reason_required%', '');
insert into t values
  ('G6 ...still suspended', (select count(*) = 1 from account_suspensions where profile_id = pg_temp.u(4)), ''),
  ('G6 unsuspending with a reason', pg_temp.r(pg_temp.u(1), format($$select admin_unsuspend(%L, 'apologised')::text$$, pg_temp.u(4))) = 'ok', '');
insert into t values
  ('G6 ...the suspension row is gone but its date and reason stay in the log', (select count(*) = 0 from account_suspensions where profile_id = pg_temp.u(4))
     and (select count(*) = 1 from moderation_log where action = 'unsuspend' and profile_id = pg_temp.u(4) and note like 'apologised (suspended %: m10 abuse in chat)'), ''),
  ('G6 unsuspending someone not suspended is refused', pg_temp.r(pg_temp.u(1), format($$select admin_unsuspend(%L, 'x')::text$$, pg_temp.u(4))) like 'ERR not_suspended%', '');

-- ================= hide a message =================
insert into t values ('G7 the admin hides the reported message', pg_temp.r(pg_temp.u(1), format($$select admin_hide_message(%L)::text$$, pg_temp.u(201))) = 'ok', '');
insert into t values
  ('G7 ...hidden, the report keeps the text as evidence', (select body = '' and deleted_at is not null from match_messages where id = pg_temp.u(201))
     and (select snapshot = 'm10 rude message' from reports where id = pg_temp.u(301)), ''),
  ('G7 ...logged with its report', (select count(*) = 1 from moderation_log where action = 'hide_message' and message_id = pg_temp.u(201) and report_id = pg_temp.u(301)), ''),
  ('G7 hiding it again changes and logs nothing', pg_temp.r(pg_temp.u(1), format($$select admin_hide_message(%L)::text$$, pg_temp.u(201))) = 'ok', '');
insert into t values ('G7 ...still one entry', pg_temp.logs('hide_message') = 1, '');

-- ================= legal hold =================
insert into t values
  ('G8 a legal hold needs a reason', pg_temp.r(pg_temp.u(1), format($$select admin_set_legal_hold(%L, true, '')::text$$, pg_temp.u(301))) like 'ERR reason_required%', ''),
  ('G8 the admin puts a report on legal hold', pg_temp.r(pg_temp.u(1), format($$select admin_set_legal_hold(%L, true, 'police request ref 12')::text$$, pg_temp.u(301))) = 'ok', '');
insert into t values
  ('G8 ...on hold and logged', (select legal_hold from reports where id = pg_temp.u(301)) and pg_temp.logs('legal_hold_on') = 1, ''),
  ('G8 setting the same value again logs nothing', pg_temp.r(pg_temp.u(1), format($$select admin_set_legal_hold(%L, true, 'again')::text$$, pg_temp.u(301))) = 'ok', '');
insert into t values ('G8 ...still one entry', pg_temp.logs('legal_hold_on') = 1, '');

-- ================= 180-day clearing =================
insert into t values
  ('G9 clearing earlier than the 180-day rule is refused', pg_temp.r(pg_temp.u(1), $$select clear_old_report_text(30)::text$$) like 'ERR too_soon%', ''),
  ('G9 the admin runs the clearing: one report qualifies', pg_temp.r(pg_temp.u(1), $$select clear_old_report_text()::text$$) = '1', '');
insert into t values
  ('G9 closed over 180 days ago: snapshot and note cleared, the report itself kept', (select snapshot is null and note is null and status = 'dismissed' and reason = 'spam' from reports where id = pg_temp.u(302)), ''),
  ('G9 on legal hold: kept', (select snapshot = 'old snapshot b' and note = 'old note b' from reports where id = pg_temp.u(303)), ''),
  ('G9 closed 100 days ago: kept', (select snapshot = 'recent snapshot' from reports where id = pg_temp.u(304)), ''),
  ('G9 open (even if old): kept', (select snapshot = 'open old snapshot' from reports where id = pg_temp.u(305)), ''),
  ('G9 ...the clearing is logged with its count', (select count(*) = 1 from moderation_log where action = 'clear_text' and note like '1 report(s)%'), ''),
  ('G9 a server job (no signed-in user) can run it too', pg_temp.r(null, 'select 1') = '1', '');
do $$ begin
  perform clear_old_report_text();
  insert into t values ('G9 ...server run succeeds (nothing left to clear)', true, '');
exception when others then insert into t values ('G9 ...server run succeeds (nothing left to clear)', false, sqlerrm);
end $$;

-- ================= the log =================
do $$ begin
  update moderation_log set note = 'edited';
  insert into t values ('G10 the log cannot be edited, even in server context', false, 'edited');
exception when others then insert into t values ('G10 the log cannot be edited, even in server context', sqlerrm like '%moderation_log_is_append_only%', sqlerrm);
end $$;
do $$ begin
  delete from moderation_log;
  insert into t values ('G10 ...nor deleted', false, 'deleted');
exception when others then insert into t values ('G10 ...nor deleted', sqlerrm like '%moderation_log_is_append_only%', sqlerrm);
end $$;
insert into t values
  ('G11 the history of the reported player, newest first, with the admin''s name', pg_temp.r(pg_temp.u(1), format($$select string_agg(action || '/' || admin_name, ',') from admin_moderation_log(null, %L)$$, pg_temp.u(4)))
     = 'legal_hold_on/G1,hide_message/G1,unsuspend/G1,suspend/G1,reopen/G2,resolve/G1', pg_temp.r(pg_temp.u(1), format($$select string_agg(action || '/' || admin_name, ',') from admin_moderation_log(null, %L)$$, pg_temp.u(4)))),
  ('G11 the board state: legal hold, history size', pg_temp.r(pg_temp.u(1), format($$select legal_hold || '/' || log_entries from admin_report_state(array[%L::uuid])$$, pg_temp.u(301))) = 'true/6', ''),
  ('G11 the log keeps ids, not names', not exists (select 1 from information_schema.columns where table_name = 'moderation_log' and column_name ~ 'name|phone|email'), '');

select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;
select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;
rollback;
