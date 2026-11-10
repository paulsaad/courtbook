-- Phase 6 review (c) round 2: public availability is limited to what a visitor can act on —
-- active clubs and courts, from yesterday to the end of each club's booking window. No history.
create or replace view public_occupancy with (security_invoker = false) as
  select b.club_id, b.court_id, b.start_at, b.end_at, 'booking'::text as kind
  from bookings b join clubs c on c.id = b.club_id join courts k on k.id = b.court_id
  where c.active and k.active
    and (b.status = 'confirmed' or (b.status = 'pending' and b.hold_expires_at > now()))
    and b.end_at > now() - interval '1 day'
    and b.start_at < now() + make_interval(days => c.booking_window_days + 1)
  union all
  select x.club_id, x.court_id, x.start_at, x.end_at, 'block'::text
  from blocks x join clubs c on c.id = x.club_id join courts k on k.id = x.court_id
  where c.active and k.active
    and x.end_at > now() - interval '1 day'
    and x.start_at < now() + make_interval(days => c.booking_window_days + 1);
revoke all on public_occupancy from public;
grant select on public_occupancy to anon, authenticated;
