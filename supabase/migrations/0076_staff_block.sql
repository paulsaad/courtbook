-- Calendar blocks, part A of two (approved 21 Nov 2026; docs/phase-i/blocks.md).
--
-- A single-court block (maintenance, an event) is now created through staff_block(), which applies the
-- club's rules in the club's own time zone:
--   * the caller is staff of that club; the court is an active court of that club;
--   * whole slots, starting on the club's grid, inside opening hours, on one day (the booking check
--     assert_valid_court_slot, without the booking minimum and maximum);
--   * not wholly in the past (a block that has started and not yet ended is allowed);
--   * no overlap with a confirmed booking, an unexpired payment hold or another block — unchanged: the
--     existing trigger reject_block_over_booking (0013) and constraint no_overlapping_blocks decide.
-- It takes the court lock first, like every booking path, and runs with the owner's rights, so the
-- expired-hold sweep in reject_block_over_booking can actually expire a stale hold. (Run as the desk user,
-- that sweep updated nothing and a stale hold wrongly refused the block.)
--
-- Additive: the website that inserts into blocks directly keeps working. From this migration on, a direct
-- insert or update by a signed-in user must follow the same rules (trigger blocks_direct_write_rules), so a
-- page opened before the new website cannot create an invalid block while the change is rolled out; it
-- gets the same readable refusals. 0077 then stops direct inserts and updates altogether.
--
-- Unchanged: close_club (whole-club Close courts), its rules and its error mapping; existing blocks (no row
-- is touched; the trigger fires only on new inserts and updates); bookings, holds, payments, RLS on reads
-- and deletes.

-- the rules for a single-court block; raises the same error names as bookings (see src/lib/types.ts ERRORS)
create or replace function assert_valid_block(p_club uuid, p_court uuid, p_start timestamptz, p_end timestamptz)
returns void
language plpgsql stable set search_path = public as $$
begin
  if p_start is null or p_end is null or p_start >= p_end then raise exception 'bad_duration'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = p_club and active) then
    raise exception 'court_not_found';
  end if;
  if p_end <= now() then raise exception 'slot_in_past'; end if;          -- started-and-ongoing is allowed
  perform assert_valid_court_slot(p_club, p_court, p_start, p_end);        -- grid, whole slots, hours, club time zone
end $$;
revoke execute on function assert_valid_block(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function assert_valid_block(uuid, uuid, timestamptz, timestamptz) to authenticated;

create or replace function staff_block(p_club uuid, p_court uuid, p_start timestamptz, p_end timestamptz, p_reason text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_staff_of(p_club) then raise exception 'forbidden'; end if;
  perform 1 from courts where id = p_court and club_id = p_club for update;   -- the court lock, as for bookings
  if not found then raise exception 'court_not_found'; end if;
  perform assert_valid_block(p_club, p_court, p_start, p_end);
  insert into blocks (club_id, court_id, start_at, end_at, reason, created_by)
  values (p_club, p_court, p_start, p_end, coalesce(nullif(btrim(p_reason), ''), 'Blocked'), auth.uid())
  returning id into v_id;
  return v_id;
exception
  when exclusion_violation then
    -- reject_block_over_booking raises block_overlaps_booking (23P01); no_overlapping_blocks raises its own
    if sqlerrm = 'block_overlaps_booking' then raise exception 'block_overlaps_booking'; end if;
    raise exception 'overlaps_existing_block';
end $$;
revoke execute on function staff_block(uuid, uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function staff_block(uuid, uuid, timestamptz, timestamptz, text) to authenticated;

-- Direct writes by a signed-in user (an older website page, or the API) follow the same rules. staff_block
-- and close_club run with the owner's rights, so current_user is not a client role inside them: staff_block
-- has already checked, and Close courts stays exactly as it was.
create or replace function blocks_direct_write_rules() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    perform assert_valid_block(new.club_id, new.court_id, new.start_at, new.end_at);
  end if;
  return new;
end $$;
drop trigger if exists blocks_direct_write_rules on blocks;
create trigger blocks_direct_write_rules
  before insert or update of club_id, court_id, start_at, end_at on blocks
  for each row execute function blocks_direct_write_rules();
