-- Review round 2, finding 2: refund after the cutoff depends on the cancellation
-- reason, not on the caller's role. Staff pass p_club_caused = true for club-caused
-- cancellations (rain, maintenance, double entry); those always refund an app booking.
-- Anything else — including a staff member cancelling their own personal booking, or a
-- player phoning the desk to cancel late — follows the cutoff rule.

drop function cancel_booking(uuid);

create or replace function cancel_booking(p_booking uuid, p_club_caused boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  b bookings%rowtype;
  cutoff int;
  is_staff boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select * into b from bookings where id = p_booking for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;

  is_staff := is_staff_of(b.club_id);
  if not is_staff and (b.player_id is null or b.player_id <> auth.uid()) then
    raise exception 'forbidden';
  end if;
  if p_club_caused and not is_staff then
    raise exception 'forbidden';
  end if;

  select cancel_cutoff_hours into cutoff from clubs where id = b.club_id;

  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking;

  if b.credit_tx_id is not null
     and (p_club_caused or b.start_at - make_interval(hours => cutoff) > now()) then
    insert into credit_transactions (profile_id, delta, kind, booking_id, created_by, note)
    values (b.player_id, +1, 'refund', b.id, auth.uid(),
            case when p_club_caused then 'club-caused cancellation' else 'cancelled before cutoff' end);
  end if;
end $$;

revoke execute on function cancel_booking(uuid, boolean) from public, anon;
grant execute on function cancel_booking(uuid, boolean) to authenticated;
