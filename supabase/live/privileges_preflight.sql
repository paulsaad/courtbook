-- Table-privilege hardening (#72) — PREFLIGHT. READ ONLY: one SELECT, changes nothing. Every row must be ok = true.
-- The draft was measured on 0001–0093. This confirms the database to be changed is in exactly that state: the same
-- leftover privileges, the same unusable write privileges, the same column grants, every object owned by postgres
-- (the default-privilege assumption), run as postgres. Any difference: STOP and re-measure before changing anything.
with trt(rel) as (select unnest(array['account_deletions', 'app_settings', 'availability_exceptions', 'availability_rules', 'blocks', 'bookings', 'club_media', 'club_payouts', 'club_staff', 'clubs', 'coach_clubs', 'coaches', 'courts', 'credit_packs', 'credit_transactions', 'districts', 'governorates', 'match_hidden', 'match_messages', 'match_players', 'matches', 'media_orphans', 'notifications', 'occupancy', 'payments', 'player_blocks', 'player_levels', 'price_rules', 'profiles', 'public_occupancy', 'sports'])),
     unu(item) as (select unnest(array['app_settings:DELETE', 'app_settings:INSERT', 'app_settings:UPDATE', 'blocks:INSERT', 'bookings:INSERT', 'bookings:UPDATE', 'club_media:DELETE', 'club_media:INSERT', 'club_media:UPDATE', 'coach_clubs:UPDATE', 'credit_transactions:DELETE', 'credit_transactions:UPDATE', 'match_hidden:DELETE', 'match_hidden:INSERT', 'match_hidden:UPDATE', 'match_messages:DELETE', 'match_messages:UPDATE', 'match_players:DELETE', 'match_players:INSERT', 'match_players:UPDATE', 'matches:INSERT', 'matches:UPDATE', 'media_orphans:DELETE', 'media_orphans:INSERT', 'media_orphans:UPDATE', 'notifications:DELETE', 'notifications:INSERT', 'payments:DELETE', 'payments:INSERT', 'payments:UPDATE', 'player_levels:DELETE', 'player_levels:INSERT', 'player_levels:UPDATE', 'profiles:DELETE', 'profiles:INSERT'])),
held_trt as (select c.relname as rel from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m')
             and (has_table_privilege('authenticated', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRIGGER') or has_table_privilege('authenticated', c.oid, 'REFERENCES')
                  or has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('anon', c.oid, 'TRIGGER') or has_table_privilege('anon', c.oid, 'REFERENCES'))),
held_unu as (select c.relname || ':' || k.cmd as item from pg_class c, unnest(array['INSERT','UPDATE','DELETE']) as k(cmd)
             where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and has_table_privilege('authenticated', c.oid, k.cmd)
               and not exists (select 1 from pg_policies pp where pp.schemaname = 'public' and pp.tablename = c.relname and pp.cmd in (k.cmd, 'ALL')
                               and pp.permissive = 'PERMISSIVE' and pp.roles && array['authenticated','public']::name[])),
checks(item, ok, detail) as (
  select 'run as postgres (the migration owner)', current_user = 'postgres', current_user::text
  union all select 'every table and view in public is owned by postgres (default-privilege assumption)',
    not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m') and pg_get_userbyid(c.relowner) <> 'postgres'),
    coalesce((select string_agg(c.relname || ':' || pg_get_userbyid(c.relowner), ',') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m') and pg_get_userbyid(c.relowner) <> 'postgres'), '')
  union all select 'TRUNCATE, TRIGGER or REFERENCES are held (by players or visitors) on exactly the 31 measured tables and views',
    (select count(*) from held_trt) = 31
    and (select bool_and(has_table_privilege('authenticated', c.oid, 'TRUNCATE') and has_table_privilege('authenticated', c.oid, 'TRIGGER') and has_table_privilege('authenticated', c.oid, 'REFERENCES'))
         from pg_class c join trt on trt.rel = c.relname where c.relnamespace = 'public'::regnamespace) and not exists (select rel from held_trt except select rel from trt) and not exists (select rel from trt except select rel from held_trt),
    'extra: ' || coalesce((select string_agg(rel, ',') from (select rel from held_trt except select rel from trt) x), '-')
      || ' · missing: ' || coalesce((select string_agg(rel, ',') from (select rel from trt except select rel from held_trt) x), '-')
  union all select 'players hold exactly the 35 measured unusable write privileges',
    (select count(*) from held_unu) = 35 and not exists (select item from held_unu except select item from unu) and not exists (select item from unu except select item from held_unu),
    'extra: ' || coalesce((select string_agg(item, ',') from (select item from held_unu except select item from unu) x), '-')
      || ' · missing: ' || coalesce((select string_agg(item, ',') from (select item from unu except select item from held_unu) x), '-')
  union all select 'visitors (anon) hold nothing but SELECT',
    not exists (select 1 from information_schema.table_privileges where grantee = 'anon' and table_schema = 'public' and privilege_type <> 'SELECT'), ''
  union all select 'the column grants the app relies on are present (club_media and towns read columns, notifications.read_at)',
    (select count(*) from pg_attribute a where a.attrelid = 'club_media'::regclass and a.attnum > 0 and has_column_privilege('authenticated', a.attrelid, a.attname, 'SELECT')) >= 9
    and (select count(*) from pg_attribute a where a.attrelid = 'towns'::regclass and a.attnum > 0 and has_column_privilege('authenticated', a.attrelid, a.attname, 'SELECT')) >= 8
    and has_column_privilege('authenticated', 'notifications', 'read_at', 'UPDATE') and not has_table_privilege('authenticated', 'notifications', 'UPDATE'), ''
  union all select 'new tables by postgres still get TRUNCATE by default (the draft is not applied yet)',
    exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) a where d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r'
            and pg_get_userbyid(d.defaclrole) = 'postgres' and a.grantee = 'authenticated'::regrole and a.privilege_type = 'TRUNCATE'), ''
)
select item, ok, detail from checks;
