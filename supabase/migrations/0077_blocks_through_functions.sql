-- Calendar blocks, part B of two (approved 21 Nov 2026; docs/phase-i/blocks.md).
--
-- Apply only after the website that calls staff_block() (0076) is live for this database. From here on a
-- block is created only by staff_block() (one court) or close_club() (Close courts); nobody signed in can
-- insert or change a block row directly. Staff can still read and delete their club's blocks.
--
--   * the "blocks: staff write" policy (insert, update, delete, read) is replaced by "blocks: staff delete";
--     reads keep "blocks: staff read" (0068). With no insert or update policy, row-level security refuses
--     every direct insert and update by a signed-in user.
--   * signed-in users also lose the update right (nothing has ever updated a block). Signed-out users have
--     no policy at all, so row-level security refuses them whatever their table rights; those are left as
--     they are, so the rollback can restore the exact previous state.
--   * the insert right stays granted to signed-in users for one reason only: a page opened before the new
--     website still inserts directly, and the trigger below gives it a readable answer ("reload") instead
--     of a database error. Row-level security refuses the insert even without the trigger.
--
-- Unchanged: staff_block, close_club, existing blocks (no row is touched), reads, deletes.

drop policy if exists "blocks: staff write" on blocks;
drop policy if exists "blocks: staff delete" on blocks;
create policy "blocks: staff delete" on blocks for delete using (is_staff_of(club_id));
revoke update on table blocks from authenticated;

create or replace function blocks_direct_insert_refused() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    -- shown as written by pages from before this change (their error list has no entry for it)
    raise exception 'CourtBook has been updated. Reload the page, then block the time again.'
      using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists blocks_direct_write_rules on blocks;      -- 0076's checks: no direct writes remain to check
drop trigger if exists blocks_direct_insert_refused on blocks;
create trigger blocks_direct_insert_refused
  before insert on blocks
  for each row execute function blocks_direct_insert_refused();
