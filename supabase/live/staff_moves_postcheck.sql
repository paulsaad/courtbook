-- F1: READ-ONLY postcheck, run after docs/staff-moves/sql/move_checks_what_desk_saw.draft.sql. Every line must end in OK.
-- Changes nothing (selects only).   psql "$DB" -X -At -F'|' -f supabase/live/staff_moves_postcheck.sql
with f as (select to_regprocedure('public.move_booking_priced(uuid,uuid,timestamptz,timestamptz,numeric,uuid,timestamptz,timestamptz)') as oid)
select 'P1 the 8-argument move_booking_priced is the draft''s (compares what the desk saw)', coalesce(md5(p.prosrc), 'missing'),
  case when md5(p.prosrc) = '1a93e01b47825e5acd5badf1a08c3254' and p.prosecdef and p.proconfig @> array['search_path=public'] then 'OK' else 'STOP' end
  from f left join pg_proc p on p.oid = f.oid
union all
select 'P2 signed-in users may call it; anon and public may not', coalesce(p.proacl::text, 'missing'),
  case when f.oid is not null and has_function_privilege('authenticated', f.oid, 'execute') and not has_function_privilege('anon', f.oid, 'execute')
        and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') then 'OK' else 'STOP' end
  from f left join pg_proc p on p.oid = f.oid
union all
select 'P3 the 0091 calls (5-argument move_booking_priced, move_booking) only refuse (move_needs_reload)', string_agg(md5(prosrc), ','),
  case when count(*) = 2 and bool_and(md5(prosrc) = 'c230bd9a83ae3abc4bc4dadce3abffb5') then 'OK' else 'STOP' end
  from pg_proc where oid in (to_regprocedure('public.move_booking_priced(uuid,uuid,timestamptz,timestamptz,numeric)'),
                             to_regprocedure('public.move_booking(uuid,uuid,timestamptz,timestamptz)'))
union all
select 'P4 no policy lets a signed-in user update bookings directly', count(*)::text, case when count(*) = 0 then 'OK' else 'STOP' end
  from pg_policies where schemaname = 'public' and tablename = 'bookings' and cmd in ('UPDATE', 'ALL')
union all
select 'P5 exactly three move functions', count(*)::text, case when count(*) = 3 then 'OK' else 'STOP' end
  from pg_proc where pronamespace = 'public'::regnamespace and proname in ('move_booking', 'move_booking_priced');
