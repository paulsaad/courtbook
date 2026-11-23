#!/usr/bin/env bash
# M2 tests (0079 account deletion) and mutation checks.
#
# LOCAL DISPOSABLE REPLICA ONLY: refuses unless connected to the local `courtbook_test` database (built by run.sh).
# Each run is ONE transaction that is ROLLED BACK; the replica is checked unchanged afterwards.
#
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
#   PSQL="sudo -u postgres psql" bash supabase/tests/m2/deletion.sh
PSQL=${PSQL:-psql}
DB=courtbook_test
MIGRATION=${MIGRATION:-supabase/migrations/0079_account_deletion.sql}
TESTS=supabase/tests/m2/deletion_tests.sql
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
fp() { $PSQL -At -d $DB -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
before=$(fp)
run() { $PSQL -d $DB -X -q -At -v mig="$1" -f $TESTS 2>&1; }

status=0
echo "== M2 tests against $MIGRATION"
out=$(run "$MIGRATION")
[ -n "${VERBOSE:-}" ] && echo "$out" | grep -E "^ok "
echo "$out" | grep -E "^(FAIL|ERROR|psql)" || true
summary=$(echo "$out" | grep -E "^FAILED " | tail -1)
oks=$(echo "$out" | grep -c "^ok ")
echo "   $oks checks passed; ${summary:-no summary (the run stopped)}"
[ "$summary" = "FAILED 0 of $oks" ] || status=1

echo "== mutation checks (each mutant must make the suite fail)"
mutants=(
  "M1 refund rule ignored (always refund)|s/    elsif (select start_at from bookings where id = r.id) - make_interval(hours => v_cutoff) > now() then/    elsif true then/"
  "M2 bookings not anonymised|s/  update bookings set player_id = null, guest_name = 'Former player', guest_phone = null where player_id = p_subject;/  perform 1;/"
  "M3 messages kept|s/  delete from match_messages where profile_id = p_subject;/  perform 1;/"
  "M4 legal hold ignored|s/    when exists (select 1 from reports where legal_hold and/    when false and exists (select 1 from reports where legal_hold and/"
  "M5 reports the person filed are deleted|\$a alter table reports drop constraint reports_reporter_id_fkey; alter table reports add constraint reports_reporter_id_fkey foreign key (reporter_id) references profiles(id) on delete cascade;"
  "M6 open request does not block bookings|s/  if deletion_requested(v_who) then raise exception 'account_deletion_requested'; end if;/  null;/"
  "M7 any signed-in user may process|s/  if not (auth.uid() is null or is_admin()) then raise exception 'forbidden'; end if;/  null;/"
  "M8 re-run skips the work (late hold left)|s/  if d.status = 'requested' then$/  if d.status = 'data_removed' then return d.summary; end if; if d.status = 'requested' then/"
  "M9 full game not reopened|s/        update matches set status = 'open', closed_at = null, closed_reason = null where id = r.id;/        null;/"
  "M10 organised games not cancelled|s/    update matches set status = 'cancelled', closed_at = now(), closed_reason = null where id = r.id;/    null;/"
  "M11 staff may request|s/  if exists (select 1 from club_staff where profile_id = auth.uid()) then raise exception 'staff_role'; end if;/  null;/"
  "M12 finish without checking the account is gone|s/  if exists (select 1 from profiles where id = p_subject) then raise exception 'account_still_exists'; end if;/  null;/"
  "M13 payments block the deletion (no rule)|\$a alter table payments drop constraint payments_profile_id_fkey; alter table payments add constraint payments_profile_id_fkey foreign key (profile_id) references profiles(id);"
  "M14 the still-signed-in person can book after the data step|s/subject_id = p_profile and status in ('requested', 'data_removed'));/subject_id = p_profile and status = 'requested');/"
  "M15 chat excerpts left in others' notifications|s/  delete from notifications where actor_id = p_subject and kind = 'match_message';/  perform 1;/"
  "M16 name left in others' notices|s/    update notifications set body = regexp_replace(body,/    update notifications set body = body || regexp_replace('',/"
  "M17 stale holds left pending|s/               and (b.status = 'pending' or (b.status = 'confirmed' and b.start_at > now()))  -- every hold, even a stale one/               and b.status in ('confirmed', 'pending') and b.start_at > now()/"
  "M18 dashboard deletion skips the data step|s/    raise exception 'use_delete_account';/    null;/"
  "M19 game notes kept|s/  update matches set note = null where organizer_id = p_subject and note is not null;/  update matches set note = note where organizer_id = p_subject and note is not null;/"
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
