#!/usr/bin/env bash
# Player photo draft (docs/profile-photo/sql/player_photos.draft.sql) on its own scratch database: every migration,
# the seed, then the draft. LOCAL ONLY.
#   PSQL="sudo -u postgres psql" bash supabase/tests/photo/player_photos.sh
#   CONTROL=1 …   the same cases with the visibility rule weakened to "any signed-in player": the privacy cases must fail
# Every case runs in its own rolled-back transaction.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_photo
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
for f in $(ls supabase/migrations/*.sql | sort) docs/profile-photo/sql/player_photos.draft.sql; do
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "BUILD FAILED: $f"; exit 2; }
done
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
if [[ -n "${CONTROL:-}" ]]; then
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 >/dev/null <<'SQL' || exit 2
create or replace function can_see_player_photo(p_viewer uuid, p_subject uuid) returns boolean
language sql stable security definer set search_path = public as $$ select p_viewer is not null and p_subject is not null $$;
SQL
fi
# A = organizer, B = accepted, C = pending in the same game, D = stranger, E = accepted in a cancelled game only, ADMIN.
A=a0000000-0000-0000-0000-00000000000a; B=b0000000-0000-0000-0000-00000000000b; C=c0000000-0000-0000-0000-00000000000c
D=d0000000-0000-0000-0000-00000000000d; E=e0000000-0000-0000-0000-00000000000e; ADMIN=f0000000-0000-0000-0000-00000000000f
G1=99999999-0000-0000-0000-000000000001; G2=99999999-0000-0000-0000-000000000002
$PSQL -q -d $DB -v ON_ERROR_STOP=1 >/dev/null <<SQL || exit 2
insert into auth.users (id, phone) values ('$A','+96101'), ('$B','+96102'), ('$C','+96103'), ('$D','+96104'), ('$E','+96105'), ('$ADMIN','+96106');
update profiles set name = 'Player ' || substr(id::text, 1, 1) where id in ('$A','$B','$C','$D','$E','$ADMIN');
update profiles set roles = '{player,admin}' where id = '$ADMIN';
insert into matches (id, club_id, sport, organizer_id, start_at, players_needed)
  select '$G1', id, 'padel', '$A', now() + interval '3 day', 3 from clubs where slug = 'batroun';
insert into matches (id, club_id, sport, organizer_id, start_at, players_needed, status)
  select '$G2', id, 'padel', '$A', now() + interval '4 day', 3, 'cancelled' from clubs where slug = 'batroun';
insert into match_players (match_id, profile_id, status) values ('$G1', '$B', 'accepted'), ('$G1', '$C', 'pending'), ('$G2', '$E', 'accepted');
SQL
status=0
q() { printf '%s\n' "\\set VERBOSITY terse" "begin;" "$1" "rollback;" | $PSQL -d $DB -X -q -At -v ON_ERROR_STOP=1 2>&1 | sed 's/^.*ERROR:  /ERR /'; }
check() { if echo "$2" | tr "\n" " " | sed "s/ $//" | grep -Eq "$3"; then echo "ok   $1"; else echo "FAIL $1"; echo "     got: $(echo "$2" | tr '\n' ' ')"; status=1; fi; }
as() { echo "set local role authenticated; set local request.jwt.claim.sub = '$1';"; }
svc() { echo "set local role service_role; set local request.jwt.claim.sub = '';"; }
IMG="decode('52494646' || '00000000' || '57454250' || repeat('00', 60), 'hex')"
put() { echo "$(svc) do \$p\$ begin perform set_player_photo('$1', $IMG, 192, 192); end \$p\$; reset role;"; }
fresh() { echo "set local role authenticated; set local request.jwt.claim.sub = '$1'; select set_config('request.jwt.claims', json_build_object('sub', '$1', 'role', 'authenticated', 'amr', json_build_array(json_build_object('method', 'otp', 'timestamp', extract(epoch from now())::bigint)))::text, true) is null;"; }
seen() { echo "$(as $1) select count(*) from player_photo('$2');"; }

check "P1 the server stores a photo; the owner sees it" \
  "$(q "$(put $B) $(seen $B $B)")" "^1$"
check "P2 a signed-in player cannot write a photo directly (function)" \
  "$(q "$(as $B) select set_player_photo('$B', $IMG, 192, 192);")" "ERR .*permission denied"
check "P2b … nor through the table" \
  "$(q "$(as $B) insert into player_photos (profile_id, image, width, height) values ('$B', $IMG, 192, 192);")" "ERR .*permission denied"
check "P2c … and the table is not readable directly" \
  "$(q "$(put $B) $(as $A) select count(*) from player_photos;")" "ERR .*permission denied"
check "P2d anon cannot read a photo" \
  "$(q "$(put $B) set local role anon; select count(*) from player_photo('$B');")" "ERR .*permission denied"
check "P3 the organizer sees an accepted player's photo, and the reverse" \
  "$(q "$(put $B) $(put $A) $(seen $A $B) $(seen $B $A)")" "^1.1$"
check "P4 a stranger does not see it" \
  "$(q "$(put $B) $(seen $D $B)")" "^0$"
check "P5 a pending requester does not see the players' photos" \
  "$(q "$(put $B) $(seen $C $B)")" "^0$"
check "P5b … and the organizer does not see the pending requester's" \
  "$(q "$(put $C) $(seen $A $C)")" "^0$"
check "P6 a shared game that was cancelled does not count" \
  "$(q "$(put $E) $(seen $A $E)")" "^0$"
check "P7 a block in either direction hides the photo" \
  "$(q "$(put $B) insert into player_blocks (blocker_id, blocked_id) values ('$B', '$A'); $(seen $A $B)")" "^0$"
check "P7b … the other direction too" \
  "$(q "$(put $B) insert into player_blocks (blocker_id, blocked_id) values ('$A', '$B'); $(seen $A $B)")" "^0$"
check "P8 a suspended player's photo is hidden, and they cannot upload" \
  "$(q "$(put $B) insert into account_suspensions (profile_id, reason, suspended_by) values ('$B', 'test', '$ADMIN'); $(seen $A $B) $(put $B)")" "^0.*ERR suspended"
check "P9 an admin has no special view of photos" \
  "$(q "$(put $B) $(seen $ADMIN $B)")" "^0$"
check "P10 the participant list gives versions only for visible photos" \
  "$(q "$(put $A) $(put $B) $(put $C) $(put $B) $(as $A) select string_agg(substr(profile_id::text,1,1) || version, ',' order by profile_id) from match_photo_versions('$G1');")" "^a1,b2$"
check "P10b a stranger gets nothing from the participant list" \
  "$(q "$(put $A) $(put $B) $(as $D) select count(*) from match_photo_versions('$G1');")" "^0$"
check "P11 the owner removes their photo" \
  "$(q "$(put $B) $(as $B) select remove_player_photo(); $(seen $B $B)")" "^t.0$"
check "P12 a player WITH a photo can close their account (the real close, under 0086's lock-out)" \
  "$(q "$(put $B) $(fresh $B) select close_my_account('web')->>'status'; reset role;")" "^f closing$"
check "P12b from closing on, the photo is hidden from everyone, the player included; the row waits for the data step" \
  "$(q "$(put $B) $(fresh $B) select close_my_account('web') is not null; reset role; $(seen $A $B) $(seen $B $B) reset role; select count(*) from player_photos where profile_id = '$B';")" "^f t 0 0 1$"
check "P12c the data step (delete_account_data, server key) deletes it" \
  "$(q "$(put $B) $(fresh $B) select close_my_account('web') is not null; reset role;
        $(svc) select delete_account_data('$B') is not null; reset role;
        select status || ' ' || (select count(*) from player_photos where profile_id = '$B') from account_deletions where subject_id = '$B';")" "^f t t data_removed 0$"
check "P12d an upload that raced the closure is removed at the data step" \
  "$(q "insert into account_deletions (subject_id, requested_via, status) values ('$B', 'web', 'closing');
        insert into player_photos (profile_id, image, width, height) values ('$B', $IMG, 192, 192);
        update account_deletions set status = 'data_removed' where subject_id = '$B';
        select count(*) from player_photos where profile_id = '$B';")" "^0$"
check "P12e a closed account cannot upload (server) or remove (as itself)" \
  "$(q "$(put $B) $(fresh $B) select close_my_account('web') is not null; reset role; $(put $B)")" "ERR account_closed"
check "P12f … nor remove it as itself (0086 lock-out on the table)" \
  "$(q "$(put $B) $(fresh $B) select close_my_account('web') is not null; select remove_player_photo();")" "ERR account_closed"
check "P12g a cancellable old-style request keeps the photo, hidden while open" \
  "$(q "$(put $B) insert into account_deletions (subject_id, requested_via) values ('$B', 'web'); select count(*) from player_photos where profile_id = '$B'; $(seen $A $B)")" "^1 0$"
check "P12h legal hold ('held'): kept, hidden" \
  "$(q "$(put $B) insert into account_deletions (subject_id, requested_via, status, held_reason) values ('$B', 'web', 'held', 'legal_hold'); select count(*) from player_photos where profile_id = '$B'; $(seen $A $B)")" "^1 0$"
check "P12i the table has 0086's closed-account lock-out (0086 test E1)" \
  "$(q "select count(*) from pg_trigger where tgrelid = 'player_photos'::regclass and tgname = 'closed_account_lockout';")" "^1$"
check "P13 non-WebP bytes are refused by the table itself" \
  "$(q "$(svc) select set_player_photo('$B', decode('89504e47' || repeat('00', 70), 'hex'), 192, 192);")" "ERR .*check constraint"
check "P13b oversize is refused" \
  "$(q "$(svc) select set_player_photo('$B', ($IMG || decode(repeat('00', 70000), 'hex')), 192, 192);")" "ERR .*check constraint"
check "P13c a replacement bumps the version" \
  "$(q "$(put $B) $(put $B) $(as $B) select version from player_photo('$B');")" "^2$"
check "P14 my_photo_version is the caller's own only" \
  "$(q "$(put $B) $(put $B) $(as $B) select coalesce(my_photo_version(), 0); $(as $A) select coalesce(my_photo_version(), 0);")" "^2 0$"
check "P15 exact table rights: nobody but the owner (anon, authenticated and service_role have none)" \
  "$(q "select string_agg(r || '=' || coalesce((select string_agg(p, '+' order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where has_table_privilege(r, 'player_photos', p)), '-'), ' ' order by r) from unnest(array['anon','authenticated','service_role']) r;")" \
  "^anon=- authenticated=- service_role=-$"
check "P15b exact function rights (anon none; players read, remove; only the server writes; internals for nobody)" \
  "$(q "select string_agg(f || ':' || (case when has_function_privilege('anon', f, 'EXECUTE') then 'A' else '' end) || (case when has_function_privilege('authenticated', f, 'EXECUTE') then 'U' else '' end), ' ' order by f)
        from unnest(array['admin_remove_player_photo(uuid,text)','can_see_player_photo(uuid,uuid)','claim_photo_upload(uuid)','match_photo_versions(uuid)','my_photo_version()','player_photo(uuid)','player_photo_on_closure()','remove_player_photo()','set_player_photo(uuid,bytea,integer,integer)']) f;")" \
  "^admin_remove_player_photo\(uuid,text\):U can_see_player_photo\(uuid,uuid\): claim_photo_upload\(uuid\): match_photo_versions\(uuid\):U my_photo_version\(\):U player_photo\(uuid\):U player_photo_on_closure\(\): remove_player_photo\(\):U set_player_photo\(uuid,bytea,integer,integer\):$"
check "P15c RLS on, no policy; every function SECURITY DEFINER with a fixed search_path" \
  "$(q "select (select relrowsecurity from pg_class where relname = 'player_photos') || ' ' || (select count(*) from pg_policies where tablename = 'player_photos') || ' ' ||
        (select count(*) from pg_proc where proname in ('can_see_player_photo','player_photo','match_photo_versions','my_photo_version','set_player_photo','remove_player_photo','player_photo_on_closure','claim_photo_upload','admin_remove_player_photo') and prosecdef and proconfig @> array['search_path=public']);")" \
  "^true 0 9$"
check "P15d the server key cannot write or read the table directly" \
  "$(q "$(svc) insert into player_photos (profile_id, image, width, height) values ('$B', $IMG, 192, 192);")" "ERR .*permission denied"
check "P13d a stored photo at exactly the cap (65536 bytes) is accepted; one byte more is not" \
  "$(q "$(svc) select set_player_photo('$B', decode('52494646' || '00000000' || '57454250' || repeat('00', 65524), 'hex'), 192, 192); select set_player_photo('$B', decode('52494646' || '00000000' || '57454250' || repeat('00', 65525), 'hex'), 192, 192);")" "^1 ERR .*check constraint"
check "P13e dimensions outside 32–256 are refused" \
  "$(q "$(svc) select set_player_photo('$B', $IMG, 512, 512);")" "ERR .*check constraint"
# review requirement 3 (26 Nov): the server-side upload limit (claim_photo_upload runs before any decode)
claim() { echo "$(svc) do \$c\$ begin perform claim_photo_upload('$1'); end \$c\$; reset role;"; }
check "U1 the server may claim 10 uploads an hour for a player; the 11th is refused (too_many_uploads)" \
  "$(q "$(for i in 1 2 3 4 5 6 7 8 9 10; do claim $B; done) select count(*) from player_photo_uploads where profile_id = '$B'; $(claim $B)")" "^10 ERR too_many_uploads$"
check "U1b the limit is per player: another player is not affected" \
  "$(q "$(for i in 1 2 3 4 5 6 7 8 9 10; do claim $B; done) $(claim $A) select count(*) from player_photo_uploads where profile_id = '$A';")" "^1$"
check "U2 attempts older than an hour no longer count" \
  "$(q "insert into player_photo_uploads (profile_id, at) select '$B', now() - interval '61 minutes' from generate_series(1, 10); $(claim $B) select count(*) from player_photo_uploads where profile_id = '$B' and at > now() - interval '1 hour';")" "^1$"
check "U2b attempts older than a day are pruned on the next claim" \
  "$(q "insert into player_photo_uploads (profile_id, at) select '$B', now() - interval '25 hours' from generate_series(1, 5); $(claim $B) select count(*) from player_photo_uploads where profile_id = '$B';")" "^1$"
check "U3 a signed-in player cannot claim (only the server), nor use the table" \
  "$(q "$(as $B) select claim_photo_upload('$B');")$(q "$(as $B) select count(*) from player_photo_uploads;")" "ERR .*permission denied.*ERR .*permission denied"
check "U3b exact table rights on the upload log: none for anon, authenticated, service_role" \
  "$(q "select string_agg(r || '=' || coalesce((select string_agg(p, '+' order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p where has_table_privilege(r, 'player_photo_uploads', p)), '-'), ' ' order by r) from unnest(array['anon','authenticated','service_role']) r;")" \
  "^anon=- authenticated=- service_role=-$"
check "U4 a closed account's attempts are deleted at the data step; the table has 0086's lock-out" \
  "$(q "$(claim $B) $(fresh $B) select close_my_account('web') is not null; reset role;
        $(svc) select delete_account_data('$B') is not null; reset role;
        select (select count(*) from player_photo_uploads where profile_id = '$B') || ' ' || exists (select 1 from pg_trigger where tgname = 'closed_account_lockout' and tgrelid = 'player_photo_uploads'::regclass);")" "^f t t 0 true$"
# review of b89b9ff (finding 1): concurrent claims are counted one by one (the per-account lock): 30 at once, 10 accepted
claim_race() {
  local pids=() ok=0
  for i in $(seq 1 30); do
    { printf '%s\n' "begin;" "set local role service_role;" "set local request.jwt.claim.sub = '';" "select claim_photo_upload('$B');" "select pg_sleep(0.2);" "commit;" \
        | $PSQL -d $DB -X -q -At -v ON_ERROR_STOP=1 >/dev/null 2>&1 && echo ok; } > /tmp/photo_claim_$i.out &
    pids+=($!)
  done
  wait "${pids[@]}"
  ok=$(cat /tmp/photo_claim_*.out | grep -c '^ok$'); rm -f /tmp/photo_claim_*.out
  echo "$ok $($PSQL -d $DB -X -At -c "select count(*) from player_photo_uploads where profile_id = '$B'") $($PSQL -d $DB -X -At -c "delete from player_photo_uploads where profile_id = '$B'" >/dev/null; echo done)"
}
check "U6 30 concurrent upload claims for one player: exactly 10 accepted and recorded (the per-account lock)" "$(claim_race)" "^10 10 done$"
check "U5 a closed or suspended account is refused before any decode" \
  "$(q "insert into account_suspensions (profile_id, reason, suspended_by) values ('$B', 'test', '$ADMIN'); $(claim $B)")$(q "$(fresh $B) select close_my_account('web') is not null; reset role; $(claim $B)")" "ERR suspended.*ERR account_closed"
# review requirement 2 (26 Nov): an admin removes an inappropriate photo, without suspending the account
check "M1 an admin removes a photo with a reason: gone, logged (who, whose, why), the account not suspended" \
  "$(q "$(put $B) $(as $ADMIN) select admin_remove_player_photo('$B', 'nudity'); reset role;
        select (select count(*) from player_photos where profile_id = '$B') || ' ' ||
               (select admin_id = '$ADMIN' and profile_id = '$B' and note = 'nudity' from moderation_log where action = 'remove_photo') || ' ' ||
               (select count(*) from account_suspensions where profile_id = '$B');")" "^t 0 true 0$"
check "M2 a player (even the organizer of a shared game) cannot use it" \
  "$(q "$(put $B) $(as $A) select admin_remove_player_photo('$B', 'x');")" "ERR forbidden"
check "M2b anon cannot call it" \
  "$(q "$(put $B) set local role anon; select admin_remove_player_photo('$B', 'x');")" "ERR .*permission denied"
check "M3 a reason is required" \
  "$(q "$(put $B) $(as $ADMIN) select admin_remove_player_photo('$B', '  ');")" "ERR reason_required"
check "M4 nothing to remove: false, and nothing is logged" \
  "$(q "$(as $ADMIN) select admin_remove_player_photo('$B', 'x'); reset role; select count(*) from moderation_log where action = 'remove_photo';")" "^f 0$"
check "M5 the player can upload again afterwards (a repeat is handled by suspension)" \
  "$(q "$(put $B) $(as $ADMIN) select admin_remove_player_photo('$B', 'nudity'); reset role; $(put $B) $(seen $B $B)")" "t.*1$"
check "M6 the removal record cannot be edited or deleted (append-only log)" \
  "$(q "$(put $B) $(as $ADMIN) select admin_remove_player_photo('$B', 'nudity'); reset role; delete from moderation_log where action = 'remove_photo';")" "ERR moderation_log_is_append_only"
exit $status
