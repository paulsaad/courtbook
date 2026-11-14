-- READ ONLY: the coach availability exception(s) that migration 0023 cannot assign to a club, with
-- everything that could identify the intended club. One SELECT; changes nothing. No emails or phones.
with ex as (
  select e.* from availability_exceptions e
  where e.coach_id not in (select coach_id from coach_clubs where status = 'approved' group by coach_id having count(*) = 1)
),
rows(n, item, value) as (
  select 1, 'exception', e.id || ' | coach ' || e.coach_id || ' | date ' || e.date || ' | ' ||
         case when e.start_time is null then 'whole day' else e.start_time || '–' || e.end_time end || ' | ' ||
         case when e.available then 'extra hours (available)' else 'closed (not available)' end ||
         case when e.date < current_date then ' | IN THE PAST' else ' | upcoming' end
  from ex e
  union all
  select 2, 'coach', c.id || ' | ' || coalesce(p.name, '(no name)') || ' | active ' || c.active || ' | coach since ' || to_char(c.created_at, 'YYYY-MM-DD')
  from coaches c left join profiles p on p.id = c.profile_id where c.id in (select coach_id from ex)
  union all
  select 3, 'club link', k.name || ' (' || k.slug || ', demo ' || k.is_demo || ') | status ' || cc.status ||
         ' | requested ' || to_char(cc.requested_at, 'YYYY-MM-DD HH24:MI') || ' | decided ' || coalesce(to_char(cc.decided_at, 'YYYY-MM-DD HH24:MI'), '-') || ' | club ' || k.id
  from coach_clubs cc join clubs k on k.id = cc.club_id where cc.coach_id in (select coach_id from ex)
  union all
  select 4, 'weekly hours at', k.name || ' | ' || count(*) || ' weekly window(s) | club ' || k.id
  from availability_rules r join clubs k on k.id = r.club_id where r.coach_id in (select coach_id from ex) group by k.id, k.name
  union all
  select 5, 'clubs the coach has ever been linked to', (select count(distinct club_id)::text from coach_clubs where coach_id in (select coach_id from ex))
  union all
  select 6, 'clubs with weekly hours', (select count(distinct club_id)::text from availability_rules where coach_id in (select coach_id from ex))
  union all
  select 7, 'exceptions needing a club (total)', (select count(*)::text from ex)
)
select n as "#", item, value from rows order by n, value;
