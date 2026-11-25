#!/usr/bin/env bash
# 0095 regression (deletion_lock_order.mjs) on a scratch copy of the local test database, dropped after. LOCAL ONLY.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/races/deletion_lock_order.sh
# CONTROL=1: put back hold_slot and book_at_desk as they were before 0095 (supabase/rollback/0095_down.sql) to show the
# suite sees the deadlock.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
SRC=courtbook_test; DB=courtbook_lockorder
where=$($PSQL -At -d $SRC -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
if [ -n "${CONTROL:-}" ]; then $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0095_down.sql >/dev/null || exit 2; echo "CONTROL: definitions before 0095"; fi
sudo -u postgres env CONTROL="${CONTROL:-}" N="${N:-60}" PG_MODULE="${PG_MODULE:-/tmp/pgdeps/node_modules}" DB="postgresql:///$DB?host=/var/run/postgresql" node supabase/tests/races/deletion_lock_order.mjs
