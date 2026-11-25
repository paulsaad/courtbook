#!/usr/bin/env bash
# M12.2 (0095) reconciliation: watermark, issues, health — then mutation checks: each deliberate mistake in 0095 must
# make the suite fail. LOCAL ONLY (refuses anything but a local database; default courtbook_test, or DB=<name>).
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/payments/reconciliation.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=${DB:-courtbook_test}
MIG=supabase/migrations/0095_payment_reconciliation.sql
where=$($PSQL -At -d "$DB" -c "select coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in local-socket|127.0.0.1|::1) ;; *) echo "refusing: $DB@$where"; exit 2;; esac
T=$DB
suite() { $PSQL -d "$T" -X -q -At -f supabase/tests/payments/reconciliation_tests.sql 2>&1; }
fp() { $PSQL -At -d "$DB" -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
before=$(fp)
out=$(suite)
echo "$out" | grep -v "^$"
status=PASS
echo "$out" | grep -qE "^(FAIL|psql)|ERROR" && status=FAIL
echo "$out" | grep -q ' 0 failed$' || status=FAIL

echo "== mutation checks (each mutant must make the suite fail)"
# mutants go into a scratch copy, never into $DB (putting a migration back could undo later ones)
T=courtbook_rec_mut
$PSQL -q -d postgres -c "drop database if exists $T" -c "create database $T template $DB" >/dev/null || { echo "could not make the scratch copy"; exit 2; }
trap '$PSQL -q -d postgres -c "drop database if exists courtbook_rec_mut" >/dev/null 2>&1' EXIT
MUTANTS=(
  "M1 the starting point can be set twice|  if exists (select 1 from payment_reconciliation where provider = p_provider) then raise exception 'already_initialised'; end if;|"
  "M2 a starting point in the future|  if p_from is null or p_from > now() then raise exception 'bad_watermark'; end if;|"
  "M3 the watermark can move back by advancing|reconciled_until = greatest(reconciled_until, p_until)|reconciled_until = p_until"
  "M4 rewinding can move it forward|reconciled_until = least(reconciled_until, p_to)|reconciled_until = p_to"
  "M5 anyone signed in resolves an issue|  if not is_admin() then raise exception 'forbidden'; end if;\n  if p_resolution|  if p_resolution"
  "M6 a resolution without text|  if p_resolution is null or btrim(p_resolution) = '' then raise exception 'resolution_required'; end if;|"
  "M7 new evidence does not reopen a resolved issue|    resolved_at = case when payment_reconciliation_issues.amount is not distinct from excluded.amount|    resolved_at = case when true or payment_reconciliation_issues.amount is not distinct from excluded.amount"
  "M8 every signed-in person reads the issues|for select to authenticated using (is_admin());|for select to authenticated using (true);"
  "M9 signed-in people may move the watermark|grant execute on function resolve_reconciliation_issue(uuid, text) to authenticated;|grant execute on function resolve_reconciliation_issue(uuid, text), advance_reconciliation_watermark(text, timestamptz), rewind_reconciliation_watermark(text, timestamptz) to authenticated;"
  "M10 the overturned resolution is not kept|      then payment_reconciliation_issues.resolution else payment_reconciliation_issues.last_resolution end,|      then null else payment_reconciliation_issues.last_resolution end,"
)
caught=0; total=0
for m in "${MUTANTS[@]}"; do
  name=${m%%|*}; rest=${m#*|}; from=${rest%%|*}; to=${rest#*|}
  total=$((total+1))
  tmp=$(mktemp /tmp/m0095.XXXXXX); chmod 644 "$tmp"
  FROM="$from" TO="$to" python3 -c "import os,sys; s=open(sys.argv[1]).read(); f=os.environ['FROM'].replace('\\\\n','\n'); t=os.environ['TO'].replace('\\\\n','\n'); n=s.count(f); assert n==1, (n, f); open(sys.argv[2],'w').write(s.replace(f,t))" "$MIG" "$tmp" \
    || { echo "  MUTANT NOT APPLIED: $name"; status=FAIL; rm -f "$tmp"; continue; }
  $PSQL -q -d "$T" -v ON_ERROR_STOP=1 -1 -f "$tmp" >/dev/null 2>&1 || { echo "  MUTANT DID NOT LOAD: $name"; status=FAIL; rm -f "$tmp"; continue; }
  mo=$(suite)
  if echo "$mo" | grep -qE "^(FAIL|psql)|ERROR"; then caught=$((caught+1)); echo "  caught  $name ($(echo "$mo" | grep -m1 '^FAIL' | cut -c1-70))"
  else echo "  MISSED  $name"; status=FAIL; fi
  rm -f "$tmp"
done
[ "$(fp)" = "$before" ] || { echo "$DB's functions changed during the run"; status=FAIL; }
echo "mutants caught: $caught of $total"
echo "RESULT: $status"
[ $status = PASS ]
