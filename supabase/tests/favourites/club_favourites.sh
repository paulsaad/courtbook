#!/usr/bin/env bash
# Security and behaviour tests for the favourite-clubs migration draft
# (docs/favourites/sql/club_favourites.draft.sql).
#
# LOCAL DISPOSABLE REPLICA ONLY: refuses anything but the local `courtbook_test` database. Every run
# is ONE transaction that is ROLLED BACK — the table, functions, users and rows never persist.
#
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh             # builds courtbook_test
#   PSQL="sudo -u postgres psql" bash supabase/tests/favourites/club_favourites.sh
#
# MIGRATION defaults to the draft; point it at the real file once the migration is numbered.
# Each mutant below is a plausible mistake and must make the suite FAIL.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_test
MIGRATION=${MIGRATION:-docs/favourites/sql/club_favourites.draft.sql}

where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
[ -f "$MIGRATION" ] || { echo "missing $MIGRATION"; exit 2; }
present() { $PSQL -At -d $DB -c "select (select count(*) from pg_class where relname='club_favourites')||'/'||(select count(*) from pg_proc where proname in ('set_club_favourite','my_favourite_clubs'))"; }
[ "$(present)" = "0/0" ] || { echo "refusing: favourites objects already exist on the replica — rebuild it with run.sh"; exit 2; }

U1=c1000000-0000-4000-8000-000000000001
U2=c1000000-0000-4000-8000-000000000002
ADM=c1000000-0000-4000-8000-000000000003

