#!/usr/bin/env bash
# Temporary M3 test games on STAGING for Paul's phone tests (20 Nov 2026). Staging only.
#
#   accounts            read only: the staging accounts, personal addresses hidden (logs are public)
#   create <player> <a> <b>   two games at the demo club, no court booked, tagged "[M3 TEST]":
#                         G1 open game organised by account <a> — <player> can join it
#                         G2 approval game organised by <player>, with <a> and <b> waiting
#   shared <player> <helper>  ONE open game by <helper> with <player> in it and one message from <helper>
#   cleanup [ids...]    removes the "[M3 TEST]" games (with their players, messages and notices); given
#                       the recorded ids, removes nothing unless the tagged games are exactly those
#
# Acting as an account sets both settings auth.uid() reads (request.jwt.claim.sub and request.jwt.claims).
# Each account is given as the first 8 characters of an account id, as `accounts` prints them. Games are made through
# the real functions (post_match, join_match) acting as each account, so every rule and notice applies.
# No court booking, no club setting, no account is created or changed.
set -euo pipefail
: "${DB:?DB missing}"
TAG="[M3 TEST]"
q() { psql "$DB" -v ON_ERROR_STOP=1 -At "$@"; }

q -c "do \$\$ begin if to_regclass('staging_meta.applied') is null then raise exception 'not the staging database (no staging marker)'; end if; end \$\$;"

case "${1:-}" in
accounts)
  q -F ' | ' <<'SQL'
select left(u.id::text, 8),
       case when u.email like '%@courtbook.test' then u.email else '(personal address hidden)' end,
       coalesce(p.name, '-'), array_to_string(p.roles, ','),
       coalesce(to_char(u.last_sign_in_at, 'YYYY-MM-DD'), 'never'),
       (select count(*) from bookings b where b.player_id = u.id and b.status = 'confirmed' and b.start_at > now()) || ' upcoming booking(s)'
from auth.users u left join profiles p on p.id = u.id
order by u.last_sign_in_at desc nulls last;
SQL
  ;;
create)
  player="${2:-}"; ra="${3:-}"; rb="${4:-}"
  for v in "$player" "$ra" "$rb"; do [[ "$v" =~ ^[0-9a-f]{8}$ ]] || { echo "give three account ids (8 hex characters each)"; exit 1; }; done
  [ "$player" != "$ra" ] && [ "$player" != "$rb" ] && [ "$ra" != "$rb" ] || { echo "three different accounts needed"; exit 1; }
  q <<SQL
begin;
do \$\$
declare
  me uuid; others uuid[]; club uuid; g1 uuid; g2 uuid;
  d1 timestamptz := (date_trunc('day', now() at time zone 'Asia/Beirut') + interval '2 days 18 hours') at time zone 'Asia/Beirut';
  d2 timestamptz := (date_trunc('day', now() at time zone 'Asia/Beirut') + interval '3 days 19 hours') at time zone 'Asia/Beirut';
