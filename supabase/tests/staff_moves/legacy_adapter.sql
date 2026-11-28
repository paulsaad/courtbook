-- TEST ONLY — never apply to staging or live. Used by staff_moves/compat.sh in a scratch checkout, after the draft.
-- The existing suites (run.sh, staff_ops, fixes, races, deletion races) were written against 0091's calls, which the
-- draft makes refuse every move. To show that the draft changes nothing else, this puts back 0091's two calls as
-- wrappers of the new function that pass the booking's CURRENT position, i.e. a desk whose view is fresh. Every other
-- rule (rights, past, length, price, slot taken, lock order) is then exercised through the new function.
create or replace function move_booking_priced(p_booking uuid, p_court uuid, p_start timestamptz, p_end timestamptz, p_expected_price numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b bookings%rowtype;
begin
  select * into b from bookings where id = p_booking;
  return move_booking_priced(p_booking, p_court, p_start, p_end, p_expected_price, b.court_id, b.start_at, b.end_at);
end $$;
create or replace function public.move_booking(p_booking uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  perform move_booking_priced(p_booking, p_court, p_start, p_end, null);
end $function$;
