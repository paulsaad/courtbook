#!/usr/bin/env bash
# F1: a staff move applies only if the booking is still where the desk saw it. DRAFT; LOCAL ONLY (scratch databases,
# never staging or live).
#   PSQL="sudo -u postgres psql" PG_MODULE=/tmp/pgdeps/node_modules bash supabase/tests/staff_moves/run.sh
# 1. scratch database 0001..last + seed + fixtures (fictional people)
# 2. controls BEFORE the draft: preflight passes; postcheck STOPS; tests.sql fails; the race harness SEES the defect
#    (both moves applied) in every round
# 3. the draft; postcheck passes; tests.sql 15/15; race harness (≥ 20 simultaneous rounds + delayed orders, and move
#    versus cancel; every round must PROVE overlap: both actors queued on the barrier and each call started before the
#    other returned on the database clock, or, delayed, the second seen waiting on the first's lock (review R101-2));
#    the draft again (idempotent): postcheck and tests.sql still pass
# 4. rollback: both functions exactly as 0091; the 8-argument one gone; the defect is back (race control passes)
# 5. mutants of the draft: each must be caught by BEHAVIOUR (tests.sql or the race harness). The postcheck's md5
#    fingerprint would STOP every mutant (any edit changes the text), so it is reported separately as an integrity
#    check and never counted as catching a defect (review R101-1). X3 must be caught by the race harness alone.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
PG_MODULE=${PG_MODULE:-/tmp/pgdeps/node_modules}
export PGOPTIONS='-c client_min_messages=warning'
DRAFT=docs/staff-moves/sql/move_checks_what_desk_saw.draft.sql
DOWN=docs/staff-moves/sql/move_checks_what_desk_saw.down.draft.sql
T=courtbook_staffmoves
trap '$PSQL -q -d postgres -c "drop database if exists courtbook_staffmoves" >/dev/null 2>&1' EXIT
q() { $PSQL -d $T -X -q -At "$@" 2>&1; }
build() {
  $PSQL -q -d postgres -c "drop database if exists $T" -c "create database $T" >/dev/null || exit 2
  $PSQL -q -d $T -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null 2>&1 || exit 2
  for f in $(ls supabase/migrations/*.sql | sort); do $PSQL -q -d $T -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "cannot build: $f"; exit 2; }; done
  $PSQL -q -d $T -f supabase/seed.sql >/dev/null 2>&1 || true
  (cd supabase/tests/staff_moves && $PSQL -d $T -X -q -At -v ON_ERROR_STOP=1 -f fixtures.sql >/dev/null 2>&1) || { echo "fixtures failed"; exit 2; }
}
tests() { (cd supabase/tests/staff_moves && $PSQL -d $T -X -q -At -f tests.sql 2>&1) | grep -v '^$'; }
race() { sudo -u postgres env PG_MODULE="$PG_MODULE" DB="postgresql:///$T?host=/var/run/postgresql" MODE="$1" DISCARD_FIRST_PROOF="${DISCARD_FIRST_PROOF:-}" ROUNDS="${ROUNDS:-20}" node supabase/tests/staff_moves/race.mjs 2>&1; }
passed() { echo "$1" | grep -q "checks: 15, failures: 0" && ! echo "$1" | grep -qE "^(FAIL|psql)|ERROR"; }
stops() { echo "$1" | grep -q "|STOP$"; }

# full run against a given draft file; returns 0 only if everything passed
run() {
  local draft=$1 ok=0 out
  build
  pre=$(q -F'|' -f supabase/live/staff_moves_preflight.sql); echo "$pre" | sed 's/^/  pre  /'
  stops "$pre" && { echo "  preflight STOPPED"; ok=1; }
  stops "$(q -F'|' -f supabase/live/staff_moves_postcheck.sql)" && echo "  control: postcheck before the draft STOPS (as it must)" || { echo "  control FAILED: postcheck passed before the draft"; ok=1; }
  passed "$(tests)" && { echo "  control FAILED: tests.sql passed before the draft"; ok=1; } || echo "  control: tests.sql fails before the draft (as it must)"
  out=$(race control); echo "$out" | grep -E "^(ok|FAIL)  +control" | sed 's/^/  /'
  echo "$out" | grep -q "^ok    control" || ok=1
  q -v ON_ERROR_STOP=1 -1 -f "$draft" >/dev/null || { echo "  draft failed to load"; return 1; }
  post=$(q -F'|' -f supabase/live/staff_moves_postcheck.sql); echo "$post" | sed 's/^/  post /'
  stops "$post" && ok=1
  out=$(tests); echo "$out" | sed 's/^/  /'; passed "$out" || ok=1
  out=$(race draft); echo "$out" | grep -vE "^ok    R[12]\." | sed 's/^/  /'   # the summary lines and any failure
  echo "$out" | grep -qE "^race checks: [0-9]+, failures: 0$" || ok=1
  echo "$out" | grep -q "^FAIL" && ok=1
  q -v ON_ERROR_STOP=1 -1 -f "$draft" >/dev/null || { echo "  second run failed"; ok=1; }
  if stops "$(q -F'|' -f supabase/live/staff_moves_postcheck.sql)" || ! passed "$(tests)"; then echo "  second run: postcheck or tests FAIL"; ok=1
  else echo "  idempotent: the draft again, postcheck and tests.sql still pass"; fi
  return $ok
}
status=PASS
echo "== the draft"
run "$DRAFT" || status=FAIL

echo "== rollback (on the migrated database)"
q -v ON_ERROR_STOP=1 -1 -f "$DOWN" >/dev/null || { echo "  rollback failed to load"; status=FAIL; }
pre=$(q -F'|' -f supabase/live/staff_moves_preflight.sql)
stops "$pre" && { echo "$pre" | sed 's/^/  /'; echo "  R1 FAIL: the preflight does not see the 0091 state"; status=FAIL; } \
  || echo "  R1 both functions exactly as 0091, the 8-argument one gone (the preflight passes again)"
out=$(race control); echo "$out" | grep -q "^ok    control" && echo "  R2 without the comparison the defect is back (race control: both moves applied)" || { echo "  R2 FAIL"; status=FAIL; }

echo "== mutants: caught only by behaviour (tests.sql, race harness); the fingerprint is reported, never counted"
caught=0; total=0
# one mutant: a fresh database with the mutant applied, then each detector on its own
# the race harness's verdict from its output (stdin): CAUGHT only on a behavioural failure; error if it crashed (no
# summary line); inconclusive if its only failures are overlap proofs; otherwise pass. Self-tested below.
race_verdict() {
  local out; out=$(cat)
  if ! echo "$out" | grep -qE "^race checks: [0-9]+, failures: [0-9]+$"; then echo error
  elif echo "$out" | grep -qE "^FAIL  (R1\.[0-9]+(#[0-9]+)? \[[a-z]+\] two desks move it at once|R2\.[0-9]+(#[0-9]+)? \[[a-z]+\] move versus cancel|I1 )"; then echo CAUGHT
  elif echo "$out" | grep -q "^FAIL"; then echo inconclusive
  else echo pass; fi
}
for c in "pass|ok    R1.1 [sim] x\nrace checks: 3, failures: 0" \
         "CAUGHT|FAIL  R1.2#3 [ab] two desks move it at once: exactly one applied  [x]\nrace checks: 3, failures: 1" \
         "CAUGHT|FAIL  R2.1 [sim] move versus cancel: the cancel stands  [x]\nrace checks: 3, failures: 1" \
         "CAUGHT|FAIL  I1 no two live bookings overlap on any court  [1]\nrace checks: 3, failures: 1" \
         "inconclusive|FAIL  R1.1 [sim] the two moves genuinely overlapped (x)  [y]\nrace checks: 3, failures: 1" \
         "error|FAIL  R1.1 [sim] two desks move it at once: exactly one applied  [x]\nError: connection refused" \
         "error|"; do
  want=${c%%|*}; got=$(printf "${c#*|}" | race_verdict)
  [ "$got" = "$want" ] || { echo "race_verdict self-test: wanted $want, got $got"; exit 1; }
done
behave() {
  local draft=$1 t r f out
  build
  q -v ON_ERROR_STOP=1 -1 -f "$draft" >/dev/null 2>&1 || { echo "load-fail load-fail load-fail"; return; }
  # tests.sql counts only when a named check fails; a file that stops on an error is reported, never counted
  out=$(tests)
  if echo "$out" | grep -q "^FAIL  M"; then t=CAUGHT; elif passed "$out"; then t=pass; else t=error; fi
  # the race counts only on a BEHAVIOURAL failure (two desks: exactly one applied; move versus cancel; I1). A run with
  # no summary line crashed (error, never a catch); a run whose only failures are overlap proofs is inconclusive
  # (review R101-a): neither is counted
  r=$(race draft | race_verdict)
  stops "$(q -F'|' -f supabase/live/staff_moves_postcheck.sql)" && f=STOP || f=ok
  echo "$t $r $f"
}
mut() {
  local name=$1 race_only=${4:-}
  total=$((total+1)); tmp=$(mktemp /tmp/staffmoves.XXXXXX.sql); chmod 644 "$tmp"
  if ! python3 -c '
import sys; s=open(sys.argv[1]).read(); f=sys.argv[3]; t=sys.argv[4]
assert s.count(f)==1, s.count(f); open(sys.argv[2],"w").write(s.replace(f,t))' "$DRAFT" "$tmp" "$2" "$3"; then
    echo "  NOT APPLIED $name"; status=FAIL; rm -f "$tmp"; return
  fi
  local res; res=$(behave "$tmp"); rm -f "$tmp"
  set -- $res
  local by=""; [ "$1" = CAUGHT ] && by="tests.sql"; [ "$2" = CAUGHT ] && by="${by:+$by + }race"
  [ "$1" = error ] && echo "          tests.sql stopped on an error without a named failing check (not counted)"
  [ "$2" = error ] && echo "          the race harness crashed (no summary line): not counted"
  [ "$2" = inconclusive ] && echo "          the race harness failed only overlap proofs (a loaded machine?): not counted; re-run on an idle machine"
  if [ "$race_only" = noop ]; then   # the standing control: behaviour identical to the draft must NOT be "caught"
    total=$((total-1))
    if [ "$1 $2" != "pass pass" ]; then printf "  FAIL    %-64s tests.sql %s, race %s: both must pass\n" "$name" "$1" "$2"; status=FAIL
    elif [ -n "$by" ]; then printf "  FAIL    %-64s reported caught by %s: the counter is unreliable\n" "$name" "$by"; status=FAIL
    else printf "  ok      %-64s not caught, as it must not be (fingerprint: %s, not counted)\n" "$name" "$3"; fi
    return
  fi
  if [ -n "$by" ]; then caught=$((caught+1)); printf "  caught  %-64s by %-17s (fingerprint: %s)\n" "$name" "$by" "$3"
  else printf "  MISSED  %-64s by behaviour       (fingerprint: %s, not counted)\n" "$name" "$3"; status=FAIL; fi
  if [ "$race_only" = race-only ] && [ "$by" != "race" ]; then echo "          expected the race harness ALONE to catch this"; status=FAIL; fi
}
# control (review R101-a / R101-1): a no-op edit, a comment INSIDE the function body. Its behaviour is the draft's, so
# nothing may report it caught; its fingerprint does change (STOP), which shows a checksum mismatch is never counted
mut "X0 no-op (a comment in the body): must NOT be counted" "  select * into b from bookings where id = p_booking for update;" "  select * into b from bookings where id = p_booking for update;  -- no-op mutant" noop
mut "X1 no comparison at all" "  if b.court_id is distinct from p_seen_court                                                        -- F1" "  if false and b.court_id is distinct from p_seen_court                                                        -- F1"
mut "X2 the court only (time and length not compared)" "     or b.start_at is distinct from p_seen_start                                                     -- F1
     or b.end_at is distinct from p_seen_end then                                                    -- F1" "     then                                                    -- F1"
# X3: the comparison made on an UNLOCKED read before the row lock, and nothing else changed (staff check and order as
# in the draft). Only real concurrency tells it apart from the draft, so the race harness alone must catch it.
mut "X3 compares an unlocked read (before the lock), nothing else" "  perform lock_courts(array_remove(array[v_court, p_court], null));
  select * into b from bookings where id = p_booking for update;
  if not is_staff_of(b.club_id) then raise exception 'forbidden'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;
  if b.court_id is null then raise exception 'not_a_court_booking'; end if;
  if b.court_id is distinct from p_seen_court                                                        -- F1
     or b.start_at is distinct from p_seen_start                                                     -- F1
     or b.end_at is distinct from p_seen_end then                                                    -- F1
    raise exception 'booking_changed_elsewhere';                                                     -- F1
  end if;                                                                                            -- F1" "  select * into b from bookings where id = p_booking;
  if not is_staff_of(b.club_id) then raise exception 'forbidden'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;
  if b.court_id is null then raise exception 'not_a_court_booking'; end if;
  if b.court_id is distinct from p_seen_court or b.start_at is distinct from p_seen_start or b.end_at is distinct from p_seen_end then
    raise exception 'booking_changed_elsewhere';
  end if;
  perform lock_courts(array_remove(array[v_court, p_court], null));
  select * into b from bookings where id = p_booking for update;" race-only
mut "X4 the comparison before the staff check (another club learns where it is)" "  if not is_staff_of(b.club_id) then raise exception 'forbidden'; end if;
  if b.status" "  if b.court_id is distinct from p_seen_court then raise exception 'booking_changed_elsewhere'; end if;
  if not is_staff_of(b.club_id) then raise exception 'forbidden'; end if;
  if b.status"
mut "X5a a missing seen court matches (<> on the court line)" "  if b.court_id is distinct from p_seen_court                                                        -- F1" "  if b.court_id <> p_seen_court                                                        -- F1"
mut "X5b a missing seen start matches (<> on the start line)" "     or b.start_at is distinct from p_seen_start                                                     -- F1" "     or b.start_at <> p_seen_start                                                     -- F1"
mut "X5c a missing seen end matches (<> on the end line)" "     or b.end_at is distinct from p_seen_end then                                                    -- F1" "     or b.end_at <> p_seen_end then                                                    -- F1"
mut "X6 the 0091 call still moves (no refusal)" "begin
  raise exception 'move_needs_reload';
end \$\$;" "declare b bookings%rowtype;
begin
  select * into b from bookings where id = p_booking;
  return move_booking_priced(p_booking, p_court, p_start, p_end, p_expected_price, b.court_id, b.start_at, b.end_at);
end \$\$;"
mut "X7 anon may call it" "revoke all on function move_booking_priced(uuid, uuid, timestamptz, timestamptz, numeric, uuid, timestamptz, timestamptz) from public, anon;" "revoke all on function move_booking_priced(uuid, uuid, timestamptz, timestamptz, numeric, uuid, timestamptz, timestamptz) from public; grant execute on function move_booking_priced(uuid, uuid, timestamptz, timestamptz, numeric, uuid, timestamptz, timestamptz) to anon;"
echo "mutants caught by behaviour: $caught/$total (the fingerprint column is an integrity check, not counted)"
echo "staff moves check what the desk saw: $status"
[ "$status" = PASS ]
