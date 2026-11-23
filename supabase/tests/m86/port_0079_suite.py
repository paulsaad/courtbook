s=open('supabase/tests/m2/deletion_tests.sql').read()
R=[]
def r(old,new,n=1): R.append((old,new,n))
r("-- M2 tests: account deletion (0079). Run by deletion.sh inside one transaction that is rolled back.\n-- psql variable :mig is the migration file under test.",
  "-- M2 tests for 0086, PORTED from supabase/tests/m2/deletion_tests.sql (0079). Every data-step check is kept word for word;\n-- the only edits are expectations 0086 changes on purpose (listed in supabase/tests/m86/PORTING.md; see `diff`). Run by\n-- deletion86.sh in one transaction that is rolled back. psql variable :mig is the migration file under test (0086).")
r("pg_temp.r(null, $$select request_account_deletion()::text$$) like 'ERR%'", "pg_temp.r(null, $$select close_my_account()::text$$) like 'ERR%'")
r("pg_temp.r(pg_temp.u(4), $$select request_account_deletion()::text$$) like 'ERR staff_role%'", "pg_temp.r(pg_temp.u(4), $$select close_my_account()::text$$) like 'ERR staff_role%'")
r("pg_temp.r(pg_temp.u(3), $$select request_account_deletion()::text$$) like 'ERR admin_role%'", "pg_temp.r(pg_temp.u(3), $$select close_my_account()::text$$) like 'ERR admin_role%'")
r("pg_temp.r(pg_temp.u(1), $$select request_account_deletion('support')::text$$) like 'ERR invalid_via%'", "pg_temp.r(pg_temp.u(1), $$select close_my_account('support')::text$$) like 'ERR invalid_via%'")
r("('A2 a player requests deletion', pg_temp.r(pg_temp.u(1), $$select request_account_deletion('web')->>'status'$$) = 'requested', '')",
  "('A2 a player closes their account', pg_temp.r(pg_temp.u(1), $$select close_my_account('web')->>'status'$$) = 'closing', '')")
r("('A2 requesting again returns the same request', pg_temp.r(pg_temp.u(1), $$select request_account_deletion()->>'status'$$) = 'requested', '')",
  "('A2 closing again returns the same record', pg_temp.r(pg_temp.u(1), $$select (close_my_account()->>'status') || '/' || (close_my_account()->>'new')$$) = 'closing/false', '')")
r("('A2 the person sees their request', pg_temp.r(pg_temp.u(1), $$select my_account_deletion()->>'status'$$) = 'requested', '')",
  "('A2 the person sees their account is closed', pg_temp.r(pg_temp.u(1), $$select (my_account_deletion()->>'status') || '/' || (my_account_deletion()->>'closed')$$) = 'closing/true', '')")
r("like 'ERR%account_deletion_requested%'", "like 'ERR%account_closed%'", 5)
r("format($$select delete_account_data(%L)::text$$, pg_temp.u(6))) like 'ERR legal_hold%'", "format($$select delete_account_data(%L)::text$$, pg_temp.u(6))) like 'ERR held: legal_hold%'")
r("('A7 coach with coach bookings: refused', pg_temp.r(pg_temp.u(5), $$select request_account_deletion()->>'status'$$) = 'requested'\n     and pg_temp.r(pg_temp.u(3), format($$select delete_account_data(%L)::text$$, pg_temp.u(5))) like 'ERR coach_has_bookings%', '')",
  "('A7 coach with coach bookings: held, refused', pg_temp.r(pg_temp.u(5), $$select close_my_account()->>'status'$$) = 'held'\n     and pg_temp.r(pg_temp.u(3), format($$select delete_account_data(%L)::text$$, pg_temp.u(5))) like 'ERR held: coach_has_bookings%', '')")
r("('A8 player 8 and player 9 request', pg_temp.r(pg_temp.u(8), $$select request_account_deletion()->>'status'$$) = 'requested'\n     and pg_temp.r(pg_temp.u(9), $$select request_account_deletion()->>'status'$$) = 'requested', '')",
  "('A8 player 8 and player 9 close', pg_temp.r(pg_temp.u(8), $$select close_my_account()->>'status'$$) = 'closing'\n     and pg_temp.r(pg_temp.u(9), $$select close_my_account()->>'status'$$) = 'closing', '')")
r("(select count(*) = 2 from account_deletions where subject_id in (pg_temp.u(8), pg_temp.u(9)) and status = 'requested')",
  "(select count(*) = 2 from account_deletions where subject_id in (pg_temp.u(8), pg_temp.u(9)) and status = 'closing')")
r("pg_temp.r(pg_temp.u(10), $$select request_account_deletion()->>'status'$$) = 'requested'", "pg_temp.r(pg_temp.u(10), $$select close_my_account()->>'status'$$) = 'closing'")
r("('C2 finishing twice is refused', pg_temp.r(pg_temp.u(3), format($$select finish_account_deletion(%L)::text$$, pg_temp.u(1))) like 'ERR no_removed_request%', '')",
  "('C2 finishing twice is fine (idempotent; 0086)', pg_temp.r(pg_temp.u(3), format($$select finish_account_deletion(%L)::text$$, pg_temp.u(1))) = 'ok', '')")
r("not has_function_privilege('anon', 'delete_account_data(uuid)', 'execute')", "not has_function_privilege('anon', 'delete_account_data(uuid, boolean)', 'execute')")
a=s.index("  ('A4 the person can cancel the request'"); b=s.index("-- ================= who may process =================")
R.append((s[a:b], '''  ('A4 no undo: players cannot cancel (D1)', pg_temp.r(pg_temp.u(1), $$select cancel_account_deletion()::text$$) like 'ERR%permission denied%', ''),
  ('A4 no undo: the old request function is not available either', pg_temp.r(pg_temp.u(1), $$select request_account_deletion()::text$$) like 'ERR%permission denied%', '');
insert into t values
  ('A4 the record is still closing', (select status = 'closing' from account_deletions where subject_id = pg_temp.u(1)), ''),
  ('A4 still locked out after the refused undo', pg_temp.r(pg_temp.u(1), $$select post_match((select id from clubs where slug = 'batroun'), 'padel', now() + interval '4 days', now() + interval '4 days 90 min', null, null, 3, 'm2 after cancel', null, 'open', gen_random_uuid())::text$$) like 'ERR%account_closed%', '');
-- clean up A3 side effects (player 2's hold)
delete from payments where booking_id in (select id from bookings where player_id = pg_temp.u(2) and start_at = pg_temp.at(7, 6));
delete from bookings where player_id = pg_temp.u(2) and start_at = pg_temp.at(7, 6);
insert into t values ('A4 closing again: still one record', pg_temp.r(pg_temp.u(1), $$select close_my_account()->>'new'$$) = 'false', '');
insert into t values ('A4 one record only', (select count(*) = 1 from account_deletions where subject_id = pg_temp.u(1)), '');

''', 1))
for old,new,n in R:
    c=s.count(old)
    assert c==n, (c,n,old[:90])
    s=s.replace(old,new)
open('supabase/tests/m86/ported_0079_tests.sql','w').write(s)
print("ported with", len(R), "named replacements")