suite() {
  local mig=$1
  {
    echo "\\set ON_ERROR_STOP 1"
    echo "begin;"
    echo "\\i $mig"
    echo "\\i $mig"   # re-runnable
    cat <<SQL
create temp table t (id text, pass boolean, detail text);
create temp table r (k text, v text);
grant all on r to authenticated, anon;
insert into t select 'F14 applies twice: one table, two functions',
  (select count(*) from pg_class where relname = 'club_favourites') = 1
  and (select count(*) from pg_proc where proname in ('set_club_favourite', 'my_favourite_clubs')) = 2, '';

insert into auth.users (id, email) values ('$U1','u1@fav.test'), ('$U2','u2@fav.test'), ('$ADM','adm@fav.test');
update profiles set roles = '{player,admin}' where id = '$ADM';
insert into clubs (name, slug) select 'Fav Club ' || i, 'fav-club-' || i from generate_series(1, 55) i;
SQL
    # --- as U1 -------------------------------------------------------------------------------
    cat <<SQL
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U1', true) \g /dev/null
insert into r select 'u1_add', set_club_favourite((select id from clubs where slug = 'batroun'), true)::text;
insert into r select 'u1_add_again', set_club_favourite((select id from clubs where slug = 'batroun'), true)::text;
insert into r select 'u1_rows_after_two_adds', count(*)::text from club_favourites where club_id = (select id from clubs where slug = 'batroun');
do \$\$ begin
  insert into club_favourites (profile_id, club_id) values ('$U1', (select id from clubs where slug = 'other'));
  insert into r values ('u1_direct_insert', 'allowed');
exception when insufficient_privilege then insert into r values ('u1_direct_insert', 'refused');
end \$\$;
do \$\$ begin
  perform set_club_favourite((select id from clubs where slug = 'closed'), true);
  insert into r values ('u1_add_inactive', 'allowed');
exception when others then insert into r values ('u1_add_inactive', sqlerrm);
end \$\$;
do \$\$ begin
  perform set_club_favourite('99999999-0000-4000-8000-000000000000', true);
  insert into r values ('u1_add_unknown', 'allowed');
exception when others then insert into r values ('u1_add_unknown', sqlerrm);
end \$\$;
do \$\$ begin
  perform set_club_favourite((select id from clubs where slug = 'other'), null);
  insert into r values ('u1_null_state', 'allowed');
exception when others then insert into r values ('u1_null_state', sqlerrm);
end \$\$;
insert into r select 'u1_add_other', set_club_favourite((select id from clubs where slug = 'other'), true)::text;
reset role;
SQL
    # make "other" newer than "batroun" regardless of statement timing, for the ordering check
    # (inside one transaction both rows carry the same now(); real requests don't)
    echo "update club_favourites set created_at = created_at + interval '1 minute' where club_id = (select id from clubs where slug = 'other');"
    cat <<SQL
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U1', true) \g /dev/null
insert into r select 'u1_list', string_agg(c.slug, ',' order by m.created_at desc) from my_favourite_clubs() m join clubs c on c.id = m.club_id;
reset role;
SQL
    # --- as U2 -------------------------------------------------------------------------------
    cat <<SQL
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U2', true) \g /dev/null
insert into r select 'u2_sees_rows', count(*)::text from club_favourites;
insert into r select 'u2_list', count(*)::text from my_favourite_clubs();
insert into r select 'u2_unfavourite_batroun', set_club_favourite((select id from clubs where slug = 'batroun'), false)::text;
do \$\$ begin
  delete from club_favourites where profile_id = '$U1';
  insert into r values ('u2_direct_delete', 'allowed');
exception when insufficient_privilege then insert into r values ('u2_direct_delete', 'refused');
end \$\$;
do \$\$ begin
  update club_favourites set profile_id = '$U2' where profile_id = '$U1';
  insert into r values ('u2_direct_update', 'allowed');
exception when insufficient_privilege then insert into r values ('u2_direct_update', 'refused');
end \$\$;
-- cap: 50 favourites, the 51st is refused, re-adding one already held at the cap is fine
insert into r select 'u2_fill_50', count(*)::text from (select set_club_favourite(id, true) from clubs where slug like 'fav-club-%' order by slug limit 50) x;
do \$\$ begin
  perform set_club_favourite((select id from clubs where slug = 'fav-club-9'), true);
  insert into r values ('u2_51st', 'allowed');
exception when others then insert into r values ('u2_51st', sqlerrm);
end \$\$;
insert into r select 'u2_readd_at_cap', set_club_favourite((select id from clubs where slug = 'fav-club-1'), true)::text;
reset role;
SQL
    # --- admin and staff read nothing; signed-out and anonymous callers are refused -----------
    cat <<SQL
set local role authenticated;
select set_config('request.jwt.claim.sub', '$ADM', true) \g /dev/null
insert into r select 'admin_sees_rows', count(*)::text from club_favourites;
select set_config('request.jwt.claim.sub', '', true) \g /dev/null
do \$\$ begin
  perform set_club_favourite((select id from clubs where slug = 'batroun'), true);
  insert into r values ('nosub_add', 'allowed');
exception when others then insert into r values ('nosub_add', sqlerrm);
end \$\$;
insert into r select 'nosub_list', count(*)::text from my_favourite_clubs();
reset role;
set local role anon;
do \$\$ begin
  perform 1 from club_favourites;
  insert into r values ('anon_select', 'allowed');
exception when insufficient_privilege then insert into r values ('anon_select', 'refused');
end \$\$;
do \$\$ begin
  perform set_club_favourite((select id from clubs where slug = 'batroun'), true);
  insert into r values ('anon_set', 'allowed');
exception when insufficient_privilege then insert into r values ('anon_set', 'refused');
  when others then insert into r values ('anon_set', sqlerrm);
end \$\$;
reset role;
SQL
    # --- club becomes inactive, then active again; account deleted -----------------------------
    cat <<SQL
update clubs set active = false where slug = 'other';
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U1', true) \g /dev/null
insert into r select 'u1_list_other_inactive', coalesce(string_agg(c.slug, ','), '') from my_favourite_clubs() m join clubs c on c.id = m.club_id;
reset role;
insert into r select 'row_kept_while_inactive', count(*)::text from club_favourites where profile_id = '$U1' and club_id = (select id from clubs where slug = 'other');
update clubs set active = true where slug = 'other';
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U1', true) \g /dev/null
insert into r select 'u1_list_reactivated', string_agg(c.slug, ',' order by m.created_at desc) from my_favourite_clubs() m join clubs c on c.id = m.club_id;
reset role;
update clubs set active = false where slug = 'other';
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U1', true) \g /dev/null
insert into r select 'u1_remove_inactive', set_club_favourite((select id from clubs where slug = 'other'), false)::text;
reset role;
insert into r select 'removed_while_inactive', count(*)::text from club_favourites where profile_id = '$U1' and club_id = (select id from clubs where slug = 'other');
do \$\$ begin
  insert into club_favourites (profile_id, club_id) values ('$U1', (select id from clubs where slug = 'batroun'));
  insert into r values ('owner_duplicate_insert', 'allowed');
exception when unique_violation then insert into r values ('owner_duplicate_insert', 'unique_violation');
end \$\$;
delete from auth.users where id = '$U1';
insert into r select 'rows_after_account_deleted', count(*)::text from club_favourites where profile_id = '$U1';

-- assertions
insert into t select id, coalesce((select v from r where k = key) = want, false), coalesce((select v from r where k = key), 'missing')
from (values
  ('F2 add returns true', 'u1_add', 'true'),
  ('F2 adding again is a no-op, not an error', 'u1_add_again', 'true'),
  ('F2 still one row after two adds (no duplicate)', 'u1_rows_after_two_adds', '1'),
  ('F3 direct insert by a player is refused', 'u1_direct_insert', 'refused'),
  ('F4 duplicate impossible even for the table owner (primary key)', 'owner_duplicate_insert', 'unique_violation'),
  ('F5 another player sees none of my rows', 'u2_sees_rows', '0'),
  ('F5 another player''s list is their own (empty)', 'u2_list', '0'),
  ('F6 another player''s unfavourite touches only their own (returns false)', 'u2_unfavourite_batroun', 'false'),
  ('F6 another player cannot delete my rows directly', 'u2_direct_delete', 'refused'),
  ('F6 another player cannot update my rows directly', 'u2_direct_update', 'refused'),
  ('F7 an inactive club cannot be added', 'u1_add_inactive', 'club_not_found'),
  ('F7 a favourite whose club becomes inactive is left out of my list', 'u1_list_other_inactive', 'batroun'),
  ('F7 ... but kept, so it returns with the club', 'row_kept_while_inactive', '1'),
  ('F7 ... and is listed again when the club is active again (newest first)', 'u1_list_reactivated', 'other,batroun'),
  ('F7 a favourite of an inactive club can still be removed', 'u1_remove_inactive', 'false'),
  ('F7 ... and is gone', 'removed_while_inactive', '0'),
  ('F8 an unknown club cannot be added', 'u1_add_unknown', 'club_not_found'),
  ('F9 up to 50 favourites', 'u2_fill_50', '50'),
  ('F9 the 51st is refused', 'u2_51st', 'too_many_favourites'),
  ('F9 re-adding one already held at the cap is fine', 'u2_readd_at_cap', 'true'),
  ('F10 null state is refused', 'u1_null_state', 'bad_request'),
  ('F10 no signed-in user: refused', 'nosub_add', 'not_authenticated'),
  ('F10 no signed-in user: empty list', 'nosub_list', '0'),
  ('F1 anonymous: no read of the table', 'anon_select', 'refused'),
  ('F1 anonymous: cannot call set_club_favourite', 'anon_set', 'refused'),
  ('F11 favourites go with the account', 'rows_after_account_deleted', '0'),
  ('F12 admin reads no player''s favourites through the table', 'admin_sees_rows', '0'),
  ('F13 newest first', 'u1_list', 'other,batroun')
) v(id, key, want);
insert into t select 'F1 anon has no privilege on the table',
  not has_table_privilege('anon', 'club_favourites', 'select') and not has_table_privilege('anon', 'club_favourites', 'insert'), '';
insert into t select 'F1 authenticated may only select the table',
  has_table_privilege('authenticated', 'club_favourites', 'select')
  and not has_table_privilege('authenticated', 'club_favourites', 'insert')
  and not has_table_privilege('authenticated', 'club_favourites', 'update')
  and not has_table_privilege('authenticated', 'club_favourites', 'delete'), '';
insert into t select 'F1 anon cannot execute either function',
  not has_function_privilege('anon', 'set_club_favourite(uuid, boolean)', 'execute')
  and not has_function_privilege('anon', 'my_favourite_clubs()', 'execute'), '';
SQL
    echo "select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;"
    echo "select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;"
    echo "rollback;"
  } | $PSQL -d $DB -X -q -At 2>&1
}

