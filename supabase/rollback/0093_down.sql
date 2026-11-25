-- Rollback of 0093 (M12.1 fee_online payments): back to exactly the 0092 schema. STAGING ONLY, and only while no
-- fee-only money exists: it refuses (and changes nothing) if any attempt, fee charge, fee-only payment or fee_online
-- club exists. Run as ONE transaction (psql -1). Verified locally: 0001–0092 → 0093 → this script gives a schema
-- fingerprint identical to 0001–0092 (supabase/tests/schema_fingerprint.sql).
do $$
begin
  -- 0094 reads 0093's tables: undo 0094 first (supabase/rollback/0094_down.sql), never leave its functions dangling
  if to_regclass('public.payment_reconciliation') is not null or to_regclass('public.payment_reconciliation_issues') is not null
     or to_regprocedure('payment_reconciliation_health(text,interval)') is not null then
    raise exception 'rollback refused: 0094 is applied; undo 0094 first';
  end if;
  if exists (select 1 from clubs where payment_mode = 'fee_online') then raise exception 'rollback refused: a club is in fee_online mode'; end if;
  if exists (select 1 from payments where kind = 'fee_only') then raise exception 'rollback refused: fee-only payments exist'; end if;
  if exists (select 1 from payment_attempts) then raise exception 'rollback refused: payment attempts exist'; end if;
  if exists (select 1 from fee_charges) then raise exception 'rollback refused: fee charges exist'; end if;
end $$;

drop function if exists start_payment_attempt(uuid, uuid);
drop function if exists open_payment_attempt(uuid, text, text);
drop function if exists abandon_payment_attempt(uuid, text);
drop function if exists reconcile_provider_charge(text, text, text, numeric, text);
drop function if exists fee_charge_already_recorded(text, text, numeric, text, uuid);
drop function if exists record_attempt_result(uuid, text, text, numeric, text);
drop function if exists attempts_to_check(interval, interval, int);
drop function if exists complete_fee_refund(uuid, numeric, text, text);
drop function if exists fee_refunds_due();

