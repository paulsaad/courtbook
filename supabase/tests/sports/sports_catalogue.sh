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
  # C16: every function's privileges, security mode and search_path, and table RLS, as they were before the draft
  [[ "$f" == docs/* ]] && $PSQL -q -d $DB -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema t_snap;
create table t_snap.fns as select p.oid::regprocedure::text as sig, coalesce((select array_agg(x::text order by x::text) from unnest(p.proacl) x)::text, 'default') as acl, p.prosecdef, coalesce(p.proconfig::text, '') as cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
create table t_snap.rls as select c.relname, c.relrowsecurity, coalesce(c.relacl::text, '') as acl from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r';
create table t_snap.pol as select tablename, policyname, cmd, roles::text, coalesce(qual, '') as qual, coalesce(with_check, '') as wc from pg_policies where schemaname = 'public';
SQL
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
  "$(q "$(as $ADMIN) insert into sports (code, name_en, sort_order) values ('cricket', 'Cricket', 95);
        $(as $STAFF) insert into courts (club_id, name, sport) values ($CLUB_B, 'Cricket net', 'cricket'); select sport from courts where name = 'Cricket net';")" "^cricket$"
check "C2 a player cannot add a sport" \
  "$(q "$(as $P1) insert into sports (code, name_en, sort_order) values ('cricket', 'Cricket', 95);")" "ERR .*(row-level security|permission denied)"
check "C3 club staff cannot add a global sport" \
  "$(q "$(as $STAFF) insert into sports (code, name_en, sort_order) values ('cricket', 'Cricket', 95);")" "ERR .*(row-level security|permission denied)"
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
  "$(q "$(as $STAFF) insert into courts (club_id, name, sport) values ($CLUB_B, 'X', 'curling');")" "ERR (unknown_sport|sport_inactive|.*courts_sport_fkey)"
check "C7b an unknown sport on a profile is refused" \
  "$(q "$(as $P1) update profiles set sports = '{curling}' where id = '$P1';")" "ERR unknown_sport"
check "C7c a malformed code is refused by the type itself" \
  "$(q "$(as $ADMIN) insert into sports (code, name_en, sort_order) values ('Cricket!', 'Cricket', 95);")" "ERR .*(sport_check|violates check constraint)"
check "C8 a sport used by a court cannot be deleted" \
  "$(q "$(as $ADMIN) delete from sports where code = 'padel';")" "ERR (sport_in_use|.*courts_sport_fkey|.*foreign key)"
check "C8b a sport listed only on a profile cannot be deleted either" \
  "$(q "insert into sports (code, name_en, sort_order) values ('cricket', 'Cricket', 95); update profiles set sports = '{cricket}' where id = '$P1';
        $(as $ADMIN) delete from sports where code = 'cricket';")" "ERR sport_in_use"
check "C8d a sport listed only on a coach cannot be deleted" \
  "$(q "insert into sports (code, name_en) values ('cricket', 'Cricket'); insert into coaches (profile_id, sports) values ('$P1', '{cricket}') on conflict (profile_id) do update set sports = '{cricket}';
        delete from sports where code = 'cricket';")" "ERR sport_in_use"
check "C8c an unused sport can be deleted by an admin" \
  "$(q "insert into sports (code, name_en, sort_order) values ('cricket', 'Cricket', 95); $(as $ADMIN) delete from sports where code = 'cricket'; select count(*) from sports where code = 'cricket';")" "^0$"
check "C9 club_sports lists the club's own sports alphabetically by name" \
  "$(q "insert into courts (club_id, name, sport) values ($CLUB_B, 'Bad 1', 'badminton'), ($CLUB_B, 'TT 1', 'table_tennis'), ($CLUB_B, 'Ten 1', 'tennis');
        $(as $P1) select array_to_string(club_sports($CLUB_B), ',');")" "^badminton,padel,table_tennis,tennis$"
check "C9b club_sports orders by display name, not by code" \
  "$(q "insert into sports (code, name_en) values ('aaa_zumba', 'Zumba'); insert into courts (club_id, name, sport) values ($CLUB_B, 'Z 1', 'aaa_zumba');
        $(as $P1) select array_to_string(club_sports($CLUB_B), ',');")" "^padel,aaa_zumba$"
check "C10 discovery: 'ping pong' finds a club with a table tennis court" \
  "$(q "insert into courts (club_id, name, sport) values ($BATROUN, 'TT 1', 'table_tennis');
        $(as $P1) select string_agg(slug, ',') from club_discovery(null, null, null, 'ping pong');")" "batroun"
check "C10b and without one the same search finds nothing" \
  "$(q "$(as $P1) select count(*) from club_discovery(null, null, null, 'ping pong');")" "^0$"
check "C10c a deactivated sport's name and aliases no longer find clubs (discovery and the Courts search)" \
  "$(q "insert into courts (club_id, name, sport) values ($BATROUN, 'TT 1', 'table_tennis'); update sports set active = false where code = 'table_tennis';
        $(as $P1) select (select count(*) from club_discovery(null, null, null, 'ping pong')) || ' ' || (select count(*) from club_day_slots(current_date + 1, null, null, null, 'ping pong'));")" "^0 0$"
check "C10d the Courts search (club_day_slots) finds a club by sport name or alias, like discovery" \
  "$(q "insert into courts (club_id, name, sport) values ($BATROUN, 'TT 1', 'table_tennis');
        $(as $P1) select (select count(distinct club_id) from club_day_slots(current_date + 1, null, null, null, 'ping pong')) || ' ' || (select count(distinct club_id) from club_day_slots(current_date + 1, null, null, null, 'Table Tennis'));")" "^1 1$"
check "C11 table tennis is an active catalogue sport, English name only (no Arabic name)" \
  "$(q "select name_en || '|' || (name_ar is null) || '|' || active from sports where code = 'table_tennis';")" "^Table tennis\|true\|true$"
check "C12 the old enum is gone; every sport column is the domain" \
  "$(q "select (select count(*) from pg_type where typname = 'sport_enum_retired') || '|' ||
          count(*) filter (where not (t.typtype = 'd' or (t.typelem <> 0 and (select e.typtype from pg_type e where e.oid = t.typelem) = 'd'))) || '|' || count(*)
        from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_type t on t.oid = a.atttypid
        where c.relnamespace = 'public'::regnamespace and a.attname in ('sport', 'sports', 'code') and c.relname in ('sports','courts','matches','player_levels','profiles','coaches') and c.relkind = 'r' and a.attnum > 0;")" "^0\|0\|6$"
# review 66-4 (27 Nov): levels follow the same rule as every other NEW use of a sport
check "C13 a player sets a level for an active sport" \
  "$(q "$(as $P1) select set_player_level('padel', 6); select level from player_levels where profile_id = '$P1' and sport = 'padel';")" "^6$"
check "C13b a level for a deactivated sport is refused (sport_inactive), not stored" \
  "$(q "update sports set active = false where code = 'squash'; $(as $P1) select set_player_level('squash', 4);")" "ERR sport_inactive"
check "C13c changing an existing level of a since-deactivated sport is refused (the stored level is left as it was)" \
  "$(q "insert into player_levels (profile_id, sport, level) values ('$P1', 'squash', 5); update sports set active = false where code = 'squash';
        $(as $P1) select set_player_level('squash', 8);")" "ERR sport_inactive"
check "C13d clearing a level of a deactivated sport still works" \
  "$(q "insert into player_levels (profile_id, sport, level) values ('$P1', 'squash', 5); update sports set active = false where code = 'squash';
        $(as $P1) select set_player_level('squash', null); reset role; select count(*) from player_levels where profile_id = '$P1' and sport = 'squash';")" "^0$"
check "C13e an unknown code is refused as unknown_sport (not the raw foreign-key error)" \
  "$(q "$(as $P1) select set_player_level('curling', 4);")" "^ERR unknown_sport"
check "C13f a code the catalogue added but has not activated yet: refused for levels, as for games and courts" \
  "$(q "insert into sports (code, name_en, sort_order, active) values ('cricket', 'Cricket', 95, false); $(as $P1) select set_player_level('cricket', 3);")" "ERR sport_inactive"
# an older app only sends codes it knows; the database decides. A new, not yet activated code is refused for a game
# (C3: updated clients ship before a sport is activated for real clubs)
check "C14 a game for a sport not yet activated is refused, whatever the client" \
  "$(q "insert into sports (code, name_en, sort_order, active) values ('cricket', 'Cricket', 95, false);
        insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed) values ($CLUB_B, 'cricket', '$P1', now() + interval '1 day', now() + interval '1 day 1 hour', 2);")" "ERR sport_inactive"
check "C14b a game for an unknown code is refused as unknown_sport" \
  "$(q "insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed) values ($CLUB_B, 'curling', '$P1', now() + interval '1 day', now() + interval '1 day 1 hour', 2);")" "ERR unknown_sport"
# the Supabase dashboard (table editor, SQL editor) runs as postgres, with no signed-in user
check "C15 dashboard: add a sport with only a code and a name; rename it, edit aliases, deactivate, reactivate" \
  "$(q "insert into sports (code, name_en) values ('cricket', 'Cricket');
        update sports set name_en = 'Cricket (nets)', aliases = '{bat and ball}' where code = 'cricket';
        update sports set active = false where code = 'cricket';
        update sports set active = true where code = 'cricket';
        select code || '|' || name_en || '|' || array_to_string(aliases, ',') || '|' || active from sports where code = 'cricket';")" "^cricket\|Cricket \(nets\)\|bat and ball\|true$"
check "C15b dashboard: a sport added there is choosable by players at once; deactivated there, it is not" \
  "$(q "insert into sports (code, name_en) values ('cricket', 'Cricket');
        $(as $P1) select string_agg(code, ',' order by name_en) from sports where active and code in ('cricket', 'squash');
        reset role; update sports set active = false where code = 'cricket';
        $(as $P1) select coalesce(string_agg(code, ','), '-') from sports where active and code = 'cricket';
        update profiles set sports = '{cricket}' where id = '$P1';")" "^cricket,squash
-
ERR sport_inactive$"
check "C15c dashboard: the code stays permanent and an in-use sport cannot be deleted" \
  "$(q "update sports set code = 'ping_pong' where code = 'table_tennis';")
$(q "delete from sports where code = 'padel';")" "^ERR sport_code_permanent
ERR sport_in_use$"
check "C15d dashboard: a duplicate display name is refused" \
  "$(q "insert into sports (code, name_en) values ('pingpong', 'table TENNIS');")" "ERR .*sports_name_en_unique"
check "C16 every function that existed before keeps its grants, security mode and search_path" \
  "$(q "select coalesce(string_agg(b.sig || ' ' || b.acl || '->' || coalesce(a.acl, 'GONE'), '; '), 'same') from t_snap.fns b
          left join (select p.oid::regprocedure::text as sig, coalesce((select array_agg(x::text order by x::text) from unnest(p.proacl) x)::text, 'default') as acl, p.prosecdef, coalesce(p.proconfig::text, '') as cfg
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') a using (sig)
          where a.sig is null or a.acl <> b.acl or a.prosecdef <> b.prosecdef or a.cfg <> b.cfg;")" "^same$"
check "C16b the new functions: guards are not callable by any client role; club_sports keeps its grants (C16)" \
  "$(q "select string_agg(r || ':' || f || '=' || has_function_privilege(r, f, 'execute'), ' ' order by r, f)
          from unnest(array['anon','authenticated','service_role']) r, unnest(array['sports_guard()','sport_choice_guard()','club_sports(uuid)']) f;")" "^anon:club_sports\(uuid\)=true anon:sport_choice_guard\(\)=false anon:sports_guard\(\)=false authenticated:club_sports\(uuid\)=true authenticated:sport_choice_guard\(\)=false authenticated:sports_guard\(\)=false service_role:club_sports\(uuid\)=true service_role:sport_choice_guard\(\)=true service_role:sports_guard\(\)=true$"
check "C16c every security-definer function in public pins its search_path" \
  "$(q "select coalesce(string_agg(p.oid::regprocedure::text, ', '), 'all pinned') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prosecdef and not coalesce(array_to_string(p.proconfig, ',') like '%search_path=%', false)
            and p.oid::regprocedure::text not in (select sig from t_snap.fns where prosecdef);")" "^all pinned$"
check "C16d table RLS flags and table grants are unchanged; sports policies are exactly read-all and admin-write" \
  "$(q "select coalesce(string_agg(b.relname, ','), 'same') from t_snap.rls b join pg_class c on c.relname = b.relname and c.relnamespace = 'public'::regnamespace
          where c.relrowsecurity <> b.relrowsecurity or coalesce(c.relacl::text, '') <> b.acl;
        select string_agg(policyname || '/' || cmd || '/' || roles::text, ' ' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'sports';
        select count(*) from (select tablename, policyname, cmd, roles::text, coalesce(qual, '') q, coalesce(with_check, '') w from pg_policies
                              where schemaname = 'public' and tablename <> 'sports' except select * from t_snap.pol) x;")" "^same
sports: admin/ALL/\{authenticated\} sports: read/SELECT/\{public\}
0$"
check "C16e a player cannot call the guards directly" \
  "$(q "$(as $P1) select sports_guard();")" "ERR (permission denied|trigger functions can only be called as triggers)"
# review of 412156a (B2): an empty element in a sports list is refused, and never switches the check off
check "C17 a NULL in a profile's sports is refused" \
  "$(q "$(as $P1) update profiles set sports = '{padel,NULL}' where id = '$P1';")" "ERR unknown_sport"
check "C17b with a NULL already stored, adding an inactive or unknown sport is still refused" \
  "$(q "update sports set active = false where code = 'squash'; alter table profiles disable trigger sport_choice_guard; update profiles set sports = '{padel,NULL}' where id = '$P1'; alter table profiles enable trigger sport_choice_guard;
        $(as $P1) update profiles set sports = '{padel,squash}' where id = '$P1';")$(q "alter table profiles disable trigger sport_choice_guard; update profiles set sports = '{padel,NULL}' where id = '$P1'; alter table profiles enable trigger sport_choice_guard;
        $(as $P1) update profiles set sports = '{padel,curling}' where id = '$P1';")" "^ERR sport_inactiveERR unknown_sport$"
check "C17c the same for a coach's sports" \
  "$(q "insert into coaches (profile_id, sports) values ('$P1', '{padel}') on conflict (profile_id) do update set sports = '{padel}';
        $(as $P1) update coaches set sports = '{padel,NULL,curling}' where profile_id = '$P1';")" "ERR unknown_sport"
# review of 412156a (B1): the functions are re-created in a fixed order with bodies unchecked; prove the order cannot
# matter by re-running the draft's §3 loop logic in reverse and alphabetical order on a copy of the pre-draft schema
reorder() {
  local db=courtbook_sports_order_$1
  $PSQL -q -d postgres -c "drop database if exists $db" -c "create database $db" >/dev/null || return 2
  $PSQL -q -d $db -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || return 2
  for f in $(ls supabase/migrations/*.sql | sort); do $PSQL -q -d $db -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || return 2; done
  sed "s/from _sport_fns order by sig loop/from _sport_fns order by sig $1 loop/" docs/sports/sql/sports_catalogue.draft.sql > /tmp/sc_order_$1.sql
  grep -q "order by sig $1 loop" /tmp/sc_order_$1.sql || { echo "sed failed"; return 2; }
  $PSQL -q -d $db -v ON_ERROR_STOP=1 -1 -f /tmp/sc_order_$1.sql 2>&1 | grep -E "ERROR" | sed 's/^.*ERROR:  /ERR /'
  $PSQL -q -d $db -At -c "select typtype from pg_type where typname = 'sport' and typnamespace = 'public'::regnamespace"
  $PSQL -q -d postgres -c "drop database if exists $db" >/dev/null; rm -f /tmp/sc_order_$1.sql
}
check "C18 the draft applies whatever order the functions come back in (ascending and descending)" "$(reorder asc) $(reorder desc)" "^d d$"
# review of 412156a (SF4): deleting a sport while another session adds it to a profile: the delete waits, then refuses
race_delete() {
  $PSQL -q -d $DB -c "insert into sports (code, name_en) values ('cricket', 'Cricket') on conflict do nothing" >/dev/null
  { printf '%s\n' "begin;" "update profiles set sports = '{cricket}' where id = '$P1';" "select pg_sleep(2);" "commit;" | $PSQL -d $DB -X -q -At >/dev/null 2>&1; } &
  local a=$!; sleep 0.7
  local out; out=$(printf '%s\n' "\\set VERBOSITY terse" "delete from sports where code = 'cricket';" | $PSQL -d $DB -X -q -At 2>&1 | sed 's/^.*ERROR:  /ERR /')
  wait $a
  echo "$out $($PSQL -d $DB -At -c "select count(*) from sports where code = 'cricket'")"
  $PSQL -q -d $DB -c "update profiles set sports = '{padel}' where id = '$P1'" -c "delete from sports where code = 'cricket'" >/dev/null 2>&1
}
check "C19 a delete racing a profile that adds the sport waits and is refused (sport_in_use); the sport stays" "$(race_delete)" "^ERR sport_in_use 1$"
# the other order (confirming review of f728c6b): the delete starts first and is still open when a profile adds the sport
race_delete_first() {
  $PSQL -q -d $DB -c "insert into sports (code, name_en) values ('cricket', 'Cricket') on conflict do nothing" >/dev/null
  { printf '%s\n' "begin;" "delete from sports where code = 'cricket';" "select pg_sleep(2);" "commit;" | $PSQL -d $DB -X -q -At >/dev/null 2>&1; } &
  local a=$!; sleep 0.7
  local out; out=$(printf '%s\n' "\\set VERBOSITY terse" "update profiles set sports = '{cricket}' where id = '$P1';" | $PSQL -d $DB -X -q -At 2>&1 | sed 's/^.*ERROR:  /ERR /')
  wait $a
  echo "$out $($PSQL -d $DB -At -c "select count(*) from profiles where id = '$P1' and 'cricket' = any(sports)")"
  $PSQL -q -d $DB -c "update profiles set sports = '{padel}' where id = '$P1'" >/dev/null 2>&1
}
check "C19b a profile adding a sport while its delete is in progress waits, then is refused (unknown_sport); nothing dangles" "$(race_delete_first)" "^ERR unknown_sport 0$"
check "C20 display names are stored trimmed, and unique ignoring case" \
  "$(q "insert into sports (code, name_en) values ('zumba', ' Zumba');")$(q "insert into sports (code, name_en) values ('tt2', 'TABLE TENNIS');")" "^ERR .*sports_names_trimmed.*ERR .*sports_name_en_unique.*$"
exit $status
