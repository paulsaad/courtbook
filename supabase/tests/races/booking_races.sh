#!/usr/bin/env bash
# Booking safety under real concurrency (booking_races.mjs) on a scratch copy of the local replica, dropped after.
# FEE=1 runs it at a fee_online club (M12.1). LOCAL ONLY.  PSQL="sudo -u postgres psql" PG_MODULE=/tmp/pgdeps/node_modules bash supabase/tests/races/booking_races.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
SRC=courtbook_test; DB=courtbook_races
where=$($PSQL -At -d $SRC -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
# CONTROL=1: put back the trigger as it was before 0090, to show the suite sees the defect (S6/S6a must fail)
if [ -n "${CONTROL:-}" ]; then
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 <<'SQL' || exit 2
create or replace function reject_booking_over_block() returns trigger language plpgsql as $f$
begin
  if new.court_id is null or new.status not in ('confirmed', 'pending') then return new; end if;
  perform 1 from courts where id = new.court_id for update;
  perform expire_stale_holds(new.court_id);
  if exists (select 1 from blocks b where b.court_id = new.court_id and b.period && tstzrange(new.start_at, new.end_at, '[)')) then
    raise exception 'slot_blocked' using errcode = '23P01';
  end if;
  return new;
end $f$;
SQL
  echo "CONTROL: trigger as before 0090"
fi
sudo -u postgres env FEE="${FEE:-}" PG_MODULE="${PG_MODULE:-/tmp/pgdeps/node_modules}" DB="postgresql:///$DB?host=/var/run/postgresql" node supabase/tests/races/booking_races.mjs
