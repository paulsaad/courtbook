#!/usr/bin/env bash
# Regression tests for the release fixes 0068–0071 (docs/audit/fixes.md). LOCAL DISPOSABLE DATABASES ONLY.
#   A. roles and behaviour (checks.sql) on 0001–0071; the same checks on 0001–0066 must fail exactly the
#      guarded items and pass the "unchanged" items
#   B. what players and visitors see of availability is identical on 0001–0066 and 0001–0071; a control
#      (the grid view made to run with the caller's rights) must change it
#   C. migration 0070 on existing data (d1_fixtures.sql → 0070 → d1_checks.sql), invariants, re-run
#   D. D3 at exact Beirut moments under a faked clock (d3_time.sh), and its control run
#   E. the release audit (catalog, roles, races, invariants) on 0001–0071
#   F. the live/staging scripts: preflight, guarded apply (in sync with the migrations), postcheck, rollback
# The M2 suite (supabase/tests/run.sh) is run separately; it applies the same migrations.
#   PSQL="sudo -u postgres psql" bash supabase/tests/fixes/run_fixes.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
NEW=courtbook_fixes; OLD=courtbook_fixes_base; D1DB=courtbook_fixes_d1; CTL=courtbook_fixes_ctl
oks=0; fails=0
rep() { if [ "$2" = true ] || [ "$2" = t ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [${3:-}]"; fails=$((fails+1)); fi; }
APDB=courtbook_fixes_apply
cleanup() { $PSQL -q -d postgres -c "drop database if exists $CTL" -c "drop database if exists $D1DB" -c "drop database if exists $APDB" >/dev/null 2>&1; }
trap cleanup EXIT

PSQL="$PSQL" DB=$NEW bash supabase/tests/audit/build_db.sh WORKTREE || exit 2
PSQL="$PSQL" DB=$OLD bash supabase/tests/audit/build_db.sh origin/mobile-m2-native || exit 2
fee_default=$($PSQL -At -d $OLD -c "select coalesce(column_default, '') from information_schema.columns where table_name = 'clubs' and column_name = 'service_fee_usd'")
fee_batroun=$($PSQL -At -d $OLD -c "select service_fee_usd::text from clubs where slug = 'batroun'")

echo "== A. roles and behaviour on 0001–0071"
outA=$($PSQL -d $NEW -X -q -At -v fee_default="$fee_default" -v fee_batroun="$fee_batroun" -f supabase/tests/fixes/checks.sql 2>&1)
echo "$outA" | grep -E "^(ERROR|psql)" && fails=$((fails+1))
while IFS='|' read -r id pass detail; do rep "$id" "$pass" "$detail"; done < <(echo "$outA" | grep -E "^[A-Z0-9]+[a-z]? ")
echo "== A'. the same checks on 0001–0066 (live today): each guarded item must fail, the rest must pass"
GUARDED="D1a D1b D1c D1d D3a D3c R2a R2d R2f S1a S1b S1c S5a S5b S5c S5g"
outB=$($PSQL -d $OLD -X -q -At -v fee_default="$fee_default" -v fee_batroun="$fee_batroun" -f supabase/tests/fixes/checks.sql 2>&1)
echo "$outB" | grep -E "^(ERROR|psql)" && fails=$((fails+1))
bad=""; nguard=0
while IFS='|' read -r id pass detail; do
  key=${id%% *}
  if echo " $GUARDED " | grep -q " $key "; then nguard=$((nguard+1)); [ "$pass" = true ] && bad="$bad $key(passes without the fix)"
  else [ "$pass" = true ] || bad="$bad $key(fails without the fix)"; fi
done < <(echo "$outB" | grep -E "^[A-Z0-9]+[a-z]? ")
rep "A' without 0068–0071 exactly the $nguard guarded checks fail" "$([ -z "$bad" ] && [ "$nguard" = 16 ] && echo true)" "$bad"

echo "== B. availability seen by players and visitors"
$PSQL -d $OLD -X -q -At -f supabase/tests/fixes/availability_snapshot.sql > /tmp/cb_snap_old 2>&1
$PSQL -d $NEW -X -q -At -f supabase/tests/fixes/availability_snapshot.sql > /tmp/cb_snap_new 2>&1
rep "B1 identical before and after the fixes ($(wc -l < /tmp/cb_snap_new) lines: grid views, day slots, next free, discovery, free now)" \
  "$(cmp -s /tmp/cb_snap_old /tmp/cb_snap_new && ! grep -q ERROR /tmp/cb_snap_new && echo true)" "$(diff /tmp/cb_snap_old /tmp/cb_snap_new | head -3 | tr '\n' ' ')"
$PSQL -q -d postgres -c "drop database if exists $CTL" -c "create database $CTL template $NEW" >/dev/null
$PSQL -q -d $CTL -c "alter view occupancy set (security_invoker = true)" >/dev/null
$PSQL -d $CTL -X -q -At -f supabase/tests/fixes/availability_snapshot.sql > /tmp/cb_snap_ctl 2>&1
rep "B2 control: if the grid view ran with the player's rights, blocks would vanish from it (snapshot differs)" \
  "$(cmp -s /tmp/cb_snap_new /tmp/cb_snap_ctl || echo true)" "control snapshot identical"
$PSQL -q -d postgres -c "drop database if exists $CTL" >/dev/null

echo "== C. migration 0070 on existing data"
PSQL="$PSQL" DB=$D1DB bash supabase/tests/audit/build_db.sh origin/mobile-m2-native >/dev/null || exit 2
for m in 0068 0069; do $PSQL -q -d $D1DB -v ON_ERROR_STOP=1 -1 -f supabase/migrations/${m}_*.sql >/dev/null 2>&1 || { rep "C0 apply $m" false; }; done
$PSQL -X -q -At -d $D1DB -v ON_ERROR_STOP=1 -f supabase/tests/fixes/d1_fixtures.sql > /tmp/cb_d1_fix 2>&1 || rep "C0 fixtures" false "$(tail -2 /tmp/cb_d1_fix)"
note=$($PSQL -X -q -d $D1DB -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0070_simulated_payment_demo_only.sql 2>&1)
rep "C1 0070 applies to data with a real club in simulated mode, and names it" "$(echo "$note" | grep -q "club realsim (not a demo) switched from simulated to at_desk; 1 hold(s) released" && ! echo "$note" | grep -q ERROR && echo true)" "$note"
while IFS='|' read -r id pass detail; do rep "$id" "$pass" "$detail"; done < <($PSQL -X -q -At -d $D1DB -f supabase/tests/fixes/d1_checks.sql 2>&1 | grep -E "^D1-M")
inv=$($PSQL -X -At -d $D1DB -f supabase/tests/audit/invariants.sql | awk -F'|' '$2 != "0" {print $1"="$2}' | tr '\n' ' ')
rep "C2 all 13 booking/payment invariants hold afterwards" "$([ -z "$inv" ] && echo true)" "$inv"
again=$($PSQL -X -q -d $D1DB -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0070_simulated_payment_demo_only.sql 2>&1); rc=$?
rep "C3 re-running 0070 changes nothing and raises no error" "$([ $rc = 0 ] && ! echo "$again" | grep -q "switched" && echo true)" "$again"

echo "== D. D3 at exact Beirut moments (faked clock)"
outD=$(bash supabase/tests/fixes/d3_time.sh 2>&1); rcD=$?
if [ $rcD = 3 ]; then echo "SKIP  $outD"; else
  while IFS='|' read -r id pass detail; do rep "$id" "$pass" "$detail"; done < <(echo "$outD" | grep -E "^D3-")
  ctl=$(CONTROL=1 bash supabase/tests/fixes/d3_time.sh 2>&1 | grep -E "^D3-" | awk -F'|' '$2 != "true" {split($1, a, " "); print a[1]}' | sort | tr '\n' ' ')
  rep "D-control without the 0071 lines, exactly the 15 guarded checks fail" "$([ "$ctl" = "D3-B2 D3-E3 D3-E4 D3-E5 D3-E6 D3-F2 D3-M1 D3-M5 D3-M6 D3-M8 D3-M9 D3-N2 D3-N4 D3-S2 D3-W2 " ] && echo true)" "$ctl"
fi

echo "== E. release audit on 0001–0071 (catalog, roles, two-session races, invariants)"
outE=$(PSQL="$PSQL" bash supabase/tests/audit/run_audit.sh WORKTREE 2>&1)
sumE=$(echo "$outE" | grep "^summary:")
rep "E1 audit: $sumE" "$(echo "$outE" | grep -q "^RESULT: PASS" && echo true)" "$(echo "$outE" | grep -E "^(FAIL|XPASS)" | tr '\n' ' ')"
echo "$outE" | grep -E "^ok +RACE" | sed 's/^/      /'

echo "== F. live/staging scripts (supabase/live/fixes_*.sql, 00{68..71}_apply.sql)"
gen=$(mktemp -d); chmod 755 "$gen"; OUT=$gen bash supabase/live/make_fixes_apply.sh >/dev/null
insync=true; for n in 0068 0069 0070 0071; do cmp -s "$gen/${n}_apply.sql" supabase/live/${n}_apply.sql || insync="false ($n differs: run make_fixes_apply.sh)"; done; rm -rf "$gen"
rep "F1 the apply scripts are in sync with the migration files" "$insync" "$insync"
pre_old=$($PSQL -X -At -d $OLD -f supabase/live/fixes_preflight.sql | awk -F'|' '$1 < 3 && $3 != "t"' | wc -l)
pre_new=$($PSQL -X -At -d $NEW -f supabase/live/fixes_preflight.sql | awk -F'|' '$1 == 1 && $3 == "t"' | wc -l)
rep "F2 full preflight: all ok on 0001–0066; every part-1 row false once applied" "$([ "$pre_old" = 0 ] && [ "$pre_new" = 0 ] && echo true)" "not ok on 0066: $pre_old; still ok on 0071: $pre_new"
$PSQL -q -d postgres -c "drop database if exists $APDB" -c "create database $APDB template $OLD" >/dev/null
$PSQL -X -q -At -d $APDB -v ON_ERROR_STOP=1 -f supabase/tests/fixes/d1_fixtures.sql >/dev/null 2>&1
review=$($PSQL -X -At -d $APDB -f supabase/live/fixes_0070_clubs.sql | awk -F'|' '{print $1":"$6":"$7}' | tr '\n' ' ')
rep "F2b the 0070 club review names the real club left simulated and its live hold, and only it" "$([ "$review" = "realsim:t:1 batroun:f:1 realdesk:f:0 " ] && echo true)" "$review"
applied=""; for n in 0068 0069 0070 0071; do applied="$applied $($PSQL -X -q -At -d $APDB -f supabase/live/${n}_apply.sql 2>&1 | grep -E "^$n applied" | tr '|' ' ')"; done
rep "F3 the four apply scripts run in order on 0001–0066 with a real club left simulated" "$(echo "$applied" | grep -q "0071 applied" && echo "$applied" | grep -q "realsim (1 hold(s) released)" && echo true)" "$applied"
post=$($PSQL -X -At -d $APDB -f supabase/live/fixes_postcheck.sql | awk -F'|' '$2 != "t" {print $1}' | tr '\n' ';')
rep "F4 postcheck all ok after them" "$([ -z "$post" ] && echo true)" "$post"
stops=0; for n in 0068 0069 0070 0071; do $PSQL -X -q -At -d $APDB -f supabase/live/${n}_apply.sql 2>&1 | grep -q "STOPPED, nothing changed" && stops=$((stops+1)); done
rep "F5 running any of them a second time stops and changes nothing" "$([ $stops = 4 ] && echo true)" "$stops of 4 stopped"
# On the M3 branch the migrations folder also holds 0067 (match_detail), reserved and applied out of
# order after 0071. F6 applies it the same way, on a copy, so F7's rollback still starts from 0068–0071.
# Later M3 candidates (0072 …) are applied after it in number order, the same way.
f6db=$APDB; f6_extra=""
extra=$(ls supabase/migrations/*.sql | sort | grep -vE '/00(0[0-9]|[1-5][0-9]|6[0-6]|6[89]|7[01])_' || true)
if [ -n "$extra" ]; then
  f6db=${APDB}_67; $PSQL -q -d postgres -c "drop database if exists $f6db" -c "create database $f6db template $APDB" >/dev/null
  for f in $extra; do $PSQL -X -q -d $f6db -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null && f6_extra="$f6_extra + $(basename "$f" | cut -c1-4)"; done
  f6_extra="$f6_extra after them"; fi
$PSQL -At -d $f6db -f supabase/tests/schema_fingerprint.sql | grep -v d1_fixture > /tmp/cb_fp_ap; $PSQL -At -d $NEW -f supabase/tests/schema_fingerprint.sql > /tmp/cb_fp_new
rep "F6 result$f6_extra identical to a build of the migrations folder (schema fingerprint)" "$(cmp -s /tmp/cb_fp_ap /tmp/cb_fp_new && echo true)" "$(diff /tmp/cb_fp_new /tmp/cb_fp_ap | head -2 | tr '\n' ' ')"
[ "$f6db" != "$APDB" ] && $PSQL -q -d postgres -c "drop database if exists $f6db" >/dev/null
$PSQL -X -q -d $APDB -v ON_ERROR_STOP=1 -f supabase/live/fixes_rollback.sql >/dev/null 2>&1
$PSQL -At -d $APDB -f supabase/tests/schema_fingerprint.sql | grep -v d1_fixture > /tmp/cb_fp_rb; $PSQL -At -d $OLD -f supabase/tests/schema_fingerprint.sql > /tmp/cb_fp_old
rep "F7 the rollback restores the 0001–0066 schema exactly" "$(cmp -s /tmp/cb_fp_rb /tmp/cb_fp_old && echo true)" "$(diff /tmp/cb_fp_old /tmp/cb_fp_rb | head -2 | tr '\n' ' ')"
$PSQL -q -d postgres -c "drop database if exists $APDB" >/dev/null

echo
echo "summary: $oks ok, $fails FAIL"
[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
