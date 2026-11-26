-- Chat notices without text (H4 draft): READ-ONLY preflight, run before applying chat_notices_without_text.draft.sql.
-- Every row: check | value | verdict. STOP anywhere means do not apply; report instead.
-- `others_checksum` and `report_snapshots` are written down and passed to the postcheck, which must find them unchanged.
\set ON_ERROR_STOP 1
begin transaction read only;
with f as (
  select (select md5(prosrc) from pg_proc where proname = 'match_message_notify' and pronamespace = 'public'::regnamespace) as trig,
         (select md5(prosrc) from pg_proc where proname = 'claim_notifications_to_email' and pronamespace = 'public'::regnamespace) as claim
), chat as (
  select count(*) as total,
         count(*) filter (where body is distinct from 'New message from ' || coalesce((select a.name from profiles a where a.id = n.actor_id), 'A player')) as with_text,
         count(*) filter (where read_at is null) as unread,
         count(*) filter (where emailed_at is null) as not_emailed
  from notifications n where kind = 'match_message'
)
select 'F1 chat trigger is exactly 0074''s (the draft replaces that version)', trig,
       case when trig = '13588dcf1818f66bc24786a40b74905f' then 'ok' else 'STOP' end from f
union all
select 'F2 email claim is exactly 0026''s', claim, case when claim = 'f62783ef40a7fc1471a96946b35e2058' then 'ok' else 'STOP' end from f
union all
select 'F3 chat notices: total / holding text / unread / not yet emailed (information: these get rewritten)',
       total || ' / ' || with_text || ' / ' || unread || ' / ' || not_emailed, 'ok' from chat
union all
select 'F4 others_checksum: every non-chat notice (must be unchanged after)',
       coalesce(md5(string_agg(id::text || '|' || kind || '|' || coalesce(body, '') || '|' || coalesce(read_at::text, '') || '|' || coalesce(emailed_at::text, ''), ',' order by id)), 'none')
         || ' (' || count(*) || ' rows)', 'ok'
from notifications where kind <> 'match_message'
union all
select 'F5 report_snapshots: reports keeping message text as evidence (must be unchanged after)', count(*)::text, 'ok'
from reports where snapshot is not null
union all
select 'F6 no role but the owner can read reports (evidence stays in moderation)',
       coalesce(string_agg(r, ','), 'none'),
       case when count(*) = 0 then 'ok' else 'STOP' end
from (select r from unnest(array['anon', 'authenticated']) r where has_table_privilege(r, 'public.reports', 'select')) x;
commit;
