-- 0067 (match_detail) — POSTCHECK. READ ONLY: one SELECT, changes nothing.
-- Run once right after 0067. Every row must be ok = true.
-- On staging this runs as the read-only action "m3_0067_postcheck" of the Staging database workflow.
with checks(item, ok, detail) as (
  select 'matches.court_lost_at: nullable timestamptz',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'matches'
            and column_name = 'court_lost_at' and data_type = 'timestamp with time zone' and is_nullable = 'YES'), ''
  union all select 'no game has court_lost_at set yet (nothing writes it before M3-H)',
    not exists (select 1 from matches where court_lost_at is not null), ''
  union all select 'matches_closed_reason_check allows full / organizer / no_court',
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'matches_closed_reason_check')
      = 'CHECK ((closed_reason = ANY (ARRAY[''full''::text, ''organizer''::text, ''no_court''::text])))',
    coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname = 'matches_closed_reason_check'), 'missing')
  union all select 'match_detail(uuid) is the verified version',
    (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'bc1682b6c836fdae0b82a5d4a3463c7a'
     from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_detail'),
    coalesce((select string_agg(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_detail'), 'missing')
  union all select 'match_detail: security definer, search_path public, read-only (stable)',
    exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_detail'
            and prosecdef and provolatile = 's' and proconfig @> array['search_path=public']), ''
  union all select 'match_detail returns 31 columns',
    (select count(*) = 31 from pg_proc p, unnest(p.proargmodes) m where p.pronamespace = 'public'::regnamespace and p.proname = 'match_detail' and m = 't'), ''
  union all select 'signed-in users may call match_detail',
    has_function_privilege('authenticated', 'public.match_detail(uuid)', 'execute'), ''
  union all select 'anonymous visitors may not call match_detail',
    not has_function_privilege('anon', 'public.match_detail(uuid)', 'execute'), ''
)
select item, ok, detail from checks order by item;
