-- Phase 6 final review, targeted corrections.
-- (1) quote_price: finite range, within the club's maximum, active court and club — anon can call it.
-- (2) PostgreSQL grants EXECUTE to PUBLIC on every new function; revoking from anon alone leaves that open.
--     Revoke PUBLIC on every function of ours (not extension-owned ones), and stop the default for new ones.

create or replace function quote_price(p_court uuid, p_start timestamptz, p_end timestamptz)
returns numeric
language plpgsql stable security definer set search_path = public as $$
declare
  c clubs%rowtype;
  v_court courts%rowtype;
  t timestamptz := p_start;
  total numeric := 0;
  step_price numeric;
  l_time time;
  l_dow int;   -- 0 = Monday
begin
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) then raise exception 'bad_range'; end if;
  if p_end <= p_start then raise exception 'bad_range'; end if;
  select * into v_court from courts where id = p_court and active;
  if not found then raise exception 'court_not_found'; end if;
  select * into c from clubs where id = v_court.club_id and active;
  if not found then raise exception 'club_not_found'; end if;
  if p_end - p_start > make_interval(mins => c.max_booking_minutes) then raise exception 'too_long'; end if;
  while t < p_end loop
    l_time := (t at time zone c.timezone)::time;
    l_dow  := extract(isodow from (t at time zone c.timezone))::int - 1;
    select pr.price_usd into step_price
    from price_rules pr
    where pr.club_id = c.id
      and (pr.court_id = p_court or pr.court_id is null)
      and (pr.weekday_mask & (1 << l_dow)) <> 0
      and pr.start_time <= l_time and l_time < pr.end_time
    order by pr.court_id nulls last           -- court-specific rule wins
    limit 1;
    if step_price is null then raise exception 'no_price_rule'; end if;
    total := total + step_price * c.slot_minutes / 60.0;
    t := t + make_interval(mins => c.slot_minutes);
  end loop;
  return round(total, 2);
end $$;

-- PUBLIC execute off for all our functions (extension members excluded: pgcrypto/btree_gist support functions)
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;
end $$;
-- Defaults for future functions. PUBLIC's built-in EXECUTE is a *global* default: schema-scoped entries only add
-- to it, so it must be revoked without "in schema". The schema-scoped grant to authenticated (Supabase default)
-- goes too: every RPC gets an explicit grant, as all migrations here already do.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

-- the public set, explicitly
grant execute on function club_discovery(sport, text, text, text) to anon;
grant execute on function next_free_slot(uuid, sport) to anon;
grant execute on function areas() to anon;
grant execute on function club_sports(uuid) to anon;
grant execute on function quote_price(uuid, timestamptz, timestamptz) to anon;
