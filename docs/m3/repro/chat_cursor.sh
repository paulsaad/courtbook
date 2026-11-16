#!/usr/bin/env bash
# Chat polling cursor check (docs/m3/05-architecture.md §5.4). LOCAL REPLICA ONLY.
# Shows that a strict cursor (p_after = newest timestamp seen) loses a message whose transaction
# committed after a newer one was read, and that the planned client rule (p_after = newest - 10 s,
# de-duplicate by id, full reload every 60 s) gets it, and also picks up a later deletion.
#   PSQL="sudo -u postgres psql" bash docs/m3/repro/chat_cursor.sh
set -u
PSQL=${PSQL:-psql}
DB=courtbook_test
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: '$where'"; exit 1;; esac
q() { $PSQL -At -d $DB -X -q "$@" 2>&1 | grep -v -E '^(SET|set_config|)$'; }
as() { echo "set role authenticated; select set_config('request.jwt.claim.sub','$1',false) \\g /dev/null"; }
O=d0000000-0000-0000-0000-00000000000a; A=d0000000-0000-0000-0000-00000000000b
q -c "delete from auth.users where id in ('$O','$A');" >/dev/null
q -c "insert into auth.users (id, email) values ('$O','o@cc.test'),('$A','a@cc.test');" >/dev/null
CLUB=$(q -c "select id from clubs where slug='batroun'")
M=$(q -c "insert into matches (club_id, sport, organizer_id, start_at, players_needed) values ('$CLUB','padel','$O', now() + interval '2 days', 3) returning id" | head -1)
q -c "insert into match_players (match_id, profile_id, status) values ('$M','$A','accepted');" >/dev/null
list() { { as $O; echo "select id from match_messages_list('$M', $1) order by created_at;"; } | q; }

# 1. Adam's message is stamped first but its transaction commits 3 s later (slow request)
{ as $A; echo "begin; insert into match_messages (match_id, profile_id, body) values ('$M','$A','slow'); select pg_sleep(3); commit;"; } | q >/dev/null &
sleep 1
# 2. Olga's message is stamped and committed meanwhile
{ as $O; echo "insert into match_messages (match_id, profile_id, body) values ('$M','$O','fast');"; } | q >/dev/null
# 3. Olga's phone polls now: sees only 'fast'; its cursor becomes the newest timestamp seen
seen1=$(list null | wc -l)
cursor=$(q -c "select max(created_at) from match_messages where match_id='$M'")
wait
slow=$(q -c "select id from match_messages where match_id='$M' and body='slow'")
strict=$(list "'$cursor'::timestamptz" | grep -c "$slow")
overlap=$(list "'$cursor'::timestamptz - interval '10 seconds'" | grep -c "$slow")
echo "poll before the slow commit returned $seen1 message(s)"
echo "next poll, strict cursor (p_after = newest seen): slow message returned $strict time(s)"
echo "next poll, overlapping cursor (newest seen - 10 s): slow message returned $overlap time(s)"
[ "$strict" = 0 ] && [ "$overlap" = 1 ] && echo "CONFIRMED: a strict cursor loses delayed commits; the overlap recovers them" || echo "NOT CONFIRMED"

# 4. Deletion: an old message is soft-deleted; incremental poll does not return it, full reload does
{ as $A; echo "select delete_match_message('$slow');"; } | q >/dev/null
inc=$({ as $O; echo "select count(*) from match_messages_list('$M', now() - interval '2 seconds') where deleted;"; } | q | tail -1)
full=$({ as $O; echo "select count(*) from match_messages_list('$M', null) where deleted;"; } | q | tail -1)
echo "after Adam deletes 'slow': incremental poll shows the deletion $inc time(s); full reload $full time(s)"
[ "$inc" = 0 ] && [ "$full" = 1 ] && echo "CONFIRMED: deletions need the periodic full reload (or a reload on focus)" || echo "NOT CONFIRMED"

q -c "delete from matches where id='$M'; delete from auth.users where id in ('$O','$A');" >/dev/null
exit 0
