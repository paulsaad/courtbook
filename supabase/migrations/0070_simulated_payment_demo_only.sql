-- D1 (release audit, approved 17 Nov 2026): simulated payment is for demo clubs only, and a new club
-- takes payment at its desk unless an admin decides otherwise.
--
-- Why: with the simulated provider, /api/pay/simulate confirms a booking at once with no money taken.
-- A real club left in simulated mode (the old default) gave players confirmed bookings for free.
--
-- What it does, in this order:
--   1. Any existing club that is NOT a demo and is in simulated mode is switched to at_desk with
--      exactly the steps of set_club_payment_mode: its live holds and their pending payments expire
--      first, then the mode changes. A NOTICE names each club switched. Confirmed bookings and their
--      payments are not touched. On live, supabase/live/fixes_0070_clubs.sql lists these clubs first.
--   2. New clubs default to at_desk (the admin "New club" form inserts with defaults).
--   3. A check constraint makes simulated + non-demo impossible from now on, however the row is
--      written; set_club_payment_mode refuses it with a readable error first.
-- Fees are untouched (service_fee_usd and the $1 question are a separate decision).
--
-- Rebuilt from pg_get_functiondef of a 0001–0066 database; the only change is the line marked "0070".
-- Same signature, so grants are untouched. Safe to re-run.

do $switch$
declare r record; n int;
begin
  for r in select id, slug from clubs where payment_mode = 'simulated' and not is_demo order by slug for update loop
    update bookings set status = 'expired' where club_id = r.id and status = 'pending';
    get diagnostics n = row_count;
    update payments p set status = 'expired'
    from bookings b where p.booking_id = b.id and b.club_id = r.id and b.status = 'expired' and p.status = 'pending';
    update clubs set payment_mode = 'at_desk' where id = r.id;
    raise notice 'club % (not a demo) switched from simulated to at_desk; % hold(s) released', r.slug, n;
  end loop;
end $switch$;

alter table clubs alter column payment_mode set default 'at_desk';
alter table clubs drop constraint if exists clubs_simulated_only_demo;
alter table clubs add constraint clubs_simulated_only_demo check (payment_mode <> 'simulated' or is_demo);

create or replace function public.set_club_payment_mode(p_club uuid, p_mode text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
end $function$;
