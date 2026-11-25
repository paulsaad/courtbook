#!/usr/bin/env bash
# Deletion vs booking-attempt lock order on the M12 chain (deletion_lock_order.mjs): the pilot's 0093 refusal in
# book_at_desk and the same refusal in 0094's hold_slot, at a fee_online club too. Scratch copy of the local test
# database, dropped after. LOCAL ONLY.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/races/deletion_lock_order.sh
# CONTROL=1: remove the refusal line from hold_slot and book_at_desk in the copy (each otherwise exactly as installed),
# to show the suite sees the deadlock without it.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
SRC=courtbook_test; DB=courtbook_lockorder
where=$($PSQL -At -d $SRC -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
# MUTANT=close_without_profile_lock: closing no longer takes the profile row first; the ordering check must then fail
if [ "${MUTANT:-}" = close_without_profile_lock ]; then
  $PSQL -At -d $DB -c "select pg_get_functiondef('close_account_internal(uuid,text)'::regprocedure)" \
    | sed 's/perform 1 from profiles where id = p_subject for update;/perform 1 from profiles where id = p_subject;  -- mutant: read without the lock/' | $PSQL -q -d $DB -v ON_ERROR_STOP=1 >/dev/null || exit 2
  echo "MUTANT: close_account_internal without its profile lock"
fi
if [ -n "${CONTROL:-}" ]; then
  for f in 'hold_slot(uuid,uuid,timestamptz,timestamptz,uuid)' 'book_at_desk(uuid,timestamptz,timestamptz,uuid)'; do
    def=$($PSQL -At -d $DB -c "select pg_get_functiondef('$f'::regprocedure)")
    [ "$(echo "$def" | grep -c "if deletion_requested(v_player) then raise exception 'account_closed'; end if;")" = 1 ] || { echo "CONTROL: refusal line not found once in $f"; exit 2; }
    echo "$def" | sed "/if deletion_requested(v_player) then raise exception 'account_closed'; end if;/d" | $PSQL -q -d $DB -v ON_ERROR_STOP=1 >/dev/null || exit 2
  done
  echo "CONTROL: hold_slot and book_at_desk without the closed-account refusal"
fi
sudo -u postgres env CONTROL="${CONTROL:-}" MUTANT="${MUTANT:-}" N="${N:-60}" PG_MODULE="${PG_MODULE:-/tmp/pgdeps/node_modules}" DB="postgresql:///$DB?host=/var/run/postgresql" node supabase/tests/races/deletion_lock_order.mjs
