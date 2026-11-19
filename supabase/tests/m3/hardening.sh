#!/usr/bin/env bash
# M3-H hardening tests (docs/m3/06-test-plan.md §AP) and mutation checks.
#
# LOCAL DISPOSABLE REPLICA ONLY: refuses unless connected to the local `courtbook_test` database. Each
# run is ONE transaction that is ROLLED BACK, so the draft never persists. Needs 0067 on the replica
# (run.sh builds it from supabase/migrations/, which holds 0067 on m3-dev).
#
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/hardening.sh
#
# MIGRATION defaults to the candidate 0072 (also applied by run.sh when it builds the replica, so the
# replica usually has it already; the run is rolled back either way and must leave the replica unchanged).
PSQL=${PSQL:-psql}
DB=courtbook_test
MIGRATION=${MIGRATION:-supabase/migrations/0072_game_hardening.sql}
TESTS=supabase/tests/m3/hardening_tests.sql
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
[ "$($PSQL -At -d $DB -c "select count(*) from pg_proc where proname = 'match_detail'")" = 1 ] || { echo "refusing: 0067 is not on the replica"; exit 2; }
fp() { $PSQL -At -d $DB -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
before=$(fp)

run() { $PSQL -d $DB -X -q -At -v mig="$1" -f $TESTS 2>&1; }

status=0
echo "== M3-H tests against $MIGRATION"
out=$(run "$MIGRATION")
[ -n "${VERBOSE:-}" ] && echo "$out" | grep -E "^ok "
echo "$out" | grep -E "^(FAIL|ERROR|psql)" || true
summary=$(echo "$out" | grep -E "^FAILED " | tail -1)
oks=$(echo "$out" | grep -c "^ok ")
echo "   $oks checks passed; ${summary:-no summary (the run stopped)}"
[ "$summary" = "FAILED 0 of $oks" ] || status=1

echo "== mutation checks (each mutant must make the suite fail)"
mutants=(
  "M1 declined player can leave and ask again (S4)|s/if was is null or was = 'declined' then return; end if;/if was is null then return; end if;/"
  "M2 trigger acts on any change away from confirmed (S18)|s/if old.status = 'confirmed' and new.status = 'cancelled' then/if new.status <> 'confirmed' then/"
  "M3 sender sets created_at (S2)|s/new.created_at := now();//"
  "M4 message can arrive deleted (S9)|s/new.deleted_at := null;//"
  "M5 removal stored as leaving|s/update match_players set status = 'declined', decided_at = now() where match_id = p_match and profile_id = p_profile;/delete from match_players where match_id = p_match and profile_id = p_profile;/"
  "M6 removal reopens any closed game|s/^  if m.status = 'closed' and m.closed_reason = 'full' then\$/  if m.status = 'closed' then/"
  "M7 resolving always reopens|s/(case when n >= m.players_needed then 'closed' else 'open' end)::match_status/'open'::match_status/"
  "M8 status changes allowed while the court is lost|s/if m.court_lost_at is not null then raise exception 'court_lost'; end if;//"
  "M9 pending players not told the court is gone (S8)|s/mp.status in ('accepted', 'pending') and mp.profile_id <> m.organizer_id/mp.status = 'accepted' and mp.profile_id <> m.organizer_id/"
  "M10 hidden games still notify (S14)|s/and not exists (select 1 from match_hidden h where h.profile_id = r.pid and h.match_id = new.match_id)//"
  "M11 no club needed (S10)|s/if p_club is null then raise exception 'club_required'; end if;//"
  "M12 waiting notice callable by players|s/revoke all on function notify_waiting(uuid) from public, anon, authenticated;/grant execute on function notify_waiting(uuid) to authenticated;/"
  "M13 cancel after the game was played (GR-8)|s/if coalesce(m.end_at, m.start_at + interval '3 hours') <= now() then raise exception 'match_over'; end if;\$//"
  "M14 no waiting-list notice (S11)|s/perform notify_waiting(p_match);//g"
  "M16 push carries the stored chat text (S7)|s/when 'match_message' then title := 'New message'; body := 'In your ' || replace(g, ', ', ' game, ') || '.';/when 'match_message' then title := 'New message'; body := n.body;/"
  "M17 push_text callable by players|s/revoke all on function push_text(uuid) from public, anon, authenticated;/grant execute on function push_text(uuid) to authenticated;/"
  "M15 approval to open accepts nobody (S15)|s/if m.join_mode = 'approval' and p_join_mode = 'open' and st = 'open' then/if false then/"
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
