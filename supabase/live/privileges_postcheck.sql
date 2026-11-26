-- Table-privilege hardening (#72) — POSTCHECK. READ ONLY: one SELECT, changes nothing. Every row must be ok = true.
-- A failure after the migration has committed means: STOP and report the actual state; the rollback
-- (docs/privileges/sql/table_privileges.down.draft.sql) needs separate approval.
with checks(item, ok, detail) as (
  select 'players and visitors hold no TRUNCATE, TRIGGER or REFERENCES on any table or view',
    not exists (select 1 from pg_class c, unnest(array['anon','authenticated']) r, unnest(array['TRUNCATE','TRIGGER','REFERENCES']) p
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m') and has_table_privilege(r, c.oid, p)),
    coalesce((select string_agg(r || ':' || c.relname || ':' || p, ',') from pg_class c, unnest(array['anon','authenticated']) r, unnest(array['TRUNCATE','TRIGGER','REFERENCES']) p
              where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m') and has_table_privilege(r, c.oid, p)), '')
  union all select 'every INSERT, UPDATE or DELETE a player holds is usable through a policy',
    not exists (select 1 from pg_class c, unnest(array['INSERT','UPDATE','DELETE']) as k(cmd)
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and has_table_privilege('authenticated', c.oid, k.cmd)
                  and not exists (select 1 from pg_policies pp where pp.schemaname = 'public' and pp.tablename = c.relname and pp.cmd in (k.cmd, 'ALL')
                                  and pp.permissive = 'PERMISSIVE' and pp.roles && array['authenticated','public']::name[])), ''
  union all select 'the app''s direct writes keep their privileges (clubs, courts, price_rules, blocks delete, coaches, coach_clubs, availability, chat insert, own profile update)',
    has_table_privilege('authenticated', 'clubs', 'INSERT') and has_table_privilege('authenticated', 'clubs', 'UPDATE')
    and has_table_privilege('authenticated', 'courts', 'INSERT') and has_table_privilege('authenticated', 'courts', 'UPDATE')
    and has_table_privilege('authenticated', 'price_rules', 'INSERT') and has_table_privilege('authenticated', 'price_rules', 'DELETE')
    and has_table_privilege('authenticated', 'blocks', 'DELETE') and has_table_privilege('authenticated', 'coaches', 'INSERT') and has_table_privilege('authenticated', 'coaches', 'UPDATE')
    and has_table_privilege('authenticated', 'coach_clubs', 'INSERT') and has_table_privilege('authenticated', 'coach_clubs', 'DELETE')
    and has_table_privilege('authenticated', 'availability_rules', 'INSERT') and has_table_privilege('authenticated', 'availability_exceptions', 'DELETE')
    and has_table_privilege('authenticated', 'match_messages', 'INSERT') and has_table_privilege('authenticated', 'profiles', 'UPDATE'), ''
  union all select 'the column grants are intact (club_media and towns read columns, notifications.read_at)',
    (select count(*) from pg_attribute a where a.attrelid = 'club_media'::regclass and a.attnum > 0 and has_column_privilege('authenticated', a.attrelid, a.attname, 'SELECT')) >= 9
    and (select count(*) from pg_attribute a where a.attrelid = 'towns'::regclass and a.attnum > 0 and has_column_privilege('authenticated', a.attrelid, a.attname, 'SELECT')) >= 8
    and has_column_privilege('authenticated', 'notifications', 'read_at', 'UPDATE'), ''
  union all select 'players keep SELECT where they had it (bookings, matches, profiles, notifications)',
    has_table_privilege('authenticated', 'bookings', 'SELECT') and has_table_privilege('authenticated', 'matches', 'SELECT')
    and has_table_privilege('authenticated', 'profiles', 'SELECT') and has_table_privilege('authenticated', 'notifications', 'SELECT'), ''
  union all select 'the server key keeps every table privilege (unchanged; H1 is separate)',
    has_table_privilege('service_role', 'bookings', 'UPDATE') and has_table_privilege('service_role', 'payments', 'INSERT') and has_table_privilege('service_role', 'account_deletions', 'SELECT'), ''
  union all select 'new tables by postgres get no TRUNCATE, TRIGGER or REFERENCES for players or visitors',
    not exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) a where d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r'
                and pg_get_userbyid(d.defaclrole) = 'postgres' and a.grantee in ('anon'::regrole, 'authenticated'::regrole) and a.privilege_type in ('TRUNCATE','TRIGGER','REFERENCES')), ''
  union all select 'the booking functions players call are still executable (hold_slot, book_at_desk, cancel_booking, set_match_status)',
    has_function_privilege('authenticated', 'hold_slot(uuid,uuid,timestamptz,timestamptz,uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'set_match_status(uuid,match_status)', 'EXECUTE')
    and exists (select 1 from pg_proc where proname = 'book_at_desk' and has_function_privilege('authenticated', oid, 'EXECUTE'))
    and exists (select 1 from pg_proc where proname = 'cancel_booking' and has_function_privilege('authenticated', oid, 'EXECUTE')), ''
)
select item, ok, detail from checks;
