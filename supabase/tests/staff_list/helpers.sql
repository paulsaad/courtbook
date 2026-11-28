-- F3 staff list: helpers (pg_temp: per session). Fictional people. Same as staff_moves/helpers.sql.
create function pg_temp.r(who uuid, q text) returns text language plpgsql as $f$
declare res text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  execute 'set local role authenticated';
  begin
    if q ~* '^\s*select' then execute q into res; else execute q; end if;
    res := coalesce(nullif(res, ''), 'ok');
  exception when others then res := 'ERR ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return res;
end $f$;
-- f7…01 Rana (player), …02 Maya and …03 Dina (staff of Batroun), …04 Omar (staff of another club only)
create function pg_temp.u(n int) returns uuid language sql as $$ select ('f7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.club() returns uuid language sql as $$ select id from clubs where slug = 'batroun' $$;
create function pg_temp.c(n text) returns uuid language sql as $$ select id from courts where club_id = pg_temp.club() and name = n $$;
create function pg_temp.at(d int, hhmm text) returns timestamptz language sql as $$ select ((current_date + d)::timestamp + hhmm::time) at time zone 'Asia/Beirut' $$;
-- where a booking is now: 'Padel 1 18:00-19:00 confirmed'
create function pg_temp.pos(b uuid) returns text language sql as $$
  select k.name || ' ' || to_char(x.start_at at time zone 'Asia/Beirut', 'HH24:MI') || '-' || to_char(x.end_at at time zone 'Asia/Beirut', 'HH24:MI') || ' ' || x.status
  from bookings x join courts k on k.id = x.court_id where x.id = b $$;
-- a desk's move: booking, target court/day/from/to, expected price, and what the desk saw (court, day, from, to)
create function pg_temp.mv(who int, b uuid, court text, d int, f text, t text, price numeric, seen_court text, sd int, sf text, st text) returns text
language sql as $$
  select pg_temp.r(pg_temp.u(who), format('select move_booking_priced(%L,%L,%L,%L,%s,%L,%L,%L)::text', b, pg_temp.c(court), pg_temp.at(d, f), pg_temp.at(d, t),
    coalesce(price::text, 'null'), pg_temp.c(seen_court), pg_temp.at(sd, sf), pg_temp.at(sd, st))) $$;