-- the functions 0093 replaced, exactly as they were after 0092
CREATE OR REPLACE FUNCTION public.set_club_payment_mode(p_club uuid, p_mode text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int := 0;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_mode not in ('simulated', 'at_desk') then raise exception 'bad_payment_mode'; end if;
  perform 1 from clubs where id = p_club for update;
  if not found then raise exception 'club_not_found'; end if;
  if p_mode = 'simulated' and not (select is_demo from clubs where id = p_club) then raise exception 'simulated_demo_only'; end if;  -- 0070

  -- expire the holds BEFORE the club flips, or the trigger below would refuse to expire their payments
  if p_mode = 'at_desk' then
    update bookings set status = 'expired'
    where club_id = p_club and status = 'pending';
    get diagnostics n = row_count;
    update payments p set status = 'expired'
    from bookings b where p.booking_id = b.id and b.club_id = p_club and b.status = 'expired' and p.status = 'pending';
  end if;

  update clubs set payment_mode = p_mode where id = p_club;
  return n;   -- holds released by the switch
end $function$
;

CREATE OR REPLACE FUNCTION public.hold_slot(p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_token uuid DEFAULT NULL::uuid)
 RETURNS TABLE(booking_id uuid, payment_id uuid, amount_usd numeric, fee_usd numeric, total_usd numeric, hold_expires_at timestamp with time zone, already boolean)
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
end $function$
;

CREATE OR REPLACE FUNCTION public.cancel_booking(p_booking uuid, p_club_caused boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_court uuid;
  b bookings%rowtype;
  cutoff int;
  is_staff boolean;
  refund boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select court_id into v_court from bookings where id = p_booking;
  if not found then raise exception 'not_found'; end if;
  if v_court is not null then perform 1 from courts where id = v_court for update; end if;
  select * into b from bookings where id = p_booking for update;
  perform 1 from payments where booking_id = p_booking for update;

  if b.status not in ('confirmed', 'pending') then raise exception 'not_confirmed'; end if;

  is_staff := is_staff_of(b.club_id);
  if not is_staff and (b.player_id is null or b.player_id <> auth.uid()) then raise exception 'forbidden'; end if;
  if p_club_caused and (not is_staff or b.player_id = auth.uid()) then raise exception 'forbidden'; end if;
  -- 0083: a player cancels only before the start; a booking being played or over is the club's record (staff can still
  -- correct it). A hold can still be released.
  if not is_staff and b.status = 'confirmed' and b.start_at <= now() then raise exception 'booking_started'; end if;

  select cancel_cutoff_hours into cutoff from clubs where id = b.club_id;
  refund := p_club_caused or b.start_at - make_interval(hours => cutoff) > now();

  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking;

  if b.status = 'pending' then
    update payments set status = 'expired' where booking_id = b.id and status = 'pending';
  elsif refund then
    update payments set status = 'refund_due',
      note = case when p_club_caused then 'club-caused cancellation' else 'cancelled before cutoff' end
      where booking_id = b.id and status = 'paid';
  end if;

  if b.credit_tx_id is not null and refund then
    insert into credit_transactions (profile_id, delta, kind, booking_id, created_by)
    values (b.player_id, +1, 'refund', b.id, auth.uid());
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.confirm_payment(p_payment uuid, p_provider_ref text, p_total_usd numeric)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking uuid; v_court uuid; v_club uuid; v_real boolean;
  p payments%rowtype; b bookings%rowtype;
begin
  select booking_id, club_id into v_booking, v_club from payments where id = p_payment;
  if v_booking is null then raise exception 'payment_not_found'; end if;
  perform 1 from clubs where id = v_club for share;          -- club → court → booking → payment
  select court_id into v_court from bookings where id = v_booking;

  if v_court is not null then perform 1 from courts where id = v_court for update; end if;
  select * into b from bookings where id = v_booking for update;
  select * into p from payments where id = p_payment for update;
  v_real := p.provider <> 'simulated';

  -- a club settling at its own desk takes nothing through CourtBook, so a simulated confirmation is
  -- never real money. A real gateway's receipt still lands: refusing it would leave a genuine
  -- obligation unrecorded.
  if not v_real and (select payment_mode from clubs where id = v_club) = 'at_desk' then
    raise exception 'wrong_payment_mode';
  end if;

  if p.status = 'paid' then
    if p.provider_ref = p_provider_ref and p.total_usd = p_total_usd then return 'already_paid'; end if;
    raise exception 'payment_mismatch';
  end if;
  if p.status in ('refund_due', 'refunded') then return p.status::text; end if;
  if p.total_usd <> p_total_usd then raise exception 'amount_mismatch'; end if;
  if exists (select 1 from payments where provider_ref = p_provider_ref and id <> p_payment) then
    raise exception 'duplicate_provider_ref';
  end if;

  if b.status = 'pending' then
    update bookings set status = 'confirmed', hold_expires_at = null where id = b.id;
    update payments set status = 'paid', paid_at = now(), collected = v_real, provider_ref = p_provider_ref where id = p.id;
    return 'confirmed';
  end if;

  -- the gateway took the money after the hold had gone: owed back, and we know when it arrived
  update payments set status = 'refund_due', paid_at = now(), collected = v_real, provider_ref = p_provider_ref,
    note = 'paid after hold expired or booking cancelled' where id = p.id;
  return 'refund_due';
end $function$
;

CREATE OR REPLACE FUNCTION public.fail_payment(p_payment uuid, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_booking uuid; v_court uuid; p payments%rowtype;
begin
  select booking_id into v_booking from payments where id = p_payment;
  if v_booking is null then return; end if;
  select court_id into v_court from bookings where id = v_booking;
  if v_court is not null then perform 1 from courts where id = v_court for update; end if;
  perform 1 from bookings where id = v_booking for update;
  select * into p from payments where id = p_payment for update;
  if p.status <> 'pending' then return; end if;
  update payments set status = 'failed', note = p_note where id = p.id;
  update bookings set status = 'expired' where id = v_booking and status = 'pending';
end $function$
;

CREATE OR REPLACE FUNCTION public.mark_refunded(p_payment uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p payments%rowtype;
begin
  select * into p from payments where id = p_payment for update;
  if not found then raise exception 'not_found'; end if;
  if auth.uid() is not null and not is_staff_of(p.club_id) then raise exception 'forbidden'; end if;
  if p.status <> 'refund_due' then raise exception 'not_refund_due'; end if;
  if not p.collected then raise exception 'never_collected'; end if;
  update payments set status = 'refunded', refunded_at = now() where id = p_payment;
end $function$
;

CREATE OR REPLACE FUNCTION public.refunds_due()
 RETURNS TABLE(payment_id uuid, club_id uuid, club_name text, player_name text, court_name text, start_at timestamp with time zone, total_usd numeric, note text, since timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id, c.id, c.name, pr.name, k.name, b.start_at, p.total_usd, p.note, b.cancelled_at
  from payments p
  join clubs c on c.id = p.club_id
  join bookings b on b.id = p.booking_id
  left join courts k on k.id = b.court_id
  left join profiles pr on pr.id = p.profile_id
  where p.status = 'refund_due' and p.collected and is_staff_of(p.club_id)
  order by b.cancelled_at nulls last;
$function$
;

CREATE OR REPLACE FUNCTION public.payments_summary(p_month date)
 RETURNS TABLE(club_id uuid, club_name text, bookings integer, gross numeric, fees numeric, owed_to_club numeric, refunds_due integer, refunded numeric, simulated_bookings integer, simulated_total numeric, simulated_refunds integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id, c.name,
         count(*) filter (where p.status = 'paid' and p.collected)::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'paid' and p.collected), 0),
         coalesce(sum(p.fee_usd)    filter (where p.status = 'paid' and p.collected), 0),
         coalesce(sum(p.amount_usd) filter (where p.status = 'paid' and p.collected), 0),
         -- only money that was taken can be owed back
         count(*) filter (where p.status = 'refund_due' and p.collected)::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'refunded' and p.collected), 0),
         count(*) filter (where p.status = 'paid' and not p.collected)::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'paid' and not p.collected), 0),
         count(*) filter (where p.status = 'refund_due' and not p.collected)::int
  from clubs c
  left join payments p on p.club_id = c.id
    and p.paid_at >= date_trunc('month', p_month)
    and p.paid_at <  date_trunc('month', p_month) + interval '1 month'
  where is_staff_of(c.id)
  group by c.id, c.name
  order by c.name;
