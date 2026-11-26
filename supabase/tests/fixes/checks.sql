-- Release fixes 0068–0071: role and behaviour checks, one rolled-back transaction.
-- Run by run_fixes.sh against a database built from migrations 0001–0071 + seed. Prints id|pass|detail.
\set ON_ERROR_STOP 1
begin;
create temp table r (id text, pass boolean, detail text);
grant all on r to authenticated, anon, service_role;
-- err(q): runs q as the current role; returns the error text, or 'no error'
create function pg_temp.err(q text) returns text language plpgsql as $f$
begin execute q; return 'no error'; exception when others then return sqlerrm; end $f$;
create function pg_temp.cnt(q text) returns bigint language plpgsql as $f$
declare n bigint; begin execute 'select count(*) from (' || q || ') x' into n; return n; end $f$;
create function pg_temp.at(d int, t text) returns timestamptz language sql as $f$
  select (current_date + d + t::time) at time zone 'Asia/Beirut' $f$;
-- the schema revokes default EXECUTE (0036), so grant these helpers explicitly
grant execute on function pg_temp.err(text), pg_temp.cnt(text), pg_temp.at(int, text) to public;

-- players P1 P2, organiser ORG, staff SA (batroun) and SB (other club), admin AD
insert into auth.users (id, email) values
  ('f0000000-0000-4000-8000-0000000000a1', 'p1@fix.test'), ('f0000000-0000-4000-8000-0000000000a2', 'p2@fix.test'),
  ('f0000000-0000-4000-8000-0000000000a3', 'org@fix.test'), ('f0000000-0000-4000-8000-0000000000b1', 'sa@fix.test'),
  ('f0000000-0000-4000-8000-0000000000b2', 'sb@fix.test'), ('f0000000-0000-4000-8000-0000000000d1', 'ad@fix.test');
update profiles set roles = '{player,admin}' where id = 'f0000000-0000-4000-8000-0000000000d1';
insert into clubs (id, name, slug, payment_mode, is_demo) values ('f0000000-0000-4000-8000-00000000c002', 'Fix Other Club', 'fix-other', 'at_desk', false);
insert into courts (id, club_id, name, sport) values ('f0000000-0000-4000-8000-00000000c0c2', 'f0000000-0000-4000-8000-00000000c002', 'Other 1', 'padel');
insert into club_staff (club_id, profile_id) select id, 'f0000000-0000-4000-8000-0000000000b1' from clubs where slug = 'batroun';
insert into club_staff (club_id, profile_id) values ('f0000000-0000-4000-8000-00000000c002', 'f0000000-0000-4000-8000-0000000000b2');
insert into blocks (id, club_id, court_id, start_at, end_at, reason, created_by)
  select 'f0000000-0000-4000-8000-0000000b10c1', k.club_id, k.id, pg_temp.at(3, '10:00'), pg_temp.at(3, '11:00'),
         'Private lesson — Ahmad H. 03 123 456', 'f0000000-0000-4000-8000-0000000000b1'
  from courts k join clubs c on c.id = k.club_id where c.slug = 'batroun' and k.name = 'Padel 3';
insert into blocks (id, club_id, court_id, start_at, end_at, reason, created_by)
  values ('f0000000-0000-4000-8000-0000000b10c2', 'f0000000-0000-4000-8000-00000000c002', 'f0000000-0000-4000-8000-00000000c0c2',
          pg_temp.at(3, '10:00'), pg_temp.at(3, '11:00'), 'Tournament', 'f0000000-0000-4000-8000-0000000000b2');
-- a game with one accepted player, and two notices for P2
insert into matches (id, club_id, sport, organizer_id, start_at, end_at, players_needed)
  select 'f0000000-0000-4000-8000-00000000aa01', id, 'padel', 'f0000000-0000-4000-8000-0000000000a3', pg_temp.at(4, '18:00'), pg_temp.at(4, '19:30'), 3
  from clubs where slug = 'batroun';
insert into match_players (match_id, profile_id) values ('f0000000-0000-4000-8000-00000000aa01', 'f0000000-0000-4000-8000-0000000000a2');
-- (notices carry no match_id, so the S1 checks cannot affect them through the cascade)
insert into notifications (id, profile_id, kind, body, emailed_at) values
  ('f0000000-0000-4000-8000-00000000ee01', 'f0000000-0000-4000-8000-0000000000a2', 'join_accepted', 'You are in', now()),
  ('f0000000-0000-4000-8000-00000000ee02', 'f0000000-0000-4000-8000-0000000000a2', 'join_accepted', 'Second', null);

