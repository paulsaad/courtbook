-- ROLLBACK of 0065 for the LIVE database, all or nothing. Only if 0065 has to be undone.
-- Puts back the 4-argument hold_slot exactly as verified before 0065 (website keeps working).
-- IMPORTANT once the app's in-app payment flow is released: it calls hold_slot with p_token, which
-- this removes. Coordinate with an app update (or roll the app back first) before running this.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $pre$
declare n int; body text;
begin
  select count(*), max(md5(prosrc)) into n, body from pg_proc where proname = 'hold_slot' and pronamespace = 'public'::regnamespace;
  if n <> 1 or body <> '6003eef1bc05a95409b35e064367f903' then
    raise exception 'STOPPED, nothing changed: hold_slot is not the 0065 version (count %, body %)', n, body;
  end if;
end $pre$;

drop function if exists public.hold_slot(uuid, uuid, timestamptz, timestamptz, uuid);
CREATE OR REPLACE FUNCTION public.hold_slot(p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(booking_id uuid, payment_id uuid, amount_usd numeric, fee_usd numeric, total_usd numeric, hold_expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  v_player uuid := auth.uid();
  c clubs%rowtype;
  v_mins numeric;
  v_price numeric;
  v_booking uuid := gen_random_uuid();
  v_payment uuid := gen_random_uuid();
  v_exp timestamptz;
  v_courts uuid[];
begin
  if v_player is null then raise exception 'not_authenticated'; end if;
  if p_start <= now() then raise exception 'slot_in_past'; end if;

  -- club first, and held: the mode cannot flip while this hold is being created
  select * into c from clubs where id = p_club and active for share;
  if not found then raise exception 'club_not_found'; end if;
  if c.payment_mode = 'at_desk' then raise exception 'wrong_payment_mode'; end if;
  if p_start > now() + make_interval(days => c.booking_window_days) then raise exception 'beyond_booking_window'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = p_club and active) then raise exception 'court_not_found'; end if;

  v_mins := extract(epoch from (p_end - p_start)) / 60;
  if v_mins < c.min_booking_minutes or v_mins > c.max_booking_minutes or v_mins % c.slot_minutes <> 0 then
    raise exception 'bad_duration';
  end if;

  perform 1 from profiles where id = v_player for update;

  select array_agg(court_id) || p_court into v_courts
  from bookings where player_id = v_player and status = 'pending' and court_id is not null;
  perform lock_courts(coalesce(v_courts, array[p_court]));

  perform 1 from bookings where player_id = v_player and status = 'pending' for update;
  update bookings set status = 'expired' where player_id = v_player and status = 'pending';
  update payments p set status = 'expired'
  from bookings b where p.booking_id = b.id and b.player_id = v_player and b.status = 'expired' and p.status = 'pending';

  perform expire_stale_holds(p_court);
  perform assert_valid_court_slot(p_club, p_court, p_start, p_end);
  v_price := quote_price(p_court, p_start, p_end);
  v_exp := now() + make_interval(mins => c.hold_minutes);

  insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by,
                        hold_expires_at, price_usd, fee_usd)
  values (v_booking, p_club, p_court, v_player, p_start, p_end, 'pending', 'app', v_player, v_exp, v_price, c.service_fee_usd);

  insert into payments (id, booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd)
  values (v_payment, v_booking, v_player, p_club,
          coalesce(nullif(current_setting('app.payment_provider', true), ''), 'simulated'),
          v_price, c.service_fee_usd, v_price + c.service_fee_usd);

  return query select v_booking, v_payment, v_price, c.service_fee_usd, v_price + c.service_fee_usd, v_exp;
exception
  when exclusion_violation then raise exception 'slot_taken';
  when unique_violation then raise exception 'hold_conflict';
end $function$

;
revoke execute on function public.hold_slot(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.hold_slot(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;

do $post$
declare n int; args text; body text; f oid;
begin
  select count(*), max(pg_get_function_identity_arguments(oid)), max(md5(prosrc)), max(oid) into n, args, body, f
  from pg_proc where proname = 'hold_slot' and pronamespace = 'public'::regnamespace;
  if n <> 1 or args <> 'p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone'
     or body <> 'a91e9a74505c97e17c4f910fa10d1e15'
     or has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
     or not has_function_privilege('service_role', f, 'execute') then
    raise exception 'ROLLED BACK: hold_slot after rollback is not the verified pre-0065 version';
  end if;
end $post$;

notify pgrst, 'reload schema';
commit;
select 'hold_slot is back to the pre-0065 version' as result;