$function$
;

CREATE OR REPLACE FUNCTION public.move_price_plan(b bookings, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone, OUT current_price numeric, OUT new_price numeric, OUT kind text)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare v_len_changed boolean := (p_end - p_start) <> (b.end_at - b.start_at);
begin
  current_price := b.price_usd;
  if b.source = 'staff' then
    new_price := quote_price(p_court, p_start, p_end);
    kind := case when new_price = b.price_usd then 'same' else 'reprice' end;
  elsif exists (select 1 from payments where booking_id = b.id) then
    new_price := b.price_usd;
    kind := case when v_len_changed then 'refused' else 'same' end;
  elsif v_len_changed then
    new_price := quote_price(p_court, p_start, p_end);
    kind := case when new_price = b.price_usd then 'same' else 'agreement' end;
  else
    new_price := b.price_usd;
    kind := 'same';
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.delete_account_data(p_subject uuid, p_cancel_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d account_deletions%rowtype;
  refusal text;
  r record;
  n_games int := 0; n_cancelled int := 0; n_refund int := 0; n_anon int; n_msgs int; n_left int; n_notes int;
  v_name text;
  susp jsonb;
  v_cutoff int;
begin
  if not (auth.uid() is null or is_admin()) then raise exception 'forbidden'; end if;
  if p_subject is null then raise exception 'not_found'; end if;
  select * into d from account_deletions where subject_id = p_subject and status in ('requested', 'closing', 'closed', 'held', 'data_removed') for update;
  if not found then raise exception 'no_open_request'; end if;
  if d.status = 'held' and not p_cancel_only then raise exception 'held: %', d.held_reason; end if;   -- 0086: held accounts keep their data
  if p_cancel_only and d.status <> 'held' then raise exception 'not_held'; end if;
  -- Re-running after the data step is allowed and repeats it: every step only touches what is still there, so a
  -- second run changes nothing — unless something arrived in between (a hold that was being written while the first
  -- run ran), which it then cancels and anonymises too. The first run's counts are kept; a re-run is recorded.
  refusal := deletion_refusal(p_subject);
  if refusal is not null and not (p_cancel_only and refusal in ('legal_hold', 'coach_has_bookings')) then raise exception '%', refusal; end if;

  -- Lock order, same as every other path: courts (sorted, as lock_courts does for move_booking and the desk), then
  -- games, then bookings, then payments. cancel_booking and the booking→game trigger take courts → booking → game,
  -- so taking every court first leaves no cycle with them.
  perform lock_courts(coalesce((select array_agg(distinct b.court_id) from bookings b
     where b.court_id is not null and b.status in ('confirmed', 'pending')
       and (b.player_id = p_subject or b.id in (select m.booking_id from matches m where m.organizer_id = p_subject))), '{}'));
  -- Wait for any booking, game or message for this person still being written by another transaction: each holds a
  -- key-share lock on the profile row (foreign-key check) until it commits, and FOR UPDATE waits for it. New ones are
  -- refused by the insert guards, since the request is open. Then lock any court that only now appears (a hold placed
  -- on a court none of their bookings used): the cancellation loop below sees and cancels it.
  perform 1 from profiles where id = p_subject for update;
  perform lock_courts(coalesce((select array_agg(distinct b.court_id) from bookings b
     where b.court_id is not null and b.status in ('confirmed', 'pending') and b.player_id = p_subject), '{}'));
  select name into v_name from profiles where id = p_subject;

  -- (a) upcoming games they organise: cancelled, players told (before the bookings, so no "court lost" notices)
  for r in select * from matches where organizer_id = p_subject and status <> 'cancelled'
             and coalesce(end_at, start_at + interval '3 hours') > now() for update loop
    update matches set status = 'cancelled', closed_at = now(), closed_reason = null where id = r.id;
    insert into notifications (profile_id, kind, match_id, body)
    select mp.profile_id, 'match_cancelled', r.id, 'Match cancelled: the organizer closed their account'
      from match_players mp where mp.match_id = r.id and mp.status in ('accepted', 'pending') and mp.profile_id <> p_subject;
    n_games := n_games + 1;
  end loop;

  -- (b) their future and pending bookings: cancelled under the same rules as cancel_booking (player side):
  --     pending → payment expired; paid and before the club's cutoff → refund due; inside the cutoff → no refund.
  --     Lock order as cancel_booking: court, then booking, then payments. Legacy credits are not re-issued.
  for r in select b.id, b.court_id, b.club_id from bookings b
             where b.player_id = p_subject
               and (b.status = 'pending' or (b.status = 'confirmed' and b.start_at > now()))  -- every hold, even a stale one
             order by b.start_at loop
    perform 1 from bookings where id = r.id for update;
    perform 1 from payments where booking_id = r.id for update;
    select cancel_cutoff_hours into v_cutoff from clubs where id = r.club_id;
    if (select status from bookings where id = r.id) = 'pending' then
      update payments set status = 'expired' where booking_id = r.id and status = 'pending';
    elsif (select start_at from bookings where id = r.id) - make_interval(hours => v_cutoff) > now() then
      update payments set status = 'refund_due', note = 'cancelled before cutoff (account deleted)'
       where booking_id = r.id and status = 'paid';
      get diagnostics n_left = row_count; n_refund := n_refund + n_left;
    end if;
    update bookings set status = 'cancelled', cancelled_at = now() where id = r.id;
    n_cancelled := n_cancelled + 1;
  end loop;

  if not p_cancel_only then   -- 0086: (c)–(e) only when the data is really to be removed
  -- (c) every booking of theirs stays as the club's and accounting record, anonymised
  update bookings set player_id = null, guest_name = 'Former player', guest_phone = null where player_id = p_subject;
  get diagnostics n_anon = row_count;

  -- (d) chat messages deleted (a report keeps its snapshot); out of every game's player list
  delete from match_messages where profile_id = p_subject;
  get diagnostics n_msgs = row_count;
  end if;
  -- leaving upcoming games of others as leave_match does: organiser told, a game closed only because it was full reopens
  for r in select m.*, mp.status as was from match_players mp join matches m on m.id = mp.match_id
             where mp.profile_id = p_subject and m.status <> 'cancelled' and m.start_at > now() for update of m loop
    delete from match_players where match_id = r.id and profile_id = p_subject;
    if r.was = 'accepted' then
      insert into notifications (profile_id, kind, match_id, body)
      select r.organizer_id, 'player_left', r.id, 'A player left your match' where r.organizer_id is not null;
      if r.status = 'closed' and r.closed_reason = 'full'
         and (select count(*) from match_players where match_id = r.id and status = 'accepted') < r.players_needed then
        update matches set status = 'open', closed_at = null, closed_reason = null where id = r.id;
      end if;
    end if;
  end loop;
  if p_cancel_only then     -- 0086 held account: record what was cancelled; status stays held, data kept
    update account_deletions set cancellations_at = coalesce(cancellations_at, now()),
      summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('held_cancellations', jsonb_build_object('at', now(),
        'games_cancelled', n_games, 'bookings_cancelled', n_cancelled, 'refunds_due', n_refund))
     where id = d.id returning summary into susp;
    return susp;
  end if;
  delete from match_players where profile_id = p_subject;              -- past games: off the list too

  -- (d2) what others hold about them: chat excerpts in others' notifications go; their name in other notices becomes
  --      "A player"; notes on games they organised (free text: could hold a phone number) are cleared; their own
  --      Help & Feedback messages go (support, not moderation). Moderation reports and snapshots stay (evidence).
  delete from notifications where actor_id = p_subject and kind = 'match_message';
  if coalesce(btrim(v_name), '') <> '' then
    update notifications set body = regexp_replace(body, '\m' || regexp_replace(v_name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '\M', 'A player', 'g')
     where actor_id = p_subject or body like '%' || v_name || '%' and match_id in (select id from matches where organizer_id = p_subject);
  end if;
  update matches set note = null where organizer_id = p_subject and note is not null;
  get diagnostics n_notes = row_count;
  delete from reports where reporter_id = p_subject and target_kind = 'feedback';

  -- (e) coach listing (no coach bookings, checked above); profile anonymised now in case the sign-in deletion is late
  delete from coaches where profile_id = p_subject;
  -- only the date: the reason is free text written about the person; it is kept (with its retention rule) in the
  -- moderation records, not in this permanent deletion record
  select jsonb_build_object('suspended_at', suspended_at) into susp from account_suspensions where profile_id = p_subject;
  update profiles set name = null, phone = null, level = null, sports = '{}', email_notifications = false where id = p_subject;

  if d.status in ('requested', 'closing', 'closed') then
    update account_deletions set status = 'data_removed', data_removed_at = now(), processed_by = auth.uid(),
      summary = jsonb_build_object('games_cancelled', n_games, 'bookings_cancelled', n_cancelled, 'refunds_due', n_refund,
                                   'bookings_anonymised', n_anon, 'messages_deleted', n_msgs, 'game_notes_cleared', n_notes, 'suspension', susp)
     where id = d.id returning summary into susp;
  else
    update account_deletions set summary = summary || jsonb_build_object('last_rerun', jsonb_build_object('at', now(),
        'games_cancelled', n_games, 'bookings_cancelled', n_cancelled, 'bookings_anonymised', n_anon, 'messages_deleted', n_msgs))
     where id = d.id returning summary into susp;
  end if;
  return susp;
end $function$
;

-- cancel_booking and delete_account_data no longer call it
drop function if exists settle_payment_on_cancel(uuid, text);

drop table if exists fee_charges;
drop table if exists payment_attempts;
alter table payments drop constraint if exists payments_fee_only_shape;
alter table payments drop constraint if exists payments_kind_check;
alter table payments drop column if exists kind;
alter table clubs drop constraint if exists clubs_payment_mode_check;
alter table clubs add constraint clubs_payment_mode_check check (payment_mode in ('simulated', 'at_desk'));
