-- R2 (release audit, 17 Nov 2026): club blocks are readable only by that club's staff and admins.
--
-- Before: policy "blocks: read" was `using (true)`, so any signed-in user could read every club's
-- blocks through the API, including the free-text reason (names, phone numbers typed by the desk)
-- and created_by (a staff member's user id).
--
-- Players never read this table. Availability reaches them through the views `occupancy` and
-- `public_occupancy` and the functions club_day_slots, next_free_slot, club_courts_free_now and
-- club_discovery, which all run with their owner's rights and expose start, end and "block" only.
-- The staff calendar keeps reading and writing blocks through "blocks: staff write" (FOR ALL, which
-- includes SELECT); the policy below states the read rule on its own so it does not depend on that.
-- is_staff_of() is true for admins as well.
--
-- Safe to re-run.
drop policy if exists "blocks: read" on blocks;
drop policy if exists "blocks: staff read" on blocks;
create policy "blocks: staff read" on blocks for select using (is_staff_of(club_id));
