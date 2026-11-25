#!/usr/bin/env bash
# 0096: the service fee must be whole cents, refused (never rounded) in the database, for every writer. LOCAL ONLY.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/payments/fee_whole_cents.sh
# Each case runs in a rolled-back transaction on courtbook_test. The control (W9) applies the rollback of 0096 in a
# scratch copy and shows the old column silently rounding, so the checks above are known to detect the problem.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
where=$($PSQL -At -d courtbook_test -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
ADMIN=33333333-3333-3333-3333-333333333333
status=0
q() { # db, sql → output (errors folded into the output as "ERR <sqlstate-ish text>")
  printf '%s\n' "\\set VERBOSITY terse" "begin;" "$2" "rollback;" | $PSQL -d "$1" -X -q -At -v ON_ERROR_STOP=1 2>&1 | sed 's/^.*ERROR:  /ERR /'
}
check() { # name, got, expected regex
  if echo "$2" | grep -Eq "$3"; then echo "ok   $1"; else echo "FAIL $1"; echo "     got: $(echo "$2" | tr '\n' ' ')"; status=1; fi
}
as_admin="set local role authenticated; select set_config('request.jwt.claim.sub','$ADMIN',true);"
fee() { echo "select service_fee_usd::text from clubs where slug = 'batroun';"; }

check "W1 a sub-cent fee is refused for the database owner too (no rounding)" \
  "$(q courtbook_test "update clubs set service_fee_usd = 0.255 where slug = 'batroun';")" "ERR .*clubs_service_fee_whole_cents"
check "W2 an admin through the API rules (RLS): 0.255 refused" \
  "$(q courtbook_test "$as_admin update clubs set service_fee_usd = 0.255 where slug = 'batroun';")" "ERR .*clubs_service_fee_whole_cents"
check "W3 an admin through the API rules: 0.25 stored exactly" \
  "$(q courtbook_test "$as_admin update clubs set service_fee_usd = 0.25 where slug = 'batroun'; $(fee)")" "^0\.25$"
for v in 0 1 1.10 9999.99; do
  check "W4 whole cents accepted: $v" "$(q courtbook_test "update clubs set service_fee_usd = $v where slug = 'batroun'; select (service_fee_usd = $v)::text from clubs where slug = 'batroun';")" "^true$"
done
for v in 0.001 1.005 0.0000001 10000 -0.01; do
  check "W5 refused: $v" "$(q courtbook_test "update clubs set service_fee_usd = $v where slug = 'batroun';")" "^ERR .*(clubs_service_fee_whole_cents|service_fee_usd_check)"
done
check "W6 a new club with a sub-cent fee is refused" \
  "$(q courtbook_test "insert into clubs (name, slug, service_fee_usd) values ('X', 'x-cents', 0.255);")" "ERR .*clubs_service_fee_whole_cents"
check "W7 a fee written as text with extra zeros is still whole cents" \
  "$(q courtbook_test "update clubs set service_fee_usd = '0.2500'::numeric where slug = 'batroun'; select (service_fee_usd = 0.25)::text from clubs where slug = 'batroun';")" "^true$"
check "W8 the column is plain numeric with the whole-cent check" \
  "$($PSQL -d courtbook_test -At -c "select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'clubs'::regclass and attname = 'service_fee_usd'; select count(*) from pg_constraint where conname = 'clubs_service_fee_whole_cents';" | tr '\n' ' ')" "^numeric 1 $"

# W9 control and rollback: in a scratch copy, 0096's rollback restores the old behaviour (0.255 silently becomes 0.26),
# existing fees survive the round trip, and 0096 applies again cleanly.
S=courtbook_cents_ctl
$PSQL -q -d postgres -c "drop database if exists $S" -c "create database $S template courtbook_test" >/dev/null 2>&1 || { echo "could not make the scratch copy"; exit 2; }
trap '$PSQL -q -d postgres -c "drop database if exists courtbook_cents_ctl" >/dev/null 2>&1' EXIT
before=$($PSQL -d $S -At -c "select string_agg(slug || '=' || service_fee_usd, ',' order by slug) from clubs")
$PSQL -d $S -q -v ON_ERROR_STOP=1 -f supabase/rollback/0096_down.sql >/dev/null 2>&1 || { echo "FAIL W9 rollback did not apply"; status=1; }
check "W9a control: without 0096 the old column rounds 0.255 to 0.26 silently (what 0096 prevents)" \
  "$(q $S "update clubs set service_fee_usd = 0.255 where slug = 'batroun'; $(fee)")" "^0\.26$"
check "W9b rollback keeps every existing fee" "$($PSQL -d $S -At -c "select string_agg(slug || '=' || service_fee_usd, ',' order by slug) from clubs")" "^$(echo "$before" | sed 's/\./\\./g')$"
$PSQL -d $S -q -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0096_service_fee_whole_cents.sql >/dev/null 2>&1 || { echo "FAIL W9c 0096 did not re-apply"; status=1; }
check "W9c 0096 re-applies after its rollback and refuses again" \
  "$(q $S "update clubs set service_fee_usd = 0.255 where slug = 'batroun';")" "ERR .*clubs_service_fee_whole_cents"

[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
