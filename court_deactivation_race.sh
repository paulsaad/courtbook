#!/usr/bin/env bash
# Booking vs court deactivation under real concurrency (0092, review 24 Nov), on a scratch copy of the local replica,
# dropped after. LOCAL ONLY.
#   PSQL="sudo -u postgres psql" PG_MODULE=/tmp/pgdeps/node_modules bash supabase/tests/races/court_deactivation_race.sh
# CONTROL=1 removes 0092's bookings_need_active_court to show the suite sees the race (the "ba" runs must fail).
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
SRC=courtbook_test; DB=courtbook_offrace
where=$($PSQL -At -d $SRC -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
if [ -n "${CONTROL:-}" ]; then
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -c "drop trigger bookings_need_active_court on bookings" || exit 2
  echo "CONTROL: bookings_need_active_court removed"
fi
sudo -u postgres env PG_MODULE="${PG_MODULE:-/tmp/pgdeps/node_modules}" DB="postgresql:///$DB?host=/var/run/postgresql" node supabase/tests/races/court_deactivation_race.mjs
