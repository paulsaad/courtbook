-- LIVE READINESS — READ ONLY. One SELECT; changes nothing; prints no names, emails or phone numbers.
-- Run in Supabase → the LIVE project (lgujfbwunokobjxlvpuf) → SQL Editor → paste → Run.
-- It says which migrations live already has, so the release sequence starts at the right step:
-- release fixes 0068 → 0069 → 0070 → 0071, then M3 0067 → 0072 → 0073 → 0074 → 0075.
-- Each "has_…" row is a fingerprint of that migration (true = applied).
with checks(n, item, value) as (
  select 1, 'database', current_database()
  union all select 2, 'has 0065 (hold_slot retry token, M2)', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hold_slot' and pg_get_function_identity_arguments(oid) like '%p_token%')::text
  union all select 3, 'has 0066 (move_booking length rules, M2)', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'move_booking' and prosrc like '%min_booking_minutes%')::text
  union all select 4, 'has 0068 (staff can read blocks)', exists (select 1 from pg_policies where tablename = 'blocks' and policyname = 'blocks: staff read')::text
  union all select 5, 'has 0069 (no direct game deletes)', (not exists (select 1 from pg_policies where tablename = 'matches' and policyname = 'matches: organizer delete'))::text
  union all select 6, 'has 0070 (simulated payment only at demo clubs)', exists (select 1 from pg_constraint where conname = 'clubs_simulated_only_demo')::text
  union all select 7, 'has 0071 (staff and past times)', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'staff_book' and prosrc like '%walk_in_too_old%')::text
  union all select 8, 'has 0067 (match_detail)', (to_regproc('public.match_detail') is not null)::text
  union all select 9, 'has 0072 (game hardening)', (to_regproc('public.resolve_court') is not null)::text
  union all select 10, 'has 0073 (post_match key)', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'matches' and column_name = 'client_token')::text
  union all select 11, 'has 0074 (chat and player safety)', (to_regclass('public.player_blocks') is not null)::text
  union all select 12, 'has 0075 (moderator history)', (to_regproc('public.admin_blocks_received') is not null)::text
  union all select 13, 'admin accounts (moderators possible)', (select count(*)::text from profiles where 'admin' = any(roles))
  union all select 14, 'clubs: real / demo', (select count(*) filter (where not is_demo) || ' / ' || count(*) filter (where is_demo) from clubs)
  union all select 15, 'real clubs in simulated payment (0070 would switch them)', (select count(*)::text from clubs where not is_demo and payment_mode = 'simulated')
  union all select 16, 'holds running now (pending bookings not yet expired)', (select count(*)::text from bookings where status = 'pending' and hold_expires_at > now())
  union all select 17, 'upcoming confirmed bookings', (select count(*)::text from bookings where status = 'confirmed' and end_at > now())
  union all select 18, 'games not cancelled (any date)', (select count(*)::text from matches where status <> 'cancelled')
)
select n, item, value from checks order by n;
