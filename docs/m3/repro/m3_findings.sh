#!/usr/bin/env bash
# M3 preparation — reproductions of the matchmaking findings (docs/m3/02-safety-review.md).
# LOCAL REPLICA ONLY: run after supabase/tests/run.sh has built courtbook_test from all migrations.
#   PSQL="sudo -u postgres psql" bash docs/m3/repro/m3_findings.sh
# Never point this at staging or live: it refuses any database name other than courtbook_test.
# Each block prints REPRODUCED (the issue exists in the current schema) or NOT REPRODUCED.
set -u
PSQL=${PSQL:-psql}
DB=courtbook_test
[ "$DB" = courtbook_test ] || exit 1
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 1;; esac
q() { $PSQL -At -d $DB -v ON_ERROR_STOP=0 "$@" 2>&1 | grep -v -E '^(SET|set_config|)$'; }
as() { echo "set role authenticated; select set_config('request.jwt.claim.sub','$1',false);"; }

O=a0000000-0000-0000-0000-00000000000a   # organizer
A=a0000000-0000-0000-0000-00000000000b   # player A
B=a0000000-0000-0000-0000-00000000000c   # player B
X=a0000000-0000-0000-0000-00000000000d   # stranger
q -c "delete from auth.users where id in ('$O','$A','$B','$X');" >/dev/null
q -c "insert into auth.users (id, email) values ('$O','o@m3.test'),('$A','a@m3.test'),('$B','b@m3.test'),('$X','x@m3.test');
      update profiles set name = case id when '$O' then 'Olga' when '$A' then 'Adam' when '$B' then 'Bana' else 'Xavi' end where id in ('$O','$A','$B','$X');" >/dev/null
CLUB=$(q -c "select id from clubs where slug='batroun'")
START="(current_date + 3 + time '18:00') at time zone 'Asia/Beirut'"
END="(current_date + 3 + time '19:30') at time zone 'Asia/Beirut'"
post() { { as $O; echo "select post_match('$CLUB','padel',$START,$END,null,null,$1,null,null,'$2');"; } | q | tail -1; }

echo "== F1 decline bypass: a declined player leaves, then asks again =="
M=$(post 3 approval)
{ as $A; echo "select join_match('$M');"; } | q >/dev/null
{ as $O; echo "select decide_join('$M','$A',false);"; } | q >/dev/null
again=$({ as $A; echo "select join_match('$M');"; } | q | grep -o -m1 'ERROR: *[a-z_]*' )
{ as $A; echo "select leave_match('$M');"; } | q >/dev/null
after=$({ as $A; echo "select join_match('$M');"; } | q | tail -1)
echo "  join after decline: $again"
echo "  join after leave_match: $after"
case "$after" in pending) echo "  REPRODUCED: leave_match deletes the 'declined' row, so the organizer receives a fresh request";; *) echo "  NOT REPRODUCED";; esac
echo "  organizer's join_request notifications from Adam: $(q -c "select count(*) from notifications where profile_id='$O' and match_id='$M' and kind='join_request'")"

echo "== F2 chat timestamps chosen by the sender (direct insert) =="
M2=$(post 3 open)
{ as $A; echo "select join_match('$M2');"; } | q >/dev/null
{ as $A; echo "insert into match_messages (match_id, profile_id, body, created_at) values ('$M2','$A','from the future','2030-01-01');"; } | q >/dev/null
{ as $A; echo "insert into match_messages (match_id, profile_id, body) values ('$M2','$A','normal message');"; } | q >/dev/null
stamp=$(q -c "select created_at::date from match_messages where match_id='$M2' and body='from the future'")
echo "  stored created_at of 'from the future': $stamp"
last=$({ as $O; echo "select body from match_messages_list('$M2', null) order by created_at desc limit 1;"; } | q | tail -1)
echo "  newest message shown to the organizer: $last"
cursor_miss=$({ as $O; echo "select count(*) from match_messages_list('$M2', '2030-01-01'::timestamptz - interval '1 second');"; } | q | tail -1)
echo "  a client that polls with p_after = newest timestamp it has seen (2030-01-01) gets $cursor_miss row(s) back now, and nothing ever again until 2030: every later real message is older than its cursor"
[ "$stamp" = 2030-01-01 ] && echo "  REPRODUCED: created_at is client-controlled; incremental polling (p_after) would stop receiving messages" || echo "  NOT REPRODUCED"

