-- Chat notices without text (H4 draft): READ-ONLY postcheck, run right after applying the draft.
--   psql -v others="<F4 value from the preflight>" -v snapshots=<F5 value> -f supabase/live/chat_notices_postcheck.sql
-- Every row: check | value | verdict. Any STOP: report the actual state; the rollback is separate and needs approval.
\set ON_ERROR_STOP 1
begin transaction read only;
with f as (
  select (select prosrc from pg_proc where proname = 'match_message_notify' and pronamespace = 'public'::regnamespace) as trig,
         (select prosrc from pg_proc where proname = 'claim_notifications_to_email' and pronamespace = 'public'::regnamespace) as claim
)
select 'P1 new chat notices carry no message text', case when trig like '%left(new.body%' then 'copies text' else 'New message from <name>' end,
       case when trig not like '%left(new.body%' and trig like '%''New message from '' || who%' then 'ok' else 'STOP' end from f
union all
select 'P2 the email claim never returns a chat notice''s stored text', case when claim like '%n.kind = ''match_message''%' then 'guarded' else 'not guarded' end,
       case when claim like '%n.kind = ''match_message''%' then 'ok' else 'STOP' end from f
union all
select 'P3 chat notices still holding text', count(*)::text, case when count(*) = 0 then 'ok' else 'STOP' end
from notifications n where kind = 'match_message'
  and body is distinct from 'New message from ' || coalesce((select a.name from profiles a where a.id = n.actor_id), 'A player')
union all
select 'P4 every non-chat notice unchanged (preflight F4)', x.v, case when x.v = :'others' then 'ok' else 'STOP' end
from (select coalesce(md5(string_agg(id::text || '|' || kind || '|' || coalesce(body, '') || '|' || coalesce(read_at::text, '') || '|' || coalesce(emailed_at::text, ''), ',' order by id)), 'none')
             || ' (' || count(*) || ' rows)' as v from notifications where kind <> 'match_message') x
union all
select 'P5 moderation evidence unchanged (preflight F5)', count(*)::text, case when count(*)::text = :'snapshots' then 'ok' else 'STOP' end
from reports where snapshot is not null;
commit;
