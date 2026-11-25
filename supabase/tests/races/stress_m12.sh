#!/usr/bin/env bash
# Booking and payment stress (stress_m12.mjs) on a scratch copy of the local test database, dropped after. LOCAL ONLY.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/races/stress_m12.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
SRC=courtbook_test; DB=courtbook_stress
where=$($PSQL -At -d $SRC -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
sudo -u postgres env PG_MODULE="${PG_MODULE:-/tmp/pgdeps/node_modules}" DB="postgresql:///$DB?host=/var/run/postgresql" node supabase/tests/races/stress_m12.mjs
