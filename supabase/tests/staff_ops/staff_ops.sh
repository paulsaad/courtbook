#!/usr/bin/env bash
# Staff operations (audit 24 Nov). LOCAL REPLICA ONLY; one transaction, rolled back.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/staff_ops/staff_ops.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
where=$($PSQL -At -d courtbook_test -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
out=$($PSQL -d courtbook_test -X -q -At ${CONTROL:+-v control=1} -f supabase/tests/staff_ops/staff_ops_tests.sql 2>&1)
echo "$out" | grep -v "^$"
echo "$out" | grep -qE "^(FAIL|psql)|ERROR" && { echo "RESULT: FAIL"; exit 1; }
echo "RESULT: PASS"
