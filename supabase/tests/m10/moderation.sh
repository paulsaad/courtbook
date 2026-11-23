#!/usr/bin/env bash
# M10 moderation tests (0082) and mutation checks.
#
# LOCAL DISPOSABLE REPLICA ONLY: refuses unless connected to the local `courtbook_test` database (built by run.sh).
# Each run is ONE transaction that is ROLLED BACK; the replica is checked unchanged afterwards.
#
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
#   PSQL="sudo -u postgres psql" bash supabase/tests/m10/moderation.sh
PSQL=${PSQL:-psql}
DB=courtbook_test
MIGRATION=${MIGRATION:-supabase/migrations/0082_moderation_readiness.sql}
TESTS=supabase/tests/m10/moderation_tests.sql
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
fp() { $PSQL -At -d $DB -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
before=$(fp)
run() { $PSQL -d $DB -X -q -At -v mig="$1" -f $TESTS 2>&1; }

status=0
echo "== M10 tests against $MIGRATION"
out=$(run "$MIGRATION")
[ -n "${VERBOSE:-}" ] && echo "$out" | grep -E "^ok "
echo "$out" | grep -E "^(FAIL|ERROR|psql)" || true
summary=$(echo "$out" | grep -E "^FAILED " | tail -1)
oks=$(echo "$out" | grep -c "^ok ")
echo "   $oks checks passed; ${summary:-no summary (the run stopped)}"
[ "$summary" = "FAILED 0 of $oks" ] || status=1

echo "== mutation checks (each mutant must make the suite fail)"
mutants=(
  "M1 a handled report can be resolved again|s/  if r.status <> 'open' then raise exception 'already_handled'; end if;/  null;/"
  "M2 reopening without a reason|s/  if r.status = 'open' then raise exception 'already_open'; end if;/  if false then null; end if;/;s/'was ' || r.status || coalesce(' (' || r.action || ')', '') || ': ' || trim(p_note)/'was ' || r.status/"
  "M3 an admin can be suspended|s/  if exists (select 1 from profiles where id = p_profile and 'admin' = any(roles)) then raise exception 'bad_target'; end if;/  null;/"
  "M4 unsuspending without a reason|s/raise exception 'reason_required'; end if;   -- unsuspend: a reason is kept/null; end if;/"
  "M5 legal hold ignored by the clearing|s/   where status <> 'open' and not legal_hold and closed_at is not null/   where status <> 'open' and closed_at is not null/"
  "M6 clearing allowed early|s/  if p_days is null or p_days < 180 then raise exception 'too_soon'; end if;   -- never earlier than the stated rule/  null;/"
  "M7 suspensions not logged|s/  perform log_moderation('suspend', null, p_profile, null, trim(p_reason));/  null;/"
  "M8 log editable|s/  raise exception 'moderation_log_is_append_only';$/  return coalesce(new, old);/"
  "M9 log readable by anyone signed in|s/  if not is_admin() then raise exception 'forbidden'; end if;$/  null;/"
  "M10 new reports do not run the retention rule|s/  perform enforce_report_retention(180);/  null;/"
  "M11 log notes on held or open reports cleared|s/     and not exists (select 1 from reports r where r.id = l.report_id and (r.status = 'open' or r.legal_hold))/     and true/"
  "M12 log notes never cleared|s/   where l.note is not null and l.action <> 'clear_text' and l.at < now() - make_interval(days => p_days)/   where false/"
  "M13 retention flag allows any edit|s/     and new.note is null and (new.id, new.at, new.admin_id, new.action, new.report_id, new.profile_id, new.message_id)/     and true and (new.id, new.at)/;s/         is not distinct from (old.id, old.at, old.admin_id, old.action, old.report_id, old.profile_id, old.message_id) then/         is not distinct from (old.id, old.at) then/"
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
