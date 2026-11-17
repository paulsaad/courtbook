-- READ ONLY, optional: how many times the database has completed statements from drift_repair.sql,
-- from Supabase's statement statistics (pg_stat_statements). Changes nothing. A statement that ended
-- in an error is not counted. If this errors with "relation does not exist", the statistics are not
-- available on this project; that is fine, skip it.
select calls, rows,
       left(regexp_replace(query, '\s+', ' ', 'g'), 140) as statement
from extensions.pg_stat_statements
where query ilike '%bookings_slot_validation%'
   or query ilike '%reviewed_exception_club%'
   or query ilike '%lock table availability_exceptions%'
   or query ilike '%coach_clubs: coach withdraws%'
order by calls desc, statement
limit 30;
