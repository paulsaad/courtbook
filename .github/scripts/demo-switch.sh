#!/usr/bin/env bash
# Sets the hide_demo_clubs switch (staging only), then runs supabase/live/demo_switch_check.sql.
# If the check fails, the switch is put back exactly as it was (row absent, or its old value) and the job fails.
#   demo-switch.sh <db url> on|off
set -uo pipefail
db=$1; case $2 in on) new=true ;; off) new=false ;; *) echo "::error::usage: demo-switch.sh <db> on|off"; exit 2 ;; esac
prev=$(psql "$db" -X -v ON_ERROR_STOP=1 -At -c "select coalesce((select value from app_settings where key = 'hide_demo_clubs'), '<absent>')") \
  || { echo "::error::could not read the switch; nothing was changed"; exit 1; }
echo "hide_demo_clubs before: $prev; setting: $new"
psql "$db" -X -v ON_ERROR_STOP=1 -q -c "insert into app_settings (key, value) values ('hide_demo_clubs', '$new') on conflict (key) do update set value = '$new'" \
  || { echo "::error::could not set the switch; nothing was changed"; exit 1; }
if bash "$(dirname "$0")/run-check.sh" "$db" supabase/live/demo_switch_check.sql all; then exit 0; fi
if [ "$prev" = "<absent>" ]; then restore="delete from app_settings where key = 'hide_demo_clubs'"
else restore="update app_settings set value = '$prev' where key = 'hide_demo_clubs'"; fi
if psql "$db" -X -v ON_ERROR_STOP=1 -q -c "$restore"; then
  now=$(psql "$db" -X -At -c "select coalesce((select value from app_settings where key = 'hide_demo_clubs'), '<absent>')")
  echo "::error::switch check failed; hide_demo_clubs put back to: $now (was $prev)"
else
  echo "::error::switch check failed AND putting the switch back failed: hide_demo_clubs may be '$new' (was $prev). Run the opposite action."
fi
exit 1
