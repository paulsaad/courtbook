#!/usr/bin/env bash
# Contract check: the app's row types (mobile/lib/gameTypes.ts) name exactly the columns, in order, that
# the database functions return on the local replica, and the app's write calls (mobile/lib/gameActions.ts)
# use exactly the functions' argument names. Catches drift when a migration changes a
# function's `returns table (...)` without the app type following (or the reverse).
#
# LOCAL REPLICA ONLY (read-only queries against courtbook_test).
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh       # builds courtbook_test
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/row_types.sh
PSQL=${PSQL:-psql}
DB=courtbook_test
TS=mobile/lib/gameTypes.ts
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac

# keys of `export type <Name> = { ... };` in declaration order
ts_keys() {
  awk -v t="$1" '
    $0 ~ "^export type " t " = \\{" {on=1; next}
    on && /^};/ {exit}
    on {print}' "$TS" | grep -oE '[a-z_]+\??:' | tr -d '?:' | tr '\n' ' '
}
# output columns of a function, in order
db_cols() {
  $PSQL -At -d $DB -c "select string_agg(n, ' ' order by i) from pg_proc p,
    unnest(p.proargnames, p.proargmodes) with ordinality as a(n, m, i)
    where p.proname = '$1' and p.pronamespace = 'public'::regnamespace and m = 't'"
}
fails=0
while read -r fn type; do
  want=$(db_cols "$fn"); have=$(ts_keys "$type" | sed 's/ $//')
  if [ -z "$want" ]; then echo "FAIL  $fn: not on the replica"; fails=$((fails+1))
  elif [ "$want" = "$have" ]; then echo "ok    $fn ↔ $type ($(echo $want | wc -w) columns)"
  else echo "FAIL  $fn ↔ $type"; echo "      db:  $want"; echo "      app: $have"; fails=$((fails+1)); fi
done <<MAP
open_matches OpenGameRow
match_board ClubGameRow
match_detail GameDetail
match_participants ParticipantRow
MAP

# write functions: argument names, in order (mobile/lib/gameActions.ts GAME_RPC_ARGS)
ACT=mobile/lib/gameActions.ts
while IFS= read -r line; do
  fn=$(echo "$line" | sed -E 's/^ *([a-z_]+):.*/\1/'); have=$(echo "$line" | grep -oE '"p_[a-z_]+"' | tr -d '"' | tr '\n' ' ' | sed 's/ $//')
  want=$($PSQL -At -d $DB -c "select string_agg(n, ' ' order by i) from pg_proc p, unnest(p.proargnames) with ordinality as a(n, i)
    where p.proname = '$fn' and p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE')")
  if [ -z "$want" ] && echo "$line" | grep -q "// M3-H"; then echo "skip  $fn (M3-H draft; not on this replica)"
  elif [ "$want" = "$have" ]; then echo "ok    $fn($have)"
  else echo "FAIL  $fn"; echo "      db:  $want"; echo "      app: $have"; fails=$((fails+1)); fi
done < <(awk '/^export const GAME_RPC_ARGS = \{/ {on=1; next} on && /^\}/ {exit} on {print}' "$ACT")

[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL ($fails)"; exit 1; }
