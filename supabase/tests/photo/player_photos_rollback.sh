#!/usr/bin/env bash
# Rollback of 0101 (supabase/rollback/0101_down.sql), on builds of 0001–0100. LOCAL ONLY, scratch DBs.
#   PSQL="sudo -u postgres psql" bash supabase/tests/photo/player_photos_rollback.sh
# R1  up then down = a plain build, exactly (schema fingerprint plus types, indexes, views, column types and defaults, data).
# R2  a stored photo blocks the rollback unless confirmed in the transaction; the refusal changes nothing; confirmed,
#     it removes the feature and the photos.
# R3  a second rollback refuses (nothing to roll back); up again after down works.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
UP=supabase/migrations/0101_player_photos.sql; DOWN=supabase/rollback/0101_down.sql
A=courtbook_ph_plain; B=courtbook_ph_roundtrip; C=courtbook_ph_blocked
build() {
  $PSQL -q -d postgres -c "drop database if exists $1" -c "create database $1" >/dev/null || exit 2
  $PSQL -q -d $1 -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
  for f in $(ls supabase/migrations/*.sql | sort | awk -F/ '$NF < "0101"'); do $PSQL -q -d $1 -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "BUILD FAILED: $f"; exit 2; }; done
  $PSQL -q -d $1 -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
}
apply() { $PSQL -q -d $1 -v ON_ERROR_STOP=1 -1 -f "$2" 2>&1 | grep -E "ERROR" | sed 's/^.*ERROR:  //'; }
build $A; build $B; build $C
trap '$PSQL -q -d postgres -c "drop database if exists $A" -c "drop database if exists $B" -c "drop database if exists $C" >/dev/null' EXIT
status=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; [ -n "${2:-}" ] && echo "$2" | head -20 | sed 's/^/     /'; status=1; }
EXTRA="
select 'type ' || t.typname || ' ' || t.typtype::text || ' ' || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '')
  || coalesce(' base=' || format_type(t.typbasetype, t.typtypmod), '') || coalesce(' check=' || (select string_agg(pg_get_constraintdef(c.oid), ';') from pg_constraint c where c.contypid = t.oid), '')
from pg_type t where t.typnamespace = 'public'::regnamespace and t.typtype in ('e','d')
union all select 'index ' || indexname || ' ' || md5(indexdef) from pg_indexes where schemaname = 'public'
union all select 'view ' || viewname || ' ' || md5(definition) from pg_views where schemaname = 'public'
union all select 'coltype ' || table_name || '.' || column_name || ' ' || udt_name || ' ' || is_nullable || ' ' || coalesce(column_default, '-') from information_schema.columns where table_schema = 'public'
union all select 'data sports ' || md5(string_agg(format('%s|%s|%s|%s|%s', code, name_en, name_ar, sort_order, active), ';' order by code)) from sports
union all select 'data courts ' || md5(string_agg(k.name || '@' || c.slug || ':' || k.sport::text || ':' || k.active, ';' order by c.slug, k.name)) from courts k join clubs c on c.id = k.club_id
union all select 'data profiles ' || md5(coalesce(string_agg(id || ':' || sports::text, ';' order by id), '')) from profiles
union all select 'data player_levels ' || md5(coalesce(string_agg(profile_id || ':' || sport::text || ':' || level, ';' order by profile_id, sport::text), '')) from player_levels
order by 1;"
fp() { { $PSQL -d $1 -X -At -v ON_ERROR_STOP=1 -f supabase/tests/schema_fingerprint.sql; $PSQL -d $1 -X -At -v ON_ERROR_STOP=1 -c "$EXTRA"; } 2>&1 | sort; }
# a fingerprint that errors would compare equal to itself: refuse to compare at all
fpa=$(fp $A); if echo "$fpa" | grep -q "ERROR"; then echo "FAIL the fingerprint queries themselves fail:"; echo "$fpa" | grep -A2 ERROR | head -5; exit 1; fi
ok "R0 the fingerprint reads $(echo "$fpa" | wc -l) items, including $(echo "$fpa" | grep -c '^index ') indexes, $(echo "$fpa" | grep -c '^type ') types and $(echo "$fpa" | grep -c '^data ') data hashes"

# R1
r=$(apply $B $UP); [ -z "$r" ] || bad "R1 up applies" "$r"
r=$(apply $B $DOWN); [ -z "$r" ] && ok "R1a down applies after up" || bad "R1a down applies after up" "$r"
d=$(diff <(fp $A) <(fp $B))
[ -z "$d" ] && ok "R1b up then down = a plain 0001–$(ls supabase/migrations | awk '$0 < "0101"' | tail -1 | cut -c1-4) build: $(fp $A | wc -l) schema and data items identical" || bad "R1b up then down differs from a plain build" "$d"

# R2
apply $C $UP >/dev/null
printf '%s\n' "insert into auth.users (id, phone) values ('a2000000-0000-4000-8000-000000000001', '+96171999001');" \
  "set role service_role;" "select set_player_photo('a2000000-0000-4000-8000-000000000001', decode('52494646' || '00000000' || '57454250' || repeat('00', 60), 'hex'), 192, 192);" \
  | $PSQL -q -d $C -v ON_ERROR_STOP=1 >/dev/null || bad "R2 fixture"
before=$(fp $C); r=$(apply $C $DOWN)
echo "$r" | grep -q "rollback_blocked: 1 stored photo(s) and 0 evidence copies would be deleted" && ok "R2a a stored photo blocks the rollback, with the reason" || bad "R2a" "$r"
[ "$before" = "$(fp $C)" ] && [ "$($PSQL -d $C -At -c "select count(*) from player_photos")" = 1 ] && ok "R2b the refused rollback changed nothing (the photo is still there)" || bad "R2b the refused rollback changed something"
r=$({ echo "set local courtbook.discard_player_photos = 'yes';"; cat $DOWN; } | $PSQL -q -d $C -v ON_ERROR_STOP=1 -1 2>&1 | grep ERROR)
[ -z "$r" ] && [ "$($PSQL -d $C -At -c "select to_regclass('public.player_photos') is null")" = t ] && ok "R2c confirmed in the transaction, it removes the feature and its photos" || bad "R2c" "$r"

# R4 (review of b89b9ff, finding 8): an admin removal is in the append-only log; the rollback keeps the wider action
# list (so that record stays valid), says so, and the feature applies again afterwards
apply $C $UP >/dev/null
printf '%s\n' "insert into moderation_log (action, profile_id, note) values ('hide_photo', 'a2000000-0000-4000-8000-000000000001', 'test');" \
  | $PSQL -q -d $C -v ON_ERROR_STOP=1 >/dev/null || bad "R4 fixture"
r=$($PSQL -q -d $C -v ON_ERROR_STOP=1 -1 -f $DOWN 2>&1)
echo "$r" | grep -q "keeps its photo moderation entries" && ! echo "$r" | grep -q ERROR \
  && [ "$($PSQL -d $C -At -c "select pg_get_constraintdef(oid) like '%hide_photo%' from pg_constraint where conname = 'moderation_log_action_check'")" = t ] \
  && [ "$($PSQL -d $C -At -c "select count(*) from moderation_log where action = 'hide_photo'")" = 1 ] \
  && ok "R4a with a hide_photo entry in the log: the rollback keeps the entry and the wider action list, and says so" || bad "R4a" "$r"
r=$(apply $C $UP); [ -z "$r" ] && ok "R4b the feature applies again after that rollback" || bad "R4b" "$r"

# R5 (decision 4): photo evidence of an open report, or one on legal hold, is never discarded by a rollback, even
# confirmed; once the report is closed and not held, it goes only with the confirmation
U=a2000000-0000-4000-8000-000000000001; V=a2000000-0000-4000-8000-000000000002
printf '%s\n' "insert into auth.users (id, phone) values ('$V', '+96171999002') on conflict do nothing;" \
  "insert into reports (id, reporter_id, target_kind, profile_id, target_key, reason) values ('a2000000-0000-4000-8000-0000000000f1', '$V', 'player', '$U', '$U', 'inappropriate');" \
  "insert into photo_evidence (report_id, profile_id, image, width, height, version, reason) values ('a2000000-0000-4000-8000-0000000000f1', '$U', decode('52494646' || '00000000' || '57454250' || repeat('00', 60), 'hex'), 192, 192, 1, 'reported');" \
  | $PSQL -q -d $C -v ON_ERROR_STOP=1 >/dev/null || bad "R5 fixture"
before=$(fp $C)
r=$({ echo "set local courtbook.discard_player_photos = 'yes';"; cat $DOWN; } | $PSQL -q -d $C -v ON_ERROR_STOP=1 -1 2>&1 | grep ERROR)
echo "$r" | grep -q "rollback_blocked: 1 photo evidence copies belong to open reports" && [ "$before" = "$(fp $C)" ] \
  && ok "R5a evidence on an open report blocks the rollback even when confirmed, and nothing changes" || bad "R5a" "$r"
$PSQL -q -d $C -c "update reports set legal_hold = true, status = 'dismissed', closed_at = now() where id = 'a2000000-0000-4000-8000-0000000000f1'" >/dev/null
r=$({ echo "set local courtbook.discard_player_photos = 'yes';"; cat $DOWN; } | $PSQL -q -d $C -v ON_ERROR_STOP=1 -1 2>&1 | grep ERROR)
echo "$r" | grep -q "rollback_blocked: 1 photo evidence copies belong to open reports, reports on legal hold" && ok "R5b … and so does evidence on a closed report under legal hold" || bad "R5b" "$r"
$PSQL -q -d $C -c "update reports set legal_hold = false where id = 'a2000000-0000-4000-8000-0000000000f1'" >/dev/null
# I-3: released less than 30 days ago, the copy is still protected, confirmed or not
r=$({ echo "set local courtbook.discard_player_photos = 'yes';"; cat $DOWN; } | $PSQL -q -d $C -v ON_ERROR_STOP=1 -1 2>&1 | grep ERROR)
echo "$r" | grep -q "rollback_blocked: 1 photo evidence copies belong to .*recently released" && ok "R5b2 … and evidence released from legal hold less than 30 days ago (I-3)" || bad "R5b2" "$r"
$PSQL -q -d $C -c "update reports set legal_hold_released_at = now() - interval '31 days' where id = 'a2000000-0000-4000-8000-0000000000f1'" >/dev/null
r=$(apply $C $DOWN); echo "$r" | grep -q "rollback_blocked: 0 stored photo(s) and 1 evidence copies" && ok "R5c closed and not held: blocked without the confirmation" || bad "R5c" "$r"
r=$({ echo "set local courtbook.discard_player_photos = 'yes';"; cat $DOWN; } | $PSQL -q -d $C -v ON_ERROR_STOP=1 -1 2>&1 | grep ERROR)
[ -z "$r" ] && [ "$($PSQL -d $C -At -c "select to_regclass('public.photo_evidence') is null")" = t ] && ok "R5d … and removed with it" || bad "R5d" "$r"

# R3
r=$(apply $B $DOWN); echo "$r" | grep -q "nothing to roll back" && ok "R3a a second rollback refuses: nothing to roll back" || bad "R3a" "$r"
r=$(apply $B $UP); [ -z "$r" ] && [ "$($PSQL -d $B -At -c "select to_regclass('public.player_photos') is not null")" = t ] && ok "R3b the photo feature applies again after a rollback" || bad "R3b" "$r"
# R6 (review of 02e7d06, S2): while a rollback runs, no new report (whose photo copy the drops would lose) can be filed
# a pause right after the guard's check (the first "end $$;"), where a report filed would otherwise slip in before the drops
awk 'BEGIN{d=0} {print} /^end \$\$;$/ && !d {print "select pg_sleep(2);"; d=1}' $DOWN > /tmp/ph_down_paused.sql
grep -q "pg_sleep(2)" /tmp/ph_down_paused.sql || bad "R6 fixture"
{ { echo "begin;"; cat /tmp/ph_down_paused.sql; echo "rollback;"; } | $PSQL -q -d $B -v ON_ERROR_STOP=1 >/dev/null 2>&1; } &
rb=$!; sleep 0.8
r=$(printf '%s\n' "set lock_timeout = '500ms';" "insert into reports (reporter_id, target_kind, target_key, reason) values (gen_random_uuid(), 'player', gen_random_uuid(), 'spam');" | $PSQL -q -d $B 2>&1)
wait $rb
echo "$r" | grep -q "lock timeout" && ok "R6 a report filed during the rollback waits for it (tables locked before the check)" || bad "R6" "$r"
r=$($PSQL -d $A -At -c "select count(*) from pg_class where relname = 'player_photo_version_seq'")
[ "$r" = 0 ] && [ "$($PSQL -d $B -At -c "select count(*) from pg_class where relname = 'player_photo_version_seq'")" = 1 ] && ok "R6b the version sequence exists with the feature and only then" || bad "R6b"
exit $status
