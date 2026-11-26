#!/usr/bin/env bash
# Chat notices without text (H4, Paul's decision of 26 Nov). DRAFT; LOCAL ONLY (scratch databases, never staging/live).
#   PSQL="sudo -u postgres psql" bash supabase/tests/chat_privacy/notice.sh
# 1. scratch database 0001..last + seed + the legacy state (fixtures.sql, made with the current trigger: notices hold text)
# 2. preflight (read-only) passes; the postcheck run BEFORE the draft must STOP (control)
# 3. the draft; postcheck passes with the preflight's values; tests.sql (rolled back); the draft again (idempotent)
# 4. rollback: functions back to exactly 0074/0026; new notices carry text again; rewritten rows stay without text
# 5. mutants of the draft: each must make the run fail
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
export PGOPTIONS='-c client_min_messages=warning'
DRAFT=docs/chat-privacy/sql/chat_notices_without_text.draft.sql
DOWN=docs/chat-privacy/sql/chat_notices_without_text.down.draft.sql
T=courtbook_chatnotice
trap '$PSQL -q -d postgres -c "drop database if exists courtbook_chatnotice" >/dev/null 2>&1' EXIT
q() { $PSQL -d $T -X -q -At "$@" 2>&1; }
build() {
  $PSQL -q -d postgres -c "drop database if exists $T" -c "create database $T" >/dev/null || exit 2
  $PSQL -q -d $T -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
  for f in $(ls supabase/migrations/*.sql | sort); do $PSQL -q -d $T -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null || { echo "cannot build: $f"; exit 2; }; done
  $PSQL -q -d $T -f supabase/seed.sql >/dev/null 2>&1 || true
  (cd supabase/tests/chat_privacy && $PSQL -d $T -X -q -At -v ON_ERROR_STOP=1 -f fixtures.sql >/dev/null 2>&1) || { echo "fixtures failed"; exit 2; }
}
# full run against a given draft file; prints results; returns 0 only if everything passed
run() {
  local draft=$1 ok=0
  build
  pre=$(q -F'|' -f supabase/live/chat_notices_preflight.sql); echo "$pre" | sed 's/^/  pre  /'
  echo "$pre" | grep -q "|STOP$" && { echo "  preflight STOPPED"; ok=1; }
  others=$(echo "$pre" | grep '^F4' | cut -d'|' -f2); snaps=$(echo "$pre" | grep '^F5' | cut -d'|' -f2)
  ctl=$(q -F'|' -v others="$others" -v snapshots="$snaps" -f supabase/live/chat_notices_postcheck.sql)
  echo "$ctl" | grep -q "|STOP$" && echo "  control: postcheck before the draft STOPS (as it must)" || { echo "  control FAILED: postcheck passed before the draft"; ok=1; }
  q -v ON_ERROR_STOP=1 -1 -f "$draft" >/dev/null || { echo "  draft failed to load"; return 1; }
  post=$(q -F'|' -v others="$others" -v snapshots="$snaps" -f supabase/live/chat_notices_postcheck.sql); echo "$post" | sed 's/^/  post /'
  echo "$post" | grep -q "|STOP$" && ok=1
  out=$(cd supabase/tests/chat_privacy && $PSQL -d $T -X -q -At -f tests.sql 2>&1); echo "$out" | grep -v '^$' | sed 's/^/  /'
  echo "$out" | grep -qE "^(FAIL|psql)|ERROR" && ok=1
  echo "$out" | grep -q "checks: 9, failures: 0" || ok=1
  q -v ON_ERROR_STOP=1 -1 -f "$draft" >/dev/null || { echo "  second run failed"; ok=1; }
  again=$(q -F'|' -v others="$others" -v snapshots="$snaps" -f supabase/live/chat_notices_postcheck.sql)
  echo "$again" | grep -q "|STOP$" && { echo "  second run: postcheck STOPS"; ok=1; } || echo "  idempotent: the draft again, postcheck still passes"
  return $ok
}
status=PASS
echo "== the draft"
run "$DRAFT" || status=FAIL

echo "== rollback (on the migrated database)"
q -v ON_ERROR_STOP=1 -1 -f "$DOWN" >/dev/null || { echo "  rollback failed to load"; status=FAIL; }
rb=$(q -c "select md5(prosrc) from pg_proc where proname = 'match_message_notify'" -c "select md5(prosrc) from pg_proc where proname = 'claim_notifications_to_email'" | tr '\n' ' ')
[ "$rb" = "13588dcf1818f66bc24786a40b74905f f62783ef40a7fc1471a96946b35e2058 " ] && echo "  R1 both functions exactly as 0074/0026" || { echo "  R1 FAIL: $rb"; status=FAIL; }
r2=$(cd supabase/tests/chat_privacy && $PSQL -d $T -X -q -At 2>&1 <<'SQL'
begin;
\ir helpers.sql
update notifications set read_at = now() where profile_id = pg_temp.u(2);
select pg_temp.say(1, pg_temp.game(2), 'after rollback');
select (select count(*) from notifications where profile_id = pg_temp.u(2) and body = 'Karim Haddad: after rollback') || '/' ||
       (select count(*) from notifications where kind = 'match_message' and body ilike any (array['%Cedar%', '%70 123 456%', '%see you at six%', '%gate code%']));
rollback;
SQL
)
r2=$(echo "$r2" | tail -1)
[ "$r2" = "1/0" ] && echo "  R2 new notices carry the excerpt again; the rewritten rows stay without text (not restorable, by design)" || { echo "  R2 FAIL: $r2"; status=FAIL; }

echo "== mutants (each must make the run fail)"
caught=0; total=0
mut() {
  total=$((total+1)); tmp=$(mktemp /tmp/chatnotice.XXXXXX.sql); chmod 644 "$tmp"
  python3 - "$DRAFT" "$tmp" "$2" "$3" <<'PY' || { echo "  NOT APPLIED $1"; status=FAIL; rm -f "$tmp"; return; }
import sys; s=open(sys.argv[1]).read(); f=sys.argv[3]; t=sys.argv[4]
assert s.count(f)==1, s.count(f); open(sys.argv[2],'w').write(s.replace(f,t))
PY
  if run "$tmp" >/dev/null 2>&1; then echo "  MISSED  $1"; status=FAIL; else caught=$((caught+1)); echo "  caught  $1"; fi
  rm -f "$tmp"
}
mut "X1 new notices still copy the text" "'New message from ' || who);" "who || ': ' || left(new.body, 80));"
mut "X2 existing notices not rewritten" " where n.kind = 'match_message'
   and n.body is distinct from" " where false and n.kind = 'match_message'
   and n.body is distinct from"
mut "X3 the rewrite reaches other kinds" " where n.kind = 'match_message'
   and n.body is distinct from" " where n.kind is not null
   and n.body is distinct from"
mut "X4 the email claim returns stored chat text" "case when n.kind = 'match_message'   -- a chat notice's stored text is never emailed (H4)" "case when false"
mut "X5 the trigger loses the block rule" "       and not exists (select 1 from player_blocks pb where pb.blocker_id = r.pid and pb.blocked_id = new.profile_id)
" ""
echo "mutants caught: $caught/$total"
echo "chat notices without text: $status"
[ "$status" = PASS ]
