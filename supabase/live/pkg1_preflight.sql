-- Package 1 (0067 + 0072 + 0073) — PREFLIGHT. READ ONLY: one SELECT, changes nothing.
-- Run once on live immediately before pkg1_apply.sql. Part 1: every row must be ok = true, or the package
-- is not applied. Part 2: information only. Rows come from 0067_preflight.sql, 0072_preflight.sql and
-- 0073_preflight.sql: every check that can be made BEFORE 0067 (the checks that need 0067 or 0072 to be
-- present are made inside pkg1_apply.sql, at the moment each migration starts).
with
fn as (select proname, md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')) as h from pg_proc where pronamespace = 'public'::regnamespace),
checks(part, item, ok, detail) as (
  -- 0067 starting point (0067_preflight.sql part 1, unchanged)
  select 1, '0067 release fixes present: policy "blocks: staff read" (0068)',
    exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'blocks' and policyname = 'blocks: staff read'), ''
  union all select 1, '0067 release fixes present: no DELETE on matches for signed-in users (0069)',
    not has_table_privilege('authenticated', 'public.matches', 'DELETE'), ''
  union all select 1, '0067 release fixes present: constraint clubs_simulated_only_demo (0070)',
    exists (select 1 from pg_constraint where conname = 'clubs_simulated_only_demo'), ''
  union all select 1, '0067 matches_closed_reason_check is exactly full / organizer',
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'matches_closed_reason_check')
      = 'CHECK ((closed_reason = ANY (ARRAY[''full''::text, ''organizer''::text])))',
    coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname = 'matches_closed_reason_check'), 'missing')
  union all select 1, '0067 no game has another closed reason',
    not exists (select 1 from matches where closed_reason is not null and closed_reason not in ('full', 'organizer')), ''
  union all select 1, '0067 no column matches.court_lost_at yet',
    not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'matches' and column_name = 'court_lost_at'), ''
  union all select 1, '0067 no function match_detail yet',
    not exists (select 1 from fn where proname = 'match_detail'), ''
  union all select 1, '0067 what match_detail uses exists: match_level_bounds, is_staff_of, is_admin',
    (select count(distinct proname) = 3 from fn where proname in ('match_level_bounds', 'is_staff_of', 'is_admin')), ''
  union all select 1, '0067 what match_detail reads exists: towns.name_en, clubs.timezone, match_hidden',
    (select count(*) = 2 from information_schema.columns where table_schema = 'public'
       and (table_name, column_name) in (('towns', 'name_en'), ('clubs', 'timezone')))
    and exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'match_hidden'), ''
  -- 0072 starting point (0072_preflight.sql part 1; 0067 does not touch these functions)
  union all select 1, '0072 the eight game functions are the 0001–0071 versions 0072 replaces',
    (select count(*) = 8 from fn where (proname, h) in (('join_match', '07d5432f9f203da2a0c7c69ebd72451f'), ('leave_match', 'db6bb484d82740641b72d8448f86ebfa'),
      ('decide_join', 'bce21b2e4e717051f838cc1714cc4e96'), ('set_match_status', '68feb36c10f79ae33bd6c67db955846f'), ('update_match', 'aa37b42e834acc500cd1f115e2aa4ee3'),
      ('post_match', '548b94f7c81c4805494564c14f213d73'), ('sync_match_with_booking', '791e9d4948f61fcf788a451ed681420c'), ('match_message_notify', '485b766738b909d27c67c1435c7d28a6')))
    and (select count(*) = 8 from fn where proname in ('join_match','leave_match','decide_join','set_match_status','update_match','post_match','sync_match_with_booking','match_message_notify')),
    (select string_agg(proname || '=' || left(h, 8), ', ' order by proname) from fn where proname in ('join_match','leave_match','decide_join','set_match_status','update_match','post_match','sync_match_with_booking','match_message_notify'))
  union all select 1, '0072 none of its new objects exists yet (5 functions, chat trigger)',
    not exists (select 1 from fn where proname in ('notify_waiting','remove_player','resolve_court','match_message_guard','push_text'))
    and not exists (select 1 from pg_trigger where tgname = 'match_messages_guard'), ''
  -- 0073 starting point (0073_preflight.sql part 1; its post_match check is the 0072 row above)
  union all select 1, '0073 matches.client_token does not exist yet',
    not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'matches' and column_name = 'client_token'), ''
  union all select 1, '0073 no index named matches_organizer_client_token yet',
    not exists (select 1 from pg_indexes where indexname = 'matches_organizer_client_token'), ''
  -- information
  union all select 2, 'games posted so far / not cancelled (unchanged by the package)', true,
    (select count(*) || ' / ' || count(*) filter (where status <> 'cancelled') from matches)
  union all select 2, 'games linked to a confirmed booking (from now on, a court cancellation pauses them)', true,
    (select count(*)::text from matches m join bookings b on b.id = m.booking_id where m.status <> 'cancelled' and b.status = 'confirmed')
  union all select 2, 'organisers already at 10 or more live games (0072 stops them posting more)', true,
    (select count(*)::text from (select organizer_id from matches where status <> 'cancelled' and start_at > now() group by 1 having count(*) >= 10) x)
  union all select 2, 'players already at 20 or more waiting requests (0072 stops further requests)', true,
    (select count(*)::text from (select mp.profile_id from match_players mp join matches m on m.id = mp.match_id where mp.status = 'pending' and m.status <> 'cancelled' and m.start_at > now() group by 1 having count(*) >= 20) x)
  union all select 2, 'signed-in statement timeout', true,
    coalesce((select array_to_string(rolconfig, ', ') from pg_roles where rolname = 'authenticated'), 'not set')
)
select part, item, ok, detail from checks order by part, item;
