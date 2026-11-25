#!/usr/bin/env bash
# M12.1 (0093) fee-only payments: attempts, charges, refunds, cancellations — then mutation checks: each deliberate
# mistake in 0093 must make the suite fail. LOCAL ONLY (refuses any database but the local courtbook_test).
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/payments/fee_online.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
MIG=supabase/migrations/0093_fee_online_payments.sql
where=$($PSQL -At -d courtbook_test -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
T=courtbook_test
suite() { $PSQL -d $T -X -q -At -f supabase/tests/payments/fee_online_tests.sql 2>&1; }
# every function in courtbook_test, to show the run left them exactly as they were
fp() { $PSQL -At -d courtbook_test -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
before=$(fp)
out=$(suite)
echo "$out" | grep -v "^$"
status=PASS
echo "$out" | grep -qE "^(FAIL|psql)|ERROR" && status=FAIL

echo "== mutation checks (each mutant must make the suite fail)"
# Mutants are loaded into a scratch copy, never into courtbook_test: putting 0093 back afterwards would also undo
# every later migration that replaced one of its functions (0095's hold_slot), and later suites would test old code.
T=courtbook_fee_mut
$PSQL -q -d postgres -c "drop database if exists $T" -c "create database $T template courtbook_test" >/dev/null || { echo "could not make the scratch copy"; exit 2; }
trap '$PSQL -q -d postgres -c "drop database if exists courtbook_fee_mut" >/dev/null 2>&1' EXIT
# name | text in 0093 | replacement
MUTANTS=(
  "M1 a wrong amount confirms|elsif p_amount <> a.amount_usd then|elsif false then"
  "M2 a wrong currency confirms|if v_currency <> a.currency then|if false then"
  "M3 a duplicate success confirms again (no duplicate rule)|elsif p.status = 'paid' then v_outcome := 'duplicate'; v_reason := 'duplicate';|"
  "M4 a failed attempt kills the hold|      update payment_attempts set status = p_result, finished_at = now(), last_checked_at = now(), checks = checks + 1 where id = a.id;|      update payment_attempts set status = p_result, finished_at = now(), last_checked_at = now(), checks = checks + 1 where id = a.id; update bookings set status = 'expired' where id = b.id and status = 'pending';"
  "M5 the player's cancellation refunds the fee|    if p_cause <> 'club' then return false; end if;|"
  "M6 no limit on attempts|  if v_n >= 3 then raise exception 'attempts_exhausted'; end if;|"
  "M7 a new attempt after the hold's deadline|  if b.hold_expires_at is null or b.hold_expires_at <= now() then raise exception 'hold_expired'; end if;|"
  "M8 club staff may complete a fee refund|  if not is_admin() then raise exception 'forbidden'; end if;\n  if p_method|  if p_method"
  "M9 mark_refunded accepts the fee|  if p.kind = 'fee_only' then raise exception 'courtbook_fee_refund'; end if;|"
  "M10 a late success is not recorded|  v_real := a.provider <> 'simulated';|  if not (p.status = 'pending' and b.status = 'pending') then return 'late'; end if; v_real := a.provider <> 'simulated';"
  "M11 a refund can be recorded twice|    if c.refund_reference = v_ref and c.refund_amount = p_amount then return 'already_refunded'; end if;\n    raise exception 'already_refunded';|    null;"
  "M12 a \$0 fee takes the online path|    if c.service_fee_usd = 0 then|    if false then"
  "M13 any amount refunded|  if p_amount is distinct from c.amount then raise exception 'refund_amount_mismatch'; end if;|"
  "M15 two unresolved attempts allowed at once|  if exists (select 1 from payment_attempts where payment_id = p.id and status in ('starting', 'open')) then\n    raise exception 'attempt_in_progress';\n  end if;|"
  "M16 an extra charge proven by the provider's records is dropped|    values (a.provider, v_ref, a.id, a.payment_id, a.club_id, p_amount, v_currency, a.provider <> 'simulated',\n            'refund_due', 'extra_charge', now())\n    on conflict (provider, provider_ref) do nothing;|    select 1 where false;"
  "M17 a callback may add a charge to a paid attempt|    raise exception 'attempt_evidence_conflict';|    v_outcome := null;"
  "M18 refunding an extra charge marks the booking's fee refunded|provider_ref = c.attempt_id::text and c.reason is distinct from 'extra_charge';|provider_ref = c.attempt_id::text;"
  "M19 a recorded reference counts as recorded whatever its evidence|  if c.amount = p_amount and c.currency = p_currency and c.attempt_id is not distinct from p_attempt then return true; end if;|  return true;"
  "M14 an unmatched charge is dropped|  insert into fee_charges (provider, provider_ref, amount, currency, collected, disposition, reason, refund_due_at)\n  values (p_provider, v_ref, p_amount, v_currency, p_provider <> 'simulated', 'refund_due', 'unmatched', now())\n  on conflict (provider, provider_ref) do nothing;|"
)
caught=0; total=0
for m in "${MUTANTS[@]}"; do
  name=${m%%|*}; rest=${m#*|}; from=${rest%%|*}; to=${rest#*|}
  total=$((total+1))
  tmp=$(mktemp /tmp/m0093.XXXXXX); chmod 644 "$tmp"   # read by the database's own user
  FROM="$from" TO="$to" python3 -c "import os,sys; s=open(sys.argv[1]).read(); f=os.environ['FROM'].replace('\\\\n','\n'); t=os.environ['TO'].replace('\\\\n','\n'); n=s.count(f); assert n==1, (n, f); open(sys.argv[2],'w').write(s.replace(f,t))" "$MIG" "$tmp" \
    || { echo "  MUTANT NOT APPLIED: $name"; status=FAIL; rm -f "$tmp"; continue; }
  $PSQL -q -d $T -v ON_ERROR_STOP=1 -1 -f "$tmp" >/dev/null 2>&1 || { echo "  MUTANT DID NOT LOAD: $name"; status=FAIL; rm -f "$tmp"; continue; }
  mo=$(suite)
  if echo "$mo" | grep -qE "^(FAIL|psql)|ERROR"; then caught=$((caught+1)); echo "  caught  $name ($(echo "$mo" | grep -m1 '^FAIL' | cut -c1-70))"
  else echo "  MISSED  $name"; status=FAIL; fi
  rm -f "$tmp"
done
[ "$(fp)" = "$before" ] || { echo "courtbook_test's functions changed during the run"; status=FAIL; }
echo "mutants caught: $caught of $total"
echo "RESULT: $status"
[ $status = PASS ]
