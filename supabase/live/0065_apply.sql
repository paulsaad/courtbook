-- 0065 for the LIVE database, all or nothing. Paste the whole file into Supabase → SQL Editor on the
-- live project and run it once, AFTER 0065_preflight.sql showed every row ok.
--
-- One transaction: it first checks that hold_slot is exactly the verified pre-0065 version, then
-- replaces it, then checks the result is exactly the verified 0065 version with the right
-- permissions. If any step or check fails, everything is rolled back and the old function is
-- untouched. Running it a second time stops at the first check and changes nothing.
-- Code is compared ignoring Windows line endings and trailing spaces (how live was pasted).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $pre$
declare n int; args text; body text;
begin
  select count(*), max(pg_get_function_identity_arguments(oid)), max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) into n, args, body
  from pg_proc where proname = 'hold_slot' and pronamespace = 'public'::regnamespace;
  if n <> 1 or args <> 'p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone'
     or body <> '93fa689d8321abde3f8d586203356c53' then
    raise exception 'STOPPED, nothing changed: hold_slot is not the verified pre-0065 version (count %, args %, body %)', n, args, body;
  end if;
end $pre$;

-- ===== migration 0065, unchanged from supabase/migrations/0065_hold_slot_retry_token.sql =====
-- G2 (native app plan §1): a retry token for hold_slot(), so a phone that lost its connection
-- mid-request can safely ask again.
--
-- Before: a second hold_slot() call cannot double-book — it expires the player's first hold and
-- makes a new one. But a phone that does not know whether its first call committed, and retries,
-- replaces a hold the player may already be paying for.
--
-- After: the caller may pass p_token (one per reservation attempt, reused on every retry of it).
--   * same player + same token + same court and times  -> the existing booking, already = true,
--     and NOTHING else happens: no other hold is expired, no row is written, and an expired hold is
--     returned as it is (a retry never revives a hold);
--   * same player + same token + different court or times -> 'token_reused' (the 0052 rule);
--   * otherwise -> exactly the old path, with the token stored on the booking.
-- Without p_token the function behaves exactly as before; the web app's call is unchanged.
--
-- Why one function and not an overload: PostgREST picks a function by name and argument names.
-- With hold_slot(4 args) and hold_slot(4 args + p_token default null) both present, a 4-argument
-- call matches both and fails as ambiguous (PGRST203); plain SQL refuses with "function is not
-- unique". So the old signature is dropped and the new one created in the same transaction: there
-- is never a moment with zero or two hold_slot functions.
--
-- Rebuilt from pg_get_functiondef of the current definition (0052), not from an older migration.
-- Changes against that definition: the parameter, the `already` column, the replay block after the
-- player lock, client_token in the insert, and the unique_violation handler.
--
-- Safe to re-run (section AL re-applies 0041+ in order; 0051/0052 re-create the 4-arg version and
-- this migration removes it again).

drop function if exists hold_slot(uuid, uuid, timestamptz, timestamptz);
-- the return type gains a column, which create or replace cannot do on a re-run of an older body
drop function if exists hold_slot(uuid, uuid, timestamptz, timestamptz, uuid);

create function hold_slot(p_club uuid, p_court uuid, p_start timestamptz, p_end timestamptz, p_token uuid default null)
returns table (booking_id uuid, payment_id uuid, amount_usd numeric, fee_usd numeric, total_usd numeric,
               hold_expires_at timestamptz, already boolean)
language plpgsql security definer set search_path = public as $$
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
  e bookings%rowtype;
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

  -- A retry of an attempt that already reached the database. The player row lock above serialises
  -- two calls with the same token, so the second always sees the first one's committed row here.
  if p_token is not null then
    select * into e from bookings where player_id = v_player and client_token = p_token;
    if found then
      if e.court_id is distinct from p_court or e.start_at <> p_start or e.end_at <> p_end then
        raise exception 'token_reused';
      end if;
      return query
        select e.id, p.id, p.amount_usd, p.fee_usd, p.total_usd, e.hold_expires_at, true
        from (select 1) one left join payments p on p.booking_id = e.id;
      return;
    end if;
  end if;

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
                        hold_expires_at, price_usd, fee_usd, client_token)
  values (v_booking, p_club, p_court, v_player, p_start, p_end, 'pending', 'app', v_player, v_exp, v_price, c.service_fee_usd, p_token);

  insert into payments (id, booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd)
  values (v_payment, v_booking, v_player, p_club,
          coalesce(nullif(current_setting('app.payment_provider', true), ''), 'simulated'),
          v_price, c.service_fee_usd, v_price + c.service_fee_usd);

  return query select v_booking, v_payment, v_price, c.service_fee_usd, v_price + c.service_fee_usd, v_exp, false;
exception
  when exclusion_violation then raise exception 'slot_taken';
  when unique_violation then
    -- Second line of defence for a token, as in book_at_desk. A duplicate token insert lands here and
    -- the whole call rolls back (including any holds it expired), so the retry still gets its own
    -- booking. The up-front check above is still needed: a retry whose expired slot has since been
    -- taken fails with slot_taken before reaching the insert (suite check 107u proves the difference).
    if p_token is not null then
      select * into e from bookings where player_id = v_player and client_token = p_token;
      if found then
        if e.court_id is distinct from p_court or e.start_at <> p_start or e.end_at <> p_end then
          raise exception 'token_reused';
        end if;
        return query
          select e.id, p.id, p.amount_usd, p.fee_usd, p.total_usd, e.hold_expires_at, true
          from (select 1) one left join payments p on p.booking_id = e.id;
        return;
      end if;
    end if;
    raise exception 'hold_conflict';
end $$;

revoke execute on function hold_slot(uuid, uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function hold_slot(uuid, uuid, timestamptz, timestamptz, uuid) to authenticated, service_role;

-- ===== end of migration 0065 =====

do $post$
declare n int; args text; body text; f oid;
begin
  select count(*), max(pg_get_function_identity_arguments(oid)), max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))), max(oid) into n, args, body, f
  from pg_proc where proname = 'hold_slot' and pronamespace = 'public'::regnamespace;
  if n <> 1 or args <> 'p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_token uuid'
     or body <> '04b6a3a1cda5618ec2894642fd0e08a2' then
    raise exception 'ROLLED BACK: hold_slot after 0065 is not the verified version (count %, args %, body %)', n, args, body;
  end if;
  if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
     or not has_function_privilege('service_role', f, 'execute') then
    raise exception 'ROLLED BACK: hold_slot permissions are not anon=no, authenticated=yes, service_role=yes';
  end if;
end $post$;

-- tell the API layer to reload its list of functions (delivered at commit)
notify pgrst, 'reload schema';
commit;
select 'hold_slot is now the 0065 version' as result;
