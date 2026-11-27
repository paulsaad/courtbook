#!/usr/bin/env bash
# 0.5.0 release-set guard (LOCAL; reads the checkout only). The 0.5.0 branch must carry exactly 0001–0093 + 0099 + 0100
# as migrations, and their rollbacks 0099_down/0100_down. M12's payment migrations 0094–0098 must NOT be on it: the
# staging workflow can apply only files present on the branch it runs from, so their absence is what makes an
# accidental "apply 0094" impossible (it answers "no such file on this branch").
set -u
cd "$(dirname "$0")/../../.."
fail=0
say() { printf '%-4s %s\n' "$1" "$2"; [ "$1" = ok ] || fail=1; }
nums=$(ls supabase/migrations/*.sql | xargs -n1 basename | cut -c1-4)
expected=$( (seq -f '%04g' 1 93; echo 0099; echo 0100) )
[ "$nums" = "$expected" ] && say ok "migrations are exactly 0001–0093, 0099, 0100 ($(echo "$nums" | wc -l) files)" \
  || say FAIL "migration set differs: $(diff <(echo "$expected") <(echo "$nums") | grep '^[<>]' | tr '\n' ' ')"
ls supabase/migrations | grep -qE '^009[4-8]' && say FAIL "a payment migration (0094–0098) is on this branch" || say ok "no 0094–0098 file"
[ "$(ls supabase/migrations | grep -c '^0099_')" = 1 ] && [ "$(ls supabase/migrations | grep -c '^0100_')" = 1 ] && say ok "one 0099 and one 0100" || say FAIL "0099/0100 missing or duplicated"
[ -f supabase/rollback/0099_down.sql ] && [ -f supabase/rollback/0100_down.sql ] && say ok "rollbacks 0099_down.sql and 0100_down.sql present" || say FAIL "a rollback is missing"
git grep -nlE "fee_online_payments|payment_reconciliation|start_payment_attempt|open_payment_attempt|reconcile_provider_charge" -- supabase/migrations src mobile/app mobile/lib mobile/shared >/dev/null \
  && say FAIL "M12 code found: $(git grep -lE 'fee_online_payments|payment_reconciliation|start_payment_attempt|open_payment_attempt|reconcile_provider_charge' -- supabase/migrations src mobile/app mobile/lib mobile/shared | tr '\n' ' ')" \
  || say ok "no M12 functions referenced by migrations, website or app"
ls supabase/migrations | grep -qiE 'photo' && say FAIL "a photo migration is on this branch (photos are held)" || say ok "no player-photo migration (held out of 0.5.0)"
[ $fail = 0 ] && echo "RELEASE SET: PASS" || echo "RELEASE SET: FAIL"
exit $fail
