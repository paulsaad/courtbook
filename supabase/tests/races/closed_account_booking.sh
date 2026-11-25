#!/usr/bin/env bash
# 0093 (pilot) race suite (closed_account_booking.mjs) on a scratch copy of the local test database, dropped after.
# LOCAL ONLY.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/races/closed_account_booking.sh
# CONTROL=all: 0093 rolled back in the copy (the old definitions) — the deadlock checks must then FAIL-by-design and the
#              control checks pass. CONTROL=rad: only request_account_deletion rolled back.
# The copy gets a test-only gate in book_at_desk and hold_slot (an advisory-lock wait, active only when the session sets
# test.gate) at three points: before the profile lock, after it, and right before lock_courts. Nothing else changes.
# MUTANT=unlocked: the check moved before the profile lock; O6 must then FAIL.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
SRC=courtbook_test; DB=courtbook_closedbook
where=$($PSQL -At -d $SRC -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null 2>&1 || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists courtbook_closedbook" >/dev/null 2>&1' EXIT
case "${CONTROL:-}" in
  all) $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0093_down.sql >/dev/null || exit 2; echo "CONTROL: 0093 rolled back";;
  rad) python3 - <<'PY' | $PSQL -q -d $DB -v ON_ERROR_STOP=1 >/dev/null || exit 2
s=open("supabase/rollback/0093_down.sql").read()
i=s.index("create or replace function request_account_deletion("); print(s[i:])
PY
       echo "CONTROL: only request_account_deletion rolled back";;
  "") ;;
  *) echo "CONTROL must be all or rad"; exit 2;;
esac
# the test gate (scratch copy only)
for sig in 'book_at_desk(uuid,timestamptz,timestamptz,uuid)' 'hold_slot(uuid,uuid,timestamptz,timestamptz,uuid)'; do
  $PSQL -At -d $DB -c "select pg_get_functiondef('$sig'::regprocedure)" | MUTANT="${MUTANT:-}" python3 -c '
import sys
s=sys.stdin.read()
import os
lock="perform 1 from profiles where id = v_player for update;"
assert s.count(lock)==1, "profile lock not found"
if os.environ.get("MUTANT") == "unlocked":   # the check moved BEFORE the profile lock (what review 25 Nov rules out)
    chk="if deletion_requested(v_player) then raise exception $$account_closed$$; end if;"
    chk0="if deletion_requested(v_player) then raise exception \x27account_closed\x27; end if;"
    assert s.count(chk0)==1, "check not found"
    s=s.replace(chk0, "-- mutant: check moved")
    s=s.replace(lock, chk+"\n  "+lock)
s=s.replace(lock, "if current_setting($$test.gate$$, true) = $$before_lock$$ then perform pg_advisory_xact_lock_shared(4242); end if;\n  "+lock
            +"\n  if current_setting($$test.gate$$, true) = $$after_lock$$ then perform pg_advisory_xact_lock_shared(4242); end if;")
i=s.index("perform lock_courts(")
s=s[:i]+"if current_setting($$test.gate$$, true) = $$after_check$$ then perform pg_advisory_xact_lock_shared(4242); end if;\n  "+s[i:]
print(s+";")' | $PSQL -q -d $DB -v ON_ERROR_STOP=1 >/dev/null || { echo "could not add the test gate to $sig"; exit 2; }
done
[ "${MUTANT:-}" = unlocked ] && echo "MUTANT: the closed-account check moved before the profile lock"
sudo -u postgres env CONTROL="${CONTROL:-}" MUTANT="${MUTANT:-}" N="${N:-60}" PG_MODULE="${PG_MODULE:-/tmp/pgdeps/node_modules}" DB="postgresql:///$DB?host=/var/run/postgresql" node supabase/tests/races/closed_account_booking.mjs
