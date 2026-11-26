#!/usr/bin/env bash
# Payments optional at launch, and hold replacement against late provider answers (optional_tests.sql), then mutation
# checks: each deliberate mistake must make the suite fail. LOCAL ONLY (refuses any database but the local courtbook_test).
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/payments/optional.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
where=$($PSQL -At -d courtbook_test -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
T=courtbook_test
suite() { $PSQL -d $T -X -q -At -f supabase/tests/payments/optional_tests.sql 2>&1; }
out=$(suite)
echo "$out" | grep -v "^$"
status=PASS
echo "$out" | grep -qE "^(FAIL|psql)|ERROR" && status=FAIL
[ "$(echo "$out" | grep -c '^ok ')" -eq 14 ] || { echo "expected 14 checks"; status=FAIL; }

echo "== mutation checks (each mutant must make the suite fail)"
# Each mutant changes ONE function as its latest migration defines it (or runs one statement), in a scratch copy.
T=courtbook_opt_mut
fresh() { $PSQL -q -d postgres -c "drop database if exists $T" -c "create database $T template courtbook_test" >/dev/null || { echo "could not make the scratch copy"; exit 2; }; }
trap '$PSQL -q -d postgres -c "drop database if exists courtbook_opt_mut" >/dev/null 2>&1' EXIT
# name | file | function | text | replacement   (function empty: the text is SQL run as it is)
MUTANTS=(
  "X1 a late success revives a replaced hold|supabase/migrations/0097_closed_account_fee_payments.sql|record_attempt_result|  elsif p.status = 'pending' and b.status = 'pending' then v_outcome := 'confirmed';|  elsif p.status in ('pending', 'expired') and b.status in ('pending', 'expired') then v_outcome := 'confirmed';"
  "X2 a replaced hold's payment stays open|supabase/migrations/0094_fee_online_payments.sql|hold_slot|  update payments p set status = 'expired'\n  from bookings b where p.booking_id = b.id and b.player_id = v_player and b.status = 'expired' and p.status = 'pending';|"
  "X3 a real club may take fees online with no provider|supabase/migrations/0094_fee_online_payments.sql|set_club_payment_mode|    raise exception 'payments_not_configured';|    null;"
  "X4 new clubs default to online fees|||alter table clubs alter column payment_mode set default 'fee_online';|"
  "X5 the readiness check needs an online provider|supabase/migrations/0089_publish_needs_map_point.sql|club_readiness_rows|  item := 'payment'; ok := c.payment_mode = 'at_desk' or c.is_demo;|  item := 'payment'; ok := c.payment_mode = 'fee_online' or c.is_demo;"
  "X6 a desk booking also opens a payment|supabase/migrations/0053_at_desk_review_2.sql|book_at_desk|  values (v_id, v_club, p_court, v_player, p_start, p_end, 'confirmed', 'app', v_player, v_price, 0, p_token);|  values (v_id, v_club, p_court, v_player, p_start, p_end, 'confirmed', 'app', v_player, v_price, 0, p_token);\n  insert into payments (booking_id, club_id, provider, kind, amount_usd, fee_usd, total_usd, status) values (v_id, v_club, 'simulated', 'full', v_price, 0, v_price, 'paid');"
)
caught=0; total=0
for m in "${MUTANTS[@]}"; do
  IFS='|' read -r name file fn from to <<< "$m"
  total=$((total+1)); fresh
  tmp=$(mktemp /tmp/mopt.XXXXXX); chmod 644 "$tmp"
  if [ -z "$fn" ]; then printf '%s\n' "$from" > "$tmp"
  else
    FROM="$from" TO="$to" python3 - "$file" "$fn" "$tmp" <<'PY' || { echo "  MUTANT NOT APPLIED: $name"; status=FAIL; rm -f "$tmp"; continue; }
import os, re, sys
src, fn, out = sys.argv[1:4]
s = open(src).read()
m = list(re.finditer(r"create or replace function (public\.)?" + re.escape(fn) + r"\(", s, re.I))
assert m, "function not found"
start = m[-1].start()
q = re.compile(r"\$[A-Za-z_]*\$").search(s, start)             # the body's dollar quote ($$ or $function$)
close = s.index(q.group(0), q.end())
body_end = s.index(";", close) + 1
block = s[start:body_end]
f = os.environ["FROM"].replace("\\n", "\n"); t = os.environ["TO"].replace("\\n", "\n")
assert block.count(f) == 1, (block.count(f), f)
open(out, "w").write(block.replace(f, t) + "\n")
PY
  fi
  $PSQL -q -d $T -v ON_ERROR_STOP=1 -1 -f "$tmp" >/dev/null 2>&1 || { echo "  MUTANT DID NOT LOAD: $name"; status=FAIL; rm -f "$tmp"; continue; }
  mo=$($PSQL -d $T -X -q -At -f supabase/tests/payments/optional_tests.sql 2>&1)
  # caught: a check fails, or one is missing (a check reads the row it is about; a refused call leaves no row)
  if echo "$mo" | grep -qE "^(FAIL|psql)|ERROR" || [ "$(echo "$mo" | grep -c '^ok ')" -ne 14 ]; then
    caught=$((caught+1)); echo "  caught  $name ($(echo "$mo" | grep -m1 -E '^FAIL|ERROR' | cut -c1-70)$(echo "$mo" | grep -c '^ok ') of 14 ok)"
  else echo "  MISSED  $name"; status=FAIL; fi
  rm -f "$tmp"
done
echo "mutants caught: $caught/$total"
echo "optional at launch + hold replacement: $status"
[ "$status" = PASS ]
