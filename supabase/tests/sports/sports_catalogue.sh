#!/usr/bin/env bash
# Sports catalogue draft (docs/sports/sql/sports_catalogue.draft.sql) on its own scratch database: every migration,
# the seed, then the draft, then run.sh's people and second club. LOCAL ONLY.
#   PSQL="sudo -u postgres psql" bash supabase/tests/sports/sports_catalogue.sh
# (Not on courtbook_test: run.sh re-applies every migration from 0041 at its end, which re-creates the older
# club_discovery over the draft's.) Every case runs in its own rolled-back transaction.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_sports
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
for f in $(ls supabase/migrations/*.sql | sort) docs/sports/sql/sports_catalogue.draft.sql; do
  [[ "$f" == docs/* && -n "${CONTROL:-}" ]] && continue
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "BUILD FAILED: $f"; exit 2; }
done
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
$PSQL -q -d $DB -v ON_ERROR_STOP=1 >/dev/null <<'SQL' || exit 2
insert into auth.users (id, phone) values ('11111111-1111-1111-1111-111111111111','+9611'), ('33333333-3333-3333-3333-333333333333','+9613'), ('44444444-4444-4444-4444-444444444444','+9614');
update profiles set roles = '{player,admin}' where id = '33333333-3333-3333-3333-333333333333';
insert into clubs (name, slug) values ('Other Club', 'other');
insert into courts (club_id, name, sport) select id, 'Other 1', 'padel' from clubs where slug = 'other';
insert into club_staff (club_id, profile_id) select id, '44444444-4444-4444-4444-444444444444' from clubs where slug = 'other';
SQL
status=0
q() { printf '%s\n' "\\set VERBOSITY terse" "begin;" "$1" "rollback;" | $PSQL -d $DB -X -q -At -v ON_ERROR_STOP=1 2>&1 | sed 's/^.*ERROR:  /ERR /'; }
check() { if echo "$2" | grep -Eq "$3"; then echo "ok   $1"; else echo "FAIL $1"; echo "     got: $(echo "$2" | tr '\n' ' ')"; status=1; fi; }
P1=11111111-1111-1111-1111-111111111111; ADMIN=33333333-3333-3333-3333-333333333333; STAFF=44444444-4444-4444-4444-444444444444
as() { echo "set local role authenticated; set local request.jwt.claim.sub = '$1';"; }
CLUB_B="(select id from clubs where slug = 'other')"
BATROUN="(select id from clubs where slug = 'batroun')"

check "C1 an admin adds a sport (cricket); club staff can then create a court of it" \
  "$(q "$(as $ADMIN) insert into sports (code, name_en, name_ar, sort_order) values ('cricket', 'Cricket', 'كريكيت', 95);
        $(as $STAFF) insert into courts (club_id, name, sport) values ($CLUB_B, 'Cricket net', 'cricket'); select sport from courts where name = 'Cricket net';")" "^cricket$"
check "C2 a player cannot add a sport" \
  "$(q "$(as $P1) insert into sports (code, name_en, name_ar, sort_order) values ('cricket', 'Cricket', 'كريكيت', 95);")" "ERR .*(row-level security|permission denied)"
check "C3 club staff cannot add a global sport" \
  "$(q "$(as $STAFF) insert into sports (code, name_en, name_ar, sort_order) values ('cricket', 'Cricket', 'كريكيت', 95);")" "ERR .*(row-level security|permission denied)"
check "C4 a sport's code is permanent (even for an admin)" \
  "$(q "$(as $ADMIN) update sports set code = 'ping_pong' where code = 'table_tennis';")" "ERR sport_code_permanent"
check "C4b an admin renames a sport and edits its aliases" \
  "$(q "$(as $ADMIN) update sports set name_en = 'Table Tennis', aliases = '{ping pong,tt}' where code = 'table_tennis'; select name_en || '|' || array_to_string(aliases, ',') from sports where code = 'table_tennis';")" "^Table Tennis\|ping pong,tt$"
check "C5 deactivating a sport keeps its courts, their bookings and its levels exactly as they were" \
  "$(q "insert into courts (club_id, name, sport) values ($BATROUN, 'Sq 1', 'squash');
        insert into player_levels (profile_id, sport, level) values ('$P1', 'squash', 5) on conflict do nothing;
        $(as $ADMIN) update sports set active = false where code = 'squash';
        reset role;
        select (select count(*) from courts where name = 'Sq 1' and active and sport = 'squash') || '/' || (select count(*) from player_levels where profile_id = '$P1' and sport = 'squash');")" "^1/1$"
check "C5b a new court of a deactivated sport is refused" \
  "$(q "update sports set active = false where code = 'squash'; $(as $STAFF) insert into courts (club_id, name, sport) values ($CLUB_B, 'Sq 2', 'squash');")" "ERR sport_inactive"
check "C5c an existing court of a deactivated sport can still be renamed" \
  "$(q "insert into courts (club_id, name, sport) values ($CLUB_B, 'Sq 3', 'squash'); update sports set active = false where code = 'squash';
        $(as $STAFF) update courts set name = 'Squash Three' where name = 'Sq 3'; select name from courts where name = 'Squash Three';")" "^Squash Three$"
check "C6 a player cannot ADD a deactivated sport to their profile" \
  "$(q "update sports set active = false where code = 'squash'; $(as $P1) update profiles set sports = '{padel,squash}' where id = '$P1';")" "ERR sport_inactive"
check "C6b a player who already had it keeps it when changing other things" \
  "$(q "update profiles set sports = '{padel,squash}' where id = '$P1'; update sports set active = false where code = 'squash';
        $(as $P1) update profiles set name = 'Renamed', sports = '{squash,padel}' where id = '$P1'; select array_to_string(sports, ',') from profiles where id = '$P1';")" "^squash,padel$"
check "C7 an unknown sport on a court is refused" \
  "$(q "$(as $STAFF) insert into courts (club_id, name, sport) values ($CLUB_B, 'X', 'curling');")" "ERR (sport_inactive|.*courts_sport_fkey)"
check "C7b an unknown sport on a profile is refused" \
  "$(q "$(as $P1) update profiles set sports = '{curling}' where id = '$P1';")" "ERR unknown_sport"
check "C7c a malformed code is refused by the type itself" \
  "$(q "$(as $ADMIN) insert into sports (code, name_en, name_ar, sort_order) values ('Cricket!', 'Cricket', 'كريكيت', 95);")" "ERR .*(sport_check|violates check constraint)"
check "C8 a sport used by a court cannot be deleted" \
  "$(q "$(as $ADMIN) delete from sports where code = 'padel';")" "ERR (sport_in_use|.*courts_sport_fkey|.*foreign key)"
check "C8b a sport listed only on a profile cannot be deleted either" \
  "$(q "insert into sports (code, name_en, name_ar, sort_order) values ('cricket', 'Cricket', 'كريكيت', 95); update profiles set sports = '{cricket}' where id = '$P1';
        $(as $ADMIN) delete from sports where code = 'cricket';")" "ERR sport_in_use"
check "C8c an unused sport can be deleted by an admin" \
  "$(q "insert into sports (code, name_en, name_ar, sort_order) values ('cricket', 'Cricket', 'كريكيت', 95); $(as $ADMIN) delete from sports where code = 'cricket'; select count(*) from sports where code = 'cricket';")" "^0$"
check "C9 club_sports lists the club's own sports alphabetically by name" \
  "$(q "insert into courts (club_id, name, sport) values ($CLUB_B, 'Bad 1', 'badminton'), ($CLUB_B, 'TT 1', 'table_tennis'), ($CLUB_B, 'Ten 1', 'tennis');
        $(as $P1) select array_to_string(club_sports($CLUB_B), ',');")" "^badminton,padel,table_tennis,tennis$"
check "C10 discovery: 'ping pong' finds a club with a table tennis court" \
  "$(q "insert into courts (club_id, name, sport) values ($BATROUN, 'TT 1', 'table_tennis');
        $(as $P1) select string_agg(slug, ',') from club_discovery(null, null, null, 'ping pong');")" "batroun"
check "C10b and without one the same search finds nothing" \
  "$(q "$(as $P1) select count(*) from club_discovery(null, null, null, 'ping pong');")" "^0$"
check "C11 table tennis is an active catalogue sport with its Arabic name" \
  "$(q "select name_en || '|' || name_ar || '|' || active from sports where code = 'table_tennis';")" "^Table tennis\|كرة الطاولة\|true$"
check "C12 the old enum is gone; every sport column is the domain" \
  "$(q "select count(*) from pg_type where typname = 'sport_enum_retired'; select string_agg(distinct format_type(atttypid, atttypmod), ',') from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace = 'public'::regnamespace and a.attname in ('sport', 'sports') and c.relkind = 'r' and a.attnum > 0;")" "^0 *$|sport"
exit $status