-- ===================== R2 — 0068: blocks readable by that club's staff and admins only
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000a1', false) \g /dev/null
insert into r select 'R2a a player reads no blocks (no reason, no creator)', pg_temp.cnt('select * from blocks') = 0, pg_temp.cnt('select * from blocks')::text;
insert into r select 'R2b ...but still sees the blocked time as taken in the booking grid (occupancy)',
  pg_temp.cnt($$select * from occupancy where kind = 'block' and court_id = (select id from courts where name = 'Padel 3') and start_at = pg_temp.at(3, '10:00')$$) = 1, '';
insert into r select 'R2c ...and is not offered the blocked hour (club_day_slots), while 12:00 on that court is offered',
  not exists (select 1 from club_day_slots(current_date + 3) s where s.court_name = 'Padel 3' and s.start_at = pg_temp.at(3, '10:00'))
  and exists (select 1 from club_day_slots(current_date + 3) s where s.court_name = 'Padel 3' and s.start_at = pg_temp.at(3, '12:00')), '';
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000b1', false) \g /dev/null
insert into r select 'R2d staff read their own club''s blocks, with the reason',
  (select count(*) from blocks where reason like 'Private lesson%') = 1 and pg_temp.cnt('select * from blocks') = 1, pg_temp.cnt('select * from blocks')::text;
-- since 0076/0077 a block is added through staff_block (docs/phase-i/blocks.md); before 0076 directly
insert into r select 'R2e staff still add and remove a block (staff calendar)',
  pg_temp.err(case when to_regproc('public.staff_block') is not null
    then $$select staff_block(club_id, id, pg_temp.at(5, '09:00'), pg_temp.at(5, '10:00'), 'Maintenance') from courts where name = 'Padel 2'$$
    else $$insert into blocks (club_id, court_id, start_at, end_at, reason, created_by)
           select club_id, id, pg_temp.at(5, '09:00'), pg_temp.at(5, '10:00'), 'Maintenance', 'f0000000-0000-4000-8000-0000000000b1'
           from courts where name = 'Padel 2'$$ end) = 'no error'
  and pg_temp.err($$delete from blocks where reason = 'Maintenance' and start_at = pg_temp.at(5, '09:00')$$) = 'no error'
  and pg_temp.cnt($$select * from blocks where reason = 'Maintenance' and start_at = pg_temp.at(5, '09:00')$$) = 0, '';
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000b2', false) \g /dev/null
insert into r select 'R2f staff of another club read only their own club''s blocks',
  pg_temp.cnt('select * from blocks') = 1 and pg_temp.cnt($$select * from blocks where reason like 'Private%'$$) = 0, pg_temp.cnt('select * from blocks')::text;
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000d1', false) \g /dev/null
insert into r select 'R2g an admin reads every club''s blocks', pg_temp.cnt('select * from blocks') = 2, pg_temp.cnt('select * from blocks')::text;
reset role; set role anon; select set_config('request.jwt.claim.sub', '', false) \g /dev/null
insert into r select 'R2h a visitor cannot read blocks at all', pg_temp.err('select 1 from blocks') like 'permission denied%', pg_temp.err('select 1 from blocks');
insert into r select 'R2i ...but the public grid still shows the blocked time as taken (public_occupancy)',
  pg_temp.cnt($$select * from public_occupancy where kind = 'block' and start_at = pg_temp.at(3, '10:00')$$) = 2, '';
reset role;

-- ===================== S1 — 0069: no direct delete of a game
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000a3', false) \g /dev/null
insert into r select 'S1a the organiser cannot delete the game row', pg_temp.err($$delete from matches where id = 'f0000000-0000-4000-8000-00000000aa01'$$) like 'permission denied%',
  pg_temp.err($$delete from matches where id = 'f0000000-0000-4000-8000-00000000aa01'$$);
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000d1', false) \g /dev/null
insert into r select 'S1b ...nor can an admin through the API (clean-up is service-role only)', pg_temp.err($$delete from matches where id = 'f0000000-0000-4000-8000-00000000aa01'$$) like 'permission denied%', '';
reset role;
insert into r select 'S1c the game and its player are intact',
  exists (select 1 from matches where id = 'f0000000-0000-4000-8000-00000000aa01')
  and exists (select 1 from match_players where match_id = 'f0000000-0000-4000-8000-00000000aa01'), '';