status=0
echo "== favourites tests against $MIGRATION"
out=$(suite "$MIGRATION")
[ -n "${VERBOSE:-}" ] && echo "$out" | grep -E "^ok "
echo "$out" | grep -E "^(FAIL|ERROR|psql)" | grep -v NOTICE || true
summary=$(echo "$out" | grep -E "^FAILED " | tail -1)
oks=$(echo "$out" | grep -c "^ok ")
echo "   $oks checks passed; $summary"
[ "$summary" = "FAILED 0 of $oks" ] || status=1

echo "== mutation checks (each must make the suite fail)"
mutants=(
  "M1 inactive clubs can be added|s/where id = p_club and active)/where id = p_club)/"
  "M2 players may write the table directly|s/^grant select on club_favourites to authenticated;/grant select, insert, update, delete on club_favourites to authenticated;/"
  "M3 everyone reads everyone's favourites|s/for select to authenticated using (profile_id = auth.uid());/for select to authenticated using (true);/"
  "M4 adding twice errors|s/^  on conflict (profile_id, club_id) do nothing;/  ;/"
  "M5 inactive clubs listed|s/join clubs c on c.id = f.club_id and c.active/join clubs c on c.id = f.club_id/"
  "M6 anon may call|s/^revoke all on function set_club_favourite(uuid, boolean) from public, anon;/grant execute on function set_club_favourite(uuid, boolean) to anon;/"
  "M7 no cap|s/>= 50/>= 5000/"
  "M8 no signed-in check|s/if me is null then raise exception 'not_authenticated'; end if;/null;/"
  "M9 list not limited to me|s/where f.profile_id = auth.uid()/where true/"
)
tmp=$(mktemp -d); chmod 755 "$tmp"
for m in "${mutants[@]}"; do
  name=${m%%|*}; expr=${m#*|}
  sed "$expr" "$MIGRATION" > "$tmp/mutant.sql"; chmod 644 "$tmp/mutant.sql"
  if cmp -s "$MIGRATION" "$tmp/mutant.sql"; then echo "   $name: NOT APPLIED (pattern not found)"; status=1; continue; fi
  res=$(suite "$tmp/mutant.sql" | grep -E "^FAILED " | tail -1)
  if [ -n "$res" ] && [ "${res#FAILED 0 }" = "$res" ]; then echo "   $name: detected ($res)"
  elif [ -z "$res" ]; then echo "   $name: detected (the suite aborted)"
  else echo "   $name: NOT DETECTED ($res)"; status=1; fi
done
rm -rf "$tmp"
echo "== replica after the run: favourites table/functions = $(present) (expected 0/0)"
[ "$(present)" = "0/0" ] || status=1
[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
