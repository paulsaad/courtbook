-- 0101 (player photos): READ-ONLY preflight, run before supabase/migrations/0101_player_photos.sql (after 0100).
-- Every line must end in OK. Any STOP: do not apply; report it. Changes nothing (selects only).
--   psql "$DB" -X -At -F'|' -f supabase/live/photos_0101_preflight.sql
-- Each STOP is a reason 0101 would fail (it runs in one transaction, so it would change nothing) or would not mean
-- what it says (applied out of order, or onto a database that already has part of it).
select 'F1 0100 is applied first (sport is the catalogue domain)',
  coalesce((select t.typtype::text from pg_type t where t.typname = 'sport' and t.typnamespace = 'public'::regnamespace), 'missing'),
  case when (select t.typtype from pg_type t where t.typname = 'sport' and t.typnamespace = 'public'::regnamespace) = 'd' then 'OK' else 'STOP' end
union all
select 'F2 0101 is not applied yet (no photo table, no release-time column)',
  coalesce(to_regclass('public.player_photos')::text, '-') || ' ' || coalesce(to_regclass('public.photo_evidence')::text, '-') || ' '
    || exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'reports' and column_name = 'legal_hold_released_at')::text,
  case when to_regclass('public.player_photos') is null and to_regclass('public.photo_evidence') is null and to_regclass('public.photo_moderators') is null
        and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'reports' and column_name = 'legal_hold_released_at')
       then 'OK' else 'STOP' end
union all
select 'F3 the functions 0101 builds on exist',
  coalesce(string_agg(f, ',') filter (where to_regprocedure(f) is null), 'all present'),
  case when count(*) filter (where to_regprocedure(f) is null) = 0 then 'OK' else 'STOP' end
  from unnest(array['log_moderation(text,uuid,uuid,uuid,text)', 'is_admin()', 'deletion_requested(uuid)', 'players_blocked(uuid,uuid)',
                    'match_participants(uuid)', 'refuse_writes_by_closed_account()', 'enforce_report_retention(integer)']) f
union all
select 'F4 reports and matches have the columns 0101 reads (legal_hold, closed_at, reason, target_kind; end_at)',
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'reports'
     and column_name in ('legal_hold', 'closed_at', 'reason', 'target_kind', 'profile_id', 'status'))::text || '/6 '
  || (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'matches' and column_name in ('end_at', 'start_at'))::text || '/2',
  case when (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'reports'
               and column_name in ('legal_hold', 'closed_at', 'reason', 'target_kind', 'profile_id', 'status')) = 6
        and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'matches' and column_name in ('end_at', 'start_at')) = 2
       then 'OK' else 'STOP' end
union all
select 'F5 the moderation-log action list is 0082''s (0101 widens it; nothing else has)',
  coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'moderation_log_action_check'), 'missing'),
  case when (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'moderation_log_action_check') like '%clear_text%'
        and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'moderation_log_action_check') not like '%photo%'
       then 'OK' else 'STOP' end
union all
select 'F6 (information) reports open / on legal hold now', 
  (select count(*) filter (where status = 'open') || ' open, ' || count(*) filter (where legal_hold) || ' on hold' from reports), 'OK';
