-- M12.2 (0095): reconciliation watermark, issues kept until a person resolves them, and the runner's health reading.
-- No provider is contacted. ONE transaction, rolled back: nothing it does persists (safe on staging after 0095).
\set ON_ERROR_STOP 1
begin;
create temp table t (id text, pass boolean, detail text);
create temp table kept (k text primary key, v text);
grant all on t, kept to authenticated, service_role, anon;
create function pg_temp.keep(k text, v text) returns void language sql as $$ insert into kept values (k, v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.got(k text) returns text language sql as $$ select v from kept where kept.k = got.k $$;
-- as a role ('anon', 'authenticated' with a user, 'service_role')
create function pg_temp.as_(rl text, who uuid, q text) returns text language plpgsql as $f$
declare res text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  execute format('set local role %I', rl);
  begin
    if q ~* '^\s*select' then execute q into res; else execute q; end if;
    res := coalesce(nullif(res, ''), 'ok');
  exception when others then res := 'ERR ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return res;
end $f$;
create function pg_temp.s(q text) returns text language sql as $$ select pg_temp.as_('service_role', null, q) $$;
create function pg_temp.u(n int) returns uuid language sql as $$ select ('f9400000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.issue(ref text) returns uuid language sql as $$ select id from payment_reconciliation_issues where provider = 'whish' and provider_ref = ref and code = 'charge_evidence_conflict' $$;

insert into auth.users (id, phone) select pg_temp.u(n), '+9617694000' || lpad(n::text, 2, '0') from generate_series(1, 3) n;
update profiles set roles = '{player,admin}' where id = pg_temp.u(3);                  -- u3: CourtBook admin; u1 a player
insert into club_staff (club_id, profile_id) select id, pg_temp.u(2) from clubs order by created_at limit 1;  -- u2: a club's desk

-- ------------------------------------------------------------------ W watermark (server only, explicit start)
insert into t select 'W1 before a starting point is set the health reading says so (no watermark) and advancing refuses',
  pg_temp.s($q$select coalesce(reconciled_until::text, 'none') from payment_reconciliation_health('whish', '24 hours')$q$) = 'none'
  and pg_temp.s($q$select advance_reconciliation_watermark('whish', now())::text$q$) = 'ERR not_initialised', null;
insert into t select 'W2 a starting point in the future is refused',
  pg_temp.s($q$select initialise_reconciliation_watermark('whish', now() + interval '1 day')::text$q$) = 'ERR bad_watermark', null;
select pg_temp.keep('w_init', pg_temp.s($q$select initialise_reconciliation_watermark('whish', now() - interval '10 days')::text$q$));
insert into t select 'W3 the server sets the starting point once; a second one is refused',
  pg_temp.got('w_init') !~ '^ERR' and pg_temp.s($q$select initialise_reconciliation_watermark('whish', now() - interval '20 days')::text$q$) = 'ERR already_initialised', pg_temp.got('w_init');
insert into t select 'W4 the watermark moves forward only (advancing to an earlier time keeps it)',
  pg_temp.s($q$select (advance_reconciliation_watermark('whish', now() - interval '5 days') = now() - interval '5 days')::text$q$) = 'true'
  and pg_temp.s($q$select (advance_reconciliation_watermark('whish', now() - interval '8 days') = now() - interval '5 days')::text$q$) = 'true', null;
insert into t select 'W5 never beyond now (+5 minutes clock slack)',
  pg_temp.s($q$select advance_reconciliation_watermark('whish', now() + interval '1 hour')::text$q$) = 'ERR bad_watermark', null;
insert into t select 'W6 rewinding (recovery by hand) moves back only',
  pg_temp.s($q$select (rewind_reconciliation_watermark('whish', now() - interval '7 days') = now() - interval '7 days')::text$q$) = 'true'
  and pg_temp.s($q$select (rewind_reconciliation_watermark('whish', now() - interval '1 day') = now() - interval '7 days')::text$q$) = 'true', null;
insert into t select 'W7 visitors, players, desks and admins can neither read nor move the watermark',
  pg_temp.as_('anon', null, $q$select initialise_reconciliation_watermark('areeba', now())::text$q$) ~ '^ERR permission denied'
  and pg_temp.as_('authenticated', pg_temp.u(1), $q$select advance_reconciliation_watermark('whish', now())::text$q$) ~ '^ERR permission denied'
  and pg_temp.as_('authenticated', pg_temp.u(2), $q$select rewind_reconciliation_watermark('whish', now() - interval '30 days')::text$q$) ~ '^ERR permission denied'
  and pg_temp.as_('authenticated', pg_temp.u(3), $q$select rewind_reconciliation_watermark('whish', now() - interval '30 days')::text$q$) ~ '^ERR permission denied'
  and pg_temp.as_('authenticated', pg_temp.u(3), $q$select count(*)::text from payment_reconciliation$q$) ~ '^ERR permission denied'
  and (select reconciled_until = now() - interval '7 days' from payment_reconciliation where provider = 'whish'), null;

-- ------------------------------------------------------------------ I issues: kept until a person resolves them
select pg_temp.keep('i_rec', pg_temp.s($q$select record_reconciliation_issue('whish', ' R-1 ', 'ext-1', 5, ' usd ', 'charge_evidence_conflict')$q$));
insert into t select 'I1 contradictory evidence is recorded open (reference trimmed, currency upper-case)',
  pg_temp.got('i_rec') = 'open' and pg_temp.issue('R-1') is not null
  and (select currency = 'USD' and seen = 1 from payment_reconciliation_issues where id = pg_temp.issue('R-1')), pg_temp.got('i_rec');
-- (an action and the check of its effect are separate statements: a statement does not see what a function it calls wrote)
select pg_temp.keep('i_again', pg_temp.s($q$select record_reconciliation_issue('whish', 'R-1', 'ext-1', 5, 'USD', 'charge_evidence_conflict')$q$));
insert into t select 'I2 seen again before anyone resolves it: still open, counted',
  pg_temp.got('i_again') = 'open'
  and (select seen = 2 from payment_reconciliation_issues where id = pg_temp.issue('R-1')), null;
insert into t select 'I3 players and desks cannot see issues; the admin can',
  pg_temp.as_('authenticated', pg_temp.u(1), $q$select count(*)::text from payment_reconciliation_issues$q$) = '0'
  and pg_temp.as_('authenticated', pg_temp.u(2), $q$select count(*)::text from payment_reconciliation_issues$q$) = '0'
  and pg_temp.as_('authenticated', pg_temp.u(3), $q$select count(*)::text from payment_reconciliation_issues$q$) = '1'
  and pg_temp.as_('anon', null, $q$select count(*)::text from payment_reconciliation_issues$q$) ~ '^ERR permission denied', null;
insert into t select 'I4 no one but the server records issues; signed-in people cannot write the table',
  pg_temp.as_('authenticated', pg_temp.u(3), $q$select record_reconciliation_issue('whish', 'R-9', null, 1, 'USD', 'charge_evidence_conflict')$q$) ~ '^ERR permission denied'
  and pg_temp.as_('authenticated', pg_temp.u(3), format('update payment_reconciliation_issues set resolution = %L, resolved_at = now() where id = %L', 'x', pg_temp.issue('R-1'))) ~ '^ERR permission denied', null;
insert into t select 'I5 only an admin resolves, and only with a written resolution',
  pg_temp.as_('authenticated', pg_temp.u(1), format('select resolve_reconciliation_issue(%L, %L)', pg_temp.issue('R-1'), 'ok')) = 'ERR forbidden'
  and pg_temp.as_('authenticated', pg_temp.u(2), format('select resolve_reconciliation_issue(%L, %L)', pg_temp.issue('R-1'), 'ok')) = 'ERR forbidden'
  and pg_temp.as_('anon', null, format('select resolve_reconciliation_issue(%L, %L)', pg_temp.issue('R-1'), 'ok')) ~ '^ERR permission denied'
  and pg_temp.as_('authenticated', pg_temp.u(3), format('select resolve_reconciliation_issue(%L, %L)', pg_temp.issue('R-1'), '  ')) = 'ERR resolution_required'
  and (select resolved_at is null from payment_reconciliation_issues where id = pg_temp.issue('R-1')), null;
select pg_temp.keep('i_res', pg_temp.as_('authenticated', pg_temp.u(3), format('select resolve_reconciliation_issue(%L, %L)', pg_temp.issue('R-1'), 'refunded by hand, ref X')));
insert into t select 'I6 the admin resolves it: who and when recorded; a second resolve says already_resolved',
  pg_temp.got('i_res') = 'resolved'
  and (select resolved_by = pg_temp.u(3) and resolution = 'refunded by hand, ref X' from payment_reconciliation_issues where id = pg_temp.issue('R-1'))
  and pg_temp.as_('authenticated', pg_temp.u(3), format('select resolve_reconciliation_issue(%L, %L)', pg_temp.issue('R-1'), 'again')) = 'already_resolved', pg_temp.got('i_res');
select pg_temp.keep('i_same', pg_temp.s($q$select record_reconciliation_issue('whish', 'R-1', 'ext-1', 5, 'USD', 'charge_evidence_conflict')$q$));
insert into t select 'I7 the same evidence again keeps the resolution (counted, not reopened)',
  pg_temp.got('i_same') = 'resolved'
  and (select resolved_at is not null and reopened = 0 and seen = 3 from payment_reconciliation_issues where id = pg_temp.issue('R-1')), null;
select pg_temp.keep('i_diff', pg_temp.s($q$select record_reconciliation_issue('whish', 'R-1', 'ext-1', 7, 'USD', 'charge_evidence_conflict')$q$));
insert into t select 'I8 different evidence for the same transaction reopens it; the overturned resolution is kept',
  pg_temp.got('i_diff') = 'open'
  and (select resolved_at is null and resolution is null and resolved_by is null and reopened = 1 and amount = 7
          and last_resolution = 'refunded by hand, ref X' from payment_reconciliation_issues where id = pg_temp.issue('R-1')), null;
insert into t select 'I9 resolving a missing issue says not_found',
  pg_temp.as_('authenticated', pg_temp.u(3), format('select resolve_reconciliation_issue(%L, %L)', pg_temp.u(99), 'x')) = 'ERR not_found', null;

-- ------------------------------------------------------------------ H health reading (server only)
insert into t select 'H1 health counts open issues and reports the watermark; only the server may read it',
  pg_temp.s($q$select open_issues::text from payment_reconciliation_health('whish', '24 hours')$q$)::int = (select count(*) from payment_reconciliation_issues where resolved_at is null)
  and pg_temp.s($q$select (reconciled_until = now() - interval '7 days')::text from payment_reconciliation_health('whish', '24 hours')$q$) = 'true'
  and pg_temp.as_('authenticated', pg_temp.u(3), $q$select open_issues::text from payment_reconciliation_health('whish', '24 hours')$q$) ~ '^ERR permission denied', null;
insert into t select 'H2 an unknown provider is refused by the tables (no stray watermark or issue)',
  pg_temp.s($q$select initialise_reconciliation_watermark('stripe', now() - interval '1 day')::text$q$) ~ '^ERR .*check constraint'
  and pg_temp.s($q$select record_reconciliation_issue('stripe', 'R-2', null, 1, 'USD', 'charge_evidence_conflict')$q$) ~ '^ERR .*check constraint', null;

insert into t select 'Z1 all 18 checks ran', (select count(*) from t) = 18, (select count(*) from t)::text;
select case when coalesce(pass, false) then 'ok   ' else 'FAIL ' end || id || case when coalesce(pass, false) then '' else '  [' || coalesce(detail, '') || ']' end from t order by id;
select format('%s checks, %s failed', count(*), count(*) filter (where not coalesce(pass, false))) from t;
rollback;
