-- 0090 — A payment confirmed just after its hold ran out no longer fails (booking-safety audit, 24 Nov).
--
-- The defect:
--   confirm_payment confirms a hold that is still 'pending', even slightly after its deadline. That is the
--   intended design (0014): the hold still owns the slot, because the exclusion constraint covers pending
--   bookings. But its `update bookings set status = 'confirmed'` fires bookings_block_check
--   (reject_booking_over_block). That trigger sweeps the court's expired holds through expire_stale_holds, and
--   the sweep includes the very row being confirmed. Postgres then refuses the confirmation with "tuple to be
--   updated was already modified by an operation triggered by the current command".
--
-- The effect: a player whose payment completes after the 10-minute hold sees an error, and the money is not
-- recorded. This lasts until something else sweeps the court; the next confirmation then lands as refund_due.
-- Found by supabase/tests/races/booking_races.mjs S6; reproduced alone, without any race.
--
-- The fix: the trigger's sweep leaves the row being written alone. Every other expired hold on the court is
-- still freed first, exactly as before. Skipping the row itself is safe:
--   - On an UPDATE, the row is already the slot's owner: no other live booking can overlap it (the
--     exclusion constraint).
--   - On an INSERT, the new row is not in the table yet, so skipping it changes nothing.
-- Nothing else changes: the order of locks (court first), the block check, and expire_stale_holds itself for its
-- other callers.

create or replace function reject_booking_over_block() returns trigger
language plpgsql as $$
begin
  if new.court_id is null or new.status not in ('confirmed', 'pending') then
    return new;
  end if;
  perform 1 from courts where id = new.court_id for update;
  -- expire_stale_holds(new.court_id), except the row being written (see the header)
  perform 1 from bookings where court_id = new.court_id and status = 'pending' and hold_expires_at < now() and id <> new.id for update;
  update bookings set status = 'expired'
  where court_id = new.court_id and status = 'pending' and hold_expires_at < now() and id <> new.id;
  update payments p set status = 'expired'
  from bookings b
  where p.booking_id = b.id and b.court_id = new.court_id and b.status = 'expired' and p.status = 'pending';
  if exists (
    select 1 from blocks b
    where b.court_id = new.court_id and b.period && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception 'slot_blocked' using errcode = '23P01';
  end if;
  return new;
end $$;
