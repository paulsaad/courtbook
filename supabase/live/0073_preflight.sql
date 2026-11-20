-- 0073 (post_match idempotency key) — PREFLIGHT. READ ONLY: one SELECT, changes nothing.
-- Run immediately before 0073 (staging first; live only after its own approval). Every part-1 row must
-- be ok = true, or 0073 is not applied. On staging: Staging database workflow, action m3_0073_preflight.
with checks(part, item, ok, detail) as (
  select 1, '0072 present (resolve_court exists)', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_court'), ''
  union all select 1, 'post_match: exactly one, the 0072 version 0073 replaces', (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '33b26aae02b8861858f86de235b66264' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'post_match'), coalesce((select string_agg(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'post_match'), 'missing')
  union all select 1, 'matches.client_token does not exist yet', not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'matches' and column_name = 'client_token'), ''
  union all select 1, 'no index named matches_organizer_client_token yet', not exists (select 1 from pg_indexes where indexname = 'matches_organizer_client_token'), ''
  union all select 2, 'games posted so far (unchanged by 0073)', true, (select count(*)::text from matches)
)
select part, item, ok, detail from checks order by part, item;