echo "== F3 organizer deletes the match row directly (RLS delete policy) =="
M3=$(post 3 open)
{ as $A; echo "select join_match('$M3');"; } | q >/dev/null
del=$({ as $O; echo "delete from matches where id='$M3' returning 'deleted';"; } | q | grep -c deleted)
left=$(q -c "select count(*) from match_players where match_id='$M3'")
notes=$(q -c "select count(*) from notifications where profile_id='$A' and kind='match_cancelled'")
echo "  rows deleted by organizer: $del; participants left: $left; 'match cancelled' notices to Adam: $notes"
[ "$del" = 1 ] && echo "  REPRODUCED: an organizer can remove a match with players in it, bypassing set_match_status (no notice to players; their history and chat vanish)" || echo "  NOT REPRODUCED"

echo "== F4 pending players are not told when the linked booking is cancelled =="
COURT=$(q -c "select id from courts where club_id='$CLUB' and name='Padel 1'")
BK=$(q -c "insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by)
           values ('$CLUB','$COURT','$O',$START,$END,'confirmed','app','$O') returning id" | head -1)
M4=$({ as $O; echo "select post_match(null,'padel',null,null,null,null,3,null,'$BK','approval');"; } | q | tail -1)
{ as $A; echo "select join_match('$M4');"; } | q >/dev/null
{ as $O; echo "select decide_join('$M4','$A',true);"; } | q >/dev/null
{ as $B; echo "select join_match('$M4');"; } | q >/dev/null
q -c "update bookings set status='cancelled' where id='$BK';" >/dev/null
na=$(q -c "select count(*) from notifications where match_id='$M4' and profile_id='$A' and kind='booking_unlinked'")
nb=$(q -c "select count(*) from notifications where match_id='$M4' and profile_id='$B' and kind='booking_unlinked'")
echo "  'booking_unlinked' notices: accepted Adam $na, pending Bana $nb; match still $(q -c "select status from matches where id='$M4'") with booking $(q -c "select coalesce(booking_id::text,'none') from matches where id='$M4'")"
[ "$na" = 1 ] && [ "$nb" = 0 ] && echo "  REPRODUCED: a pending requester is not told the court is gone (same for 'booking_moved')" || echo "  NOT REPRODUCED"

echo "== F5 a match filled through approvals leaves other requests pending =="
M5=$(post 1 approval)
{ as $A; echo "select join_match('$M5');"; } | q >/dev/null
{ as $B; echo "select join_match('$M5');"; } | q >/dev/null
{ as $O; echo "select decide_join('$M5','$A',true);"; } | q >/dev/null
st=$(q -c "select status||'/'||coalesce(closed_reason,'-') from matches where id='$M5'")
bana=$(q -c "select status from match_players where match_id='$M5' and profile_id='$B'")
board=$({ as $B; echo "select my_status from match_board(null, 30) where match_id='$M5';"; } | q | tail -1)
echo "  match: $st; Bana's request: $bana; Bana's board row says: $board"
[ "$bana" = pending ] && echo "  REPRODUCED (behaviour to define): Bana stays 'pending' on a full match with no notice; she is accepted only if a place reopens and the organizer decides" || echo "  NOT REPRODUCED"

echo "== F6 a match opened without a club never appears on the board =="
M6=$({ as $O; echo "select post_match(null,'padel',$START,$END,null,null,2,null,null,'open');"; } | q | tail -1)
seen=$({ as $X; echo "select count(*) from open_matches() where match_id='$M6';"; } | q | tail -1)
echo "  club_id: $(q -c "select coalesce(club_id::text,'null') from matches where id='$M6'"); visible on open_matches to a stranger: $seen"
[ "$seen" = 0 ] && echo "  REPRODUCED: post_match accepts p_club null; open_matches inner-joins clubs, so it is invisible (an orphan post)" || echo "  NOT REPRODUCED"

echo "== F7 a member cannot read a match once it has started (match_board is the only single-match read) =="
MP=$(q -c "insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed) values ('$CLUB','padel','$O', now() - interval '30 minutes', now() + interval '60 minutes', 3) returning id" | head -1)
q -c "insert into match_players (match_id, profile_id, status) values ('$MP','$A','accepted');" >/dev/null
seen=$({ as $A; echo "select count(*) from match_board(null, 60) where match_id='$MP';"; } | q | tail -1)
rls=$({ as $A; echo "select count(*) from matches where id='$MP';"; } | q | tail -1)
echo "  under way, Adam accepted: match_board rows $seen; direct read of matches (RLS) $rls"
[ "$seen" = 0 ] && echo "  REPRODUCED: no read path returns the match card (club, court, counts) once it starts; the web match page 404s and its chat is unreachable" || echo "  NOT REPRODUCED"

echo "== F8 chat insert: 'deleted' rows skip the length check; cancelled matches still accept messages =="
M8=$(post 3 open)
{ as $A; echo "select join_match('$M8');"; } | q >/dev/null
big=$({ as $A; echo "insert into match_messages (match_id, profile_id, body, deleted_at) values ('$M8','$A', repeat('x', 200000), now()) returning length(body);"; } | q | grep -E '^[0-9]+$' | head -1)
echo "  body length stored via a row inserted as already deleted: ${big:-refused} (live limit is 1000)"
{ as $O; echo "select set_match_status('$M8','cancelled');"; } | q >/dev/null
late=$({ as $A; echo "insert into match_messages (match_id, profile_id, body) values ('$M8','$A','after cancel') returning 1;"; } | q | grep -c '^1$')
nq=$(q -c "select count(*) from notifications where match_id='$M8' and profile_id='$O' and kind='match_message'")
echo "  message accepted on a cancelled match: $late; organizer 'match_message' notices: $nq"
[ "${big:-0}" = 200000 ] && echo "  REPRODUCED: the 1..1000 check is skipped when deleted_at is set by the sender" || echo "  NOT REPRODUCED (length)"
[ "$late" = 1 ] && echo "  REPRODUCED: the insert policy checks membership only, not match status" || echo "  NOT REPRODUCED (cancelled)"

echo "== F9 a user can rewrite and re-queue their own notifications (UPDATE is granted on every column) =="
q -c "update profiles set email_notifications = true where id='$A';" >/dev/null
NID=$(q -c "select id from notifications where profile_id='$A' order by created_at limit 1")
q -c "update notifications set emailed_at = now(), email_claimed_at = now() where id='$NID';" >/dev/null
{ as $A; echo "update notifications set body = 'Any text the user chooses', kind = 'anything', emailed_at = null, email_claimed_at = null where id='$NID';"; } | q >/dev/null
row=$(q -c "select kind||' | '||body from notifications where id='$NID'")
again=$(q -c "select count(*) from claim_notifications_to_email(50) where id='$NID'")
echo "  after the user's update: '$row'; picked again by the email claim: $again"
[ "$again" = 1 ] && echo "  REPRODUCED: an already-emailed notice goes back in the queue with user-chosen text; repeated, this spends the shared Gmail quota (recipient is always the user, profile_id is pinned by the policy)" || echo "  NOT REPRODUCED"

echo "== C1 concurrency control: two players take the last place at once =="
M7=$(post 1 open)
{ as $A; echo "begin; select join_match('$M7'); select pg_sleep(1); commit;"; } | q > /tmp/m3_c1a.log &
sleep 0.3
{ as $B; echo "begin; select join_match('$M7'); select pg_sleep(1); commit;"; } | q > /tmp/m3_c1b.log &
wait
acc=$(q -c "select count(*) from match_players where match_id='$M7' and status='accepted'")
echo "  accepted: $acc (expect 1); second session: $(grep -o -m1 'match_[a-z]*\|accepted' /tmp/m3_c1b.log | head -1)"
[ "$acc" = 1 ] && echo "  CONTROL OK: the match row lock serialises joins" || echo "  PROBLEM: $acc accepted"

echo "== C2 concurrency control: organizer accepts while a player joins the last place =="
M8=$(post 1 approval)
{ as $A; echo "select join_match('$M8');"; } | q >/dev/null
q -c "update matches set join_mode='open' where id='$M8';" >/dev/null   # simulate an edit to open mode with Adam still pending
{ as $O; echo "begin; select decide_join('$M8','$A',true); select pg_sleep(1); commit;"; } | q > /tmp/m3_c2a.log &
sleep 0.3
{ as $B; echo "begin; select join_match('$M8'); select pg_sleep(1); commit;"; } | q > /tmp/m3_c2b.log &
wait
acc=$(q -c "select count(*) from match_players where match_id='$M8' and status='accepted'")
echo "  accepted: $acc (expect 1)"
[ "$acc" = 1 ] && echo "  CONTROL OK" || echo "  PROBLEM: $acc accepted"

q -c "delete from auth.users where id in ('$O','$A','$B','$X');" >/dev/null 2>&1 || true
