#!/usr/bin/env bash
# Table-privilege hardening draft (docs/privileges/sql/table_privileges.draft.sql). LOCAL ONLY, scratch databases.
#   PSQL="sudo -u postgres psql" bash supabase/tests/privileges/table_privileges.sh
# Two databases from the same migrations (0001–0093) and seed: BASE without the draft, HARD with it.
#   Part 1  invariants on HARD (and, as a control, on BASE, where they must fail).
#   Part 2  the app's own writes, as a player, desk staff, a coach and an admin, run on BOTH databases, each case in
#           its own rolled-back transaction. The two outputs must be identical, except the declared cases that are
#           direct attempts at something no policy allows (BASE: silently nothing / RLS error; HARD: permission denied).
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
BASE=courtbook_priv_base; HARD=courtbook_priv_hard
DRAFT=docs/privileges/sql/table_privileges.draft.sql
build() {
  $PSQL -q -d postgres -c "drop database if exists $1" -c "create database $1" >/dev/null || exit 2
  $PSQL -q -d $1 -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
  for f in $(ls supabase/migrations/*.sql | sort) $2; do
    $PSQL -q -d $1 -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "BUILD FAILED: $1 $f"; exit 2; }
  done
  $PSQL -q -d $1 -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
}
build $BASE ""; build $HARD "$DRAFT"
trap '$PSQL -q -d postgres -c "drop database if exists $BASE" -c "drop database if exists $HARD" >/dev/null' EXIT
status=0
ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; [ -n "${2:-}" ] && echo "     $2"; status=1; }
val() { $PSQL -d $1 -X -At -c "$2" 2>&1; }

# ---- Part 1: invariants ------------------------------------------------------------------------------------------
EXTRA="select coalesce(string_agg(r || ':' || c.relname || ':' || p, ' ' order by r, c.relname, p), 'none') from pg_class c, unnest(array['anon','authenticated']) r, unnest(array['TRUNCATE','TRIGGER','REFERENCES']) p
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m') and has_table_privilege(r, c.oid, p)"
UNUSABLE="select coalesce(string_agg(c.relname || ':' || k.cmd, ' ' order by c.relname, k.cmd), 'none') from pg_class c, unnest(array['INSERT','UPDATE','DELETE']) as k(cmd)
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and has_table_privilege('authenticated', c.oid, k.cmd)
         and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.cmd in (k.cmd, 'ALL')
                         and p.permissive = 'PERMISSIVE' and p.roles && array['authenticated','public']::name[])"
MATRIX="select string_agg(c.relname || '=' || (select coalesce(string_agg(left(p,1), '' order by p), '-') from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where has_table_privilege('%s', c.oid, p)), ' ' order by c.relname)
       from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m')"
COLS="select string_agg(c.relname || '.' || a.attname || '=' || a.attacl::text, ' ' order by c.relname, a.attname) from pg_attribute a join pg_class c on c.oid = a.attrelid
       where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and a.attacl is not null"
DEF="select string_agg(defaclacl::text, ' ') from pg_default_acl where defaclnamespace = 'public'::regnamespace and defaclobjtype = 'r' and pg_get_userbyid(defaclrole) = 'postgres'"

r=$(val $HARD "$EXTRA"); [ "$r" = none ] && ok "V1 no TRUNCATE, TRIGGER or REFERENCES for visitors or players on any table" || bad "V1" "$r"
r=$(val $BASE "$EXTRA"); [ "$r" != none ] && ok "V1c control: without the draft, players hold them ($(echo "$r" | wc -w) grants)" || bad "V1c control"
r=$(val $HARD "$UNUSABLE"); [ "$r" = none ] && ok "V2 every INSERT/UPDATE/DELETE a player holds is usable through a policy" || bad "V2" "$r"
r=$(val $BASE "$UNUSABLE"); [ "$r" != none ] && ok "V2c control: without the draft, $(echo "$r" | wc -w) unusable write privileges" || bad "V2c control"
[ "$(val $BASE "$(printf "$MATRIX" anon)")" = "$(val $HARD "$(printf "$MATRIX" anon)")" ] && ok "V3 visitors' (anon) table rights unchanged" || bad "V3"
[ "$(val $BASE "$(printf "$MATRIX" service_role)")" = "$(val $HARD "$(printf "$MATRIX" service_role)")" ] && ok "V4 the server key's (service_role) table rights unchanged" || bad "V4"
b=$(val $BASE "$(printf "$MATRIX" authenticated)" | tr ' ' '\n' | sed 's/=.*S.*/=S/;s/=[^S]*$/=-/'); h=$(val $HARD "$(printf "$MATRIX" authenticated)" | tr ' ' '\n' | sed 's/=.*S.*/=S/;s/=[^S]*$/=-/')
[ "$b" = "$h" ] && ok "V5 players' SELECT unchanged on every table" || bad "V5" "$(diff <(echo "$b") <(echo "$h") | tr '\n' ' ')"
[ "$(val $BASE "$COLS")" = "$(val $HARD "$COLS")" ] && ok "V6 column-level grants unchanged (club_media and towns read columns, notifications.read_at)" || bad "V6"
r=$(val $HARD "$DEF"); echo "$r" | grep -q "authenticated=arwd/postgres" && ! echo "$r" | grep -q "anon=[a-zA-Z]*[Dxt]" && ok "V7 new tables get no TRUNCATE/TRIGGER/REFERENCES by default ($r)" || bad "V7" "$r"
r=$(printf '%s\n' "begin;" "create table public.zz_new (id int);" "select has_table_privilege('authenticated','public.zz_new','TRUNCATE')::text || has_table_privilege('authenticated','public.zz_new','INSERT')::text;" "rollback;" | $PSQL -d $HARD -X -q -At 2>&1)
[ "$r" = "falsetrue" ] && ok "V7b a table created after the draft: no TRUNCATE, ordinary rights kept" || bad "V7b" "$r"
snap() { echo "$(printf "$MATRIX" authenticated); $(printf "$MATRIX" anon); $COLS; select string_agg(pg_get_userbyid(defaclrole)::text || ':' || defaclobjtype::text || ':' || defaclacl::text, ' ' order by pg_get_userbyid(defaclrole)::text, defaclobjtype::text, defaclacl::text) from pg_default_acl;"; }
rb=$(printf '%s\n' "begin;" "\\i docs/privileges/sql/table_privileges.down.draft.sql" "$(snap)" "rollback;" | $PSQL -d $HARD -X -q -At 2>&1)
[ "$rb" = "$($PSQL -d $BASE -X -q -At -c "$(snap)" 2>&1)" ] && ok "V8 the rollback file restores exactly the rights before the draft (tables, columns, defaults)" || bad "V8 rollback differs"
r=$(val $HARD "$(printf "$MATRIX" authenticated)")
echo "     players' table rights after the draft (S I U D T R t): $r" | fold -w 160 | sed '2,$s/^/     /'

# ---- Part 2: the app's writes, both databases ----------------------------------------------------------------------
P=a1000000-0000-4000-8000-000000000001; O=a1000000-0000-4000-8000-000000000002; S=a1000000-0000-4000-8000-000000000003
C=a1000000-0000-4000-8000-000000000004; A=a1000000-0000-4000-8000-000000000005; X=a1000000-0000-4000-8000-000000000006
M=b1000000-0000-4000-8000-000000000001; MP=b1000000-0000-4000-8000-000000000002
fixtures="insert into auth.users (id, phone) values ('$P','+96171000001'), ('$O','+96171000002'), ('$S','+96171000003'), ('$C','+96171000004'), ('$A','+96171000005'), ('$X','+96171000006');
update profiles set name = 'T ' || right(id::text, 1) where id in ('$P','$O','$S','$C','$A','$X');
update profiles set roles = '{player,admin}' where id = '$A';
insert into club_staff (club_id, profile_id) select id, '$S' from clubs where slug = 'batroun';
insert into coaches (profile_id, sports, price_usd, bio) values ('$C', '{padel}', 25, 'Coach');
insert into matches (id, club_id, sport, organizer_id, start_at, players_needed) select '$M', id, 'padel', '$O', now() + interval '3 day', 3 from clubs where slug = 'batroun';
insert into match_players (match_id, profile_id, status) values ('$M', '$P', 'accepted');
insert into matches (id, club_id, sport, organizer_id, start_at, end_at, players_needed) select '$MP', id, 'padel', '$O', date_trunc('hour', now()) - interval '2 day', date_trunc('hour', now()) - interval '2 day' + interval '90 minutes', 3 from clubs where slug = 'batroun';
insert into match_players (match_id, profile_id, status) values ('$MP', '$P', 'accepted');
insert into notifications (profile_id, kind, match_id, actor_id, body) values ('$P', 'match_join_accepted', '$M', '$O', 'You are in');
select set_config('request.jwt.claim.sub', '$P', true), accept_community_rules();
select set_config('request.jwt.claim.sub', '$X', true), accept_community_rules();
insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) select c.id, k.id, now() + interval '5 day', now() + interval '5 day 1 hour', 'test', '$S' from clubs c join courts k on k.club_id = c.id where c.slug = 'batroun' order by k.sort limit 1;"
for db in $BASE $HARD; do $PSQL -q -d $db -v ON_ERROR_STOP=1 -c "$fixtures" >/dev/null || { echo "fixtures failed on $db"; exit 2; }; done
as() { echo "set local role authenticated; set local request.jwt.claim.sub = '$1';"; }
CLUB="(select id from clubs where slug = 'batroun')"
COACH="(select id from coaches where profile_id = '$C')"
cases=(
  "W01 player: edit own profile (ProfileForm)|$(as $P) with r as (update profiles set name = 'Rana', phone = '+96170111222', sports = '{padel}', email_notifications = true where id = '$P' returning 1) select count(*) from r;"
  "W02 player: cannot edit another's profile|$(as $P) with r as (update profiles set name = 'x' where id = '$O' returning 1) select count(*) from r;"
  "W03 player: chat message in their game (MatchChat)|$(as $P) with i as (insert into match_messages (match_id, profile_id, body) values ('$M', '$P', 'hi') returning 1) select count(*) from i;"
  "W04 player: stranger cannot post in the chat|$(as $X) with i as (insert into match_messages (match_id, profile_id, body) values ('$M', '$X', 'hi') returning 1) select count(*) from i;"
  "W05 player: notification read (direct read_at)|$(as $P) with r as (update notifications set read_at = now() where profile_id = '$P' returning 1) select count(*) from r;"
  "W06 player: mark_notifications_read|$(as $P) select mark_notifications_read((select array_agg(id) from notifications where profile_id = '$P')) is null;"
  "W07 player: set_player_level|$(as $P) select set_player_level('padel', 5) is null;"
  "W08 player: delete own notification (function)|$(as $P) select delete_notification((select id from notifications where profile_id = '$P' limit 1)) is null;"
  "W09 staff: club name and fee (ClubSettings)|$(as $S) with r as (update clubs set name = 'Batroun Padel', service_fee_usd = 0 where id = $CLUB returning 1) select count(*) from r;"
  "W10 staff: add a court|$(as $S) with i as (insert into courts (club_id, name, sport, surface, sort) values ($CLUB, 'Court 9', 'padel', null, 9) returning 1) select count(*) from i;"
  "W11 staff: deactivate a court without bookings|$(as $S) with r as (update courts set active = false where id = (select id from courts where club_id = $CLUB order by sort desc limit 1) returning 1) select count(*) from r;"
  "W12 staff: add and delete a price|$(as $S) with i as (insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values ($CLUB, null, 127, '06:00', '07:00', 30, 'early') returning id) select count(*) from i;"
  "W13 staff: delete a price|$(as $S) with r as (delete from price_rules where id = (select id from price_rules where club_id = $CLUB order by start_time limit 1) returning 1) select count(*) from r;"
  "W14 staff: remove a block (DayCalendar)|$(as $S) with r as (delete from blocks where club_id = $CLUB returning 1) select count(*) from r;"
  "W09b admin: club name and fee (ClubSettings as admin)|$(as $A) with r as (update clubs set name = 'Batroun Padel', service_fee_usd = 0 where id = $CLUB returning 1) select count(*) from r;"
  "W15b admin: club readiness switch (ClubReadiness)|$(as $A) with r as (update clubs set active = true where id = $CLUB returning 1) select count(*) from r;"
  "W15 staff: cap upcoming bookings|$(as $S) with r as (update clubs set max_upcoming_bookings = 5 where id = $CLUB returning 1) select count(*) from r;"
  "W16 coach: edit own listing|$(as $C) with r as (update coaches set bio = 'Padel coach' where id = $COACH returning 1) select count(*) from r;"
  "W17 coach: request a club, then withdraw|$(as $C) insert into coach_clubs (coach_id, club_id) values ($COACH, $CLUB); with r as (delete from coach_clubs where coach_id = $COACH returning 1) select count(*) from r;"
  "W18 coach: weekly availability add/delete|$(as $C) insert into availability_rules (coach_id, club_id, weekday, start_time, end_time) values ($COACH, $CLUB, 1, '09:00', '11:00'); with r as (delete from availability_rules where coach_id = $COACH returning 1) select count(*) from r;"
  "W19 coach: exception add/delete|$(as $C) insert into availability_exceptions (coach_id, club_id, date, available) values ($COACH, $CLUB, current_date + 3, false); with r as (delete from availability_exceptions where coach_id = $COACH returning 1) select count(*) from r;"
  "W20 player: create own coach listing (CoachDashboard)|$(as $X) with i as (insert into coaches (profile_id, sports, price_usd, bio) values ('$X', '{tennis}', 20, 'x') returning 1) select count(*) from i;"
  "W21 admin: create a club (NewClubForm)|$(as $A) with i as (insert into clubs (name, slug) values ('New Club', 'new-club') returning 1) select count(*) from i;"
  "W22 player: cannot edit a club|$(as $P) with r as (update clubs set name = 'x' where id = $CLUB returning 1) select count(*) from r;"
  "W23 player: hide a game (function)|$(as $P) select hide_match('$MP', true) is null;"
  "W24 player: leave the game (function)|$(as $P) select leave_match('$M') is not null;"
  "W25 player: delete own chat message (function)|$(as $P) insert into match_messages (match_id, profile_id, body) values ('$M', '$P', 'oops'); select delete_match_message((select id from match_messages where profile_id = '$P' limit 1)) is null;"
  "W26 staff: block a court (function)|$(as $S) select staff_block($CLUB, (select id from courts where club_id = $CLUB order by sort limit 1), date_trunc('day', now()) + interval '6 day 10 hours', date_trunc('day', now()) + interval '6 day 11 hours', 'repairs') is not null;"
  "W27 organiser: cancel their game (set_match_status)|$(as $O) select set_match_status('$M', 'cancelled') is null; select status from matches where id = '$M';"
  # direct attempts that no policy allows: the only cases whose result may change
  "D01 player: direct update of a booking|$(as $P) with r as (update bookings set status = 'cancelled' returning 1) select count(*) from r;"
  "D02 player: direct insert of a game seat|$(as $X) with i as (insert into match_players (match_id, profile_id, status) values ('$M', '$X', 'accepted') returning 1) select count(*) from i;"
  "D03 player: direct delete of own notifications|$(as $P) with r as (delete from notifications where profile_id = '$P' returning 1) select count(*) from r;"
  "D04 player: direct insert of a payment|$(as $P) with i as (insert into payments (profile_id, total_usd) values ('$P', 1) returning 1) select count(*) from i;"
  "D05 player: TRUNCATE account_deletions|$(as $P) truncate account_deletions; select 'truncated';"
  "D06 player: TRUNCATE payments|$(as $P) truncate payments; select 'truncated';"
  "D07 player: direct update of own level|$(as $P) with r as (update player_levels set level = 10 returning 1) select count(*) from r;"
)
declared="D01 D02 D03 D04 D05 D06 D07"
run_case() { printf '%s\n' "\\set VERBOSITY terse" "begin;" "$2" "rollback;" | $PSQL -d $1 -X -q -At 2>&1 | sed 's/^.*ERROR:  /ERR /' | tr '\n' ' ' | sed 's/ *$//'; }
for c in "${cases[@]}"; do
  id=${c%%|*}; sql=${c#*|}; key=${id%% *}
  b=$(run_case $BASE "$sql"); h=$(run_case $HARD "$sql")
  if [[ " $declared " == *" $key "* ]]; then
    if [[ $key == D05 || $key == D06 ]] && [ "$b" != truncated ]; then bad "$id (control: a player could truncate it before the draft)" "before: $b"; continue; fi
    if echo "$h" | grep -q "permission denied"; then ok "$id — before: ${b:0:60} | after: refused"; else bad "$id (expected permission denied)" "before: $b | after: $h"; fi
  elif [ "$b" = "$h" ]; then ok "$id — same before and after: ${h:0:70}"
  else bad "$id changed" "before: $b | after: $h"; fi
done
exit $status
