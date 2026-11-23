#!/usr/bin/env bash
# Records what 0086 answers to the exact calls the RELEASED app makes (mobile/components/DeleteAccount.tsx at ed68d21:
# my_account_deletion(), request_account_deletion({ p_via: "app" }), cancel_account_deletion()), for the app test that
# runs that released screen against them (mobile/__tests__/oldAppCompat.test.tsx). Local replica only, one rolled-back
# transaction. Writes mobile/__tests__/fixtures/old_app_answers.json (dates replaced by a fixed value).
#   PSQL="sudo -u postgres psql" bash supabase/tests/m86/old_app_answers.sh
set -eu
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
out=$($PSQL -X -q -At -d courtbook_test -v ON_ERROR_STOP=1 <<'SQL'
begin;
insert into auth.users (id, phone) values ('e8600000-0000-4000-8000-0000000000c1', '+96178600c1');
update profiles set rules_accepted_at = now() where id = 'e8600000-0000-4000-8000-0000000000c1';
update clubs set payment_mode = 'simulated', cancel_cutoff_hours = 6 where slug = 'batroun';   -- so a booking attempt reaches the lock-out
create temp table a (k text, v jsonb, err text); grant all on a to authenticated;
-- an old app's session: signed in a month ago (its refresh keeps the old sign-in time)
select set_config('request.jwt.claim.sub', 'e8600000-0000-4000-8000-0000000000c1', true);
select set_config('request.jwt.claims', json_build_object('sub', 'e8600000-0000-4000-8000-0000000000c1', 'amr', json_build_array(json_build_object('method', 'otp', 'timestamp', extract(epoch from now() - interval '30 days')::bigint)))::text, true);
set local role authenticated;
do $$
declare r jsonb;
begin
  insert into a select 'mine_before', my_account_deletion(), null;
  insert into a select 'request', request_account_deletion(p_via => 'app'), null;
  insert into a select 'mine_requested', my_account_deletion(), null;
  begin perform hold_slot((select id from clubs where slug = 'batroun'), (select id from courts where club_id = (select id from clubs where slug = 'batroun') and active order by sort limit 1),
          now() + interval '3 days', now() + interval '3 days 1 hour', gen_random_uuid()); insert into a values ('booking_while_requested', null, 'allowed');
  exception when others then insert into a values ('booking_while_requested', null, sqlerrm); end;
  perform cancel_account_deletion(); insert into a values ('cancel', null, 'ok');
  insert into a select 'mine_after_cancel', my_account_deletion(), null;
  insert into a select 'request_again', request_account_deletion(p_via => 'app'), null;
end $$;
reset role;
-- 24 hours later the worker promotes it (service key)
update account_deletions set requested_at = now() - interval '25 hours' where subject_id = 'e8600000-0000-4000-8000-0000000000c1' and status = 'requested';
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;
select promote_due_requests();
reset role;
select set_config('request.jwt.claim.sub', 'e8600000-0000-4000-8000-0000000000c1', true);
set local role authenticated;
do $$ begin
  insert into a select 'mine_promoted', my_account_deletion(), null;
  begin perform cancel_account_deletion(); insert into a values ('cancel_after_promotion', null, 'ok');
  exception when others then insert into a values ('cancel_after_promotion', null, sqlerrm); end;
  insert into a select 'request_after_promotion', request_account_deletion(p_via => 'app'), null;
end $$;
reset role;
select json_object_agg(k, coalesce(v, to_jsonb(err))) from a;
rollback;
SQL
)
json=$(echo "$out" | grep '^{' | tail -1)
echo "$json" | python3 -c '
import json,re,sys
d=json.load(sys.stdin)
s=json.dumps(d, indent=2, sort_keys=True)
s=re.sub(r"\"20\d\d-\d\d-\d\dT[^\"]*\"", "\"2026-11-23T10:00:00+00:00\"", s)
open("mobile/__tests__/fixtures/old_app_answers.json","w").write(s+"\n")
print(s)'
