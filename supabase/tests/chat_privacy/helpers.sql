-- shared by fixtures.sql and tests.sql (pg_temp: per session)
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
create function pg_temp.svc(q text) returns text language plpgsql as $f$
declare res text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role service_role';
  begin execute q into res; res := coalesce(res, 'ok'); exception when others then res := 'ERR ' || sqlerrm; end;
  execute 'reset role';
  return res;
end $f$;
create function pg_temp.u(n int) returns uuid language sql as $$ select ('f6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.at(d int, hhmm text) returns timestamptz language sql as $$ select ((current_date + d)::timestamp + hhmm::time) at time zone 'Asia/Beirut' $$;
create function pg_temp.game(n int) returns uuid language sql as $$ select id from matches where organizer_id = pg_temp.u(1) and note = 'zz-chatpriv-' || n $$;
create function pg_temp.say(who int, m uuid, txt text) returns uuid language plpgsql as $f$
begin
  perform pg_temp.r(pg_temp.u(who), format('insert into match_messages (match_id, profile_id, body) values (%L, %L, %L)', m, pg_temp.u(who), txt));
  return (select id from match_messages where match_id = m and profile_id = pg_temp.u(who) and body = txt order by created_at desc limit 1);
end $f$;
create function pg_temp.notice(who int, m uuid) returns text language sql as $$
  select coalesce(string_agg(body, ' | ' order by created_at), '') from notifications where profile_id = pg_temp.u(who) and match_id = m and kind = 'match_message' $$;
