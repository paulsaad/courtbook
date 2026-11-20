#!/usr/bin/env bash
# M3-S safety tests (supabase/migrations/0074_safety.sql) and mutation checks.
# LOCAL DISPOSABLE REPLICA ONLY; each run is one transaction that is rolled back. Needs 0072 on the replica.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/safety.sh
PSQL=${PSQL:-psql}
DB=courtbook_test
MIGRATION=${MIGRATION:-supabase/migrations/0074_safety.sql}
TESTS=supabase/tests/m3/safety_tests.sql
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
[ "$($PSQL -At -d $DB -c "select count(*) from pg_proc where proname = 'resolve_court'")" = 1 ] || { echo "refusing: 0072 is not on the replica"; exit 2; }
fp() { $PSQL -At -d $DB -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
before=$(fp)
run() { $PSQL -d $DB -X -q -At -v mig="$1" -f $TESTS 2>&1; }
status=0
echo "== M3-S tests against $MIGRATION"
out=$(run "$MIGRATION")
[ -n "${VERBOSE:-}" ] && echo "$out" | grep -E "^ok "
echo "$out" | grep -E "^(FAIL|ERROR|psql)" || true
summary=$(echo "$out" | grep -E "^FAILED " | tail -1); oks=$(echo "$out" | grep -c "^ok ")
echo "   $oks checks passed; ${summary:-no summary (the run stopped)}"
[ "$summary" = "FAILED 0 of $oks" ] || status=1

echo "== mutation checks (each mutant must make the suite fail)"
mutants=(
  "N1 no rules check|s/    raise exception 'rules_not_accepted';/    null;/"
  "N2 no word filter|s/if message_has_blocked_term(new.body) then raise exception 'message_not_allowed'; end if;//"
  "N3 block only one way|s/(blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)/(blocker_id = a and blocked_id = b)/"
  "N4 join not guarded|s/    raise exception 'blocked';/    null;/"
  "N5 blocked text not withheld|s/when x.deleted_at is not null or bl.blocked_id is not null then '' else x.body end/when x.deleted_at is not null then '' else x.body end/"
  "N6 notices despite a block|s/and not exists (select 1 from player_blocks pb where pb.blocker_id = r.pid and pb.blocked_id = new.profile_id)//"
  "N7 board shows blocked games|s/    and not players_blocked(auth.uid(), m.organizer_id)//"
  "N8 any member can read reports|s/revoke all on table reports, blocked_terms, account_suspensions from anon, authenticated;/revoke all on table blocked_terms, account_suspensions from anon, authenticated; grant select on reports to authenticated; drop policy if exists r on reports; create policy r on reports for select using (true);/"
  "N9 non-members can report messages|s/       and not exists (select 1 from match_players mp where mp.match_id = msg.match_id and mp.profile_id = me and mp.status = 'accepted') then/       and false then/"
  "N10 repeat reports pile up|s/  on conflict (reporter_id, target_kind, target_key) where status = 'open' do nothing;/  ;/"
  "N11 self-block allowed|s/if p_profile is null or p_profile = auth.uid() then raise exception 'bad_target'; end if;//"
  "N12 suspension not enforced on game writes|s/  if exists (select 1 from account_suspensions where profile_id = auth.uid()) then raise exception 'account_suspended'; end if;/  null;/"
  "N13 suspension not enforced in chat|s/  if exists (select 1 from account_suspensions where profile_id = new.profile_id) then raise exception 'account_suspended'; end if;//"
  "N14 any player lists reports|0,/  if not is_admin() then raise exception 'forbidden'; end if;/s//  null;/"
  "N15 any player suspends|/function admin_suspend/,/end \$\$;/ s/  if not is_admin() then raise exception 'forbidden'; end if;//"
  "N16 organiser accepts a blocked request|s/    if players_blocked(p_profile, m.organizer_id) then raise exception 'blocked'; end if;//"
  "N17 S15 accepts a blocked request|s/             and not players_blocked(profile_id, m.organizer_id)   -- M3-S: blocked requests keep waiting//"
  "N18 blocked messages readable from the table|s/  and not exists (select 1 from player_blocks b where b.blocker_id = auth.uid() and b.blocked_id = match_messages.profile_id));/  );/"
  "N20 no daily feedback limit|/function send_feedback/,/end \$\$;/ s/    raise exception 'slow_down';/    null;/"
  "N21 waiting players see everyone|s/       or (mine.my_status = 'accepted' and p.status::text = 'accepted')/       or true/"
  "N22 feedback not refused when empty|s/  if body = '' then raise exception 'text_required'; end if;//"
  "N19 suspensions readable|s/revoke all on table reports, blocked_terms, account_suspensions from anon, authenticated;/revoke all on table reports, blocked_terms from anon, authenticated; grant select on account_suspensions to authenticated; drop policy if exists s on account_suspensions; create policy s on account_suspensions for select using (true);/"
)
tmp=$(mktemp -d); chmod 755 "$tmp"
for m in "${mutants[@]}"; do
  name=${m%%|*}; expr=${m#*|}
  sed "$expr" "$MIGRATION" > "$tmp/mutant.sql"; chmod 644 "$tmp/mutant.sql"
  if cmp -s "$MIGRATION" "$tmp/mutant.sql"; then echo "   $name: NOT APPLIED (pattern not found) — fix the mutant"; status=1; continue; fi
  mout=$(run "$tmp/mutant.sql"); msum=$(echo "$mout" | grep -E "^FAILED " | tail -1)
  if [ -z "$msum" ] || [ "${msum#FAILED 0 }" = "$msum" ]; then echo "   $name: detected (${msum:-run stopped})"; else echo "   $name: NOT DETECTED"; status=1; fi
done
rm -rf "$tmp"
[ "$(fp)" = "$before" ] && echo "== replica unchanged" || { echo "== REPLICA CHANGED"; status=1; }
[ $status = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
