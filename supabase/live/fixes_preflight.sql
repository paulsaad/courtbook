-- Release fixes 0068–0071 — PREFLIGHT. READ ONLY: one SELECT, changes nothing.
-- Run in Supabase → SQL Editor on staging, then on live, BEFORE applying any of 0068–0071.
-- Every row in part 1 and 2 must show ok = true. Part 3 lists the clubs; read it before approving 0070.
-- Function code is compared ignoring Windows line endings and trailing spaces (as for 0065/0066).
with
fn as (
  select proname, md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')) as h, prosecdef
  from pg_proc where pronamespace = 'public'::regnamespace
),
pol as (select tablename, policyname, cmd, qual from pg_policies where schemaname = 'public'),
checks(part, item, ok, detail) as (
  -- 1. the objects the fixes replace are exactly the verified 0001–0066 versions
  select 1, '0068 policy "blocks: read" is the open read (using true)',
    exists (select 1 from pol where tablename = 'blocks' and policyname = 'blocks: read' and cmd = 'SELECT' and qual = 'true'), ''
  union all select 1, '0068 no policy "blocks: staff read" yet',
    not exists (select 1 from pol where tablename = 'blocks' and policyname = 'blocks: staff read'), ''
  union all select 1, '0069 policy "matches: organizer delete" present',
    exists (select 1 from pol where tablename = 'matches' and policyname = 'matches: organizer delete' and cmd = 'DELETE'), ''
  union all select 1, '0069 signed-in users hold UPDATE on notifications columns other than read_at (S5 present)',
    exists (select 1 from information_schema.column_privileges where table_schema = 'public' and table_name = 'notifications'
            and grantee = 'authenticated' and privilege_type = 'UPDATE' and column_name <> 'read_at'), ''
  union all select 1, '0070 clubs.payment_mode default is simulated, no demo-only constraint yet',
    (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'clubs' and column_name = 'payment_mode') = '''simulated''::text'
    and not exists (select 1 from pg_constraint where conname = 'clubs_simulated_only_demo'),
    (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'clubs' and column_name = 'payment_mode')
  union all select 1, '0070 set_club_payment_mode is the verified 0051 version',
    (select count(*) = 1 and max(h) = 'ffd87dcbedbf00607c15639123eb1629' from fn where proname = 'set_club_payment_mode'),
    (select string_agg(h, ',') from fn where proname = 'set_club_payment_mode')
  union all select 1, '0071 staff_book is the verified 0046 version',
    (select count(*) = 1 and max(h) = '1e2c0a9731bef84f4086fc6c483c89d8' from fn where proname = 'staff_book'),
    (select string_agg(h, ',') from fn where proname = 'staff_book')
  union all select 1, '0071 move_booking is the verified 0066 version',
    (select count(*) = 1 and max(h) = 'c529f2516aa80bc9dd6b3676e43d2565' from fn where proname = 'move_booking'),
    (select string_agg(h, ',') from fn where proname = 'move_booking')
  -- 2. what the fixes rely on
  union all select 2, '0068 the grid views run with their owner''s rights (players keep seeing blocked times)',
    (select bool_and(coalesce(array_to_string(reloptions, ','), '') like '%security_invoker=false%') from pg_class
     where relnamespace = 'public'::regnamespace and relname in ('occupancy', 'public_occupancy')) , ''
  union all select 2, '0068 every function that reads blocks for players is security definer',
    (select bool_and(prosecdef) from fn where proname in ('club_day_slots', 'next_free_slot', 'club_courts_free_now', 'close_club')), ''
  union all select 2, '0068 staff keep read and write through "blocks: staff write" (FOR ALL, is_staff_of)',
    exists (select 1 from pol where tablename = 'blocks' and policyname = 'blocks: staff write' and cmd = 'ALL' and qual like '%is_staff_of(club_id)%'), ''
  union all select 2, '0068 is_staff_of() includes admins',
    exists (select 1 from pg_proc where proname = 'is_staff_of' and prosrc like '%is_admin()%'), ''
  union all select 2, '0069 the web marks notices read through mark_notifications_read (security definer)',
    (select bool_and(prosecdef) from fn where proname = 'mark_notifications_read'), ''
  union all select 2, '0070 clubs.is_demo exists (0063)',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clubs' and column_name = 'is_demo'), ''
  union all select 2, 'no pending payment at a desk club today (invariant INV11)',
    not exists (select 1 from payments p join bookings b on b.id = p.booking_id join clubs c on c.id = b.club_id
                where p.status = 'pending' and c.payment_mode = 'at_desk'), ''
  -- 3. data: what 0070 will do (informational; ok = false marks a club 0070 will switch to the desk)
  union all
  select 3, 'club ' || c.slug || ' — ' || c.payment_mode || case when c.is_demo then ', demo' else ', real' end
            || case when c.active then '' else ', inactive' end,
    not (c.payment_mode = 'simulated' and not c.is_demo),
    case when c.payment_mode = 'simulated' and not c.is_demo then
      '0070 WILL SWITCH THIS CLUB TO AT THE DESK; live holds released: '
      || (select count(*) from bookings b where b.club_id = c.id and b.status = 'pending')
      || '; confirmed upcoming bookings (kept): '
      || (select count(*) from bookings b where b.club_id = c.id and b.status = 'confirmed' and b.end_at > now())
    else 'unchanged by 0070' end
  from clubs c
)
select part, item, ok, detail from checks order by part, item;
