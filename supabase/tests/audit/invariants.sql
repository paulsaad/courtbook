-- Booking and payment invariants — READ ONLY (select statements only).
-- Each row is a rule that must hold for every row in the database, whatever path created it
-- (player app, website, staff desk, admin, payment callbacks, tests). Run after the full SQL suite,
-- whose ~380 checks drive every path, so a path that leaves an inconsistent row is caught here.
-- Output: rule | violations (must be 0) | example ids.
with b as (select b.*, c.payment_mode, c.min_booking_minutes, c.max_booking_minutes
           from bookings b join clubs c on c.id = b.club_id),
rules(rule, ids) as (
  select 'INV1 two active bookings never overlap on one court',
         array(select a.id from bookings a join bookings z on a.court_id = z.court_id and a.id < z.id
               and a.status in ('pending','confirmed') and z.status in ('pending','confirmed')
               and tstzrange(a.start_at, a.end_at) && tstzrange(z.start_at, z.end_at))
  union all select 'INV2 a pending booking always has a hold expiry; a confirmed one never does',
         array(select id from bookings where (status = 'pending' and hold_expires_at is null)
                                          or (status = 'confirmed' and hold_expires_at is not null))
  union all select 'INV3 a court booking belongs to the club that owns the court',
         array(select b.id from bookings b join courts k on k.id = b.court_id where k.club_id <> b.club_id)
  union all select 'INV4 a payment matches its booking (club and player)',
         array(select p.id from payments p join bookings b on b.id = p.booking_id
               where p.club_id <> b.club_id or p.profile_id is distinct from b.player_id)
  union all select 'INV5 at most one payment per booking',
         array(select booking_id from payments group by booking_id having count(*) > 1)
  union all select 'INV6 total = amount + fee, never negative',
         array(select id from payments where total_usd <> amount_usd + fee_usd or amount_usd < 0 or fee_usd < 0)
  union all select 'INV7 a pending payment belongs to a pending booking',
         array(select p.id from payments p join bookings b on b.id = p.booking_id where p.status = 'pending' and b.status <> 'pending')
  union all select 'INV8 a confirmed booking paid through the app has a paid (or refunded) payment',
         array(select b.id from b join payments p on p.booking_id = b.id
               where b.status = 'confirmed' and p.status not in ('paid','refund_due','refunded'))
  union all select 'INV9 an expired hold never keeps a pending or paid payment',
         array(select p.id from payments p join bookings b on b.id = p.booking_id where b.status = 'expired' and p.status in ('pending','paid'))
  union all select 'INV10 money taken (paid / refund_due / refunded) always has a paid_at',
         array(select id from payments where status in ('paid','refund_due','refunded') and paid_at is null)
  union all select 'INV11 a club that settles at the desk has no payment waiting (switching mode expires holds)',
         array(select p.id from payments p join clubs c on c.id = p.club_id where c.payment_mode = 'at_desk' and p.status = 'pending')
  union all select 'INV12 an app booking at a simulated club always has its payment row',
         -- slug 'closed' = suite fixture 86a, inserted directly as table owner to test public_occupancy
         array(select b.id from b join clubs c on c.id = b.club_id where c.slug <> 'closed' and b.payment_mode = 'simulated' and b.source = 'app' and b.court_id is not null
               and b.status in ('pending','confirmed') and not exists (select 1 from payments p where p.booking_id = b.id))
  union all select 'INV13 a booking ends after it starts',
         array(select id from bookings where end_at <= start_at)
)
select rule, coalesce(array_length(ids, 1), 0) as violations, array_to_string(ids[1:3], ' ') as examples from rules order by rule;
