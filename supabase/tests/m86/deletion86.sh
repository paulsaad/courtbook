#!/usr/bin/env bash
# 0086 tests (one-confirmation account deletion) and mutation checks.
#   1. the 0079 suite PORTED to 0086 (ported_0079_tests.sql): every data-step check kept word for word
#   2. the new 0086 suite (close_tests.sql): closing, lock-out, pipeline (claim, lease, token, retries), held accounts
#   3. mutants: each deliberate mistake in 0086 must make at least one of the two suites fail
#
# LOCAL DISPOSABLE REPLICA ONLY: refuses unless connected to the local `courtbook_test` database (built by run.sh).
# Each suite run is ONE transaction that is ROLLED BACK; the replica is checked unchanged afterwards.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
#   PSQL="sudo -u postgres psql" bash supabase/tests/m86/deletion86.sh
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_test
MIGRATION=${MIGRATION:-supabase/migrations/0086_account_deletion_one_confirmation.sql}
SUITES="supabase/tests/m86/ported_0079_tests.sql supabase/tests/m86/close_tests.sql"
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
fp() { $PSQL -At -d $DB -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
before=$(fp)
run() { $PSQL -d $DB -X -q -At -v mig="$1" -f "$2" 2>&1; }

status=0
for s in $SUITES; do
  echo "== $(basename "$s") against $MIGRATION"
  out=$(run "$MIGRATION" "$s")
  [ -n "${VERBOSE:-}" ] && echo "$out" | grep -E "^ok "
  echo "$out" | grep -E "^(FAIL|ERROR|psql:.*ERROR)" || true
  summary=$(echo "$out" | grep -E "^FAILED " | tail -1)
  oks=$(echo "$out" | grep -c "^ok ")
  echo "   $oks checks passed; ${summary:-no summary (the run stopped)}"
  [ "$summary" = "FAILED 0 of $oks" ] || status=1
done

echo "== mutation checks (each mutant must make a suite fail)"
mutants=(
  # 0079's data step, as carried into 0086 (the ported suite must still see these)
  "M1 refund rule ignored (always refund)|s/    elsif (select start_at from bookings where id = r.id) - make_interval(hours => v_cutoff) > now() then/    elsif true then/"
  "M2 bookings not anonymised|s/  update bookings set player_id = null, guest_name = 'Former player', guest_phone = null where player_id = p_subject;/  perform 1;/"
  "M3 messages kept|s/  delete from match_messages where profile_id = p_subject;/  perform 1;/"
  "M9 full game not reopened|s/        update matches set status = 'open', closed_at = null, closed_reason = null where id = r.id;/        null;/"
  "M10 organised games not cancelled|s/    update matches set status = 'cancelled', closed_at = now(), closed_reason = null where id = r.id;/    null;/"
  "M15 chat excerpts left in others' notifications|s/  delete from notifications where actor_id = p_subject and kind = 'match_message';/  perform 1;/"
  "M16 name left in others' notices|s/    update notifications set body = regexp_replace(body,/    update notifications set body = body || regexp_replace('',/"
  "M17 stale holds left pending|s/               and (b.status = 'pending' or (b.status = 'confirmed' and b.start_at > now()))  -- every hold, even a stale one/               and b.status in ('confirmed', 'pending') and b.start_at > now()/"
  "M19 game notes kept|s/  update matches set note = null where organizer_id = p_subject and note is not null;/  update matches set note = note where organizer_id = p_subject and note is not null;/"
  # 0086
  "N1 lock-out trigger does nothing|s/^  if deletion_requested(auth.uid()) then raise exception 'account_closed'; end if;$/  null;/"
  "N2 assert_active ignores a closed account|s/  if deletion_requested(auth.uid()) then raise exception 'account_closed'; end if;   -- 0086/  null;/"
  "N3 a held record gets the full data step|s/  if d.status = 'held' and not p_cancel_only then raise exception 'held: %', d.held_reason; end if;   -- 0086: held accounts keep their data/  null;/"
  "N4 cancel-only also removes data|s/  if not p_cancel_only then   -- 0086:/  if true then   -- 0086:/"
  "N5 club staff may close|s/  if refusal in ('admin_role', 'staff_role') then raise exception '%', refusal; end if;/  if refusal in ('admin_role') then raise exception '%', refusal; end if;/"
  "N6 a suspended account is not held|s/then 'suspended' end);/then null end);/"
  "N7 claim ignores the lease|s/  if d.lease_until is not null and d.lease_until > now() then return/  if false then return/"
  "N8 bookkeeping ignores the token|s/where subject_id = p_subject and lease_token = p_token and p_token is not null/where subject_id = p_subject/"
  "N9 finish not idempotent|s/    if exists (select 1 from account_deletions where subject_id = p_subject and status = 'done') then return; end if;   -- already finished/    null;/"
  "N10 due list includes leased records|s/     and (lease_until is null or lease_until < now())/     and true/"
  "N11 release ignores a suspension|s/  if exists (select 1 from account_suspensions where profile_id = p_subject) then raise exception 'suspended'; end if;   -- D3: legal review/  null;/"
  "N12 older apps lose their request (review 23 Nov, finding 3)|s/^grant execute on function request_account_deletion(text) to authenticated;/revoke execute on function request_account_deletion(text) from authenticated;/"
  "N13 a second close makes a second record|s/  if found then   -- already closed/  if false then   -- already closed/"
  "N14 free text stored as the error|s/    if p_error is null or p_error !~ '^\[a-z_\]{1,60}\$' then p_error := 'unknown_error'; end if;/    null;/"
  "N15 cancel-only allowed on a normal record|s/  if p_cancel_only and d.status <> 'held' then raise exception 'not_held'; end if;/  null;/"
  "N16 release ignores a legal hold|s/  if refusal is not null then raise exception '%', refusal; end if;\$/  null;/"
  "N17 data step does not advance a closed record|s/  if d.status in ('requested', 'closing', 'closed') then/  if d.status in ('requested', 'closing') then/"
  "N18 failure keeps the lease (no retry possible)|s/next_attempt_at = now() + deletion_backoff(attempts), lease_until = null, lease_token = null/next_attempt_at = now() + deletion_backoff(attempts)/"
  "N19 a done record could be claimed|s/  select \* into d from account_deletions where subject_id = p_subject and status in ('closing', 'closed', 'held', 'data_removed')\$/  select * into d from account_deletions where subject_id = p_subject and status in ('closing', 'closed', 'held', 'data_removed', 'done')/"
  # review 23 Nov
  "N20 no recent sign-in needed|s/  if not recently_authenticated() then raise exception 'reauth_required'; end if;   -- finding 2/  null;/"
  "N21 any sign-in time counts as recent|s/    >= extract(epoch from now() - p_window)::bigint;/    >= 0;/"
  "N22 the app closes without automatic processing|s/  if p_via = 'app' and not deletion_processing_active() then raise exception 'processing_unavailable'; end if;/  null;/"
  "N23 the heartbeat never goes stale|s/last_run_at > now() - interval '1 hour'/last_run_at is not null/"
  "N24 older apps' requests processed at once (no grace)|s/where status = 'requested' and requested_at < now() - p_grace order by requested_at/where status = 'requested' order by requested_at/"
  "N25 an older request confirmed in one step is not closed|s/    if d.status = 'requested' then d := promote_request(d.id); end if;/    null;/"
  "N26 renewal does not extend the lease|s/    update account_deletions set lease_until = now() + interval '5 minutes' where id = d.id returning \* into d;/    null;/"
  "N27 players may record worker runs|s/^grant execute on function record_deletion_worker_run(jsonb) to service_role;/grant execute on function record_deletion_worker_run(jsonb) to authenticated, service_role;/"
  "N28 a request is never promoted|s/      perform promote_request(r.id);/      null;/"
)
tmp=$(mktemp -d); chmod 755 "$tmp"
for m in "${mutants[@]}"; do
  name=${m%%|*}; expr=${m#*|}
  sed "$expr" "$MIGRATION" > "$tmp/mutant.sql"; chmod 644 "$tmp/mutant.sql"
  if cmp -s "$MIGRATION" "$tmp/mutant.sql"; then echo "   $name: NOT APPLIED (pattern not found) — fix the mutant"; status=1; continue; fi
  failed=""
  for s in $SUITES; do
    res=$(run "$tmp/mutant.sql" "$s" | grep -E "^FAILED " | tail -1)
    if [ -z "$res" ] || [ "${res#FAILED 0 }" = "$res" ]; then failed="$failed $(basename "$s" .sql): ${res:-stopped}"; fi
  done
  if [ -n "$failed" ]; then echo "   $name: detected (${failed# })"
  else echo "   $name: NOT DETECTED — the suites cannot see this mistake"; status=1; fi
done
rm -rf "$tmp"

[ "$(fp)" = "$before" ] && echo "== replica unchanged (functions identical before and after)" || { echo "== replica CHANGED"; status=1; }
[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
