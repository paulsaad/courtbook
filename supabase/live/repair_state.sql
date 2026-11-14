-- READ ONLY: which parts of drift_repair.sql are present on this database right now.
-- One SELECT; changes nothing. Each row: what the repair creates, whether it is here, and whether
-- it is the "before" (as inspected on live) or the "after" (repository) version.
with r(n, item, state) as (
  select 1, 'trigger bookings_slot_validation',
         coalesce((select case when pg_get_triggerdef(oid) = 'CREATE TRIGGER bookings_slot_validation BEFORE INSERT OR UPDATE OF court_id, start_at, end_at ON public.bookings FOR EACH ROW EXECUTE FUNCTION bookings_validate_slot()'
                          then 'AFTER (repository definition)' else 'PRESENT BUT DIFFERENT: ' || pg_get_triggerdef(oid) end
                   from pg_trigger where tgname = 'bookings_slot_validation' and tgrelid = 'public.bookings'::regclass), 'BEFORE (absent)')
  union all
  select 2, 'policy "coach_clubs: coach withdraws" (0021)',
         coalesce((select case qual
                     when '((coach_id = my_coach_id()) AND (status = ANY (ARRAY[''pending''::text, ''declined''::text, ''removed''::text])))' then 'AFTER (0021)'
                     when '((coach_id = my_coach_id()) AND (status = ANY (ARRAY[''pending''::text, ''declined''::text])))' then 'BEFORE (0020)'
                     else 'OTHER: ' || qual end
                   from pg_policies where schemaname = 'public' and tablename = 'coach_clubs' and policyname = 'coach_clubs: coach withdraws'), 'MISSING')
  union all
  select 3, 'column availability_exceptions.club_id (0023)',
         coalesce((select 'AFTER (' || data_type || ', nullable ' || is_nullable || ')' from information_schema.columns
                   where table_schema = 'public' and table_name = 'availability_exceptions' and column_name = 'club_id'), 'BEFORE (absent)')
  union all
  select 4, 'foreign key availability_exceptions_club_id_fkey (0023)',
         coalesce((select 'AFTER: ' || pg_get_constraintdef(oid) from pg_constraint where conname = 'availability_exceptions_club_id_fkey'), 'BEFORE (absent)')
  union all
  select 5, 'policy "avail_exc: read" (0023)',
         coalesce((select case when qual = '((coach_id = my_coach_id()) OR is_staff_of(club_id) OR coach_listed_at(coach_id, club_id))' then 'AFTER (0023)'
                               when qual like '((coach_id = my_coach_id()) OR is_admin() OR (EXISTS%' then 'BEFORE (0022)'
                               else 'OTHER: ' || qual end
                   from pg_policies where schemaname = 'public' and tablename = 'availability_exceptions' and policyname = 'avail_exc: read'), 'MISSING')
  union all
  select 6, 'function coach_availability (0023)',
         coalesce((select case left(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), 12)
                     when '6f096de16d4c' then 'AFTER (0023)' when '69c35ce7627e' then 'BEFORE (0022)' else 'OTHER' end
                   from pg_proc where oid = to_regprocedure('public.coach_availability(uuid,uuid,date,integer)')), 'MISSING')
  union all
  select 7, 'coach availability exceptions (count; Bol''s 2026-11-19 exception and its club)',
         (select count(*) from availability_exceptions)::text || ' | ' ||
         coalesce((select 'id 1aedac0e present, club ' || coalesce(to_jsonb(e)->>'club_id', '(no club column / none)')
                   from availability_exceptions e where e.id = '1aedac0e-ee88-4b9a-a837-fdc038452abf'), '1aedac0e NOT PRESENT')
  union all
  select 8, 'hold_slot (must still be pre-0065: 4 arguments)',
         (select string_agg(pg_get_function_identity_arguments(oid), ' | ') from pg_proc where proname = 'hold_slot' and pronamespace = 'public'::regnamespace)
  union all
  select 9, 'move_booking (must still be pre-0066)',
         case when (select prosrc from pg_proc where proname = 'move_booking' and pronamespace = 'public'::regnamespace) like '%min_booking_minutes%' then '0066 PRESENT' else 'pre-0066' end
  union all
  select 10, 'checked at (database time)', to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC'
)
select n as "#", item, state from r order by n;
