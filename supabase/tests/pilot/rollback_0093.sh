#!/usr/bin/env bash
# 0093 (pilot) rollback round trip on a scratch copy of the local test database, dropped after. LOCAL ONLY.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/pilot/rollback_0093.sh
# After the rollback the three functions are byte for byte their previous definitions (book_at_desk's fingerprint is
# the one staging reported before any lock-order change: f199829493c2fc40ef9080b10649d88c); grants are unchanged;
# re-applying 0093 gives back exactly the same definitions.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
SRC=courtbook_test; DB=courtbook_rb93
where=$($PSQL -At -d $SRC -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null 2>&1 || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists courtbook_rb93" >/dev/null 2>&1' EXIT
status=0
ok() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got '$2', expected '$3')"; status=1; fi; }
fp() { $PSQL -At -d $DB -c "select string_agg(proname || '=' || md5(prosrc), ' ' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('book_at_desk', 'hold_slot', 'request_account_deletion')"; }
grants() { $PSQL -At -d $DB -c "select string_agg(p.proname || ':' || r || '=' || has_function_privilege(r, p.oid, 'execute'), ' ' order by p.proname, r) from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r where p.pronamespace = 'public'::regnamespace and p.proname in ('book_at_desk', 'hold_slot', 'request_account_deletion')"; }
checked() { $PSQL -At -d $DB -c "select count(*) from pg_proc where pronamespace = 'public'::regnamespace and ((proname in ('book_at_desk', 'hold_slot') and position('if deletion_requested(v_player) then raise exception ''account_closed''; end if;' in prosrc) between 1 and position('perform lock_courts(' in prosrc)) or (proname = 'request_account_deletion' and prosrc like '%from profiles where id = auth.uid() for update%'))"; }
after=$(fp); g=$(grants)
ok "with 0093: the check before lock_courts in book_at_desk and hold_slot; the profile lock in request_account_deletion" "$(checked)" 3
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0093_down.sql >/dev/null || { echo "FAIL rollback did not apply"; exit 1; }
ok "rollback: none of the three changes remains" "$(checked)" 0
ok "rollback: book_at_desk is byte for byte the release candidate's (staging fingerprint)" \
  "$($PSQL -At -d $DB -c "select md5(prosrc) from pg_proc where proname = 'book_at_desk' and pronamespace = 'public'::regnamespace")" f199829493c2fc40ef9080b10649d88c
ok "rollback: grants unchanged" "$(grants)" "$g"
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0093_closed_account_booking_lock_order.sql >/dev/null || { echo "FAIL 0093 did not re-apply"; exit 1; }
ok "re-applied: exactly the same three definitions" "$(fp)" "$after"
ok "re-applied: grants unchanged" "$(grants)" "$g"
[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
