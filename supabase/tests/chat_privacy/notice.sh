#!/usr/bin/env bash
# H4 (draft): a deleted chat message leaves no text in other players' Activity. Builds a scratch database from
# 0001..last + the draft, runs notice_tests.sql (rolled back), then mutants. LOCAL ONLY.
#   PSQL="sudo -u postgres psql" bash supabase/tests/chat_privacy/notice.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DRAFT=docs/chat-privacy/sql/chat_notice_follows_deletion.draft.sql
build() {   # $1 db, $2 draft file (or empty)
  $PSQL -q -d postgres -c "drop database if exists $1" -c "create database $1" >/dev/null || exit 2
  $PSQL -q -d $1 -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
  for f in $(ls supabase/migrations/*.sql | sort); do $PSQL -q -d $1 -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null || { echo "cannot build: $f"; exit 2; }; done
  $PSQL -q -d $1 -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null 2>&1 || true
  [ -n "$2" ] && { $PSQL -q -d $1 -v ON_ERROR_STOP=1 -1 -f "$2" >/dev/null || { echo "draft failed to load"; exit 2; }; }
}
suite() { (cd supabase/tests/chat_privacy && $PSQL -d $1 -X -q -At -f notice_tests.sql 2>&1); }
status=PASS
T=courtbook_chatpriv
trap '$PSQL -q -d postgres -c "drop database if exists courtbook_chatpriv" >/dev/null 2>&1' EXIT
build $T "$DRAFT"
out=$(suite $T); echo "$out" | grep -v "^$"
echo "$out" | grep -qE "^(FAIL|psql)|ERROR" && status=FAIL
echo "$out" | grep -q "checks: 6, failures: 0" || status=FAIL
echo "== mutants (each must make the suite fail)"
caught=0; total=0
mut() {  # name, sed expression on the draft
  total=$((total+1)); tmp=$(mktemp /tmp/chatmut.XXXXXX.sql); chmod 644 "$tmp"; sed "$2" "$DRAFT" > "$tmp"
  cmp -s "$tmp" "$DRAFT" && { echo "  NOT APPLIED $1"; status=FAIL; rm -f "$tmp"; return; }
  build $T "$tmp"; cp "$tmp" "$DRAFT.mut"; mo=$(cd supabase/tests/chat_privacy && sed "s#chat_notice_follows_deletion.draft.sql#chat_notice_follows_deletion.draft.sql.mut#" notice_tests.sql | $PSQL -d $T -X -q -At -f - 2>&1); rm -f "$DRAFT.mut" "$tmp"
  if echo "$mo" | grep -qE "^(FAIL|psql)|ERROR" || ! echo "$mo" | grep -q "failures: 0"; then caught=$((caught+1)); echo "  caught  $1"; else echo "  MISSED  $1"; status=FAIL; fi
}
mut "X1 no trigger" 's/^  for each row execute function chat_notice_follows_deletion();/  for each row when (false) execute function chat_notice_follows_deletion();/'
mut "X2 any sender's notice is cleared" 's/and n.actor_id = new.profile_id$/and true/'
mut "X3 no clean-up of old notices" "s/^ where n.kind = 'match_message' and n.actor_id is not null$/ where false and n.kind = 'match_message' and n.actor_id is not null/"
echo "mutants caught: $caught/$total"
echo "chat notice privacy: $status"
[ "$status" = PASS ]
