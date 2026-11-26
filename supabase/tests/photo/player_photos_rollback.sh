#!/usr/bin/env bash
# Rollback of the player-photo draft (docs/profile-photo/sql/player_photos.down.draft.sql). LOCAL ONLY, scratch DBs.
#   PSQL="sudo -u postgres psql" bash supabase/tests/photo/player_photos_rollback.sh
# R1  up then down = a plain build, exactly (schema fingerprint plus types, indexes, views, column types and defaults, data).
# R2  a stored photo blocks the rollback unless confirmed in the transaction; the refusal changes nothing; confirmed,
#     it removes the feature and the photos.
# R3  a second rollback refuses (nothing to roll back); up again after down works.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
UP=docs/profile-photo/sql/player_photos.draft.sql; DOWN=docs/profile-photo/sql/player_photos.down.draft.sql
A=courtbook_ph_plain; B=courtbook_ph_roundtrip; C=courtbook_ph_blocked
build() {
  $PSQL -q -d postgres -c "drop database if exists $1" -c "create database $1" >/dev/null || exit 2
  $PSQL -q -d $1 -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
  for f in $(ls supabase/migrations/*.sql | sort); do $PSQL -q -d $1 -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "BUILD FAILED: $f"; exit 2; }; done
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
[ -z "$d" ] && ok "R1b up then down = a plain 0001–$(ls supabase/migrations | tail -1 | cut -c1-4) build: $(fp $A | wc -l) schema and data items identical" || bad "R1b up then down differs from a plain build" "$d"

# R2
apply $C $UP >/dev/null
printf '%s\n' "insert into auth.users (id, phone) values ('a2000000-0000-4000-8000-000000000001', '+96171999001');" \
  "set role service_role;" "select set_player_photo('a2000000-0000-4000-8000-000000000001', decode('52494646' || '00000000' || '57454250' || repeat('00', 60), 'hex'), 192, 192);" \
  | $PSQL -q -d $C -v ON_ERROR_STOP=1 >/dev/null || bad "R2 fixture"
before=$(fp $C); r=$(apply $C $DOWN)
echo "$r" | grep -q "rollback_blocked: 1 stored photo(s) would be deleted" && ok "R2a a stored photo blocks the rollback, with the reason" || bad "R2a" "$r"
[ "$before" = "$(fp $C)" ] && [ "$($PSQL -d $C -At -c "select count(*) from player_photos")" = 1 ] && ok "R2b the refused rollback changed nothing (the photo is still there)" || bad "R2b the refused rollback changed something"
r=$({ echo "set local courtbook.discard_player_photos = 'yes';"; cat $DOWN; } | $PSQL -q -d $C -v ON_ERROR_STOP=1 -1 2>&1 | grep ERROR)
[ -z "$r" ] && [ "$($PSQL -d $C -At -c "select to_regclass('public.player_photos') is null")" = t ] && ok "R2c confirmed in the transaction, it removes the feature and its photos" || bad "R2c" "$r"

# R3
r=$(apply $B $DOWN); echo "$r" | grep -q "nothing to roll back" && ok "R3a a second rollback refuses: nothing to roll back" || bad "R3a" "$r"
r=$(apply $B $UP); [ -z "$r" ] && [ "$($PSQL -d $B -At -c "select to_regclass('public.player_photos') is not null")" = t ] && ok "R3b the photo feature applies again after a rollback" || bad "R3b" "$r"
exit $status
