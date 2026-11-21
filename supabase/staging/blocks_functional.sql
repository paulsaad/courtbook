-- STAGING ONLY (the workflow refuses the live project). Calendar blocks after 0076, and again after 0077:
-- tries the rules as a desk-staff account of the demo club, inside ONE transaction that is ROLLED BACK at
-- the end, so nothing is kept. The account is a throwaway one created inside that transaction (staging has
-- no permanent non-admin desk account), so it disappears with the rollback too. Each case prints a NOTICE
-- line "ok ..." or "FAIL ...".
-- Workflow action: blocks_functional.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- the throwaway desk account (rolled back with everything else)
insert into auth.users (id, email, aud, role)
values ('b10c0076-0000-4000-8000-000000000001', 'blocks-check@courtbook.test', 'authenticated', 'authenticated');
insert into club_staff (club_id, profile_id)
select id, 'b10c0076-0000-4000-8000-000000000001' from clubs where is_demo order by created_at limit 1;
do $t$
declare
  v_staff uuid; v_club uuid; v_court uuid; v_tz text; v_day date; v_open time; v_slot int;
  v_stage text; fails int := 0; got text; v_id uuid;
begin
  select cs.profile_id, c.id, c.timezone, c.open_time, c.slot_minutes into v_staff, v_club, v_tz, v_open, v_slot
  from club_staff cs join clubs c on c.id = cs.club_id
  join profiles p on p.id = cs.profile_id
  where cs.profile_id = 'b10c0076-0000-4000-8000-000000000001' and not ('admin' = any(p.roles));
  if v_staff is null then raise exception 'the throwaway desk account was not set up'; end if;
  -- a court and a day 20-40 days ahead with nothing on it
  select k.id, d into v_court, v_day
  from courts k, (select current_date + g as d from generate_series(20, 40) g) x
  where k.club_id = v_club and k.active
    and not exists (select 1 from bookings b where b.court_id = k.id and b.status in ('confirmed','pending')
                    and b.period && tstzrange((d + time '00:00') at time zone v_tz, (d + 1 + time '00:00') at time zone v_tz))
    and not exists (select 1 from blocks b where b.court_id = k.id
                    and b.period && tstzrange((d + time '00:00') at time zone v_tz, (d + 1 + time '00:00') at time zone v_tz))
  order by d, k.sort limit 1;
  v_stage := case when to_regproc('public.blocks_direct_insert_refused') is not null then '0077' else '0076' end;
  raise notice 'stage % — demo club, court %, day %, as staff %…', v_stage, v_court, v_day, left(v_staff::text, 8);

  perform set_config('request.jwt.claim.sub', v_staff::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1 a long block, opening to opening + 10 h, through staff_block
  begin
    v_id := staff_block(v_club, v_court, (v_day + v_open) at time zone v_tz, (v_day + v_open + interval '10 hours') at time zone v_tz, 'staging check');
    raise notice 'ok    1 ten-hour block saved through staff_block';
  exception when others then fails := fails + 1; raise notice 'FAIL  1 ten-hour block: %', sqlerrm; end;
  -- 2 overlap with it
  begin
    perform staff_block(v_club, v_court, (v_day + v_open + interval '1 hour') at time zone v_tz, (v_day + v_open + interval '2 hours') at time zone v_tz, 'x');
    fails := fails + 1; raise notice 'FAIL  2 overlapping block was saved';
  exception when others then
    if sqlerrm = 'overlaps_existing_block' then raise notice 'ok    2 overlap refused (overlaps_existing_block)'; else fails := fails + 1; raise notice 'FAIL  2 overlap: %', sqlerrm; end if; end;
  -- 3 off the grid (15 minutes after a slot boundary, one slot long)
  begin
    perform staff_block(v_club, v_court, (v_day + v_open + interval '11 hours 15 minutes') at time zone v_tz, (v_day + v_open + interval '11 hours 15 minutes' + make_interval(mins => v_slot)) at time zone v_tz, 'x');
    fails := fails + 1; raise notice 'FAIL  3 off-grid block was saved';
  exception when others then
    if sqlerrm = 'not_on_grid' then raise notice 'ok    3 off grid refused (not_on_grid)'; else fails := fails + 1; raise notice 'FAIL  3 off grid: %', sqlerrm; end if; end;
  -- 4 before opening
  begin
    perform staff_block(v_club, v_court, (v_day + v_open - make_interval(mins => v_slot)) at time zone v_tz, (v_day + v_open) at time zone v_tz, 'x');
    fails := fails + 1; raise notice 'FAIL  4 block before opening was saved';
  exception when others then
    if sqlerrm = 'outside_opening_hours' then raise notice 'ok    4 before opening refused (outside_opening_hours)'; else fails := fails + 1; raise notice 'FAIL  4 before opening: %', sqlerrm; end if; end;
  -- 5 wholly past
  begin
    perform staff_block(v_club, v_court, (current_date - 3 + v_open) at time zone v_tz, (current_date - 3 + v_open + make_interval(mins => v_slot)) at time zone v_tz, 'x');
    fails := fails + 1; raise notice 'FAIL  5 past block was saved';
  exception when others then
    if sqlerrm = 'slot_in_past' then raise notice 'ok    5 wholly past refused (slot_in_past)'; else fails := fails + 1; raise notice 'FAIL  5 past: %', sqlerrm; end if; end;
  -- 6 a page from before the new website: direct insert, valid times
  begin
    insert into blocks (club_id, court_id, start_at, end_at, reason, created_by)
    values (v_club, v_court, (v_day + v_open + interval '12 hours') at time zone v_tz, (v_day + v_open + interval '12 hours' + make_interval(mins => v_slot)) at time zone v_tz, 'old page', v_staff);
    if v_stage = '0076' then raise notice 'ok    6 old page, valid block: saved (as before)';
    else fails := fails + 1; raise notice 'FAIL  6 old page insert was saved after 0077'; end if;
  exception when others then
    if v_stage = '0077' and sqlerrm like 'CourtBook has been updated.%' then raise notice 'ok    6 old page after 0077: "%"', sqlerrm;
    else fails := fails + 1; raise notice 'FAIL  6 old page: %', sqlerrm; end if; end;
  -- 7 a page from before the new website, off the grid
  begin
    insert into blocks (club_id, court_id, start_at, end_at, reason, created_by)
    values (v_club, v_court, (v_day + v_open + interval '13 hours 15 minutes') at time zone v_tz, (v_day + v_open + interval '13 hours 15 minutes' + make_interval(mins => v_slot)) at time zone v_tz, 'old page', v_staff);
    fails := fails + 1; raise notice 'FAIL  7 old page off-grid block was saved';
  exception when others then
    if sqlerrm in ('not_on_grid', 'outside_opening_hours') or sqlerrm like 'CourtBook has been updated.%' then raise notice 'ok    7 old page, off grid: refused (%)', sqlerrm;
    else fails := fails + 1; raise notice 'FAIL  7 old page off grid: %', sqlerrm; end if; end;
  -- 8 delete the block from case 1
  begin
    delete from blocks where id = v_id;
    if found then raise notice 'ok    8 desk deletes its block'; else fails := fails + 1; raise notice 'FAIL  8 delete removed nothing'; end if;
  exception when others then fails := fails + 1; raise notice 'FAIL  8 delete: %', sqlerrm; end;
  -- 9 Close courts on that day still works
  begin
    perform close_club(v_club, (v_day + v_open) at time zone v_tz, (v_day + v_open + interval '2 hours') at time zone v_tz, 'staging check');
    raise notice 'ok    9 Close courts works';
  exception when others then
    -- another court may be busy on that day; that is Close courts' normal refusal
    if sqlerrm in ('block_overlaps_booking', 'overlaps_existing_block') then raise notice 'ok    9 Close courts answered as before (%)', sqlerrm;
    else fails := fails + 1; raise notice 'FAIL  9 Close courts: %', sqlerrm; end if; end;
  raise notice 'RESULT: % failure(s); everything above is rolled back', fails;
end $t$;
rollback;
select 'rolled back: nothing kept' as result;
