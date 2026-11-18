-- Release fixes 0068–0071 — FULL POSTCHECK. READ ONLY: one SELECT, changes nothing.
-- Run ONCE, after the LAST of the four has been applied on that database: every row must be true. It
-- describes the end of the whole sequence, so between steps some rows are false by design: do not use
-- it between steps. Each 00xx_apply.sql already refuses to commit unless its own result is exact.
with
fn as (select proname, md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')) as h, oid from pg_proc where pronamespace = 'public'::regnamespace),
pol as (select tablename, policyname, cmd, qual from pg_policies where schemaname = 'public'),
checks(item, ok, detail) as (
  select '0068 "blocks: read" gone; "blocks: staff read" = is_staff_of(club_id)',
    not exists (select 1 from pol where tablename = 'blocks' and policyname = 'blocks: read')
    and exists (select 1 from pol where tablename = 'blocks' and policyname = 'blocks: staff read' and cmd = 'SELECT' and qual = 'is_staff_of(club_id)'), ''
  union all select '0068 blocks: the only SELECT-capable policies are staff read and staff write',
    (select string_agg(policyname, ',' order by policyname) from pol where tablename = 'blocks' and cmd in ('SELECT', 'ALL')) = 'blocks: staff read,blocks: staff write',
    (select string_agg(policyname, ',' order by policyname) from pol where tablename = 'blocks' and cmd in ('SELECT', 'ALL'))
  union all select '0069 no DELETE policy and no DELETE privilege on matches for signed-in users or visitors',
    not exists (select 1 from pol where tablename = 'matches' and cmd = 'DELETE')
    and not has_table_privilege('authenticated', 'public.matches', 'DELETE') and not has_table_privilege('anon', 'public.matches', 'DELETE'), ''
  union all select '0069 signed-in users can update notifications.read_at only',
    (select string_agg(column_name, ',') from information_schema.column_privileges where table_schema = 'public' and table_name = 'notifications'
     and grantee = 'authenticated' and privilege_type = 'UPDATE') = 'read_at'
    and not has_table_privilege('authenticated', 'public.notifications', 'UPDATE'),
    (select string_agg(column_name, ',') from information_schema.column_privileges where table_schema = 'public' and table_name = 'notifications'
     and grantee = 'authenticated' and privilege_type = 'UPDATE')
  union all select '0070 new clubs default to at_desk; constraint present and validated',
    (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'clubs' and column_name = 'payment_mode') = '''at_desk''::text'
    and exists (select 1 from pg_constraint where conname = 'clubs_simulated_only_demo' and convalidated), ''
  union all select '0070 no real club is in simulated mode',
    not exists (select 1 from clubs where payment_mode = 'simulated' and not is_demo),
    coalesce((select string_agg(slug, ',') from clubs where payment_mode = 'simulated' and not is_demo), '')
  union all select '0070 set_club_payment_mode is the 0070 version',
    (select count(*) = 1 and max(h) = '0af6719940f8fcfe481ad47181e09f39' from fn where proname = 'set_club_payment_mode'), (select string_agg(h, ',') from fn where proname = 'set_club_payment_mode')
  union all select '0071 staff_book is the 0071 version',
    (select count(*) = 1 and max(h) = '4c62c61ff55aa739c65d1135928eadca' from fn where proname = 'staff_book'), (select string_agg(h, ',') from fn where proname = 'staff_book')
  union all select '0071 move_booking is the 0071 version',
    (select count(*) = 1 and max(h) = 'ea48ad3e1371caf23d1883b45ea16a5d' from fn where proname = 'move_booking'), (select string_agg(h, ',') from fn where proname = 'move_booking')
  union all select 'permissions of the three replaced functions unchanged: anon no, authenticated yes, service_role yes',
    (select bool_and(not has_function_privilege('anon', oid, 'execute') and has_function_privilege('authenticated', oid, 'execute')
                     and has_function_privilege('service_role', oid, 'execute'))
     from fn where proname in ('set_club_payment_mode', 'staff_book', 'move_booking')), ''
  union all select 'no pending payment at a desk club (invariant INV11)',
    not exists (select 1 from payments p join bookings b on b.id = p.booking_id join clubs c on c.id = b.club_id
                where p.status = 'pending' and c.payment_mode = 'at_desk'), ''
)
select item, ok, detail from checks order by item;
