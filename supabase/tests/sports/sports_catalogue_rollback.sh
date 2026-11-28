#!/usr/bin/env bash
# Rollback of the sports-catalogue draft (supabase/rollback/0100_down.sql). LOCAL ONLY, scratch DBs.
#   PSQL="sudo -u postgres psql" bash supabase/tests/sports/sports_catalogue_rollback.sh
# R1  up then down = a plain build, exactly: the schema fingerprint plus types, enum labels, domains, indexes, views,
#     column types and defaults, and the seeded data.
# R2  a new sport in use (a table tennis court) blocks the rollback, and the refusal changes nothing.
# R3  a second rollback refuses (nothing to roll back); up again after down works (re-runnable).
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
UP=supabase/migrations/0100_sports_catalogue.sql; DOWN=supabase/rollback/0100_down.sql
A=courtbook_sp_plain; B=courtbook_sp_roundtrip; C=courtbook_sp_blocked
build() {
  $PSQL -q -d postgres -c "drop database if exists $1" -c "create database $1" >/dev/null || exit 2
  $PSQL -q -d $1 -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
  for f in $(ls supabase/migrations/*.sql | sort | awk -F/ '$NF < "0100"'); do $PSQL -q -d $1 -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "BUILD FAILED: $f"; exit 2; }; done
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
union all select 'fnbody ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
union all select 'data player_levels ' || md5(coalesce(string_agg(profile_id || ':' || sport::text || ':' || level, ';' order by profile_id, sport::text), '')) from player_levels
order by 1;"
fp() { { $PSQL -d $1 -X -At -v ON_ERROR_STOP=1 -f supabase/tests/schema_fingerprint.sql; $PSQL -d $1 -X -At -v ON_ERROR_STOP=1 -c "$EXTRA"; } 2>&1 | sort; }
# a fingerprint that errors would compare equal to itself: refuse to compare at all
fpa=$(fp $A); if echo "$fpa" | grep -q "ERROR"; then echo "FAIL the fingerprint queries themselves fail:"; echo "$fpa" | grep -A2 ERROR | head -5; exit 1; fi
ok "R0 the fingerprint reads $(echo "$fpa" | wc -l) items, including $(echo "$fpa" | grep -c '^index ') indexes, $(echo "$fpa" | grep -c '^type ') types and $(echo "$fpa" | grep -c '^data ') data hashes"

# R1
r=$(apply $B $UP); [ -z "$r" ] || bad "R1 up applies" "$r"
r=$(apply $B $DOWN); [ -z "$r" ] && ok "R1a down applies after up" || bad "R1a down applies after up" "$r"
d=$(diff <(fp $A) <(fp $B)); n=$(fp $A | wc -l)
[ -z "$d" ] && ok "R1b up then down = a plain 0001–$(ls supabase/migrations | awk '$0 < "0100"' | tail -1 | cut -c1-4) build: $n schema and data items identical" || bad "R1b up then down differs from a plain build" "$d"

# R2
apply $C $UP >/dev/null
$PSQL -q -d $C -c "update sports set active = true where code = 'table_tennis'" -c "insert into courts (club_id, name, sport, sort) select id, 'TT 1', 'table_tennis', 99 from clubs where slug = 'batroun'" >/dev/null
before=$(fp $C); r=$(apply $C $DOWN)
echo "$r" | grep -q "rollback_blocked: sport(s) table_tennis in use" && ok "R2a a table tennis court blocks the rollback, with the reason" || bad "R2a" "$r"
[ "$before" = "$(fp $C)" ] && ok "R2b the refused rollback changed nothing" || bad "R2b the refused rollback changed something"

# R3
r=$(apply $B $DOWN); echo "$r" | grep -q "nothing to roll back" && ok "R3a a second rollback refuses: nothing to roll back" || bad "R3a" "$r"
r=$(apply $B $UP); [ -z "$r" ] && [ "$($PSQL -d $B -At -c "select count(*) from sports where code = 'table_tennis'")" = 1 ] && ok "R3b the catalogue applies again after a rollback" || bad "R3b" "$r"
exit $status
