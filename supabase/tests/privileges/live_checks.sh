#!/usr/bin/env bash
# Rehearsal of the table-privilege staging checks (supabase/live/privileges_preflight.sql and _postcheck.sql) on a
# local 0001–0093 database. LOCAL ONLY.   PSQL="sudo -u postgres psql" bash supabase/tests/privileges/live_checks.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}; DB=courtbook_priv_live
PRE=supabase/live/privileges_preflight.sql; POST=supabase/live/privileges_postcheck.sql
UP=docs/privileges/sql/table_privileges.draft.sql; DOWN=docs/privileges/sql/table_privileges.down.draft.sql
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
for f in $(ls supabase/migrations/*.sql | grep -v _table_privileges | sort); do $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "BUILD FAILED: $f"; exit 2; }; done
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
status=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/     /'; status=1; }
notok() { $PSQL -d $DB -X -At -F'|' -v ON_ERROR_STOP=1 -f "$1" 2>&1 | awk -F'|' '$2 != "t" {print $1}'; }
nrows() { $PSQL -d $DB -X -At -v ON_ERROR_STOP=1 -f "$1" 2>&1 | wc -l; }
run() { $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$1" >/dev/null 2>&1; }

r=$(notok $PRE); [ -z "$r" ] && ok "L1 preflight on 0001–0093: all $(nrows $PRE) rows ok" || bad "L1 preflight" "$r"
r=$(notok $POST); [ "$(echo "$r" | grep -c .)" = 3 ] && ok "L2 control: before the change the postcheck fails exactly its 3 privilege rows" || bad "L2 control" "$r"
$PSQL -q -d $DB -c "grant truncate on public.reports to authenticated" >/dev/null
r=$(notok $PRE); echo "$r" | grep -q "on exactly the 31 measured" && ok "L3 drift (one extra TRUNCATE on staging) stops the preflight" || bad "L3 drift" "$r"
$PSQL -q -d $DB -c "revoke truncate on public.reports from authenticated; revoke update on public.bookings from authenticated" >/dev/null
r=$(notok $PRE); echo "$r" | grep -q "exactly the 35 measured" && ok "L4 drift (one write privilege already gone) stops the preflight" || bad "L4 drift" "$r"
$PSQL -q -d $DB -c "grant update on public.bookings to authenticated" >/dev/null
[ -z "$(notok $PRE)" ] || bad "L4b back to the measured state"
run $UP || bad "L5 the draft applies"
r=$(notok $POST); [ -z "$r" ] && ok "L5 after the change: postcheck all $(nrows $POST) rows ok" || bad "L5 postcheck" "$r"
r=$(notok $PRE); [ -n "$r" ] && ok "L6 the preflight refuses a second application ($(echo "$r" | grep -c .) rows not ok)" || bad "L6 second application not refused"
run $DOWN || bad "L7 the rollback applies"
r=$(notok $PRE); [ -z "$r" ] && ok "L7 after the rollback the preflight is all ok again (the measured state is restored)" || bad "L7" "$r"
exit $status