begin
  if exists (select 1 from matches where note like '$TAG%' and status <> 'cancelled') then
    raise exception 'test games already exist: run cleanup first';
  end if;
  select id into strict me from auth.users where left(id::text, 8) = '$player';
  others := array[(select id from auth.users where left(id::text, 8) = '$ra'), (select id from auth.users where left(id::text, 8) = '$rb')];
  if others[1] is null or others[2] is null then raise exception 'account not found'; end if;
  select id into strict club from clubs where slug = 'batroun' and is_demo;

  -- G1: open game by another account (acting as that account)
  perform set_config('request.jwt.claim.sub', others[1]::text, true), set_config('request.jwt.claims', json_build_object('sub', others[1], 'role', 'authenticated')::text, true);
  g1 := post_match(club, 'padel', d1, d1 + interval '90 minutes', null, null, 3, '$TAG Open game: join it from your phone', null, 'open');

  -- G2: approval game organised by Paul's player
  perform set_config('request.jwt.claim.sub', me::text, true), set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
  g2 := post_match(club, 'padel', d2, d2 + interval '90 minutes', null, null, 3, '$TAG Your game: accept or decline the requests', null, 'approval');

  -- two requests waiting on G2
  perform set_config('request.jwt.claim.sub', others[1]::text, true), set_config('request.jwt.claims', json_build_object('sub', others[1], 'role', 'authenticated')::text, true);
  perform join_match(g2);
  perform set_config('request.jwt.claim.sub', others[2]::text, true), set_config('request.jwt.claims', json_build_object('sub', others[2], 'role', 'authenticated')::text, true);
  perform join_match(g2);
  perform set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);

  raise notice 'G1 open game        %  % (Beirut)  organiser %', g1, to_char(d1 at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI'), left(others[1]::text, 8);
  raise notice 'G2 your game        %  % (Beirut)  organiser %', g2, to_char(d2 at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI'), left(me::text, 8);
  raise notice 'G2 waiting requests %, %', left(others[1]::text, 8), left(others[2]::text, 8);
end \$\$;
commit;
SQL
  q -F ' | ' -c "select left(m.id::text, 8), m.id, m.join_mode, m.status, to_char(m.start_at at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI'),
                       (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'pending') || ' waiting',
                       (select count(*) from notifications n where n.match_id = m.id) || ' notice(s)'
                 from matches m where m.note like '$TAG%' order by m.start_at"
  ;;
shared)
  # One shared game for both phones (block / unblock check): an open game organised by <helper>, with
  # <player> already in it and one chat message from <helper> to report or block. Made through the real
  # functions acting as each account; the helper accepts the community rules first (test account).
  player="${2:-}"; helper="${3:-}"
  for v in "$player" "$helper"; do [[ "$v" =~ ^[0-9a-f]{8}$ ]] || { echo "give two account ids (8 hex characters each)"; exit 1; }; done
  [ "$player" != "$helper" ] || { echo "two different accounts needed"; exit 1; }
  q <<SQL
begin;
do \$\$
declare
  me uuid; h uuid; club uuid; g uuid;
  d timestamptz := (date_trunc('day', now() at time zone 'Asia/Beirut') + interval '2 days 18 hours') at time zone 'Asia/Beirut';
begin
  if exists (select 1 from matches where note like '$TAG%' and status <> 'cancelled') then
    raise exception 'test games already exist: run cleanup first';
  end if;
  select id into strict me from auth.users where left(id::text, 8) = '$player';
  select id into strict h from auth.users where left(id::text, 8) = '$helper';
  select id into strict club from clubs where slug = 'batroun' and is_demo;
  perform set_config('request.jwt.claim.sub', h::text, true), set_config('request.jwt.claims', json_build_object('sub', h, 'role', 'authenticated')::text, true);
  perform accept_community_rules();
  g := post_match(club, 'padel', d, d + interval '90 minutes', null, null, 3, '$TAG Shared game: chat, report and block', null, 'open');
  perform set_config('request.jwt.claim.sub', me::text, true), set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
  perform join_match(g);
  perform set_config('request.jwt.claim.sub', h::text, true), set_config('request.jwt.claims', json_build_object('sub', h, 'role', 'authenticated')::text, true);
  insert into match_messages (match_id, profile_id, body) values (g, h, 'Hi! Test message from the other player.');
  perform set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
  raise notice 'shared game  %  % (Beirut)  organiser %  player % (in the game)', g, to_char(d at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI'), left(h::text, 8), left(me::text, 8);
end \$\$;
commit;
SQL
  q -F ' | ' -c "select m.id, m.status, to_char(m.start_at at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI'),
                       (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted') || ' accepted',
                       (select count(*) from match_messages x where x.match_id = m.id) || ' message(s)'
                 from matches m where m.note like '$TAG%' order by m.start_at"
  ;;
cleanup)
  # Optional: the exact game ids expected (from the record). If given, nothing is removed unless the
  # tagged games are exactly those.
  shift; expected=$(printf '%s\n' "$@" | grep -E '^[0-9a-f-]{36}$' | sort | paste -sd, -)
  q <<SQL
begin;
do \$\$
declare found text;
begin
  select coalesce(string_agg(id::text, ',' order by id::text), '') into found from matches where note like '$TAG%';
  raise notice 'tagged games: %', nullif(found, '');
  if '$expected' <> '' and found <> '$expected' then
    raise exception 'tagged games (%) are not exactly the expected ones (%): nothing removed', found, '$expected';
  end if;
end \$\$;
select count(*) || ' notice(s) of tagged games' from notifications where match_id in (select id from matches where note like '$TAG%');
select count(*) || ' player row(s) of tagged games' from match_players where match_id in (select id from matches where note like '$TAG%');
select count(*) || ' message(s) of tagged games' from match_messages where match_id in (select id from matches where note like '$TAG%');
select count(*) || ' booking(s) linked to tagged games (must be 0)' from matches where note like '$TAG%' and booking_id is not null;
do \$\$ begin
  if exists (select 1 from matches where note like '$TAG%' and booking_id is not null) then raise exception 'a tagged game is linked to a booking: nothing removed'; end if;
end \$\$;
delete from notifications where match_id in (select id from matches where note like '$TAG%');
delete from matches where note like '$TAG%';   -- players and messages cascade
select count(*) || ' tagged game(s) left' from matches where note like '$TAG%';
commit;
SQL
  ;;
*) echo "accounts | create <player> <a> <b> | shared <player> <helper> | cleanup"; exit 1 ;;
esac
