-- 0101 (player photos): READ-ONLY postcheck, run right after supabase/migrations/0101_player_photos.sql.
-- Every line must end in OK. Any STOP: report it; the rollback is supabase/rollback/0101_down.sql (one transaction).
--   psql "$DB" -X -At -F'|' -f supabase/live/photos_0101_postcheck.sql
-- Written so that before 0101 every line says STOP (no errors), which the candidate harness checks.
select 'Q1 the four photo tables exist, RLS on, no policy',
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('player_photos', 'player_photo_uploads', 'photo_moderators', 'photo_evidence') and c.relrowsecurity)::text
  || ' tables, ' || (select count(*) from pg_policies where schemaname = 'public' and tablename in ('player_photos', 'player_photo_uploads', 'photo_moderators', 'photo_evidence'))::text || ' policies',
  case when (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('player_photos', 'player_photo_uploads', 'photo_moderators', 'photo_evidence') and c.relrowsecurity) = 4
        and (select count(*) from pg_policies where schemaname = 'public' and tablename in ('player_photos', 'player_photo_uploads', 'photo_moderators', 'photo_evidence')) = 0
       then 'OK' else 'STOP' end
union all
select 'Q2 no table rights for anon, authenticated or the server key on any of them',
  coalesce(string_agg(r || ' ' || t, ',') filter (where has_table_privilege(r, t, 'SELECT') or has_table_privilege(r, t, 'INSERT') or has_table_privilege(r, t, 'UPDATE') or has_table_privilege(r, t, 'DELETE')), 'none'),
  case when count(*) = 12 and count(*) filter (where has_table_privilege(r, t, 'SELECT') or has_table_privilege(r, t, 'INSERT') or has_table_privilege(r, t, 'UPDATE') or has_table_privilege(r, t, 'DELETE')) = 0 then 'OK' else 'STOP' end
  from unnest(array['anon', 'authenticated', 'service_role']) r
  cross join unnest(array['player_photos', 'player_photo_uploads', 'photo_moderators', 'photo_evidence']) t
  where to_regclass('public.' || t) is not null
union all
select 'Q3 signed-in players may call exactly the 8 player and moderator functions; anon none; the server writes',
  (select count(*) filter (where has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE')) || ' for players, '
        || count(*) filter (where has_function_privilege('anon', to_regprocedure(f), 'EXECUTE')) || ' for anon, '
        || count(*) filter (where to_regprocedure(f) is null) || ' missing'
     from unnest(array['player_photo(uuid)', 'match_photo_versions(uuid)', 'my_photo_version()', 'remove_player_photo()', 'is_photo_moderator()',
                       'moderator_hide_player_photo(uuid,text)', 'moderator_photo_evidence_list(uuid)', 'moderator_photo_evidence(uuid)',
                       'set_player_photo(uuid,bytea,integer,integer)', 'claim_photo_upload(uuid)', 'can_see_player_photo(uuid,uuid)']) f),
  case when (select count(*) filter (where to_regprocedure(f) is null) = 0
                and count(*) filter (where has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE')) = 8
                and count(*) filter (where has_function_privilege('anon', to_regprocedure(f), 'EXECUTE')) = 0
             from unnest(array['player_photo(uuid)', 'match_photo_versions(uuid)', 'my_photo_version()', 'remove_player_photo()', 'is_photo_moderator()',
                               'moderator_hide_player_photo(uuid,text)', 'moderator_photo_evidence_list(uuid)', 'moderator_photo_evidence(uuid)',
                               'set_player_photo(uuid,bytea,integer,integer)', 'claim_photo_upload(uuid)', 'can_see_player_photo(uuid,uuid)']) f)
        and coalesce(has_function_privilege('service_role', to_regprocedure('set_player_photo(uuid,bytea,integer,integer)'), 'EXECUTE'), false)
       then 'OK' else 'STOP' end
union all
select 'Q4 the photo triggers are in place (reports 4, account_deletions 1, moderators 2, lock-outs 4)',
  (select count(*) from pg_trigger where not tgisinternal and tgname in ('photo_evidence_on_report', 'reports_photo_evidence_retention', 'photo_evidence_hold_guard', 'photo_hold_release_guard',
     'player_photo_on_closure', 'photo_moderators_log', 'photo_moderators_truncate_log'))::text || '/7, lock-outs '
  || (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'closed_account_lockout' and c.relname in ('player_photos', 'player_photo_uploads', 'photo_moderators', 'photo_evidence'))::text || '/4',
  case when (select count(*) from pg_trigger where not tgisinternal and tgname in ('photo_evidence_on_report', 'reports_photo_evidence_retention', 'photo_evidence_hold_guard', 'photo_hold_release_guard',
              'player_photo_on_closure', 'photo_moderators_log', 'photo_moderators_truncate_log')) = 7
        and (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'closed_account_lockout' and c.relname in ('player_photos', 'player_photo_uploads', 'photo_moderators', 'photo_evidence')) = 4
       then 'OK' else 'STOP' end
union all
select 'Q5 review corrections: 30-day game rule (I-2), release guard and its column (I-3), report reasons (I-4)',
  coalesce((select (position('30 days' in pg_get_functiondef(p.oid)) > 0)::text from pg_proc p where p.oid = to_regprocedure('can_see_player_photo(uuid,uuid)')), 'missing') || ' '
  || exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'reports' and column_name = 'legal_hold_released_at')::text || ' '
  || coalesce((select (position('''abuse''' in pg_get_functiondef(p.oid)) > 0)::text from pg_proc p where p.oid = to_regprocedure('photo_evidence_on_report()')), 'missing'),
  case when coalesce((select position('30 days' in pg_get_functiondef(p.oid)) > 0 from pg_proc p where p.oid = to_regprocedure('can_see_player_photo(uuid,uuid)')), false)
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'reports' and column_name = 'legal_hold_released_at')
        and coalesce((select position('''abuse''' in pg_get_functiondef(p.oid)) > 0 from pg_proc p where p.oid = to_regprocedure('photo_evidence_on_report()')), false)
       then 'OK' else 'STOP' end
union all
select 'Q6 the moderation log accepts the photo actions',
  coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'moderation_log_action_check'), 'missing'),
  case when (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'moderation_log_action_check') like '%view_photo_evidence%' then 'OK' else 'STOP' end
union all
select 'Q7 (information) photo moderators listed (0 expected: added only after MFA, Paul''s decision 5)',
  case when to_regclass('public.photo_moderators') is not null
       then (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.photo_moderators', false, true, '')))[1]::text
       else 'no table' end,
  case when to_regclass('public.photo_moderators') is not null then 'OK' else 'STOP' end;
