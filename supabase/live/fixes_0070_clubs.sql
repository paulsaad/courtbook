-- 0070 club review — READ ONLY: one SELECT, changes nothing.
-- Run in Supabase → SQL Editor on live JUST BEFORE 0070_apply.sql, and send Paul the result:
-- 0070 is applied only after Paul has approved this list.
-- One row per club. will_switch = true marks a real (non-demo) club in simulated mode: 0070 switches
-- it to payment at the desk and releases its live holds (pending bookings and their pending payments
-- expire, exactly as set_club_payment_mode does). Confirmed bookings and payments are never touched.
select c.slug,
       c.name,
       c.payment_mode,
       c.is_demo,
       c.active,
       (c.payment_mode = 'simulated' and not c.is_demo) as will_switch,
       (select count(*) from bookings b where b.club_id = c.id and b.status = 'pending') as holds_released_if_switched,
       (select count(*) from bookings b where b.club_id = c.id and b.status = 'pending' and b.hold_expires_at > now()) as of_which_still_running,
       (select count(*) from bookings b where b.club_id = c.id and b.status = 'confirmed' and b.end_at > now()) as upcoming_confirmed_kept,
       (select count(*) from payments p join bookings b on b.id = p.booking_id where b.club_id = c.id and p.status = 'paid') as paid_payments_kept
from clubs c
order by will_switch desc, c.slug;
