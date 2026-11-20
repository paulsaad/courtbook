-- 0067 (match_detail) — PREFLIGHT. READ ONLY: one SELECT, changes nothing.
-- Run once on the target (staging first, later live), immediately before 0067. Part 1: every row must
-- be ok = true, or 0067 is not applied. Part 2 is information for later M3 stages (it does not block
-- 0067): docs/m3/02-safety-review.md §2.5.
-- On staging this runs as the read-only action "m3_0067_preflight" of the Staging database workflow.
with
fn as (select proname, prosecdef from pg_proc where pronamespace = 'public'::regnamespace),
checks(part, item, ok, detail) as (
  -- 1. the starting point: 0001–0071 (release fixes applied), nothing of 0067 present
  select 1, 'release fixes present: policy "blocks: staff read" (0068)',
    exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'blocks' and policyname = 'blocks: staff read'), ''
  union all select 1, 'release fixes present: no DELETE on matches for signed-in users (0069)',
    not has_table_privilege('authenticated', 'public.matches', 'DELETE'), ''
  union all select 1, 'release fixes present: constraint clubs_simulated_only_demo (0070)',
    exists (select 1 from pg_constraint where conname = 'clubs_simulated_only_demo'), ''
  union all select 1, 'matches_closed_reason_check is exactly full / organizer (as the migrations define it)',
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'matches_closed_reason_check')
      = 'CHECK ((closed_reason = ANY (ARRAY[''full''::text, ''organizer''::text])))',
    coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname = 'matches_closed_reason_check'), 'missing')
  union all select 1, 'no game has another closed reason',
    not exists (select 1 from matches where closed_reason is not null and closed_reason not in ('full', 'organizer')), ''
  union all select 1, 'no column matches.court_lost_at yet',
    not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'matches' and column_name = 'court_lost_at'), ''
  union all select 1, 'no function match_detail yet',
    not exists (select 1 from fn where proname = 'match_detail'), ''
  union all select 1, 'what match_detail uses exists: match_level_bounds, is_staff_of, is_admin',
    (select count(distinct proname) = 3 from fn where proname in ('match_level_bounds', 'is_staff_of', 'is_admin')), ''
  union all select 1, 'what match_detail reads exists: towns.name_en, clubs.timezone, match_hidden',
    (select count(*) = 2 from information_schema.columns where table_schema = 'public'
       and (table_name, column_name) in (('towns', 'name_en'), ('clubs', 'timezone')))
    and exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'match_hidden'), ''
  -- 2. information (does not block 0067)
  union all select 2, 'signed-in statement timeout (the chat cursor in stage 4 relies on 8s)', true,
    coalesce((select array_to_string(rolconfig, ', ') from pg_roles where rolname = 'authenticated'), 'not set')
)
select part, item, ok, detail from checks order by part, item;
