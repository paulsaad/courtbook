-- ROLLBACK of 0066 for the LIVE database, all or nothing. Only if 0066 has to be undone.
-- Puts back move_booking exactly as 0001–0065 left it (staff moves not checked against the club's
-- minimum/maximum length). The website's staff calendar keeps working either way.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $pre$
declare n int; body text; f oid;
begin
  select count(*), max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))), max(oid) into n, body, f
  from pg_proc where proname = 'move_booking' and pronamespace = 'public'::regnamespace;
  if n <> 1 or body <> 'c529f2516aa80bc9dd6b3676e43d2565' then
    raise exception 'STOPPED, nothing changed: move_booking is not the 0066 version (count %, code %)', n, body;
  end if;
  if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
     or not has_function_privilege('service_role', f, 'execute') then
    raise exception 'STOPPED, nothing changed: move_booking permissions are not anon=no, authenticated=yes, service_role=yes';
  end if;
end $pre$;

CREATE OR REPLACE FUNCTION public.move_booking(p_booking uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_court uuid; b bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select court_id into v_court from bookings where id = p_booking;
  if not found then raise exception 'not_found'; end if;
  perform lock_courts(array_remove(array[v_court, p_court], null));
  select * into b from bookings where id = p_booking for update;
  if not is_staff_of(b.club_id) then raise exception 'forbidden'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;
  if b.court_id is null then raise exception 'not_a_court_booking'; end if;
  if p_start >= p_end then raise exception 'bad_range'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = b.club_id and active) then
    raise exception 'court_not_found';
  end if;
  update bookings set court_id = p_court, start_at = p_start, end_at = p_end where id = p_booking;
exception
  when exclusion_violation then
    raise exception 'slot_taken';
end $function$

;

do $post$
declare n int; body text; f oid;
begin
  select count(*), max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))), max(oid) into n, body, f
  from pg_proc where proname = 'move_booking' and pronamespace = 'public'::regnamespace;
  if n <> 1 or body <> '8738160b4251b3e78f6b713f6f9183c2' then
    raise exception 'ROLLED BACK: move_booking after rollback is not the verified pre-0066 version (count %, code %)', n, body;
  end if;
  if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
     or not has_function_privilege('service_role', f, 'execute') then
    raise exception 'ROLLED BACK: move_booking permissions are not anon=no, authenticated=yes, service_role=yes';
  end if;
end $post$;

notify pgrst, 'reload schema';
commit;
select 'move_booking is back to the pre-0066 version' as result;
