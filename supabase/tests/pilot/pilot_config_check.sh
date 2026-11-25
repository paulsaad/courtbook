#!/usr/bin/env bash
# Checks the read-only pilot configuration check (supabase/live/pilot_config_check.sql) on the local replica,
# inside rolled-back transactions. LOCAL ONLY (refuses any database but the local courtbook_test).
#   bash supabase/tests/pilot/pilot_config_check.sh
# Test set-up only (all rolled back): existing clubs are unpublished; the publish guard, the payment foreign keys and
# 0070's demo-only rule for 'simulated' are lifted so that bare clubs and payments can be made directly.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_test
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where'"; exit 2;; esac
status=0
run() { # $1 = SQL set-up, $2 = optional psql option (e.g. "-v mode=prep"); prints the check's rows
  { echo "begin;"
    echo "alter table clubs disable trigger user;"
    echo "alter table payments drop constraint if exists payments_booking_id_fkey, drop constraint if exists payments_profile_id_fkey;"
    echo "alter table payments disable trigger user;"
    echo "update clubs set active = false;"
    # 0070 already forbids 'simulated' outside demo clubs; lifted here (rolled back) so that the check's own rule is
    # tested. On trees with 0093 the real case is 'fee_online', which this rule covers the same way.
    echo "alter table clubs drop constraint if exists clubs_simulated_only_demo;"
    echo "$1"
    cat supabase/live/pilot_config_check.sql
    echo "rollback;"
  } | $PSQL -d $DB -X -q -At -F '|' -v ON_ERROR_STOP=1 ${2:-} 2>&1
}
club() { # slug active mode fee demo
  echo "insert into clubs (name, slug, active, payment_mode, service_fee_usd, is_demo, town_id) values ('$1', '$1', $2, '$3', $4, $5, (select id from towns limit 1));"
}
pay() { # club slug, status, age
  echo "insert into payments (booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd, status, created_at)
        values (gen_random_uuid(), gen_random_uuid(), (select id from clubs where slug = '$1'), 'simulated', 20, 1, 21, '$2', now() - interval '$3');"
}
expect() { # name, output, expected (exact, newline-separated)
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; echo "  got:";  echo "$2" | sed 's/^/    /'; echo "  expected:"; echo "$3" | sed 's/^/    /'; status=1; fi
}

out=$(run "$(club p-desk true at_desk 0 false)")
expect "a published at-desk club with no fee: clean" "$out" "RESULT|||ok|0 block, 0 warn, 1 bookable clubs"

out=$(run "$(club p-desk true at_desk 0 false)
$(club p-sim true simulated 1 false)
$(club p-feedesk true at_desk 1 false)
$(club p-hidden-sim false simulated 1 false)
$(club p-demo true simulated 1 true)
$(club p-old false at_desk 0 false)
$(pay p-old pending '1 hour')
$(pay p-demo pending '1 hour')
$(pay p-desk paid '40 days')")
expect "online mode, a fee at the desk and an open payment are found; hidden, demo and old ones are not" "$out" \
"p-old|f|at_desk|block|open_online_payment
p-sim|t|simulated|block|not_at_desk
p-feedesk|t|at_desk|warn|fee_set_at_desk
p-old|f|at_desk|warn|online_payment_recent
RESULT|||block|2 block, 2 warn, 3 bookable clubs"

out=$(run "$(club p-desk true at_desk 0 false)
$(pay p-desk refunded '2 days')")
expect "a recent settled online payment is a warning, not a block" "$out" \
"p-desk|t|at_desk|warn|online_payment_recent
RESULT|||ok|0 block, 1 warn, 1 bookable clubs"

out=$(run "")
expect "verdict: nothing published yet blocks (a pilot cannot be ready without a bookable club)" "$out" \
"|||block|no_bookable_club
RESULT|||block|1 block, 0 warn, 0 bookable clubs"

out=$(run "" "-v mode=prep")
expect "preparation mode: nothing published yet is a warning, and the result is not a readiness verdict" "$out" \
"|||warn|no_bookable_club
RESULT|||prep-ok|0 block, 1 warn, 0 bookable clubs"

out=$(run "$(club p-sim true simulated 1 false)" "-v mode=prep")
expect "preparation mode still blocks on an online club" "$out" \
"p-sim|t|simulated|block|not_at_desk
RESULT|||block|1 block, 0 warn, 1 bookable clubs"

out=$(run "$(club p-desk true at_desk 0 false)" "-v mode=ready")
expect "an unknown mode is never ok" "$out" \
"|||block|unknown_mode
RESULT|||block|1 block, 0 warn, 1 bookable clubs"

# the check itself never writes: every statement in it is a select
if grep -iEq '^\s*(insert|update|delete|alter|create|drop|truncate|grant|revoke|copy|call|do)\b' supabase/live/pilot_config_check.sql; then
  echo "FAIL the check contains a writing statement"; status=1; else echo "ok   the check is select-only"; fi
[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
