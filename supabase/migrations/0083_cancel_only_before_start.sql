-- 0083 — A player can no longer cancel a booking that has started or is over (found 23 Nov, launch quality pass).
-- cancel_booking checked who may cancel but not when: a player could mark a booking played yesterday, or one being
-- played now, as cancelled. No money moved (the refund rule already refuses refunds inside the club's cutoff), but the
-- club's record of a played booking was rewritten and it no longer counted for no-show marking. Players: before the
-- start only. Club staff: unchanged (they correct records). Pending holds: unchanged (can be released).
-- The function is the current one with one added check (generated from pg_get_functiondef).
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
end $function$;
