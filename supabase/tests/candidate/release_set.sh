#!/usr/bin/env bash
# 0.5.0 release-set guard (LOCAL; reads the checkout only). The 0.5.0 branch must carry exactly 0001–0093 + 0099 + 0100
# + 0101 as migrations, and their rollbacks 0099_down/0100_down/0101_down. M12's payment migrations 0094–0098 must NOT be on it: the
# staging workflow can apply only files present on the branch it runs from, so their absence is what makes an
# accidental "apply 0094" impossible (it answers "no such file on this branch").
set -u
cd "$(dirname "$0")/../../.."
fail=0
say() { printf '%-4s %s\n' "$1" "$2"; [ "$1" = ok ] || fail=1; }
nums=$(ls supabase/migrations/*.sql | xargs -n1 basename | cut -c1-4)
expected=$( (seq -f '%04g' 1 93; echo 0099; echo 0100; echo 0101) )
[ "$nums" = "$expected" ] && say ok "migrations are exactly 0001–0093, 0099, 0100, 0101 ($(echo "$nums" | wc -l) files)" \
  || say FAIL "migration set differs: $(diff <(echo "$expected") <(echo "$nums") | grep '^[<>]' | tr '\n' ' ')"
ls supabase/migrations | grep -qE '^009[4-8]' && say FAIL "a payment migration (0094–0098) is on this branch" || say ok "no 0094–0098 file"
[ "$(ls supabase/migrations | grep -c '^0099_')" = 1 ] && [ "$(ls supabase/migrations | grep -c '^0100_')" = 1 ] && [ "$(ls supabase/migrations | grep -c '^0101_player_photos')" = 1 ] \
  && say ok "one 0099, one 0100 and one 0101 (player photos)" || say FAIL "0099/0100/0101 missing or duplicated"
[ -f supabase/rollback/0099_down.sql ] && [ -f supabase/rollback/0100_down.sql ] && [ -f supabase/rollback/0101_down.sql ] && say ok "rollbacks 0099_down, 0100_down and 0101_down present" || say FAIL "a rollback is missing"
git grep -nlE "fee_online_payments|payment_reconciliation|start_payment_attempt|open_payment_attempt|reconcile_provider_charge" -- supabase/migrations src mobile/app mobile/lib mobile/shared >/dev/null \
  && say FAIL "M12 code found: $(git grep -lE 'fee_online_payments|payment_reconciliation|start_payment_attempt|open_payment_attempt|reconcile_provider_charge' -- supabase/migrations src mobile/app mobile/lib mobile/shared | tr '\n' ' ')" \
  || say ok "no M12 functions referenced by migrations, website or app"
ls docs/profile-photo/sql/*.sql >/dev/null 2>&1 && say FAIL "an unnumbered photo draft is still in docs/profile-photo/sql" || say ok "no unnumbered photo draft left (0101 is the only copy)"
grep -q "interval '30 days'" supabase/migrations/0101_player_photos.sql && grep -q "photo_hold_release_guard" supabase/migrations/0101_player_photos.sql \
  && grep -q "'table_tennis', 'Table tennis', null, 80, false" supabase/migrations/0100_sports_catalogue.sql \
  && say ok "review corrections present: I-1 (table tennis inactive), I-2 (30 days), I-3 (release guard)" || say FAIL "a #108 review correction is missing"
[ $fail = 0 ] && echo "RELEASE SET: PASS" || echo "RELEASE SET: FAIL"
exit $fail