insert into r select 'S1d organisers can still read and update their game (cancel path unchanged)',
  has_table_privilege('authenticated', 'matches', 'SELECT') and has_table_privilege('authenticated', 'matches', 'UPDATE')
  and has_table_privilege('service_role', 'matches', 'DELETE'), '';

-- ===================== S5 — 0069: a user can change only read_at of their own notices
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000a2', false) \g /dev/null
insert into r select 'S5a a user cannot rewrite the text of their notice', pg_temp.err($$update notifications set body = 'Any text' where id = 'f0000000-0000-4000-8000-00000000ee01'$$) like 'permission denied%',
  pg_temp.err($$update notifications set body = 'Any text' where id = 'f0000000-0000-4000-8000-00000000ee01'$$);
insert into r select 'S5b ...nor put it back in the email queue', pg_temp.err($$update notifications set emailed_at = null, email_claimed_at = null where id = 'f0000000-0000-4000-8000-00000000ee01'$$) like 'permission denied%', '';
insert into r select 'S5c ...nor change kind, match or recipient', pg_temp.err($$update notifications set kind = 'x' where id = 'f0000000-0000-4000-8000-00000000ee01'$$) like 'permission denied%'
  and pg_temp.err($$update notifications set profile_id = 'f0000000-0000-4000-8000-0000000000a1' where id = 'f0000000-0000-4000-8000-00000000ee01'$$) like 'permission denied%', '';
insert into r select 'S5d marking read still works (direct read_at update)', pg_temp.err($$update notifications set read_at = now() where id = 'f0000000-0000-4000-8000-00000000ee01'$$) = 'no error', '';
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000a1', false) \g /dev/null
select pg_temp.err($$update notifications set read_at = now() where id = 'f0000000-0000-4000-8000-00000000ee02'$$) \g /dev/null
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000a2', false) \g /dev/null
insert into r select 'S5e another user cannot mark my notice read', (select read_at from notifications where id = 'f0000000-0000-4000-8000-00000000ee02') is null, '';
create temp table mr on commit drop as select pg_temp.err($$select mark_notifications_read(array['f0000000-0000-4000-8000-00000000ee02'::uuid])$$) as e;
insert into r select 'S5f mark_notifications_read (what the web uses) still works', (select e from mr) = 'no error'
  and (select read_at from notifications where id = 'f0000000-0000-4000-8000-00000000ee02') is not null, (select e from mr);
reset role;
insert into r select 'S5g the notice text and email state are unchanged', (select body = 'You are in' and emailed_at is not null from notifications where id = 'f0000000-0000-4000-8000-00000000ee01'), '';
insert into r select 'S5h the server (service role) keeps full update for the email sender', has_table_privilege('service_role', 'notifications', 'UPDATE'), '';

-- ===================== D1 — 0070: simulated payment only at demo clubs; new clubs at the desk
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000d1', false) \g /dev/null
insert into clubs (name, slug) values ('Fix New Club', 'fix-new');   -- what the admin "New club" form does
insert into r select 'D1a a club created with defaults takes payment at the desk and is not a demo',
  (select payment_mode = 'at_desk' and not is_demo from clubs where slug = 'fix-new'), (select payment_mode from clubs where slug = 'fix-new');
insert into r select 'D1b an admin cannot switch a real club to simulated payment (readable error)',
  pg_temp.err($$select set_club_payment_mode((select id from clubs where slug = 'fix-new'), 'simulated')$$) = 'simulated_demo_only'
  and (select payment_mode from clubs where slug = 'fix-new') = 'at_desk',
  pg_temp.err($$select set_club_payment_mode((select id from clubs where slug = 'fix-new'), 'simulated')$$);
insert into r select 'D1c ...nor by writing the column directly',
  pg_temp.err($$update clubs set payment_mode = 'simulated' where slug = 'fix-new'$$) like '%clubs_simulated_only_demo%', '';
insert into r select 'D1d ...nor by un-marking the demo club while it is simulated',
  pg_temp.err($$update clubs set is_demo = false where slug = 'batroun'$$) like '%clubs_simulated_only_demo%', '';
