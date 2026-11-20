-- 0075 — ROLLBACK: removes admin_blocks_received. Nothing else changes; no data is touched.
-- The Reports page then simply leaves out "blocked by N players".
drop function if exists admin_blocks_received(uuid[]);
notify pgrst, 'reload schema';
