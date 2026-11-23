#!/usr/bin/env bash
# 18+ tests (0080) and mutation checks.
#
# LOCAL DISPOSABLE REPLICA ONLY: refuses unless connected to the local `courtbook_test` database (built by run.sh).
# Each run is ONE transaction that is ROLLED BACK; the replica is checked unchanged afterwards.
#
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
#   PSQL="sudo -u postgres psql" bash supabase/tests/m80/age.sh
PSQL=${PSQL:-psql}
DB=courtbook_test
MIGRATION=${MIGRATION:-supabase/migrations/0080_age_18_plus.sql}
TESTS=supabase/tests/m80/age_tests.sql
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
fp() { $PSQL -At -d $DB -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
before=$(fp)
run() { $PSQL -d $DB -X -q -At -v mig="$1" -f $TESTS 2>&1; }

status=0
echo "== 18+ tests against $MIGRATION"
out=$(run "$MIGRATION")
[ -n "${VERBOSE:-}" ] && echo "$out" | grep -E "^ok "
echo "$out" | grep -E "^(FAIL|ERROR|psql)" || true
summary=$(echo "$out" | grep -E "^FAILED " | tail -1)
oks=$(echo "$out" | grep -c "^ok ")
echo "   $oks checks passed; ${summary:-no summary (the run stopped)}"
[ "$summary" = "FAILED 0 of $oks" ] || status=1

echo "== mutation checks (each mutant must make the suite fail)"
mutants=(
  "M1 switch ignored (never enforced)|s/  if auth.uid() is null or not age_confirmation_required() then return new; end if;/  return new;/"
  "M2 server work blocked too|s/  if auth.uid() is null or not age_confirmation_required() then return new; end if;/  if not age_confirmation_required() then return new; end if;/"
  "M3 under 18 accepted|s/  if p_is_18_or_over is distinct from true then raise exception 'under_18'; end if;   -- nothing recorded/  null;/"
  "M4 direct profile writes allowed|s/    raise exception 'age_confirmation_by_function_only';/    null;/"
  "M5 chat not gated|s/on match_messages for each row execute function require_age_confirmed('profile_id');/on match_messages for each row execute function require_age_confirmed('nobody');/"
  "M6 joining not gated|s/on match_players for each row execute function require_age_confirmed('profile_id');/on match_players for each row execute function require_age_confirmed('nobody');/"
  "M7 confirmation overwritten on repeat|s/  update profiles set age_confirmed_at = coalesce(age_confirmed_at, now()),/  update profiles set age_confirmed_at = now(), age_confirmed_via = p_via,/;s/                      age_confirmed_via = coalesce(age_confirmed_via, p_via)/                      name = name/"
)
tmp=$(mktemp -d); chmod 755 "$tmp"
for m in "${mutants[@]}"; do
  name=${m%%|*}; expr=${m#*|}
  sed "$expr" "$MIGRATION" > "$tmp/mutant.sql"; chmod 644 "$tmp/mutant.sql"
  if cmp -s "$MIGRATION" "$tmp/mutant.sql"; then echo "   $name: NOT APPLIED (pattern not found) — fix the mutant"; status=1; continue; fi
  res=$(run "$tmp/mutant.sql" | grep -E "^FAILED " | tail -1)
  if [ -n "$res" ] && [ "${res#FAILED 0 }" = "$res" ]; then echo "   $name: detected ($res)"
  else echo "   $name: NOT DETECTED (${res:-no result}) — the suite cannot see this mistake"; status=1; fi
done
rm -rf "$tmp"

[ "$(fp)" = "$before" ] && echo "== replica unchanged (functions identical before and after)" || { echo "== replica CHANGED"; status=1; }
[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