insert into r select 'D1e a real club can still be edited (hours) and switched to at-the-desk',
  pg_temp.err($$update clubs set close_time = '22:00' where slug = 'fix-new'$$) = 'no error'
  and pg_temp.err($$select set_club_payment_mode((select id from clubs where slug = 'fix-new'), 'at_desk')$$) = 'no error', '';
reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000a1', false) \g /dev/null
create temp table h on commit drop as select * from hold_slot((select id from clubs where slug = 'batroun'), (select id from courts where name = 'Padel 1'), pg_temp.at(2, '18:00'), pg_temp.at(2, '19:30'), gen_random_uuid());
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000d1', false) \g /dev/null
-- (an action and its check are separate statements: a statement does not see what a function it calls has written)
create temp table sw on commit drop as select set_club_payment_mode((select id from clubs where slug = 'batroun'), 'at_desk') as released;
insert into r select 'D1f demo club: simulated → at the desk still releases the live hold', (select released from sw) = 1
  and (select b.status::text || '/' || p.status::text from bookings b join payments p on p.booking_id = b.id where b.id = (select booking_id from h)) = 'expired/expired',
  (select released from sw)::text;
create temp table sw2 on commit drop as select pg_temp.err($$select set_club_payment_mode((select id from clubs where slug = 'batroun'), 'simulated')$$) as e;
insert into r select 'D1g demo club: at the desk → simulated is still allowed', (select e from sw2) = 'no error'
  and (select payment_mode from clubs where slug = 'batroun') = 'simulated', (select e from sw2);
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000a1', false) \g /dev/null
insert into r select 'D1h the in-app payment flow is refused at a desk club (unchanged rule)',
  pg_temp.err($$select * from hold_slot('f0000000-0000-4000-8000-00000000c002', 'f0000000-0000-4000-8000-00000000c0c2', pg_temp.at(2, '10:00'), pg_temp.at(2, '11:00'), gen_random_uuid())$$) = 'wrong_payment_mode',
  pg_temp.err($$select * from hold_slot('f0000000-0000-4000-8000-00000000c002', 'f0000000-0000-4000-8000-00000000c0c2', pg_temp.at(2, '10:00'), pg_temp.at(2, '11:00'), gen_random_uuid())$$);
reset role;
insert into r select 'D1i fees are untouched (service_fee_usd default and the demo club''s fee)',
  (select column_default from information_schema.columns where table_name = 'clubs' and column_name = 'service_fee_usd') is not distinct from :'fee_default'
  and (select service_fee_usd::text from clubs where slug = 'batroun') = :'fee_batroun', '';

-- ===================== D3 — 0071 (coarse, real clock; exact boundaries are in the faked-clock part)
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-0000000000b1', false) \g /dev/null
insert into r select 'D3a staff cannot enter a desk booking that started yesterday',
  pg_temp.err($$select staff_book((select id from clubs where slug = 'batroun'), (select id from courts where name = 'Padel 2'), pg_temp.at(-1, '10:00'), pg_temp.at(-1, '11:00'), 'Old', null)$$) = 'walk_in_too_old', '';
insert into r select 'D3b staff still book ahead as before',
  pg_temp.err($$select staff_book((select id from clubs where slug = 'batroun'), (select id from courts where name = 'Padel 2'), pg_temp.at(2, '10:00'), pg_temp.at(2, '11:00'), 'Ahead', null)$$) = 'no error', '';
insert into r select 'D3c a future booking cannot be moved to yesterday',
  pg_temp.err($$select (case when move_booking_priced((select id from bookings where guest_name = 'Ahead'), (select id from courts where name = 'Padel 2'), pg_temp.at(-1, '10:00'), pg_temp.at(-1, '11:00'), null, (select court_id from bookings where id = (select id from bookings where guest_name = 'Ahead')), (select start_at from bookings where id = (select id from bookings where guest_name = 'Ahead')), (select end_at from bookings where id = (select id from bookings where guest_name = 'Ahead'))) is not null then ''::text end)$$) = 'move_into_past', '';
insert into r select 'D3d ...and stays where it was', (select start_at from bookings where guest_name = 'Ahead') = pg_temp.at(2, '10:00'), '';
reset role;

select id || '|' || coalesce(pass::text, 'f') || '|' || coalesce(detail, '') from r order by id;
rollback;
