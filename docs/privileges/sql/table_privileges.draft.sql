-- DRAFT — remove table privileges that players (authenticated) and visitors (anon) hold but never use.
-- Not a numbered migration; applied nowhere. Separate from the approved 0087–0093 staging sequence: it would follow
-- 0093 with its own number, preflight and postcheck, and Paul's go. Approved for preparation by Paul, 26 Nov.
--
-- Why. Supabase's default privileges give every new table ALL privileges to anon and authenticated; row-level security
-- then decides which rows. Two kinds of privilege are left over that the app never uses:
--   1. TRUNCATE, TRIGGER, REFERENCES. TRUNCATE ignores row-level security altogether. Not reachable today (the data API
--      has no TRUNCATE and players have no direct SQL connection), but it is a whole-table delete waiting for a path.
--      Players held all three on every table; visitors on none (the audit's CAT4b already holds that).
--   2. INSERT / UPDATE / DELETE on tables where no policy lets a player use them. Unusable today (row-level security
--      refuses or matches nothing), so revoking changes no result except that a direct attempt now fails with
--      "permission denied" instead of silently matching no rows. The app writes these tables only through database
--      functions, which run as their owner and are unaffected.
--
-- What stays, deliberately:
--   - every privilege a policy makes usable (the app's 12 direct-write tables: clubs, courts, price_rules, blocks
--     delete, coaches, coach_clubs, availability_rules/exceptions, match_messages insert, profiles update, credit
--     purchases, the admin geography tables);
--   - SELECT everywhere (a revoke would turn some empty reads into errors; not needed for this purpose);
--   - column-level grants: club_media and towns readable columns, notifications.read_at update (a table-level REVOKE
--     of a privilege also removes column grants of the same privilege, so none of those privilege types is revoked on
--     those tables);
--   - service_role's privileges (H1 on account_deletions is a separate decision);
--   - function EXECUTE grants (a separate audit area).
--
-- Rollback: docs/privileges/sql/table_privileges.down.draft.sql re-grants exactly what this removes.

-- 1 ------------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select c.relname from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm') order by 1 loop
    execute format('revoke truncate, trigger, references on public.%I from anon, authenticated', t);   -- tables and views
  end loop;
end $$;

-- New tables no longer receive them either. ASSUMPTION: this changes the defaults of the role postgres only, so it
-- covers objects that postgres creates later. CourtBook's migrations run as postgres, and every table and view in
-- public is owned by postgres (audit CAT4e; to be confirmed read-only on staging in this step's preflight). An object
-- created by any other role (e.g. a table made in Supabase's dashboard table editor, which runs as supabase_admin)
-- gets that role's defaults, ALL to anon and authenticated, and would bring these privileges back. Tables are created
-- only through migrations; the audit's grant checks (CAT4c, CAT4d, CAT4f, finding G1; CAT4e for the owner) report any
-- drift on every run of the local matrix.
alter default privileges for role postgres in schema public revoke truncate, trigger, references on tables from anon, authenticated;

-- 2 ------------------------------------------------------------------------------------------------------------------
-- Each line: the privileges players hold on the table with no policy that lets them use them (measured on 0001–0093).
revoke insert, update, delete on public.app_settings        from authenticated;
revoke insert                 on public.blocks              from authenticated;   -- blocks are made by staff_block()
revoke insert, update         on public.bookings            from authenticated;   -- booking functions only
revoke insert, update, delete on public.club_media          from authenticated;   -- the server route only
revoke update                 on public.coach_clubs         from authenticated;   -- coaches request/withdraw; clubs decide via decide_coach_club()
revoke update, delete         on public.credit_transactions from authenticated;
revoke insert, update, delete on public.match_hidden        from authenticated;   -- hide_match()
revoke update, delete         on public.match_messages      from authenticated;   -- delete_match_message() (soft delete)
revoke insert, update, delete on public.match_players       from authenticated;   -- join_match(), leave_match(), decide_join() …
revoke insert, update         on public.matches             from authenticated;   -- post_match(), update_match() …
revoke insert, update, delete on public.media_orphans       from authenticated;
revoke insert, delete         on public.notifications       from authenticated;   -- read_at stays (column grant)
revoke insert, update, delete on public.payments            from authenticated;   -- payment functions, server key
revoke insert, update, delete on public.player_levels       from authenticated;   -- set_player_level()
revoke insert, delete         on public.profiles            from authenticated;   -- update own stays; rows come from sign-up
